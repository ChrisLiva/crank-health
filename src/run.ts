import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ADAPTERS } from './adapters/index.ts'
import { CliUsageError } from './args.ts'
import { countPhysicalLines, discoverFiles, discoverProjects } from './core/discover.ts'
import { headCommit } from './core/git.ts'
import { failingFilePercent, gradeCategory } from './core/grade.ts'
import { runScan } from './core/orchestrator.ts'
import type { ScanResult } from './core/orchestrator.ts'
import type { OutputDir } from './core/output.ts'
import { DEFAULT_OUTPUT_DIRNAME, createOutputDir } from './core/output.ts'
import type { Category, CategoryState, Grade, LanguageAdapter, RepoContext } from './core/types.ts'
import { CATEGORIES, toCategoryState } from './core/types.ts'
import { renderAgentMarkdown } from './render/agent-md.ts'
import type { Report, ResolvedRun } from './render/json.ts'
import { buildReport, serializeReport } from './render/json.ts'
import { renderReportMarkdown } from './render/report-md.ts'

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
  /** `--deep` (spec §5): add the mutation / test-suite tier. */
  readonly deep?: boolean | undefined
  readonly concurrency?: number | undefined
  readonly timeoutMs?: number | undefined
  /** Per-tool budget for the deep runners; see `DEEP_TIMEOUT_MS`. */
  readonly deepTimeoutMs?: number | undefined
  /** Injectable for tests; production always uses {@link ADAPTERS}. */
  readonly adapters?: readonly LanguageAdapter[] | undefined
}

export interface HealthScanResult {
  readonly report: Report
  /** The exact bytes written to `report.json`. */
  readonly json: string
  /** The exact bytes written to `report.md`. */
  readonly markdown: string
  /** The exact bytes written to `agent.md`. */
  readonly agentMarkdown: string
  /** Absolute path of the run directory. */
  readonly outputDir: string
  /** Absolute path of `report.json`. */
  readonly reportPath: string
  /** Absolute path of `report.md`. */
  readonly markdownPath: string
  /** Absolute path of `agent.md`. */
  readonly agentPath: string
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
  const repoRoot = await resolveRepoRoot(options.path)
  const commit = await headCommit(repoRoot)
  const scratch = await mkdtemp(join(tmpdir(), 'crank-health-'))

  try {
    const out = await createRunDirectory(repoRoot, options.out)
    const tree = await scanTree({ ...options, repoRoot, scratch })

    return await writeArtifacts(
      out,
      buildReport({
        repoPath: repoRoot,
        commit,
        profile: options.deep === true ? 'deep' : 'quick',
        selected: tree.selected,
        categories: tree.categories,
        metrics: tree.scan.metrics,
        runs: await adoptRawFiles(out, tree.scan),
        findings: tree.scan.findings,
        warnings: tree.scan.warnings,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      }),
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** One tree's scan, graded. The unit PR mode runs twice; see `run-pr.ts`. */
export interface TreeScan {
  readonly scan: ScanResult
  readonly categories: Record<Category, CategoryState>
  readonly selected: readonly Category[]
}

export interface TreeScanOptions extends Omit<HealthScanOptions, 'path' | 'out'> {
  /** Absolute, physical path to the tree to scan — the repo, or a base worktree. */
  readonly repoRoot: string
  /** Absolute path to this scan's scratch dir; two scans never share one. */
  readonly scratch: string
  /** PR mode: the paths this change touched; see {@link RunContext.changedFiles}. */
  readonly changedFiles?: readonly string[] | undefined
}

/**
 * Discovers, runs every applicable tool, and grades — everything between a
 * directory and a set of category states, and nothing about where the result is
 * written. PR mode runs this against the base worktree and against head with
 * the same options, which is what makes the two halves of a delta comparable.
 */
export async function scanTree(options: TreeScanOptions): Promise<TreeScan> {
  const files = await discoverFiles(options.repoRoot)
  const { projects } = await discoverProjects(options.repoRoot, files)
  const repo: RepoContext = {
    repoRoot: options.repoRoot,
    files,
    scratch: options.scratch,
    projects,
  }

  const scan = await runScan(repo, options.adapters ?? ADAPTERS, {
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.deepTimeoutMs === undefined ? {} : { deepTimeoutMs: options.deepTimeoutMs }),
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.changedFiles === undefined ? {} : { changedFiles: options.changedFiles }),
    deep: options.deep === true,
  })

  const selected = options.only === undefined ? CATEGORIES : options.only
  return {
    scan,
    selected,
    categories: await gradeAll(repo, scan, selected, options.deep === true),
  }
}

/**
 * Copies each runner's staged raw output into the run directory.
 *
 * @param side which scan this is, in PR mode. The base scan's evidence goes to
 * `raw/base/` and its tool records say so, because the two scans run the same
 * tools and a reader has to be able to tell which side a failure was on.
 */
export async function adoptRawFiles(
  out: OutputDir,
  scan: ScanResult,
  side?: 'base' | 'head',
): Promise<ResolvedRun[]> {
  const runs: ResolvedRun[] = []
  for (const record of scan.runs) {
    // Sequential: raw files must land in the run directory before the scratch
    // dir is destroyed, and there are only a handful of them.
    // eslint-disable-next-line no-await-in-loop
    const raw = await out.adoptRaw(record.result.rawFiles, side === 'base' ? 'base' : undefined)
    runs.push({ record, raw, ...(side === undefined ? {} : { side }) })
  }
  return runs
}

/**
 * Renders and writes all four artifacts (spec §9): the JSON is the contract,
 * the markdown is the report a person reads, and agent.md is the one an agent
 * works from. A run that wrote only some of them would leave a reader looking
 * at a stale file from an earlier scan.
 *
 * Both markdown renderers read the delta off the report itself, so a PR run
 * needs nothing extra here.
 */
export async function writeArtifacts(out: OutputDir, report: Report): Promise<HealthScanResult> {
  const json = serializeReport(report)
  const markdown = renderReportMarkdown(report)
  const agentMarkdown = renderAgentMarkdown(report)
  const [reportPath, markdownPath, agentPath] = await Promise.all([
    out.write('report.json', json),
    out.write('report.md', markdown),
    out.write('agent.md', agentMarkdown),
  ])
  return {
    report,
    json,
    markdown,
    agentMarkdown,
    outputDir: out.root,
    reportPath,
    markdownPath,
    agentPath,
  }
}

/**
 * The run directory, with the one `--out` no scan may accept: the repo itself.
 *
 * A run directory is crank-health's, not the repo's — it gets a `.gitignore`
 * that ignores everything in it, and `report.json`, `report.md` and `agent.md`
 * are written into it on every run. Pointed at the repo root that would mean
 * three files in the user's source tree and a `.gitignore` collision with
 * theirs, which is the opposite of the zero-footprint contract (spec §7) and of
 * acceptance criterion 4. It is a typo a user fixes by re-typing the command,
 * so it is a usage error (exit 2) rather than a crash.
 *
 * @throws {CliUsageError} when `out` resolves to `repoRoot`
 */
export async function createRunDirectory(
  repoRoot: string,
  out: string | undefined,
): Promise<OutputDir> {
  if (out !== undefined) {
    // `repoRoot` is physical and `--out` is whatever the user typed; compare the
    // two as the filesystem knows them. A path that does not exist yet cannot be
    // the repo, which does, so each lexical fallback is safe.
    const target = resolve(out)
    const physicalOut = await realpath(target).catch(() => target)
    const physicalRepo = await realpath(repoRoot).catch(() => repoRoot)
    if (physicalOut === physicalRepo) {
      throw new CliUsageError(
        `--out ${out} is the repo itself — crank-health writes its own run directory there, ` +
          `so give it one of its own (the default is ${DEFAULT_OUTPUT_DIRNAME}/)`,
      )
    }
  }
  return createOutputDir(repoRoot, out)
}

/**
 * The target path as the filesystem knows it: resolved against the cwd,
 * checked to be a directory, then made physical. Tools that canonicalize
 * their output paths (ruff) report inside the physical root, and
 * `repoRelative()` is purely lexical — so a symlinked root would silently
 * relativize their findings outside the repo and drop them.
 */
export async function resolveRepoRoot(path: string): Promise<string> {
  const repoRoot = resolve(path)
  await assertDirectory(repoRoot)
  return await realpath(repoRoot)
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
  deep: boolean,
): Promise<Record<Category, CategoryState>> {
  const sourceFiles = [...repo.files.byLanguage['js-ts'], ...repo.files.byLanguage.python]
  const kloc = (await countPhysicalLines(repo.repoRoot, sourceFiles)) / 1000

  const states = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) {
    const state = toCategoryState(scan.categories[category], () =>
      gradeOne(category, scan, kloc, sourceFiles.length),
    )
    // Spec §5: in quick mode the reason test quality has no grade is the
    // profile, whatever the repo contains — no mutation tool was even asked. In
    // deep mode one was, so the reason it gave (or the orchestrator's, when
    // there was no tool to ask) is the honest one, and this must not overwrite
    // it with an instruction to run the flag the user just ran.
    states[category] =
      !deep &&
      category === 'test-quality' &&
      state.status === 'not-assessed' &&
      selected.includes(category)
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
