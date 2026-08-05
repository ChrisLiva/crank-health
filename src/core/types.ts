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
  /** Only `true` findings count toward the grade; the rest are advisory. */
  readonly gradeScope: boolean
  readonly fixHint?: string
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

/** Languages with an adapter in v1. */
export type Language = 'js-ts' | 'python'

/** Cross-language runners (jscpd, gitleaks, …) live under this pseudo-language. */
export type RunnerScope = Language | 'common'

/** The file list, computed once per scan and passed into every runner. */
export interface FileInventory {
  /** Every discovered file, repo-relative posix, stable-sorted. */
  readonly all: readonly string[]
  /** Language subsets of {@link all}, in the same order. */
  readonly byLanguage: Readonly<Record<Language, readonly string[]>>
}

/** Everything a detector may look at. Detection never runs a tool. */
export interface RepoContext {
  /** Absolute path to the repo root. */
  readonly repoRoot: string
  /** The one discovery result for this scan. */
  readonly files: FileInventory
  /** Absolute path to a scratch dir outside the repo. */
  readonly scratch: string
}

/**
 * What a repo-owned tool looks like. `null` from `ToolRunner.detect` means the
 * repo does not own this tool, so the runner runs our pinned default config.
 */
export interface Detection {
  /** Why we consider the tool repo-owned (spec §1 checks it in this order). */
  readonly reason: 'config' | 'dependency' | 'config+dependency'
  /** Repo-relative posix paths of the config artifacts found, if any. */
  readonly configFiles: readonly string[]
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
  /** Repo-relative posix paths, pre-filtered for this runner's language. */
  readonly files: readonly string[]
  /** Absolute path to a scratch dir outside the repo — all writes go here. */
  readonly scratch: string
  /** `null` → run our bundled default config from `scratch`. */
  readonly detection: Detection | null
  readonly timeoutMs: number
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
  /** `null` = not repo-owned; the runner still runs, with default config. */
  detect(repo: RepoContext): Promise<Detection | null>
  run(ctx: RunContext): Promise<ToolResult>
}

/** One language's detection rule plus its runners. */
export interface LanguageAdapter {
  readonly language: RunnerScope
  detect(repo: RepoContext): Promise<boolean>
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
