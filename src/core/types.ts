/**
 * The stable core vocabulary. Grading, delta and the renderers consume these
 * types only — they never see a runner, and runners never see each other.
 */

/** The eight graded categories (spec §"Categories and tools"). */
export type Category =
  | 'security'
  | 'types'
  | 'dead-code'
  | 'complexity'
  | 'duplication'
  | 'lint'
  | 'format'
  | 'test-quality'

/**
 * Canonical category order: the deterministic remediation priority from spec
 * §10 (security → types → dead code → complexity → duplication → lint →
 * format), with `test-quality` last because it only exists in `--deep`.
 * Every stable sort and every rendered list uses this order.
 */
export const CATEGORIES: readonly Category[] = [
  'security',
  'types',
  'dead-code',
  'complexity',
  'duplication',
  'lint',
  'format',
  'test-quality',
]

/** Index of a category in {@link CATEGORIES}; used as the primary sort key. */
export function categoryRank(category: Category): number {
  return CATEGORIES.indexOf(category)
}

/** Adapter-owned severity mapping target (spec §2). */
export type Severity = 'critical' | 'error' | 'warning' | 'info'

/**
 * Letter grade. The formula table only ever emits A, B, C, D or F; `E` exists
 * because `--fail-under E` is accepted on the CLI and grade comparisons must be
 * total over the letters a user can type.
 */
export type Grade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F'

/** Best-to-worst. Index is the grade's rank; lower is better. */
export const GRADES: readonly Grade[] = ['A', 'B', 'C', 'D', 'E', 'F']

/** Display-only source location. Never part of a finding's identity (spec §2). */
export interface Range {
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
}

/** A single normalized result from one tool. Schema is spec §2, verbatim. */
export interface Finding {
  /** Fingerprint: hash(category, tool, rule, file, anchor[, occurrence]). */
  readonly id: string
  readonly category: Category
  readonly tool: string
  readonly rule: string
  readonly severity: Severity
  /** Repo-relative posix path. */
  readonly file: string
  /** Display only — NOT identity. */
  readonly range: Range
  readonly message: string
  /**
   * `repo-config` = the repo's own tool and config flagged it (they violate
   * their own standards); `default-config` = our bundled default flagged it.
   */
  readonly provenance: 'repo-config' | 'default-config'
  /**
   * Only `true` findings count toward the grade; the rest are advisory.
   *
   * Internal. `report.json` says the same thing by putting the row in
   * `findings[]` or in `advisories[]` — see `render/json.ts`.
   */
  readonly gradeScope: boolean
  /**
   * The dependency this finding is about, on the findings that are about a
   * dependency rather than about a place in the source. Absent everywhere else.
   */
  readonly package?: FindingPackage
  /**
   * Every advisory against {@link package}, sorted by id — the detail behind a
   * dependency finding's one-line message.
   *
   * One finding per vulnerable *package* and not per advisory, because one
   * upgrade answers all of them: four rows saying "lodash@4.17.15 is affected
   * by …" are one piece of work, and reading them as four problems is what
   * makes a dependency audit unreadable.
   */
  readonly packageAdvisories?: readonly PackageAdvisory[]
  /**
   * Ids of findings in **other** categories that answer for the same place in
   * this file — same path, overlapping line range — sorted, and absent when
   * there are none. Assigned once the whole scan is in; see
   * `core/fingerprint.ts`.
   */
  readonly related?: readonly string[]
  readonly fixHint?: string
  /**
   * Which project this finding is in — the nearest project up its path, stamped
   * by the orchestrator once every runner has finished (`core/orchestrator.ts`),
   * so that a repo-scoped scan's findings land in the right project too.
   *
   * **Attribution only.** {@link Finding.id} is hashed from the repo-root-relative
   * path and never from this, so moving the project boundary around a file does
   * not change its identity — see `core/fingerprint.ts`. Absent on findings a
   * test constructed by hand.
   */
  readonly project?: string
  /**
   * The material {@link Finding.id} was hashed from, carried so a PR delta can
   * re-hash it under a renamed path (`core/delta.ts`). Internal: `report.json`
   * rebuilds every finding field by field and never writes it.
   *
   * Present on everything the core identified (`computeAnchors`), absent on
   * findings a test constructed by hand.
   */
  readonly identity?: FindingIdentity
}

/** The pinned dependency a package-level finding is about. */
export interface FindingPackage {
  readonly name: string
  readonly version: string
  /** The advisory database's own ecosystem name: `npm`, `PyPI`, `NuGet`, … */
  readonly ecosystem: string
}

/** One advisory against a {@link FindingPackage}. */
export interface PackageAdvisory {
  /** The advisory's canonical id, e.g. `GHSA-…`. */
  readonly id: string
  /** Every id and alias this advisory is published under, sorted. */
  readonly aliases: readonly string[]
  readonly severity: Severity
  /** The advisory's own one-line summary; empty when it publishes none. */
  readonly summary: string
  /**
   * The version that fixes it, walked out of the OSV record's affected ranges.
   * Absent when the advisory closes no range — there is nothing to upgrade to,
   * which is why such a finding is advisory rather than graded.
   */
  readonly fixedIn?: string
  /**
   * Whether the vulnerable code is reachable from this repo. Absent until a
   * reachability analyzer has answered; it owns the vocabulary.
   */
  readonly reachability?: string
  /**
   * Which dependency scope pulls the package in — a runtime dependency and a
   * build-only one are not the same exposure. Absent until scope resolution has
   * answered; it owns the vocabulary.
   */
  readonly scope?: string
}

/** What identity is computed from, minus the fields already on the finding. */
interface FindingIdentity {
  /** Trimmed flagged source line, or the symbol name for symbol-level findings. */
  readonly anchor: string
  /** Index among findings sharing every other identity field, within the file. */
  readonly occurrence: number
}

/** A finding before the core assigns its identity. See `core/fingerprint.ts`. */
export type PendingFinding = Omit<Finding, 'id'> & {
  /**
   * Optional explicit anchor for symbol-level findings (e.g. the exported name
   * a dead-code tool flagged). When absent the anchor is the trimmed source
   * line at `range.startLine`.
   */
  readonly anchor?: string
}

/** Languages crank-health has a vocabulary for. */
export type Language = 'js-ts' | 'python' | 'csharp' | 'go'

/**
 * Canonical language order, matching the adapter order in `adapters/index.ts`.
 * Every stable sort and every rendered list of languages uses it.
 */
export const LANGUAGES: readonly Language[] = ['js-ts', 'python', 'csharp', 'go']

/** Cross-language runners (jscpd, gitleaks, …) live under this pseudo-language. */
export type RunnerScope = Language | 'common'

/** The file list, computed once per scan and passed into every runner. */
export interface FileInventory {
  /** Every discovered file, repo-relative posix, stable-sorted. */
  readonly all: readonly string[]
  /** Language subsets of {@link all}, in the same order. */
  readonly byLanguage: Readonly<Record<Language, readonly string[]>>
}

/**
 * One analyzable unit of the repo: a directory holding a `package.json` or a
 * `pyproject.toml`, plus every source file nearer to it than to any other such
 * directory. A single-project repo is the degenerate case — one project at `.`
 * holding the whole inventory.
 */
export interface Project {
  /** Identity: repo-relative posix path of the project directory, `.` for the root. */
  readonly path: string
  /** Repo-relative posix paths of the manifests in {@link path}, stable-sorted. */
  readonly manifests: readonly string[]
  /** Languages this project declares (by manifest) or contains (by file), in {@link LANGUAGES} order. */
  readonly languages: readonly Language[]
  /** The nearest-manifest slice of the scan's inventory; every source file is in exactly one. */
  readonly files: FileInventory
}

/**
 * What a run that answers about the *repo* rather than about one project is
 * attributed to: a secrets scan, a lockfile audit, the repo-wide duplication
 * pass. Not a path — {@link Project.path} is always a directory, and this names
 * the repo itself.
 */
export const REPO_SCOPE = 'repo'

/** Everything a scan works from. Detection never runs a tool. */
export interface RepoContext {
  /** Absolute path to the repo root. */
  readonly repoRoot: string
  /** The one discovery result for this scan. */
  readonly files: FileInventory
  /** Absolute path to a scratch dir outside the repo. */
  readonly scratch: string
  /** The projects this scan analyzes, stable-sorted by path; never empty. */
  readonly projects: readonly Project[]
  /**
   * Every project discovery found, stable-sorted — including the ones
   * `--project` left out of {@link projects}. Defaults to {@link projects},
   * which is what an unscoped scan has.
   *
   * Nesting is a fact about the repo and not about the selection: a package
   * inside another package is still not its parent's, however the scan was
   * scoped. Without this, scoping to the parent would make its nested packages
   * part of it — see `RunContext.nestedProjects`.
   */
  readonly allProjects?: readonly Project[]
}

/**
 * Everything a detector may look at: one project, inside one repo.
 *
 * Ownership is decided for {@link project}, and not only from its own
 * directory. A tool configured or declared in **any ancestor** up to the repo
 * root owns it there too, and an install hoisted to an ancestor
 * `node_modules/.bin` is the binary that runs — so both detection helpers
 * (`adapters/jsts/node-package.ts`, `adapters/python/py-project.ts`) walk
 * {@link import('./discover.ts').ancestryOf}. The one documented exception is
 * `tsconfig.json`, which TypeScript does not resolve upward; see
 * `NodeToolSpec.configInherits`.
 *
 * {@link files} is the whole repo's inventory, not the project's: the
 * repo-scoped runners (a secrets scanner, a workflow auditor) answer about the
 * repo, and their config belongs to it rather than to any one package.
 */
export interface DetectContext {
  /** Absolute path to the repo root. */
  readonly repoRoot: string
  /** The project ownership is being decided for. */
  readonly project: Project
  /** The whole scan's inventory. */
  readonly files: FileInventory
}

/**
 * What a repo-owned tool looks like. `null` from `ToolRunner.detect` means the
 * repo does not own this tool, so the runner runs our pinned default config.
 */
export interface Detection {
  /** Why we consider the tool repo-owned (spec §1 checks it in this order). */
  readonly reason: 'config' | 'dependency' | 'config+dependency'
  /**
   * Repo-relative posix paths of the config artifacts found, if any: the
   * project's own, and the ones it inherits from an ancestor directory.
   */
  readonly configFiles: readonly string[]
  /**
   * Which artifact decided ownership, repo-relative posix: the nearest config
   * the project inherits, or — when only a dependency declaration decided it —
   * the nearest manifest that declares the tool.
   *
   * In a monorepo this is the difference between a package that owns its
   * toolchain and one that inherits the root's, and {@link configFiles} cannot
   * say it for a `dependency` detection because there is no config to name.
   * Absent only for a detector that reports no provenance.
   */
  readonly ownedVia?: string
  /** True when the declared tool is actually installed in the repo. */
  readonly installed: boolean
  /** Absolute path to the repo's installed binary, when `installed`. */
  readonly binPath?: string
  /** Version reported by the repo's installed binary, when known. */
  readonly version?: string
}

/** Everything a runner is allowed to know. Runners never discover files. */
export interface RunContext {
  readonly repoRoot: string
  /**
   * The project this run analyzes — its directory is the one a tool's config,
   * virtualenv or manifest belongs to, and {@link files} is its slice. A
   * repo-scoped runner ({@link ToolRunner.repoScoped}) gets the whole repo as
   * one project at the root.
   */
  readonly project: Project
  /**
   * The projects nested inside {@link project}, repo-relative posix — the ones
   * whose files are theirs and not this run's.
   *
   * {@link files} already excludes them, so a runner given a file list can
   * ignore this. It is for the runners that are handed a *directory* instead
   * (jscpd), whose whole-tree measurement would otherwise take a nested
   * package's code — and a clone between two packages — for this project's own.
   * Empty for a repo-spanning run, which is meant to see everything.
   */
  readonly nestedProjects?: readonly string[]
  /** Repo-relative posix paths, pre-filtered for this runner's language. */
  readonly files: readonly string[]
  /**
   * Absolute path to a scratch dir outside the repo — all writes go here. One
   * per project, so the same tool running in two projects cannot overwrite the
   * other's raw output.
   */
  readonly scratch: string
  /**
   * Absolute path to the *scan's* root scratch dir — the one every job's
   * {@link scratch} nests under. Where per-run state shared *between* runners
   * lives (the C# build memo: three runners, one `dotnet build`): every job in
   * one scan sees the same value, and it is exactly the path the scan's own
   * teardown holds — so forgetting by it releases everything the scan cached.
   */
  readonly runScratch: string
  /** `null` → run our bundled default config from `scratch`. */
  readonly detection: Detection | null
  readonly timeoutMs: number
  /**
   * `--deep` (spec §5). Only the deep profile may execute the repo's own code,
   * so a runner that does — mutation testing, a coverage run — checks this
   * before it starts. {@link ToolRunner.deepOnly} is the declarative form and is
   * what the orchestrator filters on; this is here for the runners that behave
   * differently in the two profiles rather than only existing in one.
   */
  readonly deep: boolean
  /**
   * PR mode: the head-side paths this change touched, stable-sorted (spec §4's
   * "deep mutation scopes to diff-touched files"). Absent in a whole-repo scan,
   * which is the difference between "scope to these" and "scope to nothing".
   */
  readonly changedFiles?: readonly string[] | undefined
}

/**
 * Measurements a tool reports about the code as a whole, rather than about one
 * place in it.
 *
 * The ratio grades of spec §3 need a denominator that no list of findings can
 * carry: "% of functions over cognitive 15" needs the function count, "% of
 * files failing the formatter" needs the formattable-file count, and
 * duplication and mutation score are percentages the tool computes itself.
 * Every field is optional and additive — a runner that measures nothing simply
 * omits the whole object, and the categories whose tools report nothing stay
 * `not-assessed` exactly as before.
 *
 * The orchestrator merges these per category (`aggregateMetrics`): counts sum
 * across tools, percentages and denominators take the maximum.
 */
export interface ToolMetrics {
  /** Functions the tool analyzed — the `complexity` denominator. */
  readonly functionsTotal?: number
  /** Of those, how many exceed the cognitive-complexity ceiling. */
  readonly functionsOverCeiling?: number
  /** Files the tool was able to check formatting for — the `format` denominator. */
  readonly formattableFiles?: number
  /** Duplicated-token percentage, as the duplication detector reports it. */
  readonly duplicationPercent?: number
  /** Mutation score percentage (`--deep` only); higher is better. */
  readonly mutationScore?: number
  /** Mutants the test suite detected — killed outright or by timing out. */
  readonly mutantsDetected?: number
  /** Mutants nothing detected: survived, or never covered by a test at all. */
  readonly mutantsUndetected?: number
  /**
   * Line coverage percentage from the deep-tier coverage run. Reported and
   * rendered, never graded: spec §3 grades test quality on the mutation score,
   * and coverage is the context that makes that number readable.
   */
  readonly lineCoveragePercent?: number
}

/** A runner's outcome, including the three degradation states of spec §8. */
export interface ToolResult {
  readonly state: 'ok' | 'error' | 'timeout' | 'not-available'
  readonly findings: readonly Finding[]
  readonly toolVersion?: string
  /** Absolute paths of raw tool output written under the run's `raw/` dir. */
  readonly rawFiles: readonly string[]
  /** Human-readable explanation; required in practice for non-`ok` states. */
  readonly reason?: string
  /** Whole-codebase measurements this tool produced; see {@link ToolMetrics}. */
  readonly metrics?: ToolMetrics
  /**
   * Whether the repo's own configuration decided this run's findings — the tool
   * record's `provenance` in `report.json` (spec §1).
   *
   * Detection is not always the answer. A repo can *declare* a tool without
   * configuring it (`typescript` in `devDependencies` and no `tsconfig.json`),
   * and then the tool runs against our bundled config: the findings say
   * `default-config` and the tool record must not say `repo-config`. Only the
   * runner knows which of its detection signals it actually honored, so it says
   * so here. Omitted means "detection decides", which is right for every runner
   * whose config artifacts and dependency signal cannot come apart.
   */
  readonly configOwned?: boolean
}

/** One tool wrapper: detect how the repo owns it, then run it ephemerally. */
export interface ToolRunner {
  readonly tool: string
  readonly category: Category
  readonly pinnedVersion: string
  /**
   * Set when the tool has no meaning as a default: ESLint and Biome are
   * first-class *when detected* (spec "Categories and tools"), but crank-health
   * never imposes them on a repo that did not choose them — oxlint and prettier
   * are the defaults. A `repoOwnedOnly` runner whose `detect` returns `null` is
   * skipped entirely rather than run with a bundled config.
   */
  readonly repoOwnedOnly?: boolean
  /**
   * Set when this runner measures something no other runner in its category
   * measures, so another tool owning the category must not stand it down.
   *
   * The default-suppression rule (`withoutRedundantDefaults`) exists because
   * lint and format tools are *alternatives* — a repo formatted with Biome did
   * not ask for prettier's opinion. Security tools are not alternatives: spec
   * "Categories and tools" lists security as "opengrep + gitleaks + zizmor +
   * bandit + ruff `S`", a union of a SAST engine, a secrets scanner, a workflow
   * auditor and a dependency scanner. Without this flag, a repo that merely
   * declares bandit in its `pyproject.toml` would silently lose its secrets
   * scan — the exact failure that must never happen quietly.
   */
  readonly complementary?: boolean
  /**
   * Set when this runner belongs to the deep profile (spec §5): it executes the
   * repo's own test suite, which no quick scan may do and no quick budget could
   * afford. The orchestrator skips these runners entirely without `--deep` —
   * *without* recording a run, so a quick scan's test-quality category reads
   * "not assessed — run `--deep`" rather than "a tool declined".
   *
   * Deep runners also get their own, much larger, per-tool budget
   * ({@link import('./orchestrator.ts').DEEP_TIMEOUT_MS}).
   */
  readonly deepOnly?: boolean
  /**
   * This runner's own wall-clock budget, in milliseconds, when the quick tier's
   * shared one ({@link import('./orchestrator.ts').DEFAULT_TIMEOUT_MS}) is not
   * the right number for it — a tool that loads a whole package graph, or
   * fetches its own analyzer before it can start, is not slow because something
   * is wrong.
   *
   * A user's explicit `--timeout` still wins: naming a budget is a statement
   * about the whole scan, and a runner's default cannot outrank it. So is
   * {@link deepOnly}'s much larger budget, which is about a different tier
   * rather than about one tool.
   */
  readonly timeoutMs?: number
  /**
   * Set when this runner answers about the repo rather than about a project: a
   * secret, a vulnerable dependency or a badly written workflow is a property of
   * the repo, and scanning for one per project would scan the same tree N times
   * and report each hit N times. The orchestrator plans exactly one repo-spanning
   * job for such a runner, whatever the repo's project count, and its findings
   * are attributed back to projects by file path.
   */
  readonly repoScoped?: boolean
  /**
   * Set when this runner only has meaning for the languages it names — bandit
   * reads Python, opengrep reads JavaScript, TypeScript and Python. A repo
   * holding none of them gets one repo-spanning run saying so, rather than the
   * same "nothing to scan" sentence once per project: that a repo has no Python
   * is a fact about the repo, not about each of its packages.
   *
   * A repo holding one of them anywhere is planned per project exactly as an
   * undeclared runner is — the package without Python beside the package with it
   * still gets its own answer.
   */
  readonly languages?: readonly Language[]
  /**
   * Set when this runner measures something whose whole-repo value cannot be
   * assembled from its per-project ones — duplication being the case: a clone
   * *between* two packages is in neither package's measurement. Such a runner is
   * planned per project **and** once over the whole repo, and the repo-wide pass
   * is marked
   * {@link import('./orchestrator.ts').RunRecord.rollupOnly} so that only the
   * rollup's grade is built from it.
   *
   * A single-project repo gets no extra pass: there is no "between" for it to
   * measure, and the project's own pass already covers the whole repo.
   */
  readonly repoWidePass?: boolean
  /** `null` = not repo-owned; the runner still runs, with default config. */
  detect(ctx: DetectContext): Promise<Detection | null>
  run(ctx: RunContext): Promise<ToolResult>
}

/** One language's detection rule plus its runners. */
export interface LanguageAdapter {
  readonly language: RunnerScope
  detect(ctx: DetectContext): Promise<boolean>
  readonly runners: readonly ToolRunner[]
}

/**
 * Pre-grading category state produced by the orchestrator: did the tools
 * produce usable output at all?
 */
export type CategoryOutcome =
  | { readonly status: 'assessed' }
  | { readonly status: 'not-assessed'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string }

/**
 * Reported category state (spec §8). `assessed` becomes `graded` once the
 * formula table has run; the other two pass through unchanged.
 */
export type CategoryState =
  | { readonly status: 'graded'; readonly grade: Grade }
  | { readonly status: 'not-assessed'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string }

/** Bridges an orchestrator outcome to a reported state once a grade exists. */
export function toCategoryState(
  outcome: CategoryOutcome,
  grade: () => Grade | undefined,
): CategoryState {
  if (outcome.status !== 'assessed') return outcome
  const value = grade()
  return value === undefined
    ? { status: 'not-assessed', reason: 'no grade could be computed' }
    : { status: 'graded', grade: value }
}
