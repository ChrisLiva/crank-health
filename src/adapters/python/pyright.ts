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
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { defaultTypeChecker, detectPythonTool, findVenv } from './py-project.ts'

/**
 * pyright — the type checker crank-health prefers once a project has a
 * virtualenv (spec "Categories and tools": "ty (beta) → pyright when venv
 * exists"). With an interpreter to point at, pyright resolves the project's
 * third-party imports and can say something about code that uses them; ty
 * stands down in that case, and takes over when there is no virtualenv. Both
 * sides of that choice come from
 * {@link import('./py-project.ts').defaultTypeChecker}.
 *
 * The PyPI distribution wraps the npm package and fetches its own Node runtime
 * into pyright's cache on first use, so `uvx` is enough — the target repo never
 * sees an install either way.
 */

export const PYRIGHT_TOOL = 'pyright'

/** PyPI distribution; pyright's command and distribution names coincide. */
const PYRIGHT_DISTRIBUTION = 'pyright'

/** Root config artifacts that make pyright repo-owned (spec §1, first check). */
export const PYRIGHT_CONFIG_FILES: readonly string[] = ['pyrightconfig.json']

/** `pyproject.toml` sections that make pyright repo-owned. */
const PYRIGHT_SECTIONS: readonly string[] = ['tool.pyright']

/**
 * Flags shared by every invocation. `--outputjson` is the whole contract:
 * pyright's text output has no stable machine form. Zero footprint (spec §7):
 * pyright writes nothing outside its own cache, and its only writing mode
 * (`--outputjson` aside, the language server's code actions) is not a CLI flag.
 */
const BASE_ARGS: readonly string[] = ['--outputjson']

/** pyright severities → the core's vocabulary (spec §2). */
const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  error: 'error',
  warning: 'warning',
  information: 'info',
}

/** The rule id for a diagnostic pyright reports without one (syntax errors). */
export const PYRIGHT_GENERAL_RULE = 'pyright/diagnostic'

/**
 * Diagnostics about the *environment* rather than the code: a package that is
 * not installed in the virtualenv, or one that ships no type information. On
 * the repo's own pyright config these are graded — they configured that
 * environment; on ours they stay advisory, because we chose to point pyright at
 * an interpreter the repo never asked us to check against.
 */
export const DEFAULT_ADVISORY_RULES: ReadonlySet<string> = new Set([
  'reportMissingImports',
  'reportMissingModuleSource',
  'reportMissingTypeStubs',
  'reportAttributeAccessIssue',
])

export const pyrightRunner: ToolRunner = {
  tool: PYRIGHT_TOOL,
  category: 'types',
  pinnedVersion: pinnedPythonVersion(PYRIGHT_DISTRIBUTION),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: PYRIGHT_CONFIG_FILES,
      distribution: PYRIGHT_DISTRIBUTION,
      sections: PYRIGHT_SECTIONS,
    }),
  run: runPyright,
}

/**
 * The mirror image of ty's standdown (see `ty.ts` for why this decision lives
 * in the result rather than in `detect`): as a default, pyright runs only when
 * a virtualenv gives it an interpreter to resolve imports against. A repo that
 * owns pyright gets it either way — that is their configuration, and the
 * orchestrator has already stood ty's default down.
 */
async function runPyright(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }

  const repoConfig = ctx.detection !== null
  const venv = await findVenv(ctx.repoRoot, ctx.project.path)
  if (!repoConfig && defaultTypeChecker(venv) !== PYRIGHT_TOOL) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'standing down: this project has no virtualenv, so ty type-checks it',
    }
  }

  // Without an interpreter pyright resolves no third-party import and reports
  // the whole dependency tree as missing; with one it reports the code.
  const interpreterArgs = venv === undefined ? [] : ['--pythonpath', venv.interpreter]
  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : uvxCommand(PYRIGHT_DISTRIBUTION, [])

  const execution = await execTool(
    { ...command, args: [...command.args, ...BASE_ARGS, ...interpreterArgs, ...ctx.files] },
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'pyright.json', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'pyright.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }

  let report: PyrightReport
  try {
    report = parsePyrightJson(execution.stdout)
  } catch (error) {
    // pyright exits 1 when it found diagnostics and 2+ when it could not run;
    // either way, output we cannot read is an error, never "zero type errors".
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `could not parse pyright output (exit ${execution.exitCode ?? 'signal'}): ` +
        `${error instanceof Error ? error.message : String(error)}${suffix(execution.stderr)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(report.diagnostics, repoConfig, ctx.repoRoot).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(report.version === undefined ? {} : { toolVersion: report.version }),
    rawFiles,
  }
}

function suffix(stderr: string): string {
  const line = firstLine(stderr)
  return line.length === 0 ? '' : `: ${line}`
}

/** The parts of `pyright --outputjson` we report on. */
export interface PyrightReport {
  readonly version: string | undefined
  readonly diagnostics: readonly PyrightDiagnostic[]
}

export interface PyrightDiagnostic {
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
 * Parses one `--outputjson` document. pyright's ranges are 0-based in both
 * axes; every other tool in crank-health — and the `Finding` schema — counts
 * from 1, so they are converted here rather than in the renderers.
 *
 * Exported so an output-format shift fails a test (plan M5 checks).
 *
 * @throws {Error} when the payload is not a pyright report
 */
export function parsePyrightJson(stdout: string): PyrightReport {
  const document = asRecord(JSON.parse(stdout))
  const entries = asArray(document?.['generalDiagnostics'])
  if (document === undefined || entries === undefined) {
    throw new Error('not a pyright report: no generalDiagnostics')
  }

  const diagnostics = entries.flatMap((entry) => {
    const diagnostic = asRecord(entry)
    const file = asString(diagnostic?.['file'])
    if (diagnostic === undefined || file === undefined) return []

    const range = asRecord(diagnostic['range'])
    const start = asRecord(range?.['start'])
    const end = asRecord(range?.['end'])
    const startLine = (asNumber(start?.['line']) ?? 0) + 1
    const startCol = (asNumber(start?.['character']) ?? 0) + 1
    return [
      {
        rule: asString(diagnostic['rule']) ?? PYRIGHT_GENERAL_RULE,
        severity: asString(diagnostic['severity']) ?? 'error',
        file,
        startLine,
        startCol,
        endLine: (asNumber(end?.['line']) ?? asNumber(start?.['line']) ?? 0) + 1,
        endCol: (asNumber(end?.['character']) ?? asNumber(start?.['character']) ?? 0) + 1,
        message: asString(diagnostic['message']) ?? '',
      } satisfies PyrightDiagnostic,
    ]
  })

  return { version: asString(document['version']), diagnostics }
}

/**
 * pyright diagnostics → the core's vocabulary. On the repo's own pyright config
 * everything is graded; on ours the environment-only rules stay advisory (see
 * {@link DEFAULT_ADVISORY_RULES}).
 */
export function toPendingFindings(
  diagnostics: readonly PyrightDiagnostic[],
  repoConfig: boolean,
  repoRoot: string,
): PendingFinding[] {
  return diagnostics
    .map((diagnostic) => ({
      category: 'types' as const,
      tool: PYRIGHT_TOOL,
      rule: diagnostic.rule,
      severity: SEVERITY_BY_LEVEL[diagnostic.severity] ?? 'error',
      file: repoRelative(diagnostic.file, repoRoot),
      range: {
        startLine: diagnostic.startLine,
        startCol: diagnostic.startCol,
        endLine: diagnostic.endLine,
        endCol: diagnostic.endCol,
      },
      // pyright folds multi-part explanations into one message with newlines;
      // the schema's `message` is a single line, so the rest is in the raw file.
      message: diagnostic.message.split('\n')[0] ?? '',
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: repoConfig || !DEFAULT_ADVISORY_RULES.has(diagnostic.rule),
    }))
    .toSorted(byLocation)
}
