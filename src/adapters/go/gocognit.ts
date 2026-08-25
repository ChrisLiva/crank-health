import { writeScratchRaw } from '../../core/exec.ts'
import { COMPLEXITY_CEILING } from '../../core/grade.ts'
import type { RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import { pinnedGoSpec, pinnedGoVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  failed,
  firstLine,
  underProject,
} from '../support.ts'
import { execGo, withGoGate, withoutFetchNarration } from './go-toolchain.ts'

/**
 * gocognit — cognitive complexity per Go function, which is exactly the ratio
 * spec §3 grades on: "% of functions over cognitive 15" (complexipy's shape,
 * for the other language that measures the same metric).
 *
 * A census and nothing else: this runner reports two numbers and no findings.
 * The grade is a share of *all* functions, so the denominator is the whole
 * answer and a per-function finding would say nothing the numbers do not.
 *
 * `-over -1` is load-bearing. gocognit's default listing omits the functions it
 * scored 0 — probed on v1.2.1, where the same tree lists five functions by
 * default and nine under `-over -1` — so the default would quietly shrink the
 * denominator by every simple function in the repo and flatter every grade.
 *
 * It is handed a **directory**, because `./...` is not a path and gocognit
 * rejects it (`gocognit: open ./...: no such file or directory`, probed). A
 * directory walk sees more than the project does: a `vendor/` copy of a
 * dependency and a nested module's own packages are both under it. So what the
 * census counts is decided afterwards, by the scan's file list — the
 * `complexipy.ts` precedent, and the reason the parser takes the project it ran
 * in.
 */

const GOCOGNIT_TOOL = 'gocognit'

/** The import path `go run` fetches; pinned exactly in `manifest.ts`. */
const GOCOGNIT_PACKAGE = 'github.com/uudashr/gocognit/cmd/gocognit'

/**
 * Five minutes, like staticcheck's: this parses no more than the package graph
 * does, but on a cold module cache it downloads the analyzer first.
 */
const GOCOGNIT_TIMEOUT_MS = 300_000

/** The name the census is staged under, per project. */
const RAW_NAME = 'gocognit.json'

export const gocognitRunner: ToolRunner = {
  tool: GOCOGNIT_TOOL,
  category: 'complexity',
  pinnedVersion: pinnedGoVersion(GOCOGNIT_PACKAGE),
  timeoutMs: GOCOGNIT_TIMEOUT_MS,
  // gocognit reads no configuration — its ceiling is crank-health's, and a repo
  // cannot move the bar it is graded against — so there is nothing to detect.
  detect: () => Promise.resolve(null),
  run: withGoGate(runGocognit),
}

/** One function gocognit measured — the denominator's unit. */
export interface GocognitEntry {
  /** Repo-relative posix, already joined onto the project the run happened in. */
  readonly file: string
  readonly name: string
  readonly complexity: number
}

async function runGocognit(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' }
  }

  const execution = await execGo(ctx, invocationArgs())
  if (execution.failure !== undefined) {
    return failed(execution.failure)
  }

  const rawFiles = [await writeScratchRaw(ctx.scratch, RAW_NAME, execution.stdout)]

  // **The exit code is the failure signal, and the only one.** gocognit exits 0
  // whether or not anything cleared the threshold (probed on v1.2.1 under
  // `-over -1`, where every function does); it exits non-zero only when it
  // could not read the tree — an unreadable directory, or a file it could not
  // parse — and then the census it printed is not a denominator.
  if (execution.exitCode !== 0) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `gocognit exited ${execution.exitCode ?? 'signal'}: ` +
        // Stripped of fetch narration first, like staticcheck's: on a cold
        // cache the literal first line is `go: downloading …`, and `reason` is
        // a `report.json` field, so a cold run must not differ from a warm one.
        firstLine(withoutFetchNarration(execution.stderr)),
    }
  }

  // Only the files this scan owns. The walk saw the vendored dependency and the
  // nested module too, and neither belongs in this project's census or in its
  // denominator (`complexipy.ts`'s filter, for the same reason).
  const analyzed = new Set(ctx.files)
  const measured = parseGocognitJson(execution.stdout, ctx.project.path).filter((entry) =>
    analyzed.has(entry.file),
  )

  return {
    state: 'ok',
    findings: [],
    // `go run <import-path>@<version>` is an exact spec with no resolution step
    // that could land elsewhere, so the pin is what ran (spec §6).
    toolVersion: pinnedGoVersion(GOCOGNIT_PACKAGE),
    rawFiles,
    // Spec §3's complexity ratio, exactly: % of functions over cognitive 15.
    metrics: {
      functionsTotal: measured.length,
      functionsOverCeiling: measured.filter((entry) => entry.complexity > COMPLEXITY_CEILING)
        .length,
    },
  }
}

/**
 * The one invocation; see this file's header for why `-over -1` and why a
 * directory rather than `./...`.
 */
function invocationArgs(): string[] {
  return ['run', pinnedGoSpec(GOCOGNIT_PACKAGE), '-json', '-over', '-1', '.']
}

/**
 * `-json` stdout → the census.
 *
 * The document is an array of `{PkgName, FuncName, Complexity, Pos}`, and
 * `Pos.Filename` is relative to the directory gocognit ran in (probed on
 * v1.2.1) — so the project it ran in is what turns it into a path the rest of
 * the report can speak about. A tree it measured nothing in prints `null`
 * rather than `[]`, and that is no entries, not a parse failure.
 *
 * Every field is read by name and an entry missing one is dropped rather than
 * counted: a census entry with no place and no score is not a function.
 *
 * @param projectPath repo-relative posix project directory, `.` for the root
 */
export function parseGocognitJson(stdout: string, projectPath: string): readonly GocognitEntry[] {
  const entries = asArray(parseDocument(stdout))
  if (entries === undefined) return []

  return entries.flatMap((entry) => {
    const record = asRecord(entry)
    const file = asString(asRecord(record?.['Pos'])?.['Filename'])
    const complexity = asNumber(record?.['Complexity'])
    const name = asString(record?.['FuncName'])
    if (file === undefined || complexity === undefined || name === undefined) return []
    return [{ file: underProject(projectPath, file), name, complexity } satisfies GocognitEntry]
  })
}

/** The stream as JSON, or `undefined` where it was not JSON at all. */
function parseDocument(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}
