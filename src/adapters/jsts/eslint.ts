import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  batchFiles,
  byLocation,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { detectNodeTool } from './node-package.ts'

/**
 * ESLint — first-class when the repo owns it (spec "Categories and tools").
 *
 * `repoOwnedOnly`: oxlint is crank-health's default linter, so there is no
 * default-config ESLint run. A repo that never chose ESLint is not measured
 * against it, and this runner is skipped entirely rather than reporting an
 * empty result — which is why every ESLint finding is `repo-config` and every
 * one of them is graded: the repo is violating the standard it wrote itself.
 */

export const ESLINT_TOOL = 'eslint'

/** npm package name; ESLint's command and package names coincide. */
const ESLINT_PACKAGE = 'eslint'

/** Flat config (ESLint 9+) first, then the legacy eslintrc family (spec §1). */
export const ESLINT_CONFIG_FILES: readonly string[] = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc',
]

/** The eslintrc-era config names, which the pinned ESLint can no longer read. */
const LEGACY_CONFIG_FILES: ReadonlySet<string> = new Set(
  ESLINT_CONFIG_FILES.filter((file) => file.startsWith('.eslintrc')),
)

/**
 * Flags shared by every invocation.
 *
 * Zero footprint (spec §7) is a matter of what is *not* here: ESLint writes a
 * cache file only when `--cache` is passed and rewrites sources only under
 * `--fix`, so neither flag may ever appear. `--no-warn-ignored` suppresses the
 * "file ignored because no matching configuration was supplied" warning that a
 * config scoped to, say, `**' + '/*.js` would otherwise emit for every `.ts`
 * path in the explicit file list we hand it.
 */
const BASE_ARGS: readonly string[] = ['--format', 'json', '--no-color', '--no-warn-ignored']

/** ESLint's two numeric severities (spec §2: adapter-owned mapping tables). */
const SEVERITY_BY_LEVEL: Readonly<Record<number, Severity>> = { 2: 'error', 1: 'warning' }

/** Rule name for a parse/config failure, which ESLint reports with a null id. */
const FATAL_RULE = 'eslint(fatal)'

export const eslintRunner: ToolRunner = {
  tool: ESLINT_TOOL,
  category: 'lint',
  pinnedVersion: pinnedVersion(ESLINT_PACKAGE),
  repoOwnedOnly: true,
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      configFiles: ESLINT_CONFIG_FILES,
      packageName: ESLINT_PACKAGE,
      binName: ESLINT_TOOL,
    }),
  run: runEslint,
}

async function runEslint(ctx: RunContext): Promise<ToolResult> {
  const detection = ctx.detection
  if (detection === null || ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no files for ESLint to check' }
  }

  const installed = detection.installed && detection.binPath !== undefined
  if (!installed && onlyLegacyConfig(detection)) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason:
        `this repo configures ESLint through ${detection.configFiles.join(', ')}, which ` +
        `ESLint ${pinnedVersion(ESLINT_PACKAGE)} no longer reads — run \`npm install\` so ` +
        'crank-health can use the repo’s own ESLint, or migrate to a flat `eslint.config.*`',
    }
  }

  const command =
    installed && detection.binPath !== undefined
      ? repoCommand(detection.binPath, [])
      : ephemeralCommand(ESLINT_PACKAGE, [])

  const batches = batchFiles(ctx.files)
  const pending: PendingFinding[] = []
  const rawFiles: string[] = []

  for (const [index, batch] of batches.entries()) {
    const suffix = batches.length === 1 ? '' : `.${index + 1}`
    // Sequential by design: the orchestrator provides the parallelism, and
    // batches share the raw-output namespace.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(
      { ...command, args: [...command.args, ...BASE_ARGS, ...batch] },
      { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
    )

    // eslint-disable-next-line no-await-in-loop
    const staged = await writeScratchRaw(ctx.scratch, `eslint${suffix}.json`, execution.stdout)
    rawFiles.push(staged)
    if (execution.stderr.trim().length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const stderr = await writeScratchRaw(
        ctx.scratch,
        `eslint${suffix}.stderr.txt`,
        execution.stderr,
      )
      rawFiles.push(stderr)
    }

    if (execution.failure !== undefined) {
      return {
        state: execution.failure.state,
        findings: [],
        rawFiles,
        reason: execution.failure.reason,
      }
    }

    // ESLint exits 1 when it found problems and 2 when it could not run at all;
    // in the second case there is no JSON to read, only a message on stderr.
    if (execution.stdout.trim().length === 0) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `eslint produced no output (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
      }
    }

    let results: EslintFileResult[]
    try {
      results = parseEslintJson(execution.stdout)
    } catch (error) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `could not parse eslint output: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    pending.push(...toPendingFindings(results, ctx.repoRoot))
  }

  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending.toSorted(byLocation)),
    ...(detection.version === undefined
      ? { toolVersion: pinnedVersion(ESLINT_PACKAGE) }
      : { toolVersion: detection.version }),
    rawFiles,
  }
}

/** One file's worth of ESLint's JSON formatter output. */
export interface EslintFileResult {
  /** Absolute path, exactly as ESLint reports it. */
  readonly filePath: string
  readonly messages: readonly EslintMessage[]
}

export interface EslintMessage {
  /** `null` for parse and configuration failures. */
  readonly ruleId: string | null
  readonly severity: number
  readonly message: string
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * Parses ESLint's `--format json` output. Exported so a format shift fails a
 * test instead of corrupting a report (plan M4 checks).
 *
 * @throws {Error} when the payload is not the array of file results ESLint documents
 */
export function parseEslintJson(stdout: string): EslintFileResult[] {
  const document: unknown = JSON.parse(stdout)
  const files = asArray(document)
  if (files === undefined) throw new Error('eslint JSON output is not an array of file results')

  return files.flatMap((entry) => {
    const result = asRecord(entry)
    const filePath = asString(result?.['filePath'])
    if (result === undefined || filePath === undefined) return []

    const messages = (asArray(result['messages']) ?? []).flatMap((raw) => {
      const message = asRecord(raw)
      if (message === undefined) return []
      const line = asNumber(message['line']) ?? 1
      const column = asNumber(message['column']) ?? 1
      return [
        {
          ruleId: asString(message['ruleId']) ?? null,
          severity: asNumber(message['severity']) ?? 1,
          message: asString(message['message']) ?? '',
          line,
          column,
          endLine: asNumber(message['endLine']) ?? line,
          endColumn: asNumber(message['endColumn']) ?? column,
        } satisfies EslintMessage,
      ]
    })

    return [{ filePath, messages } satisfies EslintFileResult]
  })
}

/**
 * ESLint results → the core's vocabulary. Every finding is `repo-config` and
 * graded: this runner only ever executes against a config the repo wrote.
 */
export function toPendingFindings(
  results: readonly EslintFileResult[],
  repoRoot: string,
): PendingFinding[] {
  return results
    .flatMap((result) =>
      result.messages.map((message) => ({
        category: 'lint' as const,
        tool: ESLINT_TOOL,
        rule: message.ruleId ?? FATAL_RULE,
        severity: SEVERITY_BY_LEVEL[message.severity] ?? 'warning',
        file: repoRelative(result.filePath, repoRoot),
        range: {
          startLine: message.line,
          startCol: message.column,
          endLine: message.endLine,
          endCol: message.endColumn,
        },
        message: message.message,
        provenance: 'repo-config' as const,
        gradeScope: true,
      })),
    )
    .toSorted(byLocation)
}

function onlyLegacyConfig(detection: Detection): boolean {
  return (
    detection.configFiles.length > 0 &&
    detection.configFiles.every((file) => LEGACY_CONFIG_FILES.has(file))
  )
}
