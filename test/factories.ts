import { inventoryOf, repoProject } from '../src/core/discover.ts'
import type {
  Category,
  CategoryState,
  Finding,
  Grade,
  Project,
  Severity,
  ToolMetrics,
} from '../src/core/types.ts'
import { CATEGORIES } from '../src/core/types.ts'
import type { Report, ReportInput } from '../src/render/json.ts'
import { buildReport } from '../src/render/json.ts'

/**
 * A file list as one project at the repo root — the unit a single-project scan
 * hands its runners, and what a runner test needs to build a `RunContext`.
 */
export function makeProject(files: readonly string[] = []): Project {
  return repoProject(inventoryOf(files))
}

/** A minimal valid finding; override only what the assertion is about. */
export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'deadbeefdeadbeef',
    category: 'lint',
    tool: 'oxlint',
    rule: 'no-unused-vars',
    severity: 'warning',
    file: 'src/a.ts',
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 2 },
    message: 'unused variable',
    provenance: 'default-config',
    gradeScope: true,
    ...overrides,
  }
}

/** `count` identical findings — for driving density and count bands. */
export function makeFindings(
  count: number,
  severity: Severity,
  category: Category = 'lint',
  overrides: Partial<Finding> = {},
): Finding[] {
  return Array.from({ length: count }, (_, index) =>
    makeFinding({ severity, category, file: `src/f${index}.ts`, ...overrides }),
  )
}

/** A report input where nothing was assessed; override what the test is about. */
export function makeReportInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    repoPath: '/repo',
    commit: 'abc123',
    profile: 'quick',
    selected: CATEGORIES,
    categories: allNotAssessed(),
    metrics: noMetrics(),
    runs: [],
    findings: [],
    warnings: [],
    generatedAt: '2024-01-01T00:00:00.000Z',
    durationMs: 42,
    ...overrides,
  }
}

/** The assembled report for {@link makeReportInput} — what a renderer consumes. */
export function makeReport(overrides: Partial<ReportInput> = {}): Report {
  return buildReport(makeReportInput(overrides))
}

/** Every category in the same degraded state, as a starting point. */
export function allNotAssessed(): Record<Category, CategoryState> {
  const states = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) {
    states[category] = { status: 'not-assessed', reason: 'no tool available for this category' }
  }
  return states
}

/** Every category graded the same, so a test can override the ones it is about. */
export function allGraded(grade: Grade = 'A'): Record<Category, CategoryState> {
  const states = {} as Record<Category, CategoryState>
  for (const category of CATEGORIES) states[category] = { status: 'graded', grade }
  return states
}

export function noMetrics(): Record<Category, ToolMetrics> {
  const metrics = {} as Record<Category, ToolMetrics>
  for (const category of CATEGORIES) metrics[category] = {}
  return metrics
}
