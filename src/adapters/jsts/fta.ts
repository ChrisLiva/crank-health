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
import { detectNodeTool } from './node-package.ts'

/**
 * fta — the second complexity signal (spec "Categories and tools": "fallow
 * health / fta"), and an **advisory one only**.
 *
 * Spec §3 defines the complexity grade as "% of functions over cognitive 15".
 * fta does not measure that: it scores whole *files* on a blend of cyclomatic
 * complexity, Halstead effort and length. `fallow health` measures cognitive
 * complexity per function and supplies the graded ratio; fta contributes a
 * maintainability signal at a different granularity, so every fta finding
 * carries `gradeScope: false` and this runner reports no metrics. Mapping
 * file-level scores onto a function-level ratio would have produced a number
 * that looks like the spec's and does not mean it.
 */

export const FTA_TOOL = 'fta'

/** npm package name; the command it ships is `fta`. */
const FTA_PACKAGE = 'fta-cli'

export const FTA_CONFIG_FILES: readonly string[] = ['fta.json']

/**
 * FTA score at which a file is worth a reader's attention. fta's own bands are
 * "OK" below 50, "could be better" from 50, and "needs improvement" from 60; we
 * report from the last of those, so the advisory list stays short enough to be
 * read.
 */
export const FTA_ADVISORY_SCORE = 60

/** Above this the file is flagged as `warning` rather than `info`. */
const FTA_WARNING_SCORE = 70

export const ftaRunner: ToolRunner = {
  tool: FTA_TOOL,
  category: 'complexity',
  pinnedVersion: pinnedVersion(FTA_PACKAGE),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      configFiles: FTA_CONFIG_FILES,
      packageName: FTA_PACKAGE,
      binName: FTA_TOOL,
    }),
  run: runFta,
}

async function runFta(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no JavaScript or TypeScript files' }
  }

  const detection = ctx.detection
  // fta takes a project directory, not a file list, and walks it itself; the
  // results are filtered to discovered paths below so nothing gitignored or
  // vendored can reach a report.
  const args = ['.', '--json']
  const command =
    detection?.installed === true && detection.binPath !== undefined
      ? repoCommand(detection.binPath, args)
      : ephemeralCommand(FTA_PACKAGE, args, FTA_TOOL)

  const execution = await execTool(command, { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs })

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'fta.json', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'fta.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }
  if (execution.stdout.trim().length === 0) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `fta produced no output (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
    }
  }

  let scores: FtaFileScore[]
  try {
    scores = parseFtaJson(execution.stdout)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse fta output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(scores, detection !== null).filter((finding) => analyzed.has(finding.file)),
    ),
    ...(detection?.version === undefined
      ? { toolVersion: pinnedVersion(FTA_PACKAGE) }
      : { toolVersion: detection.version }),
    rawFiles,
  }
}

/** One entry from `fta --json`. */
export interface FtaFileScore {
  readonly file: string
  readonly score: number
  readonly cyclomatic: number
  readonly lineCount: number
  /** fta's own verdict: `OK`, `Could be better`, `Needs improvement`. */
  readonly assessment: string
}

/**
 * Parses `fta --json` output. Exported so a format shift fails a test instead
 * of corrupting a report (plan M4 checks).
 *
 * @throws {Error} when the payload is not fta's array of per-file scores
 */
export function parseFtaJson(stdout: string): FtaFileScore[] {
  const entries = asArray(JSON.parse(stdout))
  if (entries === undefined) throw new Error('fta output is not an array of file scores')

  return entries.flatMap((entry) => {
    const record = asRecord(entry)
    const file = asString(record?.['file_name'])
    const score = asNumber(record?.['fta_score'])
    if (record === undefined || file === undefined || score === undefined) return []
    return [
      {
        file: repoRelative(file),
        score,
        cyclomatic: asNumber(record['cyclo']) ?? 0,
        lineCount: asNumber(record['line_count']) ?? 0,
        assessment: asString(record['assessment']) ?? '',
      } satisfies FtaFileScore,
    ]
  })
}

/**
 * File scores → the core's vocabulary. Advisory by construction (see the file
 * comment): `gradeScope` is always `false`, and only files at or above
 * {@link FTA_ADVISORY_SCORE} are reported at all.
 *
 * The explicit empty anchor keeps identity file-level — an fta finding is about
 * the whole file, and must not move when its first line changes.
 */
export function toPendingFindings(
  scores: readonly FtaFileScore[],
  repoConfig: boolean,
): PendingFinding[] {
  return scores
    .filter((score) => score.score >= FTA_ADVISORY_SCORE)
    .map((score) => ({
      category: 'complexity' as const,
      tool: FTA_TOOL,
      rule: 'fta/file-score',
      severity: score.score >= FTA_WARNING_SCORE ? ('warning' as const) : ('info' as const),
      file: score.file,
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      message:
        `File has an FTA maintainability score of ${score.score.toFixed(1)} ` +
        `(${score.assessment.toLowerCase()}), across ${score.lineCount} lines`,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: false,
      anchor: '',
    }))
    .toSorted(byLocation)
}
