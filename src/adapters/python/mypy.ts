import { join } from 'node:path'
import { execTool, repoCommand, uvxCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedPythonVersion } from '../../manifest.ts'
import {
  asNumber,
  asRecord,
  asString,
  byLocation,
  errorMessage,
  failed,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { detectPythonTool, findVenv } from './py-project.ts'

/**
 * mypy — the original Python type checker, and the one crank-health runs only
 * where the repo asked for it (`repoOwnedOnly`). ty and pyright are defaults we
 * choose; mypy is a choice the repo already made, usually with a config that
 * tunes strictness per module, so imposing it on a repo that never opted in
 * would grade code against rules nobody signed up for.
 *
 * Its parser is tested against captured bytes for the same reason every other
 * one is: an output-format change must fail a test, not quietly report a clean
 * repo.
 */

const MYPY_TOOL = 'mypy'

/** PyPI distribution; mypy's command and distribution names coincide. */
const MYPY_DISTRIBUTION = 'mypy'

/** Root config artifacts that make mypy repo-owned (spec §1, first check). */
const MYPY_CONFIG_FILES: readonly string[] = ['mypy.ini', '.mypy.ini']

/** `pyproject.toml` sections that make mypy repo-owned. */
const MYPY_SECTIONS: readonly string[] = ['tool.mypy']

/** The rule id for a diagnostic mypy reports without a code (`"code": null`). */
export const MYPY_GENERAL_RULE = 'mypy/diagnostic'

/**
 * mypy severities → the core's vocabulary (spec §2). mypy 2.3.1 asserts its own
 * severity is `error` or `note`, and notes never reach here (see
 * {@link parseMypyJsonl}); the `warning` row is forward compatibility, so that a
 * severity mypy may add later cannot silently grade as an error, and anything
 * unrecognized falls back to `error` because that is the safe direction.
 */
const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  error: 'error',
  warning: 'warning',
}

/**
 * Flags shared by every invocation. `--output=json` is the whole contract:
 * mypy's text output has no stable machine form, and the JSON form is JSON
 * Lines. mypy has no writing mode reachable from here; everything it does want
 * to write — its cache and its reports — is redirected into the scratch dir per
 * run (see {@link REPORT_KINDS}).
 */
const BASE_ARGS: readonly string[] = ['--output=json']

/**
 * The reports mypy generates without lxml, named by the middle of their
 * `--<kind>-report` flag and written one directory apiece.
 *
 * Zero footprint (spec §7): every one of these is settable from the config file
 * this runner deliberately points mypy at, and each resolves relative to the
 * cwd, which is always the repo. Left alone, a `linecount_report = mypyreport`
 * writes `mypyreport/` next to the code, and `junit_xml = junit.xml` writes
 * that file beside it. The CLI wins over the config, so passing all five with a
 * scratch destination is what makes such a setting harmless.
 *
 * mypy's other four reports — `--txt-report`, `--html-report`, `--xml-report`
 * and `--cobertura-xml-report` — are deliberately *not* passed: each aborts
 * mypy with an internal error when lxml is absent (verified against 2.3.1), so
 * passing them would trade a config we can neutralize for a run we cannot make.
 * A repo that sets one of the four either aborts honestly — surfaced as
 * `state: 'error'` — or, on a machine with lxml, still writes it where its own
 * config says.
 */
const REPORT_KINDS: readonly string[] = ['any-exprs', 'linecount', 'linecoverage', 'lineprecision']

/** Where each report goes: fixed flag order, every destination under scratch. */
function reportArgs(scratch: string): string[] {
  const reports = join(scratch, 'mypy-reports')
  return [
    ...REPORT_KINDS.flatMap((kind) => [`--${kind}-report`, join(reports, kind)]),
    '--junit-xml',
    join(reports, 'junit.xml'),
  ]
}

/**
 * `repoOwnedOnly` is the whole difference from ty and pyright. Those two are
 * crank-health's defaults for the types category and one of them runs on every
 * Python project; mypy runs only where the repo declared or configured it,
 * because a mypy config is a per-module strictness policy and running it
 * unasked would grade a repo against a policy it never wrote.
 */
export const mypyRunner: ToolRunner = {
  tool: MYPY_TOOL,
  category: 'types',
  pinnedVersion: pinnedPythonVersion(MYPY_DISTRIBUTION),
  repoOwnedOnly: true,
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: MYPY_CONFIG_FILES,
      distribution: MYPY_DISTRIBUTION,
      sections: MYPY_SECTIONS,
    }),
  run: runMypy,
}

/**
 * What a repo-owned mypy cannot be run without: an environment. mypy resolves
 * third-party imports through an interpreter, and with neither an installed
 * copy nor a virtualenv to point an ephemeral one at, every import in the
 * project would come back `import-not-found` — a confident wall of noise that
 * says nothing about the code. `not-available` with this reason is the honest
 * answer, and it names the one thing that would make the project checkable
 * (spec §8).
 */
const NO_VENV_REASON =
  'mypy is declared but this project has no virtualenv; ' +
  "create one and install the project's dependencies"

async function runMypy(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }

  // The repo's own mypy first — it is the version their config was written for,
  // and it already lives in the environment it must resolve imports against.
  const binPath = ctx.detection?.installed === true ? ctx.detection.binPath : undefined
  const venv = binPath === undefined ? await findVenv(ctx.repoRoot, ctx.project.path) : undefined
  if (binPath === undefined && venv === undefined) {
    return { state: 'not-available', findings: [], rawFiles: [], reason: NO_VENV_REASON }
  }

  // The pinned mypy runs *outside* the project's environment, so it is told
  // which interpreter to resolve the project's imports against. The repo's own
  // copy already lives in that environment and needs no telling.
  const ephemeral = binPath === undefined
  const command =
    binPath === undefined ? uvxCommand(MYPY_DISTRIBUTION, []) : repoCommand(binPath, [])
  const interpreterArgs = venv === undefined ? [] : ['--python-executable', venv.interpreter]

  const execution = await execTool(
    {
      ...command,
      args: [
        ...command.args,
        ...BASE_ARGS,
        // Zero footprint (spec §7): without these mypy writes a `.mypy_cache/`
        // next to the code it is checking, and any report its config asked for
        // beside it.
        '--cache-dir',
        join(ctx.scratch, 'mypy-cache'),
        ...reportArgs(ctx.scratch),
        ...configArgs(ctx.detection, ctx.repoRoot),
        ...interpreterArgs,
        // One invocation, never batched: mypy builds one dependency graph over
        // everything it is given, and splitting the file list would make each
        // half see the other half as an unresolved import.
        ...ctx.files,
      ],
    },
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'mypy.jsonl', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'mypy.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return failed(execution.failure, rawFiles)
  }

  let diagnostics: MypyDiagnostic[] = []
  let parseError: string | undefined
  try {
    diagnostics = parseMypyJsonl(execution.stdout)
  } catch (error) {
    parseError = errorMessage(error)
  }

  // mypy exits 0 for a clean run and 1 for one that found type errors; anything
  // else means it could not check the project. It reports that refusal as a
  // diagnostic on stdout and leaves stderr empty, so both are worth quoting.
  if (execution.exitCode !== 0 && execution.exitCode !== 1) {
    const said = firstLine(execution.stderr) || diagnostics[0]?.message || (parseError ?? '')
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `mypy failed (exit ${execution.exitCode ?? 'signal'}): ${said}`,
    }
  }
  if (parseError !== undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse mypy output: ${parseError}`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(diagnostics, ctx.repoRoot).filter((finding) => analyzed.has(finding.file)),
    ),
    // Set from the same flag that chose the command, so a `null` version in the
    // report is a faithful witness that the repo's own binary ran.
    ...(ephemeral ? { toolVersion: pinnedPythonVersion(MYPY_DISTRIBUTION) } : {}),
    rawFiles,
  }
}

/**
 * Which config mypy reads. `ownedVia` is the artifact detection decided
 * ownership on — the nearest `mypy.ini` or `pyproject.toml`, which in a
 * workspace may be an ancestor's — and naming it explicitly keeps the answer
 * the same wherever the run is launched from.
 *
 * A repo that only *declares* mypy has no config to point at, and the empty
 * `--config-file=` is what stops mypy discovering one anyway: it would otherwise
 * walk up to the repo's `setup.cfg` — or to the user's `~/.mypy.ini`, which
 * would make the report depend on whose machine ran it.
 */
function configArgs(detection: Detection | null, repoRoot: string): string[] {
  return detection === null || detection.reason === 'dependency' || detection.ownedVia === undefined
    ? ['--config-file=']
    : ['--config-file', join(repoRoot, detection.ownedVia)]
}

/** One mypy diagnostic, in the fields we report on. */
export interface MypyDiagnostic {
  /** mypy's error code, e.g. `return-value`, or {@link MYPY_GENERAL_RULE}. */
  readonly rule: string
  readonly severity: string
  readonly file: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
  readonly message: string
}

/**
 * Parses `mypy --output=json`, which is JSON *Lines*: one object per line, no
 * enclosing array, so a truncated run still yields whole records.
 *
 * Positions are normalized here rather than in the renderers: mypy counts lines
 * from 1 and columns from 0, and uses `-1` for "no position on this axis" (a
 * whole-file or whole-line diagnostic). Everything downstream counts both axes
 * from 1, so every axis is converted and then clamped.
 *
 * `note` lines are dropped. They are mypy's explanations attached to the error
 * above them — and `reveal_type`'s answer, which is a question the author asked
 * on purpose — not findings of their own. `hint` is dropped for the same reason
 * it is not a `fixHint`: it is prose about resolving the error, often several
 * lines of it, and the raw output keeps it.
 *
 * Exported so an output-format shift fails a test instead of reporting a clean
 * repo.
 *
 * @throws {Error} when a line is not JSON, or is not a mypy diagnostic
 */
export function parseMypyJsonl(stdout: string): MypyDiagnostic[] {
  const diagnostics: MypyDiagnostic[] = []

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue

    const record = asRecord(JSON.parse(line))
    const file = asString(record?.['file'])
    if (record === undefined || file === undefined) {
      throw new Error('not a mypy diagnostic: no file')
    }
    const severity = asString(record['severity']) ?? 'error'
    if (severity === 'note') continue

    const startLine = asNumber(record['line']) ?? 1
    const startCol = asNumber(record['column']) ?? 0
    const endLine = asNumber(record['end_line']) ?? startLine
    const endCol = asNumber(record['end_column']) ?? startCol
    diagnostics.push({
      rule: asString(record['code']) ?? MYPY_GENERAL_RULE,
      severity,
      file,
      startLine: Math.max(1, startLine),
      startCol: Math.max(1, startCol + 1),
      endLine: Math.max(1, endLine),
      endCol: Math.max(1, endCol + 1),
      message: asString(record['message']) ?? '',
    })
  }

  return diagnostics
}

/**
 * mypy diagnostics → the core's vocabulary. There is no provenance question to
 * ask: mypy is `repoOwnedOnly`, so it never runs against a config of ours and
 * every finding it produces came from the repo's own settings — which is also
 * why none of them is advisory the way ty's and pyright's environment
 * diagnostics are. A repo that configured mypy asked for all of this.
 */
export function toPendingFindings(
  diagnostics: readonly MypyDiagnostic[],
  repoRoot: string,
): PendingFinding[] {
  return diagnostics
    .map((diagnostic) => ({
      category: 'types' as const,
      tool: MYPY_TOOL,
      rule: diagnostic.rule,
      severity: SEVERITY_BY_LEVEL[diagnostic.severity] ?? 'error',
      file: repoRelative(diagnostic.file, repoRoot),
      range: {
        startLine: diagnostic.startLine,
        startCol: diagnostic.startCol,
        endLine: diagnostic.endLine,
        endCol: diagnostic.endCol,
      },
      message: diagnostic.message,
      provenance: 'repo-config' as const,
      gradeScope: true,
    }))
    .toSorted(byLocation)
}
