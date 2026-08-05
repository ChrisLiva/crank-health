import { execTool, repoCommand, uvxCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  RepoContext,
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
 * ty — Astral's type checker, and crank-health's default for a Python project
 * with no virtualenv (spec "Categories and tools": "ty (beta) → pyright when
 * venv exists"). The standdown between the two lives in {@link runTy} and
 * {@link import('./pyright.ts')}, and both ask
 * {@link import('./py-project.ts').defaultTypeChecker} so the two halves of the
 * decision can never drift apart.
 *
 * ty is pre-1.0. That is exactly why its version is pinned in the manifest and
 * its parser is tested against captured bytes: a diagnostic-format change fails
 * a test instead of quietly reporting a clean repo.
 */

export const TY_TOOL = 'ty'

/** PyPI distribution; ty's command and distribution names coincide. */
const TY_DISTRIBUTION = 'ty'

/** Root config artifacts that make ty repo-owned (spec §1, first check). */
export const TY_CONFIG_FILES: readonly string[] = ['ty.toml', '.ty.toml']

/** `pyproject.toml` sections that make ty repo-owned. */
const TY_SECTIONS: readonly string[] = ['tool.ty']

/**
 * Flags shared by every invocation.
 *
 * `gitlab` is the one machine format ty emits that carries the rule name, the
 * severity and an exact range (`concise` is text, `github` is annotations,
 * `junit` is XML). Zero footprint (spec §7): ty keeps no cache in the project,
 * and `--fix`, its only writing mode, is never reachable from here.
 * `--exit-zero` keeps "found type errors" from reading as "the tool broke".
 */
const BASE_ARGS: readonly string[] = [
  'check',
  '--output-format',
  'gitlab',
  '--exit-zero',
  '--no-progress',
  '--color',
  'never',
]

/**
 * GitLab Code Quality severities → the core's vocabulary (spec §2). ty maps its
 * `error` diagnostics to `major` and its `warning` diagnostics to `minor`;
 * `critical` stays reserved for leaked secrets in the security shape.
 */
const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  blocker: 'error',
  critical: 'error',
  major: 'error',
  minor: 'warning',
  info: 'info',
  unknown: 'info',
}

/**
 * Rules that describe the *environment* rather than the code. Without a
 * virtualenv there is nothing for ty to resolve third-party imports against, so
 * on our default config "cannot resolve import `requests`" says nothing about
 * the health of the code and stays advisory. On the repo's own ty config it is
 * graded like anything else: they configured the environment they are failing.
 */
export const DEFAULT_ADVISORY_RULES: ReadonlySet<string> = new Set([
  'unresolved-import',
  'missing-typeshed-stub',
])

export const tyRunner: ToolRunner = {
  tool: TY_TOOL,
  category: 'types',
  pinnedVersion: pinnedPythonVersion(TY_DISTRIBUTION),
  detect: (repo: RepoContext): Promise<Detection | null> =>
    detectPythonTool(repo, {
      configFiles: TY_CONFIG_FILES,
      distribution: TY_DISTRIBUTION,
      sections: TY_SECTIONS,
    }),
  run: runTy,
}

/**
 * **Why the standdown is here and not in `detect`.** `detect` answers exactly
 * one question — does the repo own this tool — and its two answers already mean
 * something ("run their config" / "run ours"). "Do not run at all, because the
 * sibling tool is the better default here" is a third answer, and the honest
 * place to give it is the result: the report then shows ty as `not-available`
 * with the reason, instead of hiding a decision the reader cannot see.
 *
 * When the repo owns ty, the orchestrator has already dropped pyright's default
 * run (a category the repo owns does not also get our default imposed on it),
 * so this branch is not reached and ty runs whatever the venv situation is.
 */
async function runTy(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }

  const repoConfig = ctx.detection !== null
  if (!repoConfig) {
    const venv = await findVenv(ctx.repoRoot)
    if (defaultTypeChecker(venv) !== TY_TOOL) {
      return {
        state: 'not-available',
        findings: [],
        rawFiles: [],
        reason: `standing down: this project has a virtualenv (${venv?.directory ?? ''}), so pyright type-checks it`,
      }
    }
  }

  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : uvxCommand(TY_DISTRIBUTION, [])

  const execution = await execTool(
    { ...command, args: [...command.args, ...BASE_ARGS, ...ctx.files] },
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'ty.gitlab.json', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'ty.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }
  if (execution.exitCode !== 0) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `ty failed (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
    }
  }

  let diagnostics: TyDiagnostic[]
  try {
    diagnostics = parseGitlab(execution.stdout)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse ty output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(diagnostics, repoConfig, ctx.repoRoot).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    toolVersion: pinnedPythonVersion(TY_DISTRIBUTION),
    rawFiles,
  }
}

/** One ty diagnostic, in the fields we report on. */
export interface TyDiagnostic {
  /** ty's rule name, e.g. `unresolved-reference`. */
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
 * Parses ty's GitLab Code Quality report. Exported so an output-format shift
 * fails a test instead of reporting a clean repo (plan M5 checks).
 *
 * @throws {Error} when the payload is not an array of code-quality entries
 */
export function parseGitlab(stdout: string): TyDiagnostic[] {
  if (stdout.trim().length === 0) return []
  const entries = asArray(JSON.parse(stdout))
  if (entries === undefined) throw new Error('ty output is not an array of diagnostics')

  return entries.flatMap((entry) => {
    const record = asRecord(entry)
    const location = asRecord(record?.['location'])
    const file = asString(location?.['path'])
    const rule = asString(record?.['check_name'])
    if (record === undefined || file === undefined || rule === undefined) return []

    const positions = asRecord(location?.['positions'])
    const begin = asRecord(positions?.['begin'])
    const end = asRecord(positions?.['end'])
    const startLine = asNumber(begin?.['line']) ?? 1
    const startCol = asNumber(begin?.['column']) ?? 1
    // The description repeats the rule name; the message is what follows it.
    const description = asString(record['description']) ?? ''
    return [
      {
        rule,
        severity: asString(record['severity']) ?? 'unknown',
        file,
        startLine,
        startCol,
        endLine: asNumber(end?.['line']) ?? startLine,
        endCol: asNumber(end?.['column']) ?? startCol,
        message: description.startsWith(`${rule}: `)
          ? description.slice(rule.length + 2)
          : description,
      } satisfies TyDiagnostic,
    ]
  })
}

/**
 * ty diagnostics → the core's vocabulary. On the repo's own ty config every
 * diagnostic is graded; on ours the environment-only rules stay advisory (see
 * {@link DEFAULT_ADVISORY_RULES}).
 */
export function toPendingFindings(
  diagnostics: readonly TyDiagnostic[],
  repoConfig: boolean,
  repoRoot: string,
): PendingFinding[] {
  return diagnostics
    .map((diagnostic) => ({
      category: 'types' as const,
      tool: TY_TOOL,
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
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: repoConfig || !DEFAULT_ADVISORY_RULES.has(diagnostic.rule),
    }))
    .toSorted(byLocation)
}
