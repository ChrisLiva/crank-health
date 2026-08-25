import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execTool, repoCommand, uvxCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Category,
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
  batchFiles,
  byLocation,
  errorMessage,
  failed,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { detectPythonTool } from './py-project.ts'

/**
 * ruff — crank-health's default Python linter *and* formatter (spec "Categories
 * and tools"). One file, two runners: the same binary and the same detection,
 * because a repo that owns ruff owns both of its verdicts.
 *
 * Three run modes each, per spec §1: the repo's installed ruff with the repo's
 * config, our pinned ruff with the repo's config, or our pinned ruff with
 * {@link DEFAULT_CONFIG} materialized in the scratch dir.
 */

const RUFF_LINT_TOOL = 'ruff-lint'
const RUFF_FORMAT_TOOL = 'ruff-format'

/** PyPI distribution; ruff's command and distribution names coincide. */
const RUFF_DISTRIBUTION = 'ruff'

/** Root config artifacts that make ruff repo-owned (spec §1, first check). */
const RUFF_CONFIG_FILES: readonly string[] = ['ruff.toml', '.ruff.toml']

/** `pyproject.toml` sections that make ruff repo-owned. */
const RUFF_SECTIONS: readonly string[] = ['tool.ruff']

/** The one rule id every formatting failure reports under. */
export const RUFF_FORMAT_RULE = 'ruff/format'

/**
 * ruff's own code for a file it could not parse. It is not a lint rule — it
 * arrives from both `check` and `format` — and it is graded under every config,
 * because a file that will not parse is broken by anyone's standard.
 */
export const RUFF_SYNTAX_CODE = 'invalid-syntax'

/**
 * Our bundled default config, materialized into the scratch dir and passed with
 * `--config`, which makes ruff ignore the repo's own configuration entirely.
 *
 * This is deliberately *not* ruff's own default rule set: as of 0.16 that set
 * has grown to some three hundred rules across thirty-odd families, most of
 * them modernization and style opinions that a repo which never adopted ruff
 * has not agreed to. What is left is the historic default — pyflakes plus the
 * import/statement/runtime subsets of pycodestyle — and of those only the
 * correctness classes count toward the grade ({@link GRADED_DEFAULT_PREFIXES}).
 */
const DEFAULT_CONFIG = `# crank-health default ruff configuration.
# Written into a scratch dir; the target repo is never modified.
[lint]
select = ["E4", "E7", "E9", "F"]
`

/**
 * Rule prefixes that count toward the grade on our default config (spec §1's
 * "only correctness-class rules"):
 *
 * - `F` — pyflakes: undefined names, unused imports and variables, broken
 *   f-strings. Every one of them is a defect, not a preference.
 * - `E9` — runtime and IO errors (`E902` unreadable file, `E999` syntax).
 *
 * `E4` (imports) and `E7` (statement style) are reported and stay advisory.
 */
const GRADED_DEFAULT_PREFIXES: readonly string[] = ['F', 'E9']

/**
 * Rule families whose findings belong to the security category rather than to
 * lint (spec "Categories and tools": Python security is "+ bandit, ruff `S`").
 * `S` is ruff's port of bandit; routing by prefix is what keeps a repo that
 * selected those rules from having its security findings graded as lint noise.
 *
 * Note that the *category outcome* for security still comes from a security
 * runner (bandit, M6). Until one runs, these findings are reported and carried
 * into the grade the moment the category is assessed at all.
 */
const SECURITY_PREFIX = 'S'

/**
 * Adapter-owned severity mapping (spec §2). ruff's JSON carries a `severity`
 * field, but as of 0.16 it is `error` for every diagnostic, so the mapping is
 * driven by the rule family instead:
 *
 * - unparseable source and pyflakes' undefined-name family (`F82x`) break at
 *   runtime → `error`
 * - everything else, security rules included, → `warning`; `critical` stays
 *   reserved for leaked secrets in the absolute security shape (spec §3)
 */
const ERROR_PREFIXES: readonly string[] = ['E9', 'F82']

export const ruffLintRunner: ToolRunner = {
  tool: RUFF_LINT_TOOL,
  category: 'lint',
  pinnedVersion: pinnedPythonVersion(RUFF_DISTRIBUTION),
  detect: detectRuff,
  run: runRuffLint,
}

export const ruffFormatRunner: ToolRunner = {
  tool: RUFF_FORMAT_TOOL,
  category: 'format',
  pinnedVersion: pinnedPythonVersion(RUFF_DISTRIBUTION),
  detect: detectRuff,
  run: runRuffFormat,
}

/**
 * Repo-owned when `ruff.toml`/`.ruff.toml` exists, when `pyproject.toml` has a
 * `[tool.ruff]` section, or when ruff is a declared dependency.
 */
function detectRuff(ctx: DetectContext): Promise<Detection | null> {
  return detectPythonTool(ctx, {
    configFiles: RUFF_CONFIG_FILES,
    distribution: RUFF_DISTRIBUTION,
    sections: RUFF_SECTIONS,
  })
}

async function runRuffLint(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }
  const run = await invoke(ctx, RUFF_LINT_TOOL, ['check', ...LINT_ARGS])
  if (run.failure !== undefined) return run.failure

  let diagnostics: RuffDiagnostic[]
  try {
    diagnostics = run.batches.flatMap((stdout) => parseRuffJson(stdout))
  } catch (error) {
    return parseFailure(RUFF_LINT_TOOL, run.rawFiles, error)
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toLintFindings(diagnostics, ctx.detection !== null, ctx.repoRoot).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    toolVersion: pinnedPythonVersion(RUFF_DISTRIBUTION),
    rawFiles: run.rawFiles,
  }
}

async function runRuffFormat(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }
  const run = await invoke(ctx, RUFF_FORMAT_TOOL, ['format', ...FORMAT_ARGS])
  if (run.failure !== undefined) return run.failure

  let diagnostics: RuffDiagnostic[]
  try {
    diagnostics = run.batches.flatMap((stdout) => parseRuffJson(stdout))
  } catch (error) {
    return parseFailure(RUFF_FORMAT_TOOL, run.rawFiles, error)
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toFormatFindings(diagnostics, ctx.detection !== null, ctx.repoRoot).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    toolVersion: pinnedPythonVersion(RUFF_DISTRIBUTION),
    rawFiles: run.rawFiles,
    // The `format` denominator (spec §3: "% files failing"). Every path handed
    // to this runner is a Python source and ruff formats all of them.
    metrics: { formattableFiles: ctx.files.length },
  }
}

/**
 * Flags shared by every `ruff check` invocation.
 *
 * Zero footprint (spec §7): `--no-cache` is what stops ruff writing a
 * `.ruff_cache/` into the target repo, and `--fix`, which is the only flag that
 * would rewrite a source file, is never reachable from here. `--exit-zero`
 * keeps "ruff found something" from looking like "ruff failed", so a non-zero
 * exit means the process itself went wrong.
 */
const LINT_ARGS: readonly string[] = ['--output-format', 'json', '--no-cache', '--exit-zero']

/**
 * Flags shared by every `ruff format` invocation. `--check` is what makes the
 * run read-only — without it ruff rewrites files in place — and the JSON output
 * reports one `unformatted` diagnostic per failing file.
 */
const FORMAT_ARGS: readonly string[] = ['--check', '--no-cache', '--output-format', 'json']

/** One entry of ruff's JSON output, in the fields we report on. */
export interface RuffDiagnostic {
  /** Rule code (`F401`), or `invalid-syntax` for unparseable source. */
  readonly code: string
  readonly file: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
  readonly message: string
  /** ruff's documentation link for the rule, when it has one. */
  readonly url?: string
}

/**
 * Parses one `--output-format json` document — the same shape for `check` and
 * for `format --check`. Exported so a format shift fails a test instead of
 * silently reporting a clean repo (plan M5 checks).
 *
 * @throws {Error} when the payload is not ruff's array of diagnostics
 */
export function parseRuffJson(stdout: string): RuffDiagnostic[] {
  if (stdout.trim().length === 0) return []
  const document: unknown = JSON.parse(stdout)
  const entries = asArray(document)
  if (entries === undefined) throw new Error('ruff output is not an array of diagnostics')

  return entries.flatMap((entry) => {
    const diagnostic = asRecord(entry)
    const file = asString(diagnostic?.['filename'])
    const code = asString(diagnostic?.['code'])
    if (diagnostic === undefined || file === undefined || code === undefined) return []

    const start = asRecord(diagnostic['location'])
    const end = asRecord(diagnostic['end_location'])
    const startLine = asNumber(start?.['row']) ?? 1
    const startCol = asNumber(start?.['column']) ?? 1
    const url = asString(diagnostic['url'])
    return [
      {
        code,
        file,
        startLine,
        startCol,
        endLine: asNumber(end?.['row']) ?? startLine,
        endCol: asNumber(end?.['column']) ?? startCol,
        message: asString(diagnostic['message']) ?? '',
        ...(url === undefined ? {} : { url }),
      } satisfies RuffDiagnostic,
    ]
  })
}

/**
 * `ruff check` diagnostics → the core's vocabulary.
 *
 * On the repo's own config every finding is graded: they selected these rules
 * and are violating them. On ours only {@link GRADED_DEFAULT_PREFIXES} count.
 * `S` findings leave the lint category altogether — they are security results
 * that happen to have come out of a linter.
 */
export function toLintFindings(
  diagnostics: readonly RuffDiagnostic[],
  repoConfig: boolean,
  repoRoot: string,
): PendingFinding[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.code !== RUFF_FORMAT_RULE_CODE)
    .map((diagnostic) => ({
      category: categoryOf(diagnostic.code),
      tool: RUFF_LINT_TOOL,
      rule: diagnostic.code,
      severity: severityOf(diagnostic.code),
      file: repoRelative(diagnostic.file, repoRoot),
      range: {
        startLine: diagnostic.startLine,
        startCol: diagnostic.startCol,
        endLine: diagnostic.endLine,
        endCol: diagnostic.endCol,
      },
      message: diagnostic.message,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: repoConfig || isGradedByDefault(diagnostic.code),
      ...(diagnostic.url === undefined ? {} : { fixHint: `see ${diagnostic.url}` }),
    }))
    .toSorted(byLocation)
}

/**
 * `ruff format --check` diagnostics → the core's vocabulary: one finding per
 * failing file, because "unformatted" is a property of the file and not of the
 * line ruff happened to point at. The explicit empty anchor keeps identity at
 * `(category, tool, rule, file)`.
 *
 * **Why formatting is graded even on a default config**: a formatter has
 * exactly one verdict — the file either matches the canonical output or it does
 * not — so there is no style/correctness split to make. The `format` category
 * *is* that verdict; the provenance tag still shows the repo never chose ruff.
 *
 * Diagnostics that are not `unformatted` (ruff reports unparseable files here
 * too) are dropped: a file that will not parse is a lint finding, and
 * {@link toLintFindings} already reports it.
 */
export function toFormatFindings(
  diagnostics: readonly RuffDiagnostic[],
  repoConfig: boolean,
  repoRoot: string,
): PendingFinding[] {
  const failing = diagnostics
    .filter((diagnostic) => diagnostic.code === RUFF_FORMAT_RULE_CODE)
    .map((diagnostic) => repoRelative(diagnostic.file, repoRoot))

  return [...new Set(failing)]
    .map((file) => ({
      category: 'format' as const,
      tool: RUFF_FORMAT_TOOL,
      rule: RUFF_FORMAT_RULE,
      severity: 'warning' as const,
      file,
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      message: repoConfig
        ? 'File does not match the repo’s ruff format configuration'
        : 'File does not match ruff’s default formatting',
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: true,
      anchor: '',
      fixHint: 'uvx ruff format <file>',
    }))
    .toSorted(byLocation)
}

/** The code `ruff format --check` reports a file needing reformatting under. */
const RUFF_FORMAT_RULE_CODE = 'unformatted'

function categoryOf(code: string): Category {
  return isSecurityRule(code) ? 'security' : 'lint'
}

function severityOf(code: string): Severity {
  return code === RUFF_SYNTAX_CODE || ERROR_PREFIXES.some((prefix) => code.startsWith(prefix))
    ? 'error'
    : 'warning'
}

function isGradedByDefault(code: string): boolean {
  return (
    code === RUFF_SYNTAX_CODE || GRADED_DEFAULT_PREFIXES.some((prefix) => code.startsWith(prefix))
  )
}

/** `S101`-style codes only: the `S` family, never a rule that merely starts with S. */
function isSecurityRule(code: string): boolean {
  return new RegExp(`^${SECURITY_PREFIX}\\d`).test(code)
}

interface Invocation {
  /** One stdout per batch, in order. */
  readonly batches: string[]
  readonly rawFiles: string[]
  readonly failure?: ToolResult
}

/**
 * Runs one ruff subcommand over the file list, batched so that no command line
 * outruns the OS argument limit. Both subcommands analyze each file on its own,
 * so splitting the list changes nothing about the result.
 */
async function invoke(ctx: RunContext, tool: string, subcommand: string[]): Promise<Invocation> {
  const repoConfig = ctx.detection !== null
  const configArgs = repoConfig ? [] : ['--config', await materializeDefaultConfig(ctx.scratch)]
  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : uvxCommand(RUFF_DISTRIBUTION, [])

  const batches = batchFiles(ctx.files)
  const stdouts: string[] = []
  const rawFiles: string[] = []

  for (const [index, batch] of batches.entries()) {
    const suffix = batches.length === 1 ? '' : `.${index + 1}`
    // Sequential by design: the orchestrator provides the parallelism, and
    // batches share the raw-output namespace.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(
      { ...command, args: [...command.args, ...subcommand, ...configArgs, ...batch] },
      { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
    )

    // eslint-disable-next-line no-await-in-loop
    rawFiles.push(await writeScratchRaw(ctx.scratch, `${tool}${suffix}.json`, execution.stdout))
    if (execution.stderr.trim().length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const stderr = await writeScratchRaw(
        ctx.scratch,
        `${tool}${suffix}.stderr.txt`,
        execution.stderr,
      )
      rawFiles.push(stderr)
    }

    if (execution.failure !== undefined) {
      return {
        batches: stdouts,
        rawFiles,
        failure: failed(execution.failure, rawFiles),
      }
    }

    // `check` runs under `--exit-zero`; `format --check` exits 1 when a file
    // would be reformatted and 2 when a file could not be parsed — and in that
    // last case it still prints the diagnostics that explain why, so an empty
    // stdout is the only unrecoverable outcome.
    if (execution.exitCode !== 0 && execution.stdout.trim().length === 0) {
      return {
        batches: stdouts,
        rawFiles,
        failure: {
          state: 'error',
          findings: [],
          rawFiles,
          reason: `${tool} failed (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
        },
      }
    }
    stdouts.push(execution.stdout)
  }

  return { batches: stdouts, rawFiles }
}

function parseFailure(tool: string, rawFiles: string[], error: unknown): ToolResult {
  return failed(
    { state: 'error', reason: `could not parse ${tool} output: ${errorMessage(error)}` },
    rawFiles,
  )
}

/**
 * Writes {@link DEFAULT_CONFIG} into scratch and returns its path. Passing it
 * with `--config` makes ruff ignore every configuration file in the target
 * repo, which is the point: a repo that did not choose ruff must not steer a
 * ruff run it never opted into.
 */
async function materializeDefaultConfig(scratch: string): Promise<string> {
  const directory = join(scratch, 'ruff')
  await mkdir(directory, { recursive: true })
  const target = join(directory, 'ruff.toml')
  await writeFile(target, DEFAULT_CONFIG, 'utf8')
  return target
}
