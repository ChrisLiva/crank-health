import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
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
import { pinnedVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  batchFiles,
  byLocation,
  identify,
  repoRelative,
} from '../support.ts'
import { detectNodeTool } from './node-package.ts'

/**
 * Biome — first-class when the repo owns it, for both lint and format (spec
 * "Categories and tools"). One file, two runners: they share a detection rule,
 * a JSON reporter and a diagnostic parser, and differ only in the subcommand
 * and the category they report into.
 *
 * `repoOwnedOnly` on both: Biome is never crank-health's default (oxlint lints,
 * prettier formats), so a repo that did not choose Biome is never measured
 * against it. Every Biome finding is therefore `repo-config` and graded.
 */

const BIOME_LINT_TOOL = 'biome-lint'
const BIOME_FORMAT_TOOL = 'biome-format'

/** npm package name; the command it ships is `biome`. */
const BIOME_PACKAGE = '@biomejs/biome'
const BIOME_BIN = 'biome'

export const BIOME_CONFIG_FILES: readonly string[] = ['biome.json', 'biome.jsonc']

/** The one rule id every formatting failure reports under. */
const BIOME_FORMAT_RULE = 'biome/format'

/**
 * Flags shared by both subcommands.
 *
 * Zero footprint (spec §7) again comes from what is absent: neither `--write`
 * nor `--fix` nor `--suppress` may ever appear, since each rewrites the repo's
 * own sources. `--vcs-use-ignore-file=true` is required for Biome to honour
 * `.gitignore` at all (it does not by default), and `--max-diagnostics=none`
 * stops it truncating the diagnostics at 20.
 *
 * `--reporter-file` is deliberately *not* used: in Biome 2.5 it writes the
 * *default* human reporter to the path and leaves the JSON on stdout, whatever
 * `--reporter` says. {@link parseBiomeReport} reads stdout instead and is built
 * for what it finds there — see its comment.
 */
const BASE_ARGS: readonly string[] = [
  '--reporter=json',
  '--max-diagnostics=none',
  '--colors=off',
  '--no-errors-on-unmatched',
  '--vcs-enabled=true',
  '--vcs-client-kind=git',
  '--vcs-use-ignore-file=true',
]

/** Biome diagnostic severities → the core's vocabulary (spec §2). */
const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  fatal: 'error',
  error: 'error',
  warning: 'warning',
  information: 'info',
  hint: 'info',
}

export const biomeLintRunner: ToolRunner = {
  tool: BIOME_LINT_TOOL,
  category: 'lint',
  pinnedVersion: pinnedVersion(BIOME_PACKAGE),
  repoOwnedOnly: true,
  detect: detectBiome,
  run: (ctx: RunContext) => runBiome(ctx, 'lint'),
}

export const biomeFormatRunner: ToolRunner = {
  tool: BIOME_FORMAT_TOOL,
  category: 'format',
  pinnedVersion: pinnedVersion(BIOME_PACKAGE),
  repoOwnedOnly: true,
  detect: detectBiome,
  run: (ctx: RunContext) => runBiome(ctx, 'format'),
}

function detectBiome(ctx: DetectContext): Promise<Detection | null> {
  return detectNodeTool(ctx, {
    configFiles: BIOME_CONFIG_FILES,
    packageName: BIOME_PACKAGE,
    binName: BIOME_BIN,
  })
}

type Subcommand = 'lint' | 'format'

async function runBiome(ctx: RunContext, subcommand: Subcommand): Promise<ToolResult> {
  const detection = ctx.detection
  const tool = subcommand === 'lint' ? BIOME_LINT_TOOL : BIOME_FORMAT_TOOL
  if (detection === null || ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no files for Biome to check' }
  }

  const command =
    detection.installed && detection.binPath !== undefined
      ? repoCommand(detection.binPath, [subcommand])
      : ephemeralCommand(BIOME_PACKAGE, [subcommand], BIOME_BIN)

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
    const staged = await writeScratchRaw(ctx.scratch, `${tool}${suffix}.txt`, execution.stdout)
    rawFiles.push(staged)
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
        state: execution.failure.state,
        findings: [],
        rawFiles,
        reason: execution.failure.reason,
      }
    }

    let diagnostics: BiomeDiagnostic[]
    try {
      diagnostics = parseBiomeReport(execution.stdout)
    } catch (error) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `could not parse biome output: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    pending.push(...toPendingFindings(diagnostics, subcommand))
  }

  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending.toSorted(byLocation)),
    ...(detection.version === undefined
      ? { toolVersion: pinnedVersion(BIOME_PACKAGE) }
      : { toolVersion: detection.version }),
    rawFiles,
    // The format denominator: every file Biome was asked about (spec §3's
    // "% files failing"). Biome reports failures, never the clean total.
    ...(subcommand === 'format' ? { metrics: { formattableFiles: ctx.files.length } } : {}),
  }
}

/** One entry from Biome's `--reporter=json` `diagnostics` array. */
export interface BiomeDiagnostic {
  readonly severity: string
  /** `lint/correctness/noUnusedVariables`, `format`, `parse`, … */
  readonly category: string
  readonly message: string
  readonly file: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
}

/**
 * Parses Biome's JSON reporter output out of the surrounding stdout.
 *
 * Biome does not give the JSON a stream of its own: it prints an
 * "experimental reporter" banner before it and a decorated run summary after
 * it, and the report itself is one long line. So the report is located rather
 * than assumed — the first line that parses as an object carrying
 * `diagnostics`. Exported so a format shift fails a test instead of corrupting
 * a report, which matters more here than elsewhere because Biome still labels
 * this reporter experimental.
 *
 * @throws {Error} when no Biome report is present in the output
 */
export function parseBiomeReport(stdout: string): BiomeDiagnostic[] {
  const document = findReport(stdout)
  const diagnostics = asArray(document?.['diagnostics'])
  if (document === undefined || diagnostics === undefined) {
    throw new Error('no biome JSON report in output')
  }

  return diagnostics.flatMap((entry) => {
    const diagnostic = asRecord(entry)
    const location = asRecord(diagnostic?.['location'])
    const file = asString(location?.['path']) ?? asString(asRecord(location?.['path'])?.['file'])
    if (diagnostic === undefined || file === undefined) return []

    // Biome reports file-level diagnostics (a formatting failure covers the
    // whole file) at line 0; the schema is 1-based everywhere else.
    const start = asRecord(location?.['start'])
    const end = asRecord(location?.['end'])
    const startLine = Math.max(1, asNumber(start?.['line']) ?? 1)
    const startCol = Math.max(1, asNumber(start?.['column']) ?? 1)
    return [
      {
        severity: asString(diagnostic['severity']) ?? 'error',
        category: asString(diagnostic['category']) ?? 'unknown',
        message: asString(diagnostic['message']) ?? '',
        file: repoRelative(file),
        startLine,
        startCol,
        endLine: Math.max(startLine, asNumber(end?.['line']) ?? startLine),
        endCol: Math.max(1, asNumber(end?.['column']) ?? startCol),
      } satisfies BiomeDiagnostic,
    ]
  })
}

/**
 * Biome diagnostics → the core's vocabulary.
 *
 * Lint diagnostics keep Biome's own rule path as the rule id and are all
 * graded (the repo chose these rules). In `format` mode only `category:
 * "format"` diagnostics are formatting failures; anything else Biome emits
 * there — a parse error, say — is reported as advisory signal rather than
 * silently dropped, because it is real but it is not a formatting verdict.
 *
 * Formatting failures are file-level, so they carry an explicit empty anchor:
 * identity is `(category, tool, rule, file)` and must not move when the file's
 * first line changes.
 */
export function toPendingFindings(
  diagnostics: readonly BiomeDiagnostic[],
  subcommand: Subcommand,
): PendingFinding[] {
  const category: Category = subcommand === 'lint' ? 'lint' : 'format'
  const seen = new Set<string>()

  return diagnostics
    .flatMap((diagnostic) => {
      const isFormat = subcommand === 'format' && diagnostic.category === 'format'
      const rule = isFormat ? BIOME_FORMAT_RULE : diagnostic.category
      // One formatting verdict per file, however many hunks differ.
      const key = `${rule}\u0000${diagnostic.file}`
      if (isFormat && seen.has(key)) return []
      seen.add(key)

      return [
        {
          category,
          tool: subcommand === 'lint' ? BIOME_LINT_TOOL : BIOME_FORMAT_TOOL,
          rule,
          severity: isFormat
            ? ('warning' as const)
            : (SEVERITY_BY_LEVEL[diagnostic.severity] ?? 'warning'),
          file: diagnostic.file,
          range: {
            startLine: diagnostic.startLine,
            startCol: diagnostic.startCol,
            endLine: diagnostic.endLine,
            endCol: diagnostic.endCol,
          },
          message: diagnostic.message,
          provenance: 'repo-config' as const,
          gradeScope: subcommand === 'lint' || isFormat,
          ...(isFormat ? { anchor: '' } : {}),
        },
      ]
    })
    .toSorted(byLocation)
}

function findReport(stdout: string): Record<string, unknown> | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      const document = asRecord(JSON.parse(line))
      if (document?.['diagnostics'] !== undefined) return document
    } catch {
      // Not the report line; keep looking.
    }
  }
  return undefined
}
