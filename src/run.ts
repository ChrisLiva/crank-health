import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mergeReachability } from './adapters/common/govulncheck.ts'
import { forgetBuilds } from './adapters/csharp/build.ts'
import { forgetStaticcheck } from './adapters/go/staticcheck.ts'
import { ADAPTERS } from './adapters/index.ts'
import { readRepoExcludes } from './adapters/jsts/repo-excludes.ts'
import { CliUsageError } from './args.ts'
import { applyDependencyScopes } from './core/dep-scope.ts'
import type { RootShell } from './core/discover.ts'
import {
  countPhysicalLines,
  discoverFiles,
  discoverProjects,
  inventoryOf,
  partitionProjects,
} from './core/discover.ts'
import { headCommit } from './core/git.ts'
import {
  COMPLEXITY_CEILING,
  GRADE_TABLE,
  failingFilePercent,
  gradeCategory,
  weightedCount,
} from './core/grade.ts'
import { aggregateCategories, aggregateMetrics, runScan } from './core/orchestrator.ts'
import type { RunRecord, ScanResult } from './core/orchestrator.ts'
import type { OutputDir } from './core/output.ts'
import {
  BASE_RAW_DIRNAME,
  DEFAULT_OUTPUT_DIRNAME,
  createOutputDir,
  rawPrefix,
} from './core/output.ts'
import type {
  Category,
  CategoryOutcome,
  CategoryState,
  FileInventory,
  Finding,
  Grade,
  LanguageAdapter,
  Project,
  RepoContext,
  Severity,
  ToolMetrics,
} from './core/types.ts'
import { CATEGORIES, LANGUAGES, toCategoryState } from './core/types.ts'
import { renderAgentMarkdown } from './render/agent-md.ts'
import type {
  ProjectScan,
  Report,
  ReportCoverage,
  ReportGradeBasis,
  ResolvedRun,
} from './render/json.ts'
import { buildReport, serializeReport } from './render/json.ts'
import { renderReportMarkdown } from './render/report-md.ts'

/**
 * The whole scan, from a path to a written `report.json`. `cli.ts` is a thin
 * shell over this, and the fixture tests drive it directly — so what the tests
 * prove is exactly what the CLI does.
 */

/**
 * Why a project has no state of its own for a category only the repo answered.
 *
 * A secret, a vulnerable dependency and a badly written workflow are properties
 * of the repo — that is why their runners span it — so when nothing
 * project-scoped assessed a category, the honest per-project answer is that the
 * rollup holds it, not a grade the project did not earn.
 */
export const REPO_SCOPED_REASON = 'repo-scoped'

export interface HealthScanOptions {
  /** Target repo; relative paths resolve against the cwd. */
  readonly path: string
  /** `--out`; defaults to `<path>/.codebase-health/`. */
  readonly out?: string | undefined
  /** `--only`; defaults to every category. */
  readonly only?: readonly Category[] | undefined
  /**
   * `--project`; defaults to every discovered project. See
   * {@link scopedProjects} for what scoping does and does not narrow.
   */
  readonly projects?: readonly string[] | undefined
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
  await assertProjectScope(repoRoot, options.projects)
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
        ...(options.projects === undefined ? {} : { scopedTo: options.projects }),
        categories: tree.categories,
        gradeBasis: tree.gradeBasis,
        metrics: tree.scan.metrics,
        coverage: tree.coverage,
        projects: tree.projects,
        ...(tree.rootShell === undefined ? {} : { rootShell: tree.rootShell }),
        runs: await adoptRawFiles(out, tree.scan),
        findings: tree.scan.findings,
        warnings: tree.warnings,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      }),
    )
  } finally {
    // The C# build and staticcheck memos key on this scratch path; forgetting
    // them here means a long-lived process (the test suite) never retains a
    // parsed SARIF or finding set per scan.
    forgetBuilds(scratch)
    forgetStaticcheck(scratch)
    await rm(scratch, { recursive: true, force: true })
  }
}

/** One tree's scan, graded. The unit PR mode runs twice; see `run-pr.ts`. */
export interface TreeScan {
  readonly scan: ScanResult
  /**
   * Everything this tree's run has to say about itself: what discovery left out
   * of the inventory, then what the tools reported about their own runs. The
   * scan is read against a scope, so the scope comes first.
   */
  readonly warnings: readonly string[]
  /** The rollup's states: the whole tree, on the whole tree's denominators. */
  readonly categories: Record<Category, CategoryState>
  /** The arithmetic behind the rollup's grades; see {@link ReportGradeBasis}. */
  readonly gradeBasis: Partial<Record<Category, ReportGradeBasis>>
  /** How much of this tree the rollup's grades are about; see {@link scanCoverage}. */
  readonly coverage: ReportCoverage
  readonly selected: readonly Category[]
  /**
   * The same, per project, ordered by path. Never empty, except on the side of
   * a `--pr` comparison that has none of the selected projects yet.
   */
  readonly projects: readonly ProjectScan[]
  /** Present when the tree's root is a workspace shell rather than a project. */
  readonly rootShell?: RootShell
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
  const discovered = await discoverFiles(options.repoRoot)
  const files = discovered.files
  const discovery = await discoverProjects(options.repoRoot, files)
  const scanned = scopedProjects(discovery.projects, options.projects)
  const repo: RepoContext = {
    repoRoot: options.repoRoot,
    files,
    scratch: options.scratch,
    projects: scanned,
    // The whole partition travels with the selection: what is *inside* a project
    // is a fact about the tree, and scoping must not change a project's own
    // grade (see `RepoContext.allProjects`).
    allProjects: discovery.projects,
  }

  const raw = await runScan(repo, options.adapters ?? ADAPTERS, {
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.deepTimeoutMs === undefined ? {} : { deepTimeoutMs: options.deepTimeoutMs }),
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.changedFiles === undefined ? {} : { changedFiles: options.changedFiles }),
    deep: options.deep === true,
  })
  // The two things a runner cannot do for itself, both folded in here, once,
  // before anything is graded or rendered — so the rollup, every project and
  // both sides of a PR delta read the same set.
  //
  // Reachability is a verdict *about another tool's finding*, and runners never
  // see each other. Dependency scope is a fact about the repo's lockfile rather
  // than about any tool's output, and the lockfile is read once for the scan
  // instead of once per finding. Scope goes second: it stamps a field on the
  // advisories a merge may just have combined.
  const merged = await applyDependencyScopes(options.repoRoot, mergeReachability(raw.findings))
  const scan: ScanResult = {
    ...raw,
    findings: merged.findings,
    warnings: [...raw.warnings, ...merged.warnings],
  }

  const selected = options.only === undefined ? CATEGORIES : options.only
  // The rollup's denominator: the whole tree, or — under `--project` — the
  // selection. Coverage is read against the same set, so the two agree.
  const graded = options.projects === undefined ? files : filesOf(scanned)
  const rollup = await gradeAll(repo.repoRoot, rollupScope(scan, graded))
  return {
    scan,
    warnings: [...discovered.warnings, ...scan.warnings],
    selected,
    categories: rollup.categories,
    gradeBasis: rollup.basis,
    coverage: await scanCoverage(repo.repoRoot, graded, rollup.sourceLines),
    projects: await gradeProjects(repo, scan, selected),
    ...(discovery.rootShell === undefined ? {} : { rootShell: discovery.rootShell }),
  }
}

/**
 * What the grades are silent about, in files and physical lines: the tree the
 * scan saw, minus the part a language adapter claims.
 *
 * A repo can be graded A across the board while a third of it — workflow YAML,
 * SQL, templates, shell — was never read by any tool, because the density
 * denominators are the *assessed* KLOC and the file counts are assessed files.
 * The remainder is broken down by extension so a reader can see what it is made
 * of, rather than being handed one discouraging percentage.
 *
 * @param assessedLines the source lines {@link gradeAll} already counted for the
 * KLOC denominator — the same read, not a second one. Only the remainder is read
 * here, so the whole tree is read exactly once between the two.
 */
export async function scanCoverage(
  repoRoot: string,
  files: FileInventory,
  assessedLines: number,
): Promise<ReportCoverage> {
  const assessed = new Set(LANGUAGES.flatMap((language) => files.byLanguage[language]))
  const groups = new Map<string, string[]>()
  for (const file of files.all) {
    if (assessed.has(file)) continue
    const extension = extensionOf(file)
    const group = groups.get(extension)
    if (group === undefined) groups.set(extension, [file])
    else group.push(file)
  }

  const unassessed: { extension: string; files: number; lines: number }[] = []
  for (const [extension, group] of [...groups].toSorted(([a], [b]) => compareFiles(a, b))) {
    // Sequential: each call already pools its own reads, and the extensions of
    // one repo are few.
    // eslint-disable-next-line no-await-in-loop
    const lines = await countPhysicalLines(repoRoot, group)
    unassessed.push({ extension, files: group.length, lines })
  }

  const remainder = unassessed.reduce((total, entry) => total + entry.lines, 0)
  return {
    files: { total: files.all.length, assessed: assessed.size },
    lines: { total: assessedLines + remainder, assessed: assessedLines },
    unassessed,
  }
}

/**
 * The lowercased extension, dot included, or the empty string for a file that
 * has none — `Makefile`, `.gitignore`, `LICENSE`.
 *
 * The rule is `languageOf`'s, deliberately: a dot must not be the first
 * character of the name, or every dotfile would read as an extension of its own
 * and the breakdown would disagree with the classification it is the complement
 * of.
 */
function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Copies each runner's staged raw output into the run directory, under the
 * project it came from: `raw/<project-path>/`, with `raw/root/` for the root
 * project and `raw/repo/` for a repo-scoped run ({@link rawPrefix}). Every
 * runner names its raw files after itself, so the nesting is what keeps the same
 * tool's output in two projects apart.
 *
 * @param side which scan this is, in PR mode. The base scan's evidence goes
 * under `raw/base/` with the same nesting below it, because the two scans run
 * the same tools and a reader has to be able to tell which side a failure was
 * on. `base` is a reserved name like the others, so a project directory called
 * `base/` is escaped away from it rather than into head's copy of it.
 */
export async function adoptRawFiles(
  out: OutputDir,
  scan: ScanResult,
  side?: 'base' | 'head',
): Promise<ResolvedRun[]> {
  const runs: ResolvedRun[] = []
  for (const record of scan.runs) {
    const prefix = rawPrefix(record.project, record.repoWide)
    // Sequential: raw files must land in the run directory before the scratch
    // dir is destroyed, and there are only a handful of them.
    // eslint-disable-next-line no-await-in-loop
    const raw = await out.adoptRaw(
      record.result.rawFiles,
      side === 'base' ? `${BASE_RAW_DIRNAME}/${prefix}` : prefix,
    )
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
  const agentMarkdown = renderAgentMarkdown(report, { excludes: await repoExcludes(report) })
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
 * Every glob the repo's own Biome and fallow configs exclude, across the
 * projects this scan covered — the same seam the duplication pass inherits from
 * (`adapters/jsts/repo-excludes.ts`), read here because `agent.md` uses it to
 * tell generated files from hand-written ones and a renderer opens no files.
 *
 * Per project and then unioned: the patterns come back rooted at the directory
 * of the config that declared them, so a package's own `!build/**` arrives as
 * `packages/web/build/**` and cannot reach outside the package that wrote it.
 */
async function repoExcludes(report: Report): Promise<readonly string[]> {
  const read = await Promise.all(
    report.projects.map(async (project) => readRepoExcludes(report.repo.path, project.path)),
  )
  return [...new Set(read.flatMap((excludes) => excludes.patterns))].toSorted(compareFiles)
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
 * What one grade is computed over: a set of files to be the denominator, the
 * findings against them, and the run outcomes and measurements behind them.
 *
 * There are two kinds, and they are the same arithmetic on different material:
 * the **rollup** ({@link rollupScope}) is the whole tree, and each **project**
 * is its own slice ({@link gradeProjects}).
 */
interface GradedScope {
  readonly files: FileInventory
  readonly findings: readonly Finding[]
  readonly categories: Readonly<Record<Category, CategoryOutcome>>
  readonly metrics: Readonly<Record<Category, ToolMetrics>>
}

/**
 * The whole tree, which is exactly what a single-project repo has always been —
 * and, under `--project`, the part of it that was scanned.
 *
 * @param files the denominator: the whole inventory, or the selected projects'
 * files. Every finding the run produced counts either way, including the ones a
 * repo-spanning scanner brought back from outside the selection — those tools
 * still scan the repo, and a secret is not less of a secret for sitting in a
 * package this invocation did not grade.
 */
function rollupScope(scan: ScanResult, files: FileInventory): GradedScope {
  return {
    files,
    findings: scan.findings,
    categories: scan.categories,
    metrics: scan.metrics,
  }
}

/**
 * The projects this scan analyzes: every discovered one, or the `--project`
 * selection.
 *
 * Scoping narrows the *project* dimension and nothing else. Repo-spanning
 * runners still span the repo (a secrets scan that skipped half the tree would
 * be a secrets scan that missed the secret), and what the rollup is graded over
 * follows the selection — see {@link rollupScope}.
 *
 * A selected path this tree does not have simply selects nothing here: the PR
 * base predates a project the change added, and that is churn to report rather
 * than an error. The usage error for a path no project matches is raised once,
 * against the tree the user pointed at, by {@link assertProjectScope}.
 */
function scopedProjects(
  projects: readonly Project[],
  requested: readonly string[] | undefined,
): readonly Project[] {
  if (requested === undefined) return projects
  return projects.filter((project) => requested.includes(project.path))
}

/** The selected projects' files as one inventory; projects never overlap. */
function filesOf(projects: readonly Project[]): FileInventory {
  return inventoryOf(projects.flatMap((project) => project.files.all).toSorted(compareFiles))
}

/**
 * Checks a `--project` selection against the projects the target actually has,
 * before any tool runs — a mistyped package name is worth a second of discovery
 * rather than a full scan of the wrong thing, and in PR mode it is the head tree
 * the user typed the path against.
 *
 * @throws {CliUsageError} when a selected path matches no discovered project
 */
export async function assertProjectScope(
  repoRoot: string,
  requested: readonly string[] | undefined,
): Promise<void> {
  if (requested === undefined) return
  const known = partitionProjects((await discoverFiles(repoRoot)).files).map(
    (project) => project.path,
  )
  const unknown = requested.filter((path) => !known.includes(path))
  if (unknown.length === 0) return
  throw new CliUsageError(
    `unknown --project ${unknown.map((path) => `"${path}"`).join(', ')}; ` +
      `this repo's projects are ${known.join(', ')}`,
  )
}

/** Byte-wise ordering, not locale-aware: the sort must not vary by machine. */
function compareFiles(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Every project graded on its own denominators: its own files' KLOC and file
 * count, its own runs, and the findings attributed to it.
 *
 * Two exclusions decide what "its own" means. The repo-wide duplication pass
 * measures what no single project can see, so only the rollup grades on it. And
 * a repo-spanning run answers about the repo — when a category has nothing
 * project-scoped behind it, the project's state says {@link REPO_SCOPED_REASON}
 * rather than a grade. What such a run *found* is a different question: a secret
 * in a package is that package's problem, so the findings attributed to it count
 * toward the grade of any category the project did assess. A package cannot be
 * shown an A next to a critical finding of its own.
 */
export async function gradeProjects(
  repo: RepoContext,
  scan: ScanResult,
  selected: readonly Category[],
): Promise<ProjectScan[]> {
  const own = scan.runs.filter((record) => !record.rollupOnly)
  const spanning = own.filter((record) => record.repoWide)

  const scans: ProjectScan[] = []
  for (const project of repo.projects) {
    // `repoWide` and not the path: a package directory called `repo/` has the
    // same `project` string a repo-spanning run does.
    const records = own.filter((record) => !record.repoWide && record.project === project.path)
    const metrics = aggregateMetrics(records)
    const scope: GradedScope = {
      files: project.files,
      findings: scan.findings.filter((finding) => finding.project === project.path),
      // The deferred set is the scan's: a category only `--deep` could answer
      // was deferred for every project its adapter applies to.
      categories: withRepoScoped(
        aggregateCategories(selected, records, scan.deferredCategories),
        records,
        spanning,
      ),
      metrics,
    }
    scans.push({
      project,
      // Sequential: each project's KLOC is its own read of its own files, and
      // the file reads inside are already pooled.
      // eslint-disable-next-line no-await-in-loop
      categories: (await gradeAll(repo.repoRoot, scope)).categories,
      metrics,
    })
  }
  return scans
}

/**
 * Categories the repo answered and the project did not; see
 * {@link REPO_SCOPED_REASON}.
 *
 * "Did not" means *graded*, not *ran*. The common adapter plans a per-project
 * SAST pass everywhere, so a project always has security records — and if the
 * only thing they say is that the scanner is not on this machine's PATH, the
 * project has no security answer of its own and the repo-spanning scan is where
 * its answer is. Keying on the presence of a record instead would make this
 * branch unreachable and fail such a project for a category the repo graded.
 *
 * The repo's side has to have graded it too. A repo-spanning run that errored or
 * was not available answered nothing, and stamping projects `repo-scoped` on the
 * strength of it would exempt them from `--fail-under` on a security scan that
 * never ran — the failure states must stay visible where they happened.
 */
function withRepoScoped(
  outcomes: Record<Category, CategoryOutcome>,
  records: readonly RunRecord[],
  spanning: readonly RunRecord[],
): Record<Category, CategoryOutcome> {
  const assessedHere = gradedCategories(records)
  const assessedForRepo = gradedCategories(spanning)

  const adjusted = {} as Record<Category, CategoryOutcome>
  for (const category of CATEGORIES) {
    adjusted[category] =
      !assessedHere.has(category) && assessedForRepo.has(category)
        ? { status: 'not-assessed', reason: REPO_SCOPED_REASON }
        : outcomes[category]
  }
  return adjusted
}

/** The categories these runs actually produced a measurement for. */
function gradedCategories(records: readonly RunRecord[]): Set<Category> {
  return new Set(
    records.filter((record) => record.result.state === 'ok').map((record) => record.category),
  )
}

/**
 * Turns each category's run outcome into its reported state.
 *
 * Denominators are the pipeline's job, not the runners': density grades are per
 * KLOC of analyzed source, and `format` is a share of analyzed source files.
 * Non-source files (manifests, docs) are in neither — grading lint noise
 * against a README's line count would be meaningless.
 */
async function gradeAll(repoRoot: string, scope: GradedScope): Promise<GradedResult> {
  const sourceFiles = LANGUAGES.flatMap((language) => scope.files.byLanguage[language])
  const sourceLines = await countPhysicalLines(repoRoot, sourceFiles)
  const kloc = sourceLines / 1000

  const categories = {} as Record<Category, CategoryState>
  const basis: Partial<Record<Category, ReportGradeBasis>> = {}
  for (const category of CATEGORIES) {
    categories[category] = toCategoryState(scope.categories[category], () =>
      gradeOne(category, scope, kloc, sourceFiles.length),
    )
    // Only where there is a letter to explain: the arithmetic behind a category
    // nothing could assess is a row of zeroes that reads as a measurement.
    if (categories[category].status === 'graded') {
      basis[category] = basisOf(category, scope, kloc, sourceFiles.length)
    }
  }
  return { categories, basis, sourceLines }
}

/**
 * One scope's grades, and the line count they were divided by — kept rather than
 * discarded, because it is also the assessed half of {@link scanCoverage} and
 * re-counting it would read every source file in the repo a second time.
 */
interface GradedResult {
  readonly categories: Record<Category, CategoryState>
  /** The arithmetic behind the graded ones; see {@link ReportGradeBasis}. */
  readonly basis: Partial<Record<Category, ReportGradeBasis>>
  /** Physical lines of the source files a language adapter claims. */
  readonly sourceLines: number
}

/**
 * The two numbers one category's formula divided, in that formula's own terms
 * (spec §3) — the same reading `report.md`'s "basis" sentence has always given
 * a person, said in a shape a machine can check.
 *
 * The `null` denominators are the shapes that normalize nothing: security counts
 * findings outright, and duplication and mutation score are percentages their
 * tool computed, with no numerator and denominator of ours behind them.
 */
function basisOf(
  category: Category,
  scope: GradedScope,
  kloc: number,
  sourceFileCount: number,
): ReportGradeBasis {
  const counted = countedFindings(category, scope.findings)
  const metrics = scope.metrics[category]
  switch (category) {
    case 'security':
      return { value: counted.length, denominator: null, unit: 'graded findings' }
    case 'lint':
    case 'types':
    case 'dead-code':
      return {
        value: weightedCount(counted),
        denominator: kloc,
        unit: 'weighted findings per KLOC',
      }
    case 'format':
      return {
        value: new Set(counted.map((finding) => finding.file)).size,
        denominator: metrics.formattableFiles ?? sourceFileCount,
        unit: 'files failing the formatter',
      }
    case 'complexity':
      return {
        value: metrics.functionsOverCeiling ?? 0,
        denominator: metrics.functionsTotal ?? null,
        unit: `functions over cognitive complexity ${COMPLEXITY_CEILING}`,
      }
    case 'duplication':
      return {
        value: metrics.duplicationPercent ?? 0,
        denominator: null,
        unit: '% of tokens duplicated',
      }
    case 'test-quality':
      return { value: metrics.mutationScore ?? 0, denominator: null, unit: '% of mutants detected' }
  }
}

/**
 * The findings a category's formula counts: in scope, in that category, and —
 * for `types`, the one category whose rule names severities — of a severity the
 * rule reads. The rule is read off `GRADE_TABLE`, so this cannot drift from what
 * `gradeDensity` actually counted.
 */
function countedFindings(category: Category, findings: readonly Finding[]): readonly Finding[] {
  const rule = GRADE_TABLE[category]
  const mine = findings.filter((finding) => finding.gradeScope && finding.category === category)
  if (!('severities' in rule)) return mine
  const severities: readonly Severity[] = rule.severities
  return mine.filter((finding) => severities.includes(finding.severity))
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
  scope: GradedScope,
  kloc: number,
  sourceFileCount: number,
): Grade | undefined {
  const findings = scope.findings.filter((finding) => finding.category === category)
  const metrics = scope.metrics[category]
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
