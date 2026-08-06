import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
import { batchFiles, byLocation, firstLine, identify, repoRelative } from '../support.ts'
import { detectNodeTool } from './node-package.ts'

/**
 * prettier — crank-health's default JS/TS formatter (spec "Categories and
 * tools"). Same three modes as oxlint: the repo's installed prettier with the
 * repo's config, our pinned prettier with the repo's config, or our pinned
 * prettier with prettier's own defaults.
 *
 * **Why every formatting finding is graded, even on a default config.** Spec §1
 * says only "correctness-class rules" count when we impose our own config, and
 * for a formatter that is the whole tool: there is no style/correctness split
 * to make, because a formatter has exactly one verdict — the file either
 * matches the canonical output or it does not. The `format` category *is* that
 * verdict, so a default-config run grades it too, and the report still tags the
 * provenance so a reader can see the repo never opted into prettier.
 */

export const PRETTIER_TOOL = 'prettier'

/** npm package name; prettier's command and package names coincide. */
const PRETTIER_PACKAGE = 'prettier'

/** The one rule id every formatting failure reports under. */
export const PRETTIER_FORMAT_RULE = 'prettier/format'

export const PRETTIER_CONFIG_FILES: readonly string[] = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.mjs',
  '.prettierrc.cjs',
  '.prettierrc.ts',
  '.prettierrc.mts',
  '.prettierrc.cts',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  'prettier.config.ts',
  'prettier.config.mts',
  'prettier.config.cts',
]

/**
 * Flags shared by every invocation.
 *
 * `--list-different` prints one failing path per line and nothing else, which
 * is the only prettier output that is trivially parseable (`--check` adds
 * decorated log lines, and the two flags are mutually exclusive). Zero footprint
 * (spec §7): `--list-different` never writes a byte — `--write` is the flag that
 * would, and it is never passed — and prettier keeps a cache only under
 * `--cache`. `--ignore-unknown` keeps a path prettier has no parser for from
 * failing the whole run.
 */
const BASE_ARGS: readonly string[] = ['--list-different', '--ignore-unknown']

/**
 * Extra flags for a repo that did not choose prettier: neither its config files
 * nor its `.editorconfig` may steer a run it never opted into, so the run is
 * prettier's documented defaults exactly.
 */
const DEFAULT_CONFIG_ARGS: readonly string[] = ['--no-config', '--no-editorconfig']

export const prettierRunner: ToolRunner = {
  tool: PRETTIER_TOOL,
  category: 'format',
  pinnedVersion: pinnedVersion(PRETTIER_PACKAGE),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      configFiles: PRETTIER_CONFIG_FILES,
      packageName: PRETTIER_PACKAGE,
      binName: PRETTIER_TOOL,
      // A `"prettier"` block in package.json is a config artifact in its own right.
      manifestKeys: ['prettier'],
    }),
  run: runPrettier,
}

async function runPrettier(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no JavaScript or TypeScript files' }
  }

  const detection = ctx.detection
  const repoConfig = detection !== null
  const command =
    detection?.installed === true && detection.binPath !== undefined
      ? repoCommand(detection.binPath, [])
      : ephemeralCommand(PRETTIER_PACKAGE, [])

  const batches = batchFiles(ctx.files)
  const failing: string[] = []
  const rawFiles: string[] = []

  for (const [index, batch] of batches.entries()) {
    const suffix = batches.length === 1 ? '' : `.${index + 1}`
    // Sequential by design: the orchestrator provides the parallelism.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(
      {
        ...command,
        args: [...command.args, ...BASE_ARGS, ...(repoConfig ? [] : DEFAULT_CONFIG_ARGS), ...batch],
      },
      { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
    )

    // eslint-disable-next-line no-await-in-loop
    const staged = await writeScratchRaw(ctx.scratch, `prettier${suffix}.txt`, execution.stdout)
    rawFiles.push(staged)
    if (execution.stderr.trim().length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const stderr = await writeScratchRaw(
        ctx.scratch,
        `prettier${suffix}.stderr.txt`,
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

    // 0 = everything matched, 1 = some files differ, 2 = prettier itself failed.
    if (execution.exitCode !== 0 && execution.exitCode !== 1) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `prettier failed (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
      }
    }

    failing.push(...parseListDifferent(execution.stdout))
  }

  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, toPendingFindings(failing, repoConfig)),
    ...(detection?.version === undefined
      ? { toolVersion: pinnedVersion(PRETTIER_PACKAGE) }
      : { toolVersion: detection.version }),
    rawFiles,
    // The `format` denominator (spec §3: "% files failing"). Every path handed
    // to this runner is a JS/TS source, and prettier parses all of them — so
    // the files it was asked about are exactly the formattable ones.
    metrics: { formattableFiles: ctx.files.length },
  }
}

/**
 * Parses `--list-different` output: one repo-relative path per line, blank
 * lines ignored. Exported so an output-format shift fails a test instead of
 * silently reporting a perfectly formatted repo.
 */
export function parseListDifferent(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => repoRelative(line))
}

/**
 * Failing paths → the core's vocabulary: one finding per file, because
 * "unformatted" is a property of the file and not of a line. The explicit empty
 * anchor keeps identity at `(category, tool, rule, file)` — a formatting finding
 * must not get a new id every time the file's first line changes.
 */
export function toPendingFindings(
  failing: readonly string[],
  repoConfig: boolean,
): PendingFinding[] {
  return [...new Set(failing)]
    .map((file) => ({
      category: 'format' as const,
      tool: PRETTIER_TOOL,
      rule: PRETTIER_FORMAT_RULE,
      severity: 'warning' as const,
      file,
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      message: repoConfig
        ? 'File does not match the repo’s prettier configuration'
        : 'File does not match prettier’s default formatting',
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: true,
      anchor: '',
      fixHint: 'npx prettier --write <file>',
    }))
    .toSorted(byLocation)
}
