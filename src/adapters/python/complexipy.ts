import { mkdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { execTool, repoCommand, uvxCommand, writeScratchRaw } from '../../core/exec.ts'
import { COMPLEXITY_CEILING } from '../../core/grade.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
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
import { detectPythonTool } from './py-project.ts'

/**
 * complexipy — cognitive complexity per Python function, which is exactly the
 * ratio spec §3 grades on: "% of functions over cognitive 15".
 *
 * Two output formats from one run, because neither alone is enough: the JSON
 * report lists *every* function it measured with its score (the denominator)
 * but carries no line numbers, and the SARIF report carries the locations but
 * only for the functions over the ceiling. Both land in the run's `raw/`.
 *
 * Zero footprint (spec §7) takes two flags and one decision: `--output` sends
 * both reports into the scratch dir, the explicit file list keeps complexipy
 * from walking — and reporting on — anything discovery excluded, and the process
 * runs with its *working directory in scratch*, because complexipy writes a
 * `.complexipy_cache/` that cannot be disabled and it writes it next to wherever
 * it was started, not next to what it analyzed. Running it from scratch with
 * absolute paths is what the plan called copy-then-scan, minus the copy.
 *
 * The one thing that costs: a repo's own `[tool.complexipy]` settings live in a
 * `pyproject.toml` complexipy looks for in its working directory, so they do not
 * reach this run. Neither of the two settings that would matter survives anyway
 * — the ceiling is fixed below, and the file list is discovery's. The ceiling is
 * always crank-health's
 * {@link COMPLEXITY_CEILING}, even for a repo that configured its own: the
 * grade is defined against one fixed ceiling, so a repo cannot move the bar it
 * is graded against by moving its own.
 */

export const COMPLEXIPY_TOOL = 'complexipy'

/** PyPI distribution; complexipy's command and distribution names coincide. */
const COMPLEXIPY_DISTRIBUTION = 'complexipy'

/** Root config artifacts that make complexipy repo-owned. */
export const COMPLEXIPY_CONFIG_FILES: readonly string[] = ['complexipy.toml', '.complexipy.toml']

/** `pyproject.toml` sections that make complexipy repo-owned. */
const COMPLEXIPY_SECTIONS: readonly string[] = ['tool.complexipy']

/** The one rule id every complexity finding reports under. */
export const COMPLEXIPY_RULE = 'complexipy/cognitive-complexity'

/** complexipy exits 0 when everything is under the ceiling and 1 when not. */
const EXPECTED_EXIT_CODES: ReadonlySet<number> = new Set([0, 1])

/** Report file names complexipy derives from the output directory. */
const JSON_REPORT = 'complexipy-results.json'
const SARIF_REPORT = 'complexipy-results.sarif'

export const complexipyRunner: ToolRunner = {
  tool: COMPLEXIPY_TOOL,
  category: 'complexity',
  pinnedVersion: pinnedPythonVersion(COMPLEXIPY_DISTRIBUTION),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: COMPLEXIPY_CONFIG_FILES,
      distribution: COMPLEXIPY_DISTRIBUTION,
      sections: COMPLEXIPY_SECTIONS,
    }),
  run: runComplexipy,
}

async function runComplexipy(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }

  const workingDir = join(ctx.scratch, COMPLEXIPY_TOOL)
  const outputDir = join(workingDir, 'report')
  await mkdir(outputDir, { recursive: true })

  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : uvxCommand(COMPLEXIPY_DISTRIBUTION, [])

  const execution = await execTool(
    {
      ...command,
      args: [
        ...command.args,
        '--quiet',
        '--max-complexity-allowed',
        String(COMPLEXITY_CEILING),
        // A trailing separator is what tells complexipy this is a directory;
        // without it, two output formats is a usage error.
        '--output',
        `${outputDir}${sep}`,
        '--output-format',
        'json,sarif',
        // Absolute, because the working directory is not the repo.
        ...ctx.files.map((file) => join(ctx.repoRoot, file)),
      ],
    },
    { cwd: workingDir, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles: string[] = []
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'complexipy.stderr.txt', execution.stderr))
  }
  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }

  const measured = await readFileOrUndefined(join(outputDir, JSON_REPORT))
  const violations = await readFileOrUndefined(join(outputDir, SARIF_REPORT))
  if (measured !== undefined) {
    rawFiles.unshift(await writeScratchRaw(ctx.scratch, 'complexipy.json', measured))
  }
  if (violations !== undefined) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'complexipy.sarif.json', violations))
  }

  if (
    execution.exitCode === undefined ||
    !EXPECTED_EXIT_CODES.has(execution.exitCode) ||
    measured === undefined ||
    violations === undefined
  ) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `complexipy failed (exit ${execution.exitCode ?? 'signal'}): ${
        firstLine(execution.stderr) || firstLine(execution.stdout) || 'no report was written'
      }`,
    }
  }

  let functions: ComplexipyFunction[]
  let overCeiling: ComplexipyViolation[]
  try {
    functions = parseComplexipyJson(measured, ctx.repoRoot)
    overCeiling = parseComplexipySarif(violations, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse complexipy output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  const measuredHere = functions.filter((entry) => analyzed.has(entry.file))
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(overCeiling, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    toolVersion: pinnedPythonVersion(COMPLEXIPY_DISTRIBUTION),
    rawFiles,
    // Spec §3's complexity ratio, exactly: % of functions over cognitive 15.
    metrics: {
      functionsTotal: measuredHere.length,
      functionsOverCeiling: measuredHere.filter((entry) => entry.complexity > COMPLEXITY_CEILING)
        .length,
    },
  }
}

/** One function complexipy measured — the denominator's unit. */
export interface ComplexipyFunction {
  readonly file: string
  readonly name: string
  readonly complexity: number
}

/** One function over the ceiling, with the location only SARIF carries. */
export interface ComplexipyViolation {
  readonly file: string
  readonly name: string
  readonly startLine: number
  readonly endLine: number
  readonly message: string
}

/**
 * Parses complexipy's JSON report: every function it measured, with its
 * cognitive complexity. Exported so a format shift fails a test instead of
 * silently emptying the denominator (plan M5 checks).
 *
 * @throws {Error} when the payload is not complexipy's array of functions
 */
export function parseComplexipyJson(text: string, repoRoot = ''): ComplexipyFunction[] {
  const entries = asArray(JSON.parse(text))
  if (entries === undefined) throw new Error('complexipy JSON report is not an array')

  return entries.flatMap((entry) => {
    const record = asRecord(entry)
    const file = asString(record?.['path'])
    const complexity = asNumber(record?.['complexity'])
    if (record === undefined || file === undefined || complexity === undefined) return []
    return [
      {
        file: repoRelative(file, repoRoot),
        name: asString(record['function_name']) ?? '',
        complexity,
      } satisfies ComplexipyFunction,
    ]
  })
}

/**
 * Parses complexipy's SARIF report: the functions over the ceiling, with their
 * line ranges and names. Exported so a format shift fails a test (plan M5).
 *
 * @throws {Error} when the payload is not a SARIF document we recognize
 */
export function parseComplexipySarif(text: string, repoRoot = ''): ComplexipyViolation[] {
  const run = asRecord(asArray(asRecord(JSON.parse(text))?.['runs'])?.[0])
  if (run === undefined) throw new Error('no SARIF run in complexipy output')

  return (asArray(run['results']) ?? []).flatMap((entry) => {
    const result = asRecord(entry)
    const location = asRecord(asArray(result?.['locations'])?.[0])
    const physical = asRecord(location?.['physicalLocation'])
    const file = asString(asRecord(physical?.['artifactLocation'])?.['uri'])
    if (result === undefined || file === undefined) return []

    const region = asRecord(physical?.['region'])
    const startLine = asNumber(region?.['startLine']) ?? 1
    return [
      {
        file: repoRelative(file, repoRoot),
        name: asString(asRecord(asArray(location?.['logicalLocations'])?.[0])?.['name']) ?? '',
        startLine,
        endLine: asNumber(region?.['endLine']) ?? startLine,
        message: asString(asRecord(result['message'])?.['text']) ?? '',
      } satisfies ComplexipyViolation,
    ]
  })
}

/**
 * Over-ceiling functions → the core's vocabulary. The grade is a ratio over the
 * metrics rather than a count of findings, so `gradeScope` here is a label for
 * the reader: every one of these functions is over the ceiling and each of them
 * moves the percentage.
 *
 * The function name is the anchor, so a complex function keeps its identity
 * when the code above it moves (spec §2).
 */
export function toPendingFindings(
  violations: readonly ComplexipyViolation[],
  repoConfig: boolean,
): PendingFinding[] {
  return violations
    .map((violation) => ({
      category: 'complexity' as const,
      tool: COMPLEXIPY_TOOL,
      rule: COMPLEXIPY_RULE,
      severity: 'warning' as const,
      file: violation.file,
      range: {
        startLine: violation.startLine,
        startCol: 1,
        endLine: violation.endLine,
        endCol: 1,
      },
      message: violation.message,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: true,
      anchor: violation.name,
    }))
    .toSorted(byLocation)
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}
