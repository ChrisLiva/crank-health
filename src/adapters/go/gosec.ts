import { writeScratchRaw } from '../../core/exec.ts'
import type {
  PendingFinding,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedGoSpec, pinnedGoVersion } from '../../manifest.ts'
import {
  OMITTED,
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  compare,
  firstLine,
  identify,
  repoRelative,
  sanitizeRawResults,
} from '../support.ts'
import { execGo, withGoGate, withoutFetchNarration } from './go-toolchain.ts'

/**
 * gosec — the Go SAST scanner (spec "Categories and tools"), reported under
 * `security` beside the repo-scoped scanners rather than instead of them:
 * security tools are a union, not a menu, so this runner is `complementary`
 * (`ToolRunner.complementary`) and a repo that owns none of them still gets all
 * of them.
 *
 * **It is the one Go tool that quotes the repo's source.** Every issue carries
 * a `code` window of the flagged file, and on a G101 ("potential hardcoded
 * credentials") the line in that window is the credential. So the excerpt is
 * dropped twice, the bandit way: it never reaches a `PendingFinding`
 * ({@link parseGosecJson}), and the raw evidence staged into the run directory
 * is scrubbed before it is written ({@link sanitizeRawJson}). gosec's own
 * `details` text names the rule and quotes nothing, so — unlike bandit's
 * B105–B107 messages — there is nothing to redact in the message.
 *
 * There is no `-quiet`: under it a clean tree with a package that would not
 * load prints *nothing at all* and exits 0 (probed on v2.28.0), which would
 * make a refused analysis indistinguishable from a clean one. Without it the
 * envelope always prints, and the exit code stops being the whole story.
 */

const GOSEC_TOOL = 'gosec'

/** The import path `go run` fetches; pinned exactly in `manifest.ts`. */
const GOSEC_PACKAGE = 'github.com/securego/gosec/v2/cmd/gosec'

/**
 * Five minutes, like staticcheck's: gosec type-checks every package of the
 * module before a rule sees it, and on a cold module cache it downloads itself
 * first.
 */
const GOSEC_TIMEOUT_MS = 300_000

/** The name the scan is staged under, per project. */
const RAW_NAME = 'gosec.json'

/** The envelope key holding gosec's issues — `Issues`, not `results`. */
const ISSUES_KEY = 'Issues'

/** The envelope key holding the packages gosec could not load. */
const ERRORS_KEY = 'Golang errors'

/** gosec's severity tiers, read with its confidence; see {@link toPendingFinding}. */
const SEVERITIES: Readonly<Record<string, Severity>> = {
  HIGH: 'warning',
  MEDIUM: 'warning',
  LOW: 'info',
}

/** The tiers that count toward the grade; the rest are evidence (bandit's rule). */
const GRADED_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(['error', 'warning'])

export const gosecRunner: ToolRunner = {
  tool: GOSEC_TOOL,
  category: 'security',
  pinnedVersion: pinnedGoVersion(GOSEC_PACKAGE),
  // Security tools union rather than suppress each other: a repo scanned by
  // gitleaks has not thereby declined a SAST pass. See `ToolRunner.complementary`.
  complementary: true,
  timeoutMs: GOSEC_TIMEOUT_MS,
  // gosec reads no repo configuration crank-health honours — its rule set is
  // the default one — so there is nothing to detect, and detection never spawns.
  detect: () => Promise.resolve(null),
  run: withGoGate(runGosec),
}

/**
 * What one gosec run said: the issues it found, and the packages it could not
 * load. Both, because either one alone would be a lie about the other — a run
 * that reported nothing because nothing compiled is not a clean repo.
 */
export interface GosecOutcome {
  readonly loadErrors: readonly string[]
  readonly findings: readonly PendingFinding[]
}

async function runGosec(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' }
  }

  const execution = await execGo(ctx, invocationArgs())
  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles: [],
      reason: execution.failure.reason,
    }
  }

  // Scrubbed on the way to disk, never after: the run directory must not hold a
  // credential even for the moment between writing and rewriting it.
  const rawFiles = [await writeScratchRaw(ctx.scratch, RAW_NAME, sanitizeRawJson(execution.stdout))]

  // **The exit code is not the failure signal here.** gosec exits 1 for a run
  // that found issues *and* for a run whose packages would not load (probed on
  // v2.28.0), so what happened is read off the envelope: no issues and a
  // non-empty `Golang errors` map is an analysis that never happened, and
  // grading a `security` category off it would be the flattering A spec §3
  // forbids. Issues beside load errors is a partial analysis, and partial beats
  // nothing.
  if (!isGosecEnvelope(execution.stdout)) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `gosec exited ${execution.exitCode ?? 'signal'}: ` +
        // Stripped of fetch narration first: on a cold cache the literal first
        // line is `go: downloading …`, and `reason` is a `report.json` field.
        firstLine(withoutFetchNarration(execution.stderr)),
    }
  }

  const outcome = parseGosecJson(execution.stdout, ctx.repoRoot)
  if (outcome.findings.length === 0 && outcome.loadErrors.length > 0) {
    return { state: 'error', findings: [], rawFiles, reason: outcome.loadErrors[0] ?? '' }
  }

  // Only the files this scan owns: `./...` walks the module's own packages —
  // stopping at a nested module and skipping `vendor/` — but a generated file
  // discovery excluded is still not the repo's to answer for.
  const analyzed = new Set(ctx.files)
  const pending = outcome.findings.filter((finding) => analyzed.has(finding.file))

  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending),
    // `go run <import-path>@<version>` is an exact spec with no resolution step
    // that could land elsewhere, so the pin is what ran (spec §6). The binary
    // itself reports `GosecVersion: "dev"` when `go run` built it, which is a
    // fact about this machine and not about the analyzer.
    toolVersion: pinnedGoVersion(GOSEC_PACKAGE),
    rawFiles,
  }
}

/**
 * The one invocation. `./...` is every package of the module at `cwd` and stops
 * at a nested module's boundary, so a project's run measures the project.
 */
function invocationArgs(): string[] {
  return ['run', pinnedGoSpec(GOSEC_PACKAGE), '-fmt=json', './...']
}

/** Whether this stdout is gosec's report envelope at all. */
function isGosecEnvelope(stdout: string): boolean {
  return asArray(asRecord(parseDocument(stdout))?.[ISSUES_KEY]) !== undefined
}

/**
 * `-fmt=json` stdout → what the run said.
 *
 * Every field is read by name. `line` and `column` arrive as *strings*
 * (probed on v2.28.0 — `"line": "5"`), `file` is absolute, and `code` is the
 * three-line source window that this parser is careful never to carry forward:
 * a finding is a place and a rule, and the line itself is in the repo where the
 * reader can look at it.
 *
 * A stream that is not the envelope — empty, truncated, or a panic — is no
 * findings and no errors rather than a throw; the runner reports the failure
 * from the exit code and stderr, which is where the explanation is.
 *
 * @param repoRoot the absolute repo root, which is what turns gosec's absolute
 * paths into the paths the rest of the report speaks
 */
export function parseGosecJson(stdout: string, repoRoot: string): GosecOutcome {
  const record = asRecord(parseDocument(stdout))
  const issues = asArray(record?.[ISSUES_KEY])
  if (record === undefined || issues === undefined) return { loadErrors: [], findings: [] }

  const findings = issues
    .flatMap((issue) => {
      const finding = toPendingFinding(asRecord(issue), repoRoot)
      return finding === undefined ? [] : [finding]
    })
    .toSorted(byLocation)

  return { loadErrors: loadErrorsOf(record, repoRoot), findings }
}

/**
 * One issue in the core's vocabulary, or `undefined` where it carried no place
 * or nothing to say.
 *
 * Severity pairs gosec's own tier with its confidence, the way bandit's does: a
 * HIGH-severity finding gosec is HIGH-confident about is an `error`, one it is
 * less sure of is a `warning`, and a LOW-severity guess is `info` — evidence,
 * not a grade. Provenance is always `default-config`: the rule set is
 * crank-health's, not the repo's.
 */
function toPendingFinding(
  issue: Record<string, unknown> | undefined,
  repoRoot: string,
): PendingFinding | undefined {
  const rule = asString(issue?.['rule_id'])
  const file = asString(issue?.['file'])
  const message = asString(issue?.['details'])
  if (rule === undefined || file === undefined || message === undefined) return undefined

  const tier = asString(issue?.['severity']) ?? 'UNDEFINED'
  const confidence = asString(issue?.['confidence']) ?? 'UNDEFINED'
  const severity: Severity =
    tier === 'HIGH' && confidence === 'HIGH' ? 'error' : (SEVERITIES[tier] ?? 'info')
  const line = numeric(issue?.['line'])
  const column = numeric(issue?.['column'])
  const url = asString(asRecord(issue?.['cwe'])?.['url'])

  return {
    category: 'security',
    tool: GOSEC_TOOL,
    rule,
    severity,
    file: repoRelative(file, repoRoot),
    // gosec reports where an issue starts and nothing more, so the span is the
    // point it named.
    range: { startLine: line, startCol: column, endLine: line, endCol: column },
    message: `${message} (${tier.toLowerCase()} severity, ${confidence.toLowerCase()} confidence)`,
    provenance: 'default-config',
    gradeScope: GRADED_SEVERITIES.has(severity),
    ...(url === undefined ? {} : { fixHint: `see ${url}` }),
  }
}

/**
 * The packages gosec could not load, one sentence each, in a fixed order.
 *
 * `Golang errors` is a map from file to compile errors, and Go's toolchain adds
 * one entry under the empty key whose text is headed `# <package>` — the header
 * is not the diagnostic, so the *last* line is what is quoted (the mirror of
 * `go vet`'s `firstLine`, which reads a stderr whose header comes last). The
 * map is sorted by key rather than trusted in document order: `reason` is a
 * `report.json` field and two runs of the same commit must word it the same.
 */
function loadErrorsOf(record: Record<string, unknown>, repoRoot: string): string[] {
  const errors = asRecord(record[ERRORS_KEY]) ?? {}
  return Object.entries(errors)
    .toSorted(([a], [b]) => compare(a, b))
    .flatMap(([file, entries]) =>
      (asArray(entries) ?? []).flatMap((entry) => {
        const failure = asRecord(entry)
        const message = lastLine(asString(failure?.['error']) ?? '')
        if (message === '') return []
        const where =
          file === ''
            ? ''
            : `${repoRelative(file, repoRoot)}:${numeric(failure?.['line'])}:${numeric(failure?.['column'])}: `
        return [`${where}${message}`]
      }),
    )
}

/** Last non-empty line of a message; see {@link loadErrorsOf}. */
function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? ''
}

/**
 * gosec's raw JSON with every `code` excerpt replaced — it quotes three lines
 * of the flagged file around each issue, and on a G101 the middle one is the
 * credential. See {@link sanitizeRawResults}.
 */
export function sanitizeRawJson(stdout: string): string {
  return sanitizeRawResults(stdout, ISSUES_KEY, (issue) =>
    issue['code'] === undefined ? issue : { ...issue, code: OMITTED },
  )
}

/**
 * A field gosec reports as a decimal string (`"line": "5"`) or, in the load-
 * error map, as a number. Anything unreadable is 0 — a place the report can
 * still name without inventing one.
 */
function numeric(value: unknown): number {
  const asNumeric = asNumber(value) ?? Number(asString(value) ?? '')
  return Number.isFinite(asNumeric) ? asNumeric : 0
}

/** The stream as JSON, or `undefined` where it was not JSON at all. */
function parseDocument(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}
