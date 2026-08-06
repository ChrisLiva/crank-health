import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inventoryOf, partitionProjects } from '../src/core/discover.ts'
import type { RunRecord, ScanResult } from '../src/core/orchestrator.ts'
import { sortFindings } from '../src/core/orchestrator.ts'
import type { Category, CategoryOutcome, RepoContext, ToolMetrics } from '../src/core/types.ts'
import { CATEGORIES, REPO_SCOPE } from '../src/core/types.ts'
import type { ProjectScan } from '../src/render/json.ts'
import { QUICK_MODE_TEST_QUALITY_REASON, REPO_SCOPED_REASON, gradeProjects } from '../src/run.ts'
import { makeFinding } from './factories.ts'

/**
 * Per-project grading: each project graded on its own denominators, its own
 * runs and the findings attributed to it, with the repo-spanning runs kept
 * where they belong.
 *
 * The tree is a workspace shell over two packages of very different size — the
 * same one lint warning is a catastrophe in a 20-line package and a rounding
 * error in a 2000-line one, and only per-project KLOC can say so.
 */

/** Repo-relative posix paths, with the line count each source file is written to. */
const TREE: Readonly<Record<string, number>> = {
  'packages/api/api/main.py': 2000,
  'packages/api/pyproject.toml': 1,
  'packages/web/.env': 1,
  'packages/web/package.json': 1,
  'packages/web/src/a.ts': 20,
}

const PROJECTS = partitionProjects(inventoryOf(Object.keys(TREE).toSorted()))

let repoRoot: string

beforeAll(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'crank-project-grade-'))
  for (const [file, lines] of Object.entries(TREE)) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(join(repoRoot, dirname(file)), { recursive: true })
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(repoRoot, file), 'x\n'.repeat(lines), 'utf8')
  }
})

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('gradeProjects', () => {
  let graded: readonly ProjectScan[]

  beforeAll(async () => {
    graded = await gradeProjects(repo(), scan(), CATEGORIES, false)
  })

  it('returns every project, in path order, with all eight states', () => {
    expect(graded.map((project) => project.project.path)).toEqual(['packages/api', 'packages/web'])
    for (const project of graded) {
      expect(Object.keys(project.categories)).toEqual([...CATEGORIES])
    }
  })

  /**
   * One warning each. 20 lines of TypeScript is 50 weighted findings per KLOC
   * and 2000 lines of Python is 0.5 — the whole point of grading a package on
   * its own size rather than on the repo's.
   */
  it('grades density on each project’s own KLOC', () => {
    expect(categories('packages/web').lint).toEqual({ status: 'graded', grade: 'F' })
    expect(categories('packages/api').lint).toEqual({ status: 'graded', grade: 'A' })
  })

  /**
   * A secret is the repo's finding, and the package it landed in is where a
   * reader looks for it — so it counts toward the grade of a package that had a
   * security tool of its own. An A beside a critical finding would be a lie.
   */
  it('counts a repo-spanning run’s findings toward the project they landed in', () => {
    expect(categories('packages/web').security).toEqual({ status: 'graded', grade: 'F' })
  })

  it('says repo-scoped where only a repo-spanning run assessed the category', () => {
    expect(categories('packages/api').security).toEqual({
      status: 'not-assessed',
      reason: REPO_SCOPED_REASON,
    })
  })

  /**
   * The repo-wide duplication pass measures clones *between* packages, which is
   * in neither package's own measurement. Only the rollup grades on it.
   */
  it('keeps the repo-wide rollup pass out of every project’s measurement', () => {
    for (const project of graded) {
      expect(project.metrics.duplication.duplicationPercent).toBe(1)
      expect(project.categories.duplication).toEqual({ status: 'graded', grade: 'A' })
    }
  })

  it('gives each project the quick profile’s reason for test quality', () => {
    expect(categories('packages/web')['test-quality']).toEqual({
      status: 'not-assessed',
      reason: QUICK_MODE_TEST_QUALITY_REASON,
    })
  })

  function categories(path: string): ProjectScan['categories'] {
    const found = graded.find((project) => project.project.path === path)
    if (found === undefined) throw new Error(`no project ${path}`)
    return found.categories
  }
})

function repo(): RepoContext {
  return {
    repoRoot,
    files: inventoryOf(Object.keys(TREE).toSorted()),
    scratch: repoRoot,
    projects: PROJECTS,
  }
}

/** A scan of the tree: two linters, one secrets scan, and three jscpd passes. */
function scan(): ScanResult {
  return {
    findings: sortFindings([
      makeFinding({
        id: 'web-lint',
        file: 'packages/web/src/a.ts',
        project: 'packages/web',
      }),
      makeFinding({
        id: 'api-lint',
        tool: 'ruff',
        file: 'packages/api/api/main.py',
        project: 'packages/api',
      }),
      makeFinding({
        id: 'web-secret',
        category: 'security',
        tool: 'gitleaks',
        rule: 'generic-api-key',
        severity: 'critical',
        file: 'packages/web/.env',
        project: 'packages/web',
      }),
    ]),
    runs: [
      record('oxlint', 'lint', 'packages/web'),
      record('ruff', 'lint', 'packages/api'),
      record('opengrep', 'security', 'packages/web'),
      record('gitleaks', 'security', REPO_SCOPE),
      record('jscpd', 'duplication', 'packages/web', { duplicationPercent: 1 }),
      record('jscpd', 'duplication', 'packages/api', { duplicationPercent: 1 }),
      {
        ...record('jscpd', 'duplication', REPO_SCOPE, { duplicationPercent: 40 }),
        rollupOnly: true,
      },
    ],
    // The rollup's own aggregation is the orchestrator's; per-project grading
    // never reads it.
    categories: Object.fromEntries(
      CATEGORIES.map((category) => [category, { status: 'assessed' }]),
    ) as Record<Category, CategoryOutcome>,
    metrics: Object.fromEntries(CATEGORIES.map((category) => [category, {}])) as Record<
      Category,
      ToolMetrics
    >,
    warnings: [],
  }
}

function record(
  tool: string,
  category: Category,
  project: string,
  metrics?: ToolMetrics,
): RunRecord {
  return {
    tool,
    category,
    scope: 'common',
    project,
    rollupOnly: false,
    pinnedVersion: '1.0.0',
    detection: null,
    result: {
      state: 'ok',
      findings: [],
      rawFiles: [],
      ...(metrics === undefined ? {} : { metrics }),
    },
    durationMs: 1,
    standby: false,
  }
}
