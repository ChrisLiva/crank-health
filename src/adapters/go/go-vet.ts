import { writeScratchRaw } from '../../core/exec.ts'
import type { PendingFinding, RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import {
  asArray,
  asRecord,
  asString,
  byLocation,
  failed,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { MINIMUM_GO_MINOR, execGo, withGoGate } from './go-toolchain.ts'

/**
 * `go vet -json ./...` — the toolchain's own analyzer suite (spec "Categories
 * and tools"), reported under `lint` beside staticcheck's.
 *
 * Two lint tools, deliberately: `vet` and staticcheck overlap on some checks
 * and neither is a superset of the other (a mismatched `Printf` verb is both
 * `printf` and `SA5009`), so a repo gets both rows and the reader sees which
 * analyzer said what. They are not alternatives a repo chose between — `vet`
 * ships with Go and every Go repo already runs it through `go test` — so
 * neither stands the other down.
 *
 * Like `gofmt`, `vet` is the machine's toolchain rather than a pinned analyzer:
 * there is nothing to fetch, nothing to configure and no version of its own to
 * report, so the tool record's `version` stays null.
 */

export const GO_VET_TOOL = 'go-vet'

/**
 * Five minutes, like staticcheck's: `vet` type-checks every package of the
 * module before an analyzer sees it. A user's `--timeout` still wins.
 */
const GO_VET_TIMEOUT_MS = 300_000

/** The name the stream is staged under, per project. */
const RAW_NAME = 'go-vet.json'

/**
 * Not a pin crank-health can enforce — `vet` is a subcommand of the machine's
 * own Go toolchain. What can be stated is the floor the gate holds it to.
 */
const GO_VET_FLOOR = `1.${MINIMUM_GO_MINOR}`

export const goVetRunner: ToolRunner = {
  tool: GO_VET_TOOL,
  category: 'lint',
  pinnedVersion: GO_VET_FLOOR,
  timeoutMs: GO_VET_TIMEOUT_MS,
  // `vet` has no configuration a repo could own — its analyzer set is the
  // toolchain's — so there is nothing to detect, and detection never spawns.
  detect: () => Promise.resolve(null),
  run: withGoGate(runGoVet),
}

async function runGoVet(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' }
  }

  const execution = await execGo(ctx, invocationArgs())
  if (execution.failure !== undefined) {
    return failed(execution.failure)
  }

  const rawFiles = [await writeScratchRaw(ctx.scratch, RAW_NAME, execution.stdout)]

  // **The exit code is the failure signal, and the only one.** `vet` exits 0
  // when it reported diagnostics (probed on go 1.26.6) — findings are the
  // normal outcome, not an error — and non-zero only when a package would not
  // load. Then the documents it did print describe a package set that was never
  // fully loaded, so they are discarded rather than half-graded: refusal beats a
  // flattering grade, and the type error itself is staticcheck's to report under
  // `types`.
  if (execution.exitCode !== 0) {
    // Plain `firstLine`: `vet` is toolchain-shipped, so this stderr carries no
    // `go: downloading …` narration to strip (unlike the `go run`-fetched
    // analyzers, which read theirs through `withoutFetchNarration`). Go heads a
    // load failure with `# <package>`, so the first line names the package that
    // failed — deterministic, and the same on a cold cache as on a warm one.
    return { state: 'error', findings: [], rawFiles, reason: firstLine(execution.stderr) }
  }

  // Only the files this scan owns: `./...` walks the module's own packages —
  // stopping at a nested module and skipping `vendor/` — but a generated file
  // discovery excluded is still not the repo's to answer for.
  const analyzed = new Set(ctx.files)
  const pending = parseVetStream(execution.stdout, ctx.repoRoot).filter((finding) =>
    analyzed.has(finding.file),
  )
  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending.toSorted(byLocation)),
    rawFiles,
  }
}

/**
 * The one invocation. `./...` is every package of the module at `cwd` and stops
 * at a nested module's boundary, so a project's run measures the project.
 */
function invocationArgs(): string[] {
  return ['vet', '-json', './...']
}

/**
 * `-json` stdout → findings.
 *
 * The stream is neither one JSON document nor JSON Lines: it is *concatenated
 * pretty-printed* documents, one per package analyzed, and a package with
 * nothing to say contributes a bare `{}`. So the documents are found by
 * counting braces outside of strings, and each is parsed on its own — a package
 * whose diagnostics arrive as a shape this does not recognize costs that
 * package's findings, never the rest of the stream.
 *
 * A document is `{package: {analyzer: [diagnostic…]}}`, and the analyzer's name
 * is the rule: `printf`, `copylocks`, `loopclosure`. Every diagnostic is a lint
 * finding — `vet`'s suite is one severity, and it has no notion of a rule a repo
 * turned into an error.
 *
 * @param repoRoot the absolute repo root; `posn` is an absolute
 * `file:line:col`, which makes it the only thing needed to place a diagnostic
 */
export function parseVetStream(stdout: string, repoRoot: string): readonly PendingFinding[] {
  return documentsIn(stdout).flatMap((document) => findingsInDocument(document, repoRoot))
}

/**
 * One document's findings: a document that did not parse, or that is not the
 * `{package: {analyzer: […]}}` shape, costs its own package's findings alone.
 */
function findingsInDocument(document: string, repoRoot: string): PendingFinding[] {
  const packages = asRecord(parseDocument(document))
  if (packages === undefined) return []
  return Object.values(packages).flatMap((analyzers) => findingsInPackage(analyzers, repoRoot))
}

/** One package's `{analyzer: [diagnostic…]}` map, with the analyzer as the rule. */
function findingsInPackage(analyzers: unknown, repoRoot: string): PendingFinding[] {
  const findings: PendingFinding[] = []
  for (const [analyzer, diagnostics] of Object.entries(asRecord(analyzers) ?? {})) {
    for (const diagnostic of asArray(diagnostics) ?? []) {
      const finding = toPendingFinding(analyzer, asRecord(diagnostic), repoRoot)
      if (finding !== undefined) findings.push(finding)
    }
  }
  return findings
}

/**
 * The top-level JSON documents of a concatenated stream, in the order they were
 * printed.
 *
 * Brace counting has one hazard, and it is not hypothetical: a diagnostic
 * message quotes the Go source it flagged, and Go source is made of braces and
 * quotes. So the scan tracks whether it is inside a string and whether the last
 * character escaped the next one, and counts only the braces that are really
 * structure.
 */
function documentsIn(stdout: string): string[] {
  const documents: string[] = []
  let depth = 0
  let start = -1

  for (const { index, char } of structuralBraces(stdout)) {
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (depth === 0) continue
    depth -= 1
    if (depth === 0 && start !== -1) {
      documents.push(stdout.slice(start, index + 1))
      start = -1
    }
  }
  return documents
}

/**
 * Every `{` and `}` in the stream that is structure rather than string content,
 * with the index it sits at. A brace inside a quoted diagnostic message — Go
 * source quoted back at the reader — is not structure, and neither is one behind
 * a backslash escape.
 */
function* structuralBraces(stdout: string): Generator<{ index: number; char: string }> {
  let inString = false
  let escaped = false

  for (let index = 0; index < stdout.length; index += 1) {
    const char = stdout[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '}') yield { index, char }
  }
}

/** One document, or `undefined` where it was not JSON after all. */
function parseDocument(document: string): unknown {
  try {
    return JSON.parse(document)
  } catch {
    return undefined
  }
}

/**
 * One diagnostic in the core's vocabulary, or `undefined` where it carried no
 * place or nothing to say.
 *
 * Severity is `warning` throughout: `vet`'s checks are correctness suspicions
 * about code that compiles, and grading one as an `error` would put a D on a
 * repo for a suspicion (`core/grade.ts` reads severity, not counts, for its
 * worst grades). Provenance is always `default-config` — there is no
 * configuration for a repo to own.
 */
function toPendingFinding(
  analyzer: string,
  diagnostic: Record<string, unknown> | undefined,
  repoRoot: string,
): PendingFinding | undefined {
  if (diagnostic === undefined) return undefined
  const message = asString(diagnostic['message'])
  const start = position(asString(diagnostic['posn']), repoRoot)
  if (message === undefined || start === undefined) return undefined
  // `end` is the span's other end where the analyzer reported one, and the
  // start stands in for it where it did not.
  const end = position(asString(diagnostic['end']), repoRoot) ?? start

  return {
    category: 'lint',
    tool: GO_VET_TOOL,
    rule: analyzer,
    severity: 'warning',
    file: start.file,
    range: {
      startLine: start.line,
      startCol: start.column,
      endLine: end.line,
      endCol: end.column,
    },
    message,
    provenance: 'default-config',
    gradeScope: true,
  }
}

/** Where one end of a diagnostic points, as the repo sees it. */
interface Position {
  readonly file: string
  readonly line: number
  readonly column: number
}

/**
 * A `posn`/`end` string: `<file>:<line>:<column>`, with the file absolute
 * (probed on go 1.26.6). The file part is matched greedily and by name, so a
 * path that holds a colon of its own — a Windows drive letter, a directory
 * someone named with one — keeps it.
 */
const POSITION = /^(?<file>.+):(?<line>\d+):(?<column>\d+)$/

function position(posn: string | undefined, repoRoot: string): Position | undefined {
  const matched = posn === undefined ? undefined : POSITION.exec(posn)?.groups
  if (matched === undefined) return undefined
  return {
    file: repoRelative(matched['file'] ?? '', repoRoot),
    line: Number(matched['line']),
    column: Number(matched['column']),
  }
}
