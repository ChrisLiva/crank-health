import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ADAPTERS } from './adapters/index.ts'
import { countPhysicalLines, discoverFiles } from './core/discover.ts'
import { headCommit } from './core/git.ts'
import { failingFilePercent, gradeCategory } from './core/grade.ts'
import { runScan } from './core/orchestrator.ts'
import type { ScanResult } from './core/orchestrator.ts'
import { createOutputDir } from './core/output.ts'
import type { Category, CategoryState, Grade, LanguageAdapter, RepoContext } from './core/types.ts'
import { CATEGORIES, toCategoryState } from './core/types.ts'
import type { Report, ResolvedRun } from './render/json.ts'
import { buildReport, serializeReport } from './render/json.ts'

/**
 * The whole scan, from a path to a written `report.json`. `cli.ts` is a thin
 * shell over this, and the fixture tests drive it directly — so what the tests
 * prove is exactly what the CLI does.
 */

/** Spec §5: quick mode grades everything except test quality. */
export const QUICK_MODE_TEST_QUALITY_REASON = 'not assessed — run `--deep`'

export interface HealthScanOptions {
  /** Target repo; relative paths resolve against the cwd. */
  readonly path: string
  /** `--out`; defaults to `<path>/.codebase-health/`. */
  readonly out?: string | undefined
  /** `--only`; defaults to every category. */
  readonly only?: readonly Category[] | undefined
  readonly concurrency?: number | undefined
  readonly timeoutMs?: number | undefined
  /** Injectable for tests; production always uses {@link ADAPTERS}. */
  readonly adapters?: readonly LanguageAdapter[] | undefined
}

export interface HealthScanResult {
  readonly report: Report
  /** The exact bytes written to `report.json`. */
  readonly json: string
  /** Absolute path of the run directory. */
  readonly outputDir: string
  /** Absolute path of `report.json`. */
  readonly reportPath: string
}

/**
 * Runs a quick whole-repo scan and writes the run directory.
 *
 * @throws {Error} only for crank-health's own failures (bad path, not a git
 * repo, unwritable output dir). A tool that fails is a degraded category, never
 * an exception (spec §8).
 */
export async function runHealthScan(options: HealthScanOptions): Promise<HealthScanResult> {
  const startedAt = Date.now()
  const repoRoot = resolve(options.path)
  await assertDirectory(repoRoot)

  const commit = await headCommit(repoRoot)
  const scratch = await mkdtemp(join(tmpdir(), 'crank-health-'))

  try {
    const files = await discoverFiles(repoRoot)
    const repo: RepoContext = { repoRoot, files, scratch }
    const out = await createOutputDir(repoRoot, options.out)

    const scan = await runScan(repo, options.adapters ?? ADAPTERS, {
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.only === undefined ? {} : { only: options.only }),
    })

    const runs: ResolvedRun[] = []
    for (const record of scan.runs) {
      // Sequential: raw files must land in the run directory before the scratch
      // dir is destroyed, and there are only a handful of them.
      // eslint-disable-next-line no-await-in-loop
      runs.push({ record, raw: await out.adoptRaw(record.result.rawFiles) })
    }

    const selected = options.only === undefined ? CATEGORIES : options.only
    const report = buildReport({
      repoPath: repoRoot,
      commit,
      profile: 'quick',
      selected,
      categories: await gradeAll(repo, scan, selected),
      metrics: scan.metrics,
      runs,
      findings: scan.findings,
      warnings: scan.warnings,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    })

    const json = serializeReport(report)
    const reportPath = await out.write('report.json', json)
    return { report, json, outputDir: out.root, reportPath }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Turns each category's run outcome into its reported state.
 *
 * Denominators are the pipeline's job, not the runners': density grades are per
 * KLOC of analyzed source, and `format` is a share of analyzed source files.
 * Non-source files (manifests, docs) are in neither — grading lint noise
 * against a README's line count would be meaningless.
 */
async function gradeAll(
  repo: RepoContext,
  scan: ScanResult,
  selected: readonly Category[],
): Promise<Record<Category, CategoryState>> {
  const sourceFiles = [...repo.files.byLanguage['js-ts'], ...repo.files.byLanguage.python]
  const kloc = (await countPhysicalLines(repo.repoRoot, sourceFiles)) / 1000

  const states = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) {
    const state = toCategoryState(scan.categories[category], () =>
      gradeOne(category, scan, kloc, sourceFiles.length),
    )
    states[category] =
      category === 'test-quality' && state.status === 'not-assessed' && selected.includes(category)
        ? { status: 'not-assessed', reason: QUICK_MODE_TEST_QUALITY_REASON }
        : state
  }
  return states
}

/**
 * Applies the one formula shape that fits this category (spec §3).
 *
 * The ratio categories grade on a percentage no list of findings can carry, so
 * they read it from the {@link ToolMetrics} the orchestrator merged: complexity
 * from the function counts, duplication and test quality from the percentage
 * their tool computed. When no tool reported the measurement the category has
 * no grade — `undefined` here becomes `not-assessed`, never a flattering zero.
 */
function gradeOne(
  category: Category,
  scan: ScanResult,
  kloc: number,
  sourceFileCount: number,
): Grade | undefined {
  const findings = scan.findings.filter((finding) => finding.category === category)
  const metrics = scan.metrics[category]
  switch (category) {
    case 'security':
      return gradeCategory(category, { shape: 'absolute', findings })
    case 'lint':
    case 'types':
    case 'dead-code':
      return gradeCategory(category, { shape: 'density', findings, kloc })
    case 'format':
      return gradeCategory(category, {
        shape: 'ratio',
        // The formatters report how many files they could check; falling back
        // to every source file only matters when none of them ran.
        percent: failingFilePercent(
          findings,
          category,
          metrics.formattableFiles ?? sourceFileCount,
        ),
      })
    case 'complexity':
      return ratioGrade(category, percentOf(metrics.functionsOverCeiling, metrics.functionsTotal))
    case 'duplication':
      return ratioGrade(category, metrics.duplicationPercent)
    case 'test-quality':
      return ratioGrade(category, metrics.mutationScore)
  }
}

function ratioGrade(category: Category, percent: number | undefined): Grade | undefined {
  return percent === undefined ? undefined : gradeCategory(category, { shape: 'ratio', percent })
}

/** `undefined` when either half is missing, or when nothing was measured. */
function percentOf(part: number | undefined, whole: number | undefined): number | undefined {
  if (part === undefined || whole === undefined || whole <= 0) return undefined
  return (part / whole) * 100
}

async function assertDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return
  } catch {
    throw new Error(`no such directory: ${path}`)
  }
  throw new Error(`not a directory: ${path}`)
}
