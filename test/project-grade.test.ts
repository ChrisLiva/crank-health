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

  /**
   * `packages/api` *has* a security record — the per-project SAST pass is
   * planned in every project — and all it says is that the scanner is missing.
   * Having run is not having answered, so the project's security answer is the
   * repo's, and `--fail-under` must not fail the package for it.
   */
  it('says repo-scoped where the project’s own runs assessed nothing', () => {
    expect(categories('packages/api').security).toEqual({
      status: 'not-assessed',
      reason: REPO_SCOPED_REASON,
    })
  })

  /**
   * The repo-wide duplication pass measures clones *between* packages, which is
   * in neither package's own measurement. Only the rollup grades on it.
   */
  it('keeps the repo-wide rollup pass out of a project’s measurement', () => {
    const web = graded.find((project) => project.project.path === 'packages/web')
    expect(web?.metrics.duplication.duplicationPercent).toBe(1)
    expect(web?.categories.duplication).toEqual({ status: 'graded', grade: 'A' })
  })

  /**
   * …and out of the repo-scoped substitution. The repo-wide pass answers about
   * the rollup, not about a package whose own measurement failed: that package
   * keeps its own reason, and the gate still sees the failure.
   */
  it('never lets the rollup pass stand in for a project’s failed run', () => {
    expect(categories('packages/api').duplication).toEqual({
      status: 'not-assessed',
      reason: 'jscpd found nothing to measure',
    })
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

/**
 * `repo-scoped` says the repo holds this project's answer. A repo-spanning run
 * that errored or never ran holds nothing — stamping the projects with it would
 * exempt them from `--fail-under` on the strength of a security scan that did
 * not happen, which is the one direction this must never fail in.
 */
describe('gradeProjects when the repo-spanning run failed too', () => {
  it('leaves each project the reason its own runs gave', async () => {
    const scanned = scan()
    const graded = await gradeProjects(
      repo(),
      {
        ...scanned,
        runs: scanned.runs.map((run) =>
          run.tool === 'gitleaks' ? degraded(run, 'gitleaks is not on PATH') : run,
        ),
      },
      CATEGORIES,
      false,
    )

    const api = graded.find((project) => project.project.path === 'packages/api')
    expect(api?.categories.security).toEqual({ status: 'not-assessed', reason: NO_SCANNER })
  })
})

/**
 * A C#-only package must be graded on its own C# KLOC. A source-file list that
 * forgets a language grades density against zero measurable code, and
 * `gradeDensity` reads that as unbounded density — F for a package whose one
 * warning in two thousand lines is a rounding error.
 */
describe('gradeProjects on a C#-only project', () => {
  const CS_TREE: Readonly<Record<string, number>> = {
    'packages/cs/App.csproj': 1,
    'packages/cs/Program.cs': 2000,
  }

  let csRoot: string

  beforeAll(async () => {
    csRoot = await mkdtemp(join(tmpdir(), 'crank-project-grade-cs-'))
    for (const [file, lines] of Object.entries(CS_TREE)) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(join(csRoot, dirname(file)), { recursive: true })
      // eslint-disable-next-line no-await-in-loop
      await writeFile(join(csRoot, file), 'x\n'.repeat(lines), 'utf8')
    }
  })

  afterAll(async () => {
    await rm(csRoot, { recursive: true, force: true })
  })

  it('grades lint density on the project’s C# KLOC, not on zero', async () => {
    const files = inventoryOf(Object.keys(CS_TREE).toSorted())
    const graded = await gradeProjects(
      { repoRoot: csRoot, files, scratch: csRoot, projects: partitionProjects(files) },
      {
        findings: sortFindings([
          makeFinding({ file: 'packages/cs/Program.cs', project: 'packages/cs' }),
        ]),
        runs: [record('roslynator', 'lint', 'packages/cs')],
        categories: Object.fromEntries(
          CATEGORIES.map((category) => [category, { status: 'assessed' }]),
        ) as Record<Category, CategoryOutcome>,
        metrics: Object.fromEntries(CATEGORIES.map((category) => [category, {}])) as Record<
          Category,
          ToolMetrics
        >,
        warnings: [],
      },
      CATEGORIES,
      false,
    )

    expect(graded.map((project) => project.project.path)).toEqual(['packages/cs'])
    // One warning in 2000 lines is 0.5 weighted findings per KLOC → A.
    expect(graded[0]?.categories.lint).toEqual({ status: 'graded', grade: 'A' })
  })
})

function repo(): RepoContext {
  return {
    repoRoot,
    files: inventoryOf(Object.keys(TREE).toSorted()),
    scratch: repoRoot,
    projects: PROJECTS,
  }
}

/** What a runner that could not answer here reports; see {@link degraded}. */
const NO_SCANNER = 'opengrep is not on PATH'

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
      // The per-project SAST pass is planned everywhere, so `packages/api` has a
      // security record — it just says nothing, because the scanner is missing.
      degraded(record('opengrep', 'security', 'packages/api'), NO_SCANNER),
      record('gitleaks', 'security', REPO_SCOPE),
      record('jscpd', 'duplication', 'packages/web', { duplicationPercent: 1 }),
      degraded(record('jscpd', 'duplication', 'packages/api'), 'jscpd found nothing to measure'),
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
    repoWide: project === REPO_SCOPE,
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

/** The same record, from a tool that could not run here. */
function degraded(base: RunRecord, reason: string): RunRecord {
  return { ...base, result: { state: 'not-available', findings: [], rawFiles: [], reason } }
}
