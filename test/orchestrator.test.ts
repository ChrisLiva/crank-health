import { mkdtempSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { inventoryOf, partitionProjects } from '../src/core/discover.ts'
import type { RunRecord } from '../src/core/orchestrator.ts'
import { runScan, sortFindings } from '../src/core/orchestrator.ts'
import { rawPrefix } from '../src/core/output.ts'
import { REPO_SCOPE } from '../src/core/types.ts'
import type {
  Category,
  DetectContext,
  Detection,
  FileInventory,
  Finding,
  Language,
  LanguageAdapter,
  RepoContext,
  RunContext,
  RunnerScope,
  ToolMetrics,
  ToolResult,
  ToolRunner,
} from '../src/core/types.ts'
import { makeFinding } from './factories.ts'

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path)).isDirectory()
}

const FILES: FileInventory = {
  all: ['src/a.ts', 'src/b.py', 'README.md'],
  byLanguage: { 'js-ts': ['src/a.ts'], python: ['src/b.py'] },
}

/** Real, because the orchestrator stages each project's scratch dir on disk. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'crank-orchestrator-'))

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true })
})

const REPO: RepoContext = {
  repoRoot: '/repo',
  files: FILES,
  scratch: SCRATCH,
  projects: partitionProjects(FILES),
}

interface FakeRunner extends ToolRunner {
  readonly calls: RunContext[]
}

function fakeRunner(
  tool: string,
  category: Category,
  run: (ctx: RunContext) => Promise<ToolResult>,
  detect: (ctx: DetectContext) => Promise<Detection | null> = async () => null,
): FakeRunner {
  const calls: RunContext[] = []
  return {
    tool,
    category,
    pinnedVersion: '1.0.0',
    calls,
    detect,
    run: async (ctx) => {
      calls.push(ctx)
      return run(ctx)
    },
  }
}

function adapter(
  language: RunnerScope,
  runners: readonly ToolRunner[],
  detected = true,
): LanguageAdapter {
  return { language, runners, detect: async () => detected }
}

const ok = (findings: readonly Finding[] = []): ToolResult => ({
  state: 'ok',
  findings,
  rawFiles: [],
  toolVersion: '1.0.0',
})

const never = () => new Promise<ToolResult>(() => {})

/** A repo-owned detection; the details never matter, only that it is not null. */
const DETECTION: Detection = { reason: 'config', configFiles: ['x'], installed: false }

/**
 * A monorepo: a root project with sources of its own, a JS package and a Python
 * package. `.env` belongs to no language — it is what a repo-scoped scan flags.
 */
const MONO_FILES: FileInventory = inventoryOf([
  '.env',
  'package.json',
  'packages/api/api/main.py',
  'packages/api/pyproject.toml',
  'packages/web/package.json',
  'packages/web/src/app.ts',
  'src/root.ts',
])

const MONO: RepoContext = {
  repoRoot: '/repo',
  files: MONO_FILES,
  scratch: SCRATCH,
  projects: partitionProjects(MONO_FILES),
}

/** A language adapter that applies where the *project's* inventory has its language. */
function languageAdapter(language: Language, runners: readonly ToolRunner[]): LanguageAdapter {
  return {
    language,
    runners,
    detect: async (ctx) => ctx.project.files.byLanguage[language].length > 0,
  }
}

/** The cross-language adapter, which applies to any repo with a file in it. */
function commonAdapter(runners: readonly ToolRunner[]): LanguageAdapter {
  return { language: 'common', runners, detect: async (ctx) => ctx.files.all.length > 0 }
}

/** What ran, and where: the planning matrix as a readable table. */
function matrix(result: { readonly runs: readonly RunRecord[] }): [string, string][] {
  return result.runs.map((run) => [run.tool, run.project])
}

describe('runScan planning across projects', () => {
  it('plans a language runner once per project that has its language', async () => {
    const oxlint = fakeRunner('oxlint', 'lint', async () => ok())
    const ruff = fakeRunner('ruff', 'lint', async () => ok())

    const result = await runScan(MONO, [
      languageAdapter('js-ts', [oxlint]),
      languageAdapter('python', [ruff]),
    ])

    expect(matrix(result)).toEqual([
      ['oxlint', '.'],
      ['oxlint', 'packages/web'],
      ['ruff', 'packages/api'],
    ])
    // Each run sees its own project's files, not the repo's.
    expect(oxlint.calls.map((call) => call.files)).toEqual([
      ['src/root.ts'],
      ['packages/web/src/app.ts'],
    ])
    expect(oxlint.calls.map((call) => call.project.path)).toEqual(['.', 'packages/web'])
  })

  it('detects ownership per project, so each run gets its own project’s config', async () => {
    const detections: string[] = []
    const tsc = fakeRunner(
      'tsc',
      'types',
      async () => ok(),
      async (ctx) => {
        detections.push(ctx.project.path)
        return ctx.project.path === 'packages/web' ? DETECTION : null
      },
    )

    const result = await runScan(MONO, [languageAdapter('js-ts', [tsc])])

    expect(detections).toEqual(['.', 'packages/web'])
    expect(result.runs.map((run) => [run.project, run.detection !== null])).toEqual([
      ['.', false],
      ['packages/web', true],
    ])
  })

  it('runs a repo-scoped runner once over the whole repo, whatever the project count', async () => {
    const gitleaks: ToolRunner = {
      ...fakeRunner('gitleaks', 'security', async () => ok()),
      repoScoped: true,
      complementary: true,
    }
    const opengrep = {
      ...fakeRunner('opengrep', 'security', async () => ok()),
      complementary: true,
    }

    const result = await runScan(MONO, [commonAdapter([gitleaks, opengrep])])

    expect(matrix(result)).toEqual([
      ['gitleaks', 'repo'],
      ['opengrep', '.'],
      ['opengrep', 'packages/api'],
      ['opengrep', 'packages/web'],
    ])
    expect((gitleaks as FakeRunner).calls[0]?.files).toEqual(MONO_FILES.all)
  })

  /** Spec §1's exclusive branches, decided per project rather than per repo. */
  it('stands our default down only in the project that owns the tool', async () => {
    const eslint: ToolRunner = {
      ...fakeRunner(
        'eslint',
        'lint',
        async () => ok(),
        async (ctx) =>
          ctx.project.path === 'packages/web' ? { ...DETECTION, installed: true } : null,
      ),
      repoOwnedOnly: true,
    }
    const oxlint = fakeRunner('oxlint', 'lint', async () => ok())

    const result = await runScan(MONO, [languageAdapter('js-ts', [eslint, oxlint])])

    expect(matrix(result)).toEqual([
      ['eslint', 'packages/web'],
      ['oxlint', '.'],
    ])
  })

  it('resolves a standby against its own project, never against a sibling’s owner', async () => {
    const eslint: ToolRunner = {
      ...fakeRunner(
        'eslint',
        'lint',
        async () => ok(),
        async (ctx) => (ctx.project.path === 'packages/web' ? DETECTION : null),
      ),
      repoOwnedOnly: true,
    }
    const oxlint = fakeRunner('oxlint', 'lint', async (ctx) =>
      ok([makeFinding({ id: `o-${ctx.project.path}`, tool: 'oxlint', category: 'lint' })]),
    )

    const result = await runScan(MONO, [languageAdapter('js-ts', [eslint, oxlint])])

    // The root project never had an owner, so its oxlint run is not a standby…
    expect(result.runs.find((run) => run.project === '.')?.result.reason).toBeUndefined()
    // …while the package that owns ESLint has its oxlint stood down by it.
    expect(
      result.runs.find((run) => run.project === 'packages/web' && run.tool === 'oxlint')?.result
        .reason,
    ).toBe('stood down: lint graded by eslint')
  })
})

describe('runScan repo-wide duplication pass', () => {
  /**
   * A jscpd stand-in. The repo-wide pass is the one handed the whole inventory;
   * every other run gets its own project's slice, which is what tells them apart
   * from inside a runner.
   */
  const jscpd = (repoWide: number, perProject: Readonly<Record<string, number>>): ToolRunner => ({
    ...fakeRunner('jscpd', 'duplication', async (ctx) => ({
      ...ok(),
      metrics: {
        duplicationPercent:
          ctx.files.length === MONO_FILES.all.length
            ? repoWide
            : (perProject[ctx.project.path] ?? 0),
      },
    })),
    repoWidePass: true,
  })

  it('runs beside the per-project passes and is marked for the rollup alone', async () => {
    const result = await runScan(MONO, [commonAdapter([jscpd(5, {})])])

    expect(result.runs.map((run) => [run.project, run.rollupOnly])).toEqual([
      ['.', false],
      ['packages/api', false],
      ['packages/web', false],
      ['repo', true],
    ])
  })

  /** A clone between two packages is in neither package's measurement. */
  it('gives the rollup the whole-repo percentage, not the worst project’s', async () => {
    const result = await runScan(MONO, [
      commonAdapter([jscpd(5, { '.': 4, 'packages/api': 40, 'packages/web': 2 })]),
    ])

    expect(result.metrics.duplication).toEqual({ duplicationPercent: 5 })
  })

  /**
   * A package directory called `repo/` has the same attribution string a
   * repo-spanning run does. If ownership were decided on that string, the
   * package's own config would stand the repo-wide pass down — and the rollup's
   * duplication would quietly fall back to the largest package's, which is the
   * number the repo-wide pass exists to replace.
   */
  it('is not stood down by a package that happens to be called repo/', async () => {
    const files = inventoryOf([
      'package.json',
      'repo/.jscpd.json',
      'repo/package.json',
      'repo/src/b.ts',
      'src/a.ts',
    ])
    const owned: ToolRunner = {
      ...fakeRunner(
        'jscpd',
        'duplication',
        async (ctx) => ({
          ...ok(),
          metrics: { duplicationPercent: ctx.files.length === files.all.length ? 5 : 40 },
        }),
        async (ctx) => (ctx.project.path === 'repo' ? DETECTION : null),
      ),
      repoWidePass: true,
    }

    const result = await runScan(
      { repoRoot: '/repo', files, scratch: SCRATCH, projects: partitionProjects(files) },
      [commonAdapter([owned])],
    )

    expect(result.runs.map((run) => [run.project, run.repoWide, run.rollupOnly])).toEqual([
      ['.', false, false],
      ['repo', false, false],
      [REPO_SCOPE, true, true],
    ])
    // The rollup's percentage is the repo-wide pass's, not the package's 40.
    expect(result.metrics.duplication).toEqual({ duplicationPercent: 5 })
  })

  /**
   * Scoping narrows the project dimension and nothing else: two packages
   * selected out of three still have a "between" to measure, and the rollup is
   * where that measurement belongs.
   */
  it('still runs the repo-wide pass when more than one project is scanned', async () => {
    const scoped: RepoContext = {
      ...MONO,
      projects: MONO.projects.filter((project) => project.path !== '.'),
    }

    const result = await runScan(scoped, [commonAdapter([jscpd(5, {})])])

    expect(result.runs.map((run) => [run.project, run.rollupOnly])).toEqual([
      ['packages/api', false],
      ['packages/web', false],
      ['repo', true],
    ])
  })

  /**
   * A parent project holding packages of its own must not measure their code as
   * its duplication — nor the clones between them, which belong to the rollup
   * alone. The file list already excludes them; a runner handed a *directory*
   * needs telling.
   */
  it('tells each per-project run which projects are nested inside it', async () => {
    const runner: ToolRunner = {
      ...fakeRunner('jscpd', 'duplication', async () => ok()),
      repoWidePass: true,
    }

    await runScan(MONO, [commonAdapter([runner])])

    // Sorted: the pool decides which run starts first, and nothing here is about
    // that. The repo-wide pass is the one handed the whole inventory.
    const nesting = (runner as FakeRunner).calls
      .map((call) => {
        const unit = call.files.length === MONO_FILES.all.length ? 'repo-wide' : call.project.path
        return `${unit} → [${(call.nestedProjects ?? []).join(' ')}]`
      })
      .toSorted()

    expect(nesting).toEqual([
      '. → [packages/api packages/web]',
      'packages/api → []',
      'packages/web → []',
      // The repo-wide pass is the one that is supposed to see everything.
      'repo-wide → []',
    ])
  })

  /**
   * …and the list is the repo's, not the selection's. `--project .` must not
   * make the packages inside the root part of it: a project's own grade cannot
   * depend on which *other* projects a run was scoped to.
   */
  it('keeps the nested list the same when the scan is scoped', async () => {
    const runner = fakeRunner('jscpd', 'duplication', async () => ok())
    const root = MONO.projects.filter((project) => project.path === '.')

    await runScan({ ...MONO, projects: root, allProjects: MONO.projects }, [
      commonAdapter([{ ...runner, repoWidePass: true }]),
    ])

    expect((runner as FakeRunner).calls.map((call) => call.nestedProjects)).toEqual([
      ['packages/api', 'packages/web'],
    ])
  })

  it('adds no second pass to a single-project repo', async () => {
    const runner: ToolRunner = {
      ...fakeRunner('jscpd', 'duplication', async () => ({
        ...ok(),
        metrics: { duplicationPercent: 3 },
      })),
      repoWidePass: true,
    }

    const result = await runScan(REPO, [commonAdapter([runner])])

    expect(result.runs.map((run) => [run.project, run.rollupOnly])).toEqual([['.', false]])
    expect(result.metrics.duplication).toEqual({ duplicationPercent: 3 })
  })

  it('reports a clone both passes found once, under its one identity', async () => {
    const clone = makeFinding({ id: 'clone-1', category: 'duplication', file: 'src/root.ts' })
    const runner: ToolRunner = {
      ...fakeRunner('jscpd', 'duplication', async (ctx) =>
        ok(ctx.project.path === 'packages/api' ? [] : [clone]),
      ),
      repoWidePass: true,
    }

    const result = await runScan(MONO, [commonAdapter([runner])])

    expect(result.findings.map((finding) => finding.id)).toEqual(['clone-1'])
  })
})

describe('runScan finding attribution', () => {
  it('stamps every finding with the project its file is in', async () => {
    const runner = fakeRunner('oxlint', 'lint', async (ctx) =>
      ok(
        ctx.project.path === '.'
          ? [makeFinding({ id: 'root', file: 'src/root.ts' })]
          : [makeFinding({ id: 'web', file: 'packages/web/src/app.ts' })],
      ),
    )

    const result = await runScan(MONO, [languageAdapter('js-ts', [runner])])

    expect(result.findings.map((finding) => [finding.id, finding.project])).toEqual([
      ['web', 'packages/web'],
      ['root', '.'],
    ])
  })

  /** The whole point of a repo-scoped scan: one run, findings in many projects. */
  it('attributes a repo-scoped run’s findings by path, not to the run’s scope', async () => {
    const gitleaks: ToolRunner = {
      ...fakeRunner('gitleaks', 'security', async () =>
        ok([
          makeFinding({ id: 'in-web', category: 'security', file: 'packages/web/src/app.ts' }),
          makeFinding({ id: 'in-api', category: 'security', file: 'packages/api/api/main.py' }),
          makeFinding({ id: 'at-root', category: 'security', file: '.env' }),
          makeFinding({ id: 'unclaimed', category: 'security', file: 'infra/deploy.yaml' }),
        ]),
      ),
      repoScoped: true,
    }

    const result = await runScan(MONO, [commonAdapter([gitleaks])])

    expect(
      Object.fromEntries(result.findings.map((finding) => [finding.id, finding.project])),
    ).toEqual({
      'in-web': 'packages/web',
      'in-api': 'packages/api',
      'at-root': '.',
      // Under no project at all, but the root is a project here, so it is its.
      unclaimed: '.',
    })
  })

  /**
   * With a workspace shell at the root there is no project at `.`, and a
   * workflow file belongs to none of the packages. Stamping it `.` would put a
   * task under a project that is not in `projects[]` at all.
   */
  it('leaves a finding no project claims unattributed', async () => {
    const files = inventoryOf([
      '.github/workflows/ci.yml',
      'package.json',
      'packages/web/package.json',
      'packages/web/src/app.ts',
    ])
    const gitleaks: ToolRunner = {
      ...fakeRunner('gitleaks', 'security', async () =>
        ok([
          makeFinding({ id: 'in-web', category: 'security', file: 'packages/web/src/app.ts' }),
          makeFinding({ id: 'in-ci', category: 'security', file: '.github/workflows/ci.yml' }),
        ]),
      ),
      repoScoped: true,
    }

    const result = await runScan(
      { repoRoot: '/repo', files, scratch: SCRATCH, projects: partitionProjects(files) },
      [commonAdapter([gitleaks])],
    )

    expect(result.findings.map((finding) => [finding.id, finding.project])).toEqual([
      ['in-ci', undefined],
      ['in-web', 'packages/web'],
    ])
    expect(result.findings.find((finding) => finding.id === 'in-ci')).not.toHaveProperty('project')
  })
})

describe('runScan raw staging', () => {
  it('gives every job a distinct posix-nested scratch dir that exists', async () => {
    const oxlint = fakeRunner('oxlint', 'lint', async () => ok())
    const ruff = fakeRunner('ruff', 'lint', async () => ok())
    const gitleaks: ToolRunner = {
      ...fakeRunner('gitleaks', 'security', async () => ok()),
      repoScoped: true,
    }

    const result = await runScan(MONO, [
      languageAdapter('js-ts', [oxlint]),
      languageAdapter('python', [ruff]),
      commonAdapter([gitleaks]),
    ])

    const prefixes = result.runs.map((run) => rawPrefix(run.project, run.repoWide))
    expect(prefixes).toEqual(['root', 'packages/web', 'packages/api', 'repo'])
    expect(prefixes.some((prefix) => prefix.includes('\\'))).toBe(false)

    const scratches = [...oxlint.calls, ...ruff.calls, ...(gitleaks as FakeRunner).calls]
      .map((call) => call.scratch)
      .toSorted()
    expect(scratches).toEqual(
      prefixes.map((prefix) => join(SCRATCH, ...prefix.split('/'))).toSorted(),
    )
    expect(await Promise.all(scratches.map(isDirectory))).toEqual(scratches.map(() => true))
  })

  /**
   * The reserved `raw/root` and `raw/repo` are names a repo may already use for
   * a package. Two runs staging into one directory is evidence one of them
   * loses — and a report a tool reads back out of the wrong file.
   */
  it('keeps a project called root or repo out of the reserved directories', async () => {
    const files = inventoryOf([
      'package.json',
      'repo/package.json',
      'repo/src/b.ts',
      'root/package.json',
      'root/src/a.ts',
      'src/root.ts',
    ])
    const oxlint = fakeRunner('oxlint', 'lint', async () => ok())
    const gitleaks: ToolRunner = {
      ...fakeRunner('gitleaks', 'security', async () => ok()),
      repoScoped: true,
    }

    const result = await runScan(
      { repoRoot: '/repo', files, scratch: SCRATCH, projects: partitionProjects(files) },
      [languageAdapter('js-ts', [oxlint]), commonAdapter([gitleaks])],
    )

    // Three of these four `project` strings are project paths and one is the
    // repo scope — and two of them are spelled the same.
    expect(result.runs.map((run) => [run.project, run.repoWide])).toEqual([
      ['.', false],
      ['repo', false],
      ['root', false],
      [REPO_SCOPE, true],
    ])

    const scratches = [...oxlint.calls, ...(gitleaks as FakeRunner).calls]
      .map((call) => call.scratch)
      .toSorted()
    expect(new Set(scratches).size).toBe(scratches.length)
    expect(scratches).toEqual(
      [
        join(SCRATCH, 'root'), // the root project
        join(SCRATCH, 'root_'), // the package called `root/`
        join(SCRATCH, 'repo_'), // the package called `repo/`
        join(SCRATCH, 'repo'), // the repo-spanning run
      ].toSorted(),
    )
  })
})

/**
 * The rollup's numbers are the whole repo's. Every runner only counts what it
 * was handed, so the merge is what turns per-project measurements back into one
 * — and a rule that took the largest project's count would grade three packages
 * against the size of one.
 */
describe('runScan rollup metrics', () => {
  const formatter = (tool: string, files: number): ToolRunner =>
    fakeRunner(tool, 'format', async () => ({ ...ok(), metrics: { formattableFiles: files } }))

  it('sums each project’s count into the rollup', async () => {
    const result = await runScan(MONO, [
      languageAdapter('js-ts', [formatter('prettier', 1)]),
      languageAdapter('python', [formatter('ruff-format', 1)]),
    ])

    // Two JS projects and one Python project, one file each — not `1`.
    expect(result.metrics.format).toEqual({ formattableFiles: 3 })
  })

  it('still takes the larger of two tools measuring the same project’s files', async () => {
    const result = await runScan(REPO, [
      adapter('js-ts', [formatter('prettier', 5), formatter('biome', 3)]),
    ])

    expect(result.metrics.format).toEqual({ formattableFiles: 5 })
  })

  /**
   * Three units measured three things: the root project, a package called
   * `repo/`, and the repo-spanning run whose attribution string that package
   * shares. Merging any two of them as "the same files measured twice" would
   * lose a measurement.
   */
  it('keeps a package called repo/ and a repo-spanning run apart', async () => {
    const files = inventoryOf(['package.json', 'repo/package.json', 'repo/src/b.ts', 'src/a.ts'])
    const spanning: ToolRunner = {
      ...fakeRunner('secretlint', 'format', async () => ({
        ...ok(),
        metrics: { formattableFiles: 10 },
      })),
      repoScoped: true,
      complementary: true,
    }

    const result = await runScan(
      { repoRoot: '/repo', files, scratch: SCRATCH, projects: partitionProjects(files) },
      [commonAdapter([formatter('prettier', 1), spanning])],
    )

    expect(result.metrics.format).toEqual({ formattableFiles: 12 })
  })

  it('sums the mutation counts and re-derives the score over all of them', async () => {
    const stryker = (detected: number, undetected: number): ToolRunner =>
      fakeRunner('stryker', 'test-quality', async (ctx) => ({
        ...ok(),
        metrics:
          ctx.project.path === 'packages/web'
            ? { mutantsDetected: detected, mutantsUndetected: undetected, mutationScore: 90 }
            : { mutantsDetected: 1, mutantsUndetected: 9, mutationScore: 10 },
      }))

    const result = await runScan(MONO, [languageAdapter('js-ts', [stryker(9, 1)])])

    expect(result.metrics['test-quality']).toEqual({
      mutationScore: 50,
      mutantsDetected: 10,
      mutantsUndetected: 10,
    })
  })
})

describe('runScan degradation', () => {
  it('gives every failure mode its own state and still completes the run', async () => {
    const runners = [
      fakeRunner('good', 'lint', async () => ok([makeFinding({ category: 'lint' })])),
      fakeRunner('crasher', 'types', async () => {
        throw new Error('boom')
      }),
      fakeRunner('hanger', 'duplication', never),
      fakeRunner('absent', 'security', async () => ({
        state: 'not-available',
        findings: [],
        rawFiles: [],
        reason: 'uv is not installed',
      })),
    ]

    const result = await runScan(REPO, [adapter('common', runners)], { timeoutMs: 30 })

    expect(result.runs.map((run) => [run.tool, run.result.state])).toEqual([
      ['good', 'ok'],
      ['crasher', 'error'],
      ['hanger', 'timeout'],
      ['absent', 'not-available'],
    ])
    expect(result.categories.lint).toEqual({ status: 'assessed' })
    expect(result.categories.types).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('boom'),
    })
    expect(result.categories.duplication).toMatchObject({
      status: 'not-assessed',
      reason: expect.stringContaining('budget'),
    })
    expect(result.categories.security).toEqual({
      status: 'not-assessed',
      reason: 'uv is not installed',
    })
    expect(result.findings).toHaveLength(1)
  })

  it('grades on what did run when one of a category’s tools fails', async () => {
    const runners = [
      fakeRunner('eslint', 'lint', async () => ok([makeFinding({ tool: 'eslint' })])),
      fakeRunner('biome', 'lint', async () => {
        throw new Error('nope')
      }),
    ]
    const result = await runScan(REPO, [adapter('js-ts', runners)])
    expect(result.categories.lint).toEqual({ status: 'assessed' })
    expect(result.findings).toHaveLength(1)
  })

  it('marks categories with no runner as not-assessed', async () => {
    const result = await runScan(REPO, [
      adapter('js-ts', [fakeRunner('a', 'lint', async () => ok())]),
    ])
    expect(result.categories.security).toEqual({
      status: 'not-assessed',
      reason: 'no tool available for this category',
    })
    expect(result.categories['test-quality'].status).toBe('not-assessed')
  })

  it('skips the runners of a language that is not present', async () => {
    const runner = fakeRunner('ruff', 'lint', async () => ok())
    const result = await runScan(REPO, [adapter('python', [runner], false)])
    expect(runner.calls).toHaveLength(0)
    expect(result.categories.lint.status).toBe('not-assessed')
  })

  it('survives a language detector that throws', async () => {
    const broken: LanguageAdapter = {
      language: 'python',
      runners: [fakeRunner('ruff', 'lint', async () => ok())],
      detect: async () => {
        throw new Error('detector exploded')
      },
    }
    const result = await runScan(REPO, [broken])
    expect(result.warnings.join()).toContain('detector exploded')
    expect(result.categories.lint.status).toBe('not-assessed')
  })

  it('falls back to the default config when a tool detector throws', async () => {
    const runner = fakeRunner(
      'oxlint',
      'lint',
      async () => ok(),
      async () => {
        throw new Error('unreadable package.json')
      },
    )
    const result = await runScan(REPO, [adapter('js-ts', [runner])])
    expect(runner.calls[0]?.detection).toBeNull()
    expect(result.warnings.join()).toContain('unreadable package.json')
    expect(result.categories.lint).toEqual({ status: 'assessed' })
  })
})

describe('runScan context', () => {
  it('hands each runner its language file list, and everything to common runners', async () => {
    const js = fakeRunner('oxlint', 'lint', async () => ok())
    const py = fakeRunner('ruff', 'lint', async () => ok())
    const common = fakeRunner('jscpd', 'duplication', async () => ok())

    await runScan(
      REPO,
      [adapter('js-ts', [js]), adapter('python', [py]), adapter('common', [common])],
      { timeoutMs: 4321 },
    )

    expect(js.calls[0]?.files).toEqual(['src/a.ts'])
    expect(py.calls[0]?.files).toEqual(['src/b.py'])
    expect(common.calls[0]?.files).toEqual(REPO.files.all)
    expect(js.calls[0]).toMatchObject({
      repoRoot: '/repo',
      // The root project's own scratch dir, mirroring where its raw output lands.
      scratch: join(SCRATCH, 'root'),
      timeoutMs: 4321,
      detection: null,
    })
  })

  it('passes a repo-owned detection through to the runner', async () => {
    const detection: Detection = {
      reason: 'config',
      configFiles: ['eslint.config.js'],
      installed: true,
    }
    const runner = fakeRunner(
      'eslint',
      'lint',
      async () => ok(),
      async () => detection,
    )
    const result = await runScan(REPO, [adapter('js-ts', [runner])])
    expect(runner.calls[0]?.detection).toEqual(detection)
    expect(result.runs[0]?.detection).toEqual(detection)
  })

  it('honours --only', async () => {
    const lint = fakeRunner('oxlint', 'lint', async () => ok())
    const security = fakeRunner('gitleaks', 'security', async () => ok())
    const result = await runScan(REPO, [adapter('common', [lint, security])], {
      only: ['security'],
    })

    expect(lint.calls).toHaveLength(0)
    expect(security.calls).toHaveLength(1)
    expect(result.categories.lint).toEqual({
      status: 'not-assessed',
      reason: 'not selected by --only',
    })
    expect(result.categories.security).toEqual({ status: 'assessed' })
  })
})

describe('runScan tool selection', () => {
  it('skips a repo-owned-only runner the repo did not choose', async () => {
    const eslint = { ...fakeRunner('eslint', 'lint', async () => ok()), repoOwnedOnly: true }
    const oxlint = fakeRunner('oxlint', 'lint', async () => ok())
    const result = await runScan(REPO, [adapter('js-ts', [eslint, oxlint])])

    expect(result.runs.map((run) => run.tool)).toEqual(['oxlint'])
    expect(result.categories.lint).toEqual({ status: 'assessed' })
  })

  it('runs a repo-owned-only runner the repo did choose', async () => {
    const eslint = {
      ...fakeRunner(
        'eslint',
        'lint',
        async () => ok(),
        async () => DETECTION,
      ),
      repoOwnedOnly: true,
    }
    const result = await runScan(REPO, [adapter('js-ts', [eslint])])
    expect(result.runs.map((run) => run.tool)).toEqual(['eslint'])
  })

  /** Spec §1's two branches are exclusive: owned → their tool, not owned → ours. */
  it('stands our default down in a category this language already owns', async () => {
    const biome = fakeRunner(
      'biome-format',
      'format',
      async () => ok(),
      async () => DETECTION,
    )
    const prettier = fakeRunner('prettier', 'format', async () => ok())
    const oxlint = fakeRunner('oxlint', 'lint', async () => ok())

    const result = await runScan(REPO, [adapter('js-ts', [biome, prettier, oxlint])])

    expect(result.runs.map((run) => run.tool)).toEqual(['biome-format', 'oxlint'])
    expect(prettier.calls).toHaveLength(0)
  })

  it('still merges two repo-owned tools in the same category', async () => {
    const eslint = fakeRunner(
      'eslint',
      'lint',
      async () => ok([makeFinding({ id: 'e', tool: 'eslint' })]),
      async () => DETECTION,
    )
    const biome = fakeRunner(
      'biome-lint',
      'lint',
      async () => ok([makeFinding({ id: 'b', tool: 'biome-lint' })]),
      async () => DETECTION,
    )
    const result = await runScan(REPO, [adapter('js-ts', [eslint, biome])])
    expect(result.runs.map((run) => run.tool)).toEqual(['eslint', 'biome-lint'])
    expect(result.findings).toHaveLength(2)
  })

  it('scopes ownership to one language, so Python cannot silence a JS default', async () => {
    const ruff = fakeRunner(
      'ruff-format',
      'format',
      async () => ok(),
      async () => DETECTION,
    )
    const prettier = fakeRunner('prettier', 'format', async () => ok())
    const result = await runScan(REPO, [adapter('python', [ruff]), adapter('js-ts', [prettier])])
    expect(result.runs.map((run) => run.tool)).toEqual(['ruff-format', 'prettier'])
  })

  /**
   * Security tools are a union, not a menu (spec "Categories and tools":
   * "opengrep + gitleaks + zizmor + bandit"). A repo that merely declares
   * bandit must not thereby lose its secrets scan — the failure that would
   * matter most, and would happen silently.
   */
  it('never stands a complementary runner down, whoever owns the category', async () => {
    const bandit: ToolRunner = {
      ...fakeRunner(
        'bandit',
        'security',
        async () => ok(),
        async () => DETECTION,
      ),
      complementary: true,
    }
    const gitleaks = {
      ...fakeRunner('gitleaks', 'security', async () => ok()),
      complementary: true,
    }
    const opengrep = {
      ...fakeRunner('opengrep', 'security', async () => ok()),
      complementary: true,
    }

    const result = await runScan(REPO, [adapter('common', [bandit, gitleaks, opengrep])])

    expect(result.runs.map((run) => run.tool)).toEqual(['bandit', 'gitleaks', 'opengrep'])
  })

  /** And a complementary runner does not confer ownership on an ordinary one. */
  it('leaves an ordinary default alone when only a complementary runner is owned', async () => {
    const owned: ToolRunner = {
      ...fakeRunner(
        'gitleaks',
        'security',
        async () => ok(),
        async () => DETECTION,
      ),
      complementary: true,
    }
    const ordinary = fakeRunner('some-sast', 'security', async () => ok())
    const result = await runScan(REPO, [adapter('common', [owned, ordinary])])
    expect(result.runs.map((run) => run.tool)).toEqual(['gitleaks', 'some-sast'])
  })
})

/**
 * A `repoOwnedOnly` tool the repo declared but did not install has to be fetched
 * before it can say anything, and that fetch can fail. Suppressing our default
 * on the strength of a tool that might not run is how a category goes silently
 * ungraded. So the default is scheduled anyway, as a *standby*: it runs, and
 * then either stands down (the owner graded the category) or is promoted (the
 * owner did not, and the repo is told which config the grade came from).
 */
describe('runScan standby', () => {
  const ownedOnly = (
    tool: string,
    category: Category,
    run: (ctx: RunContext) => Promise<ToolResult>,
    detection: Detection = DETECTION,
  ): ToolRunner => ({
    ...fakeRunner(tool, category, run, async () => detection),
    repoOwnedOnly: true,
  })

  it('runs our default behind an owner that is not installed, then stands it down', async () => {
    const eslint = ownedOnly('eslint', 'lint', async () =>
      ok([makeFinding({ id: 'e', tool: 'eslint', category: 'lint' })]),
    )
    const oxlint = fakeRunner('oxlint', 'lint', async () =>
      ok([makeFinding({ id: 'o', tool: 'oxlint', category: 'lint' })]),
    )

    const result = await runScan(REPO, [adapter('js-ts', [eslint, oxlint])])

    expect(result.runs.map((run) => run.tool)).toEqual(['eslint', 'oxlint'])
    const stood = result.runs.find((run) => run.tool === 'oxlint')
    expect(stood?.result.findings).toEqual([])
    expect(stood?.result.reason).toBe('stood down: lint graded by eslint')
    expect(stood?.result.state).toBe('ok')
    expect(result.findings.map((finding) => finding.id)).toEqual(['e'])
    expect(result.categories.lint).toEqual({ status: 'assessed' })
  })

  it('promotes the standby when the owner could not run, and says whose config graded', async () => {
    const eslint = ownedOnly('eslint', 'lint', async () => ({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'x',
    }))
    const oxlint = fakeRunner('oxlint', 'lint', async () =>
      ok([makeFinding({ id: 'o', tool: 'oxlint', category: 'lint' })]),
    )

    const result = await runScan(REPO, [adapter('js-ts', [eslint, oxlint])])

    expect(result.findings.map((finding) => finding.id)).toEqual(['o'])
    expect(result.categories.lint).toEqual({ status: 'assessed' })
    expect(result.warnings).toContain(
      'oxlint: graded lint on its default config because eslint reported not-available',
    )
  })

  it('names every owner that failed, in a stable order', async () => {
    const eslint = ownedOnly('eslint', 'lint', async () => ({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'x',
    }))
    const biome = ownedOnly('biome-lint', 'lint', async () => ({
      state: 'error',
      findings: [],
      rawFiles: [],
      reason: 'boom',
    }))
    const oxlint = fakeRunner('oxlint', 'lint', async () =>
      ok([makeFinding({ id: 'o', tool: 'oxlint', category: 'lint' })]),
    )

    const result = await runScan(REPO, [adapter('js-ts', [eslint, biome, oxlint])])

    expect(result.warnings).toContain(
      'oxlint: graded lint on its default config because biome-lint reported error, eslint reported not-available',
    )
  })

  /** Nothing graded the category, so there is no config difference to report. */
  it('says nothing when the standby failed too — the category degrades on its own', async () => {
    const eslint = ownedOnly('eslint', 'lint', async () => ({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'x',
    }))
    const oxlint = fakeRunner('oxlint', 'lint', async () => ({
      state: 'error',
      findings: [],
      rawFiles: [],
      reason: 'crashed: boom',
    }))

    const result = await runScan(REPO, [adapter('js-ts', [eslint, oxlint])])

    expect(result.warnings).toEqual([])
    expect(result.categories.lint).toMatchObject({
      status: 'error',
      reason: expect.stringContaining('boom'),
    })
  })

  it('stands a failed standby down too, keeping the state that explains it', async () => {
    const eslint = ownedOnly('eslint', 'lint', async () => ok())
    const oxlint = fakeRunner('oxlint', 'lint', async () => ({
      state: 'error',
      findings: [],
      rawFiles: [],
      reason: 'crashed: boom',
      metrics: { functionsTotal: 9 },
    }))

    const result = await runScan(REPO, [adapter('js-ts', [eslint, oxlint])])

    const stood = result.runs.find((run) => run.tool === 'oxlint')
    expect(stood?.result.state).toBe('error')
    expect(stood?.result.reason).toBe('stood down: lint graded by eslint')
    expect('metrics' in (stood?.result ?? {})).toBe(false)
  })

  it('schedules no standby when the owner is installed and can simply run', async () => {
    const eslint = ownedOnly('eslint', 'lint', async () => ok(), {
      ...DETECTION,
      installed: true,
    })
    const oxlint = fakeRunner('oxlint', 'lint', async () => ok())

    const result = await runScan(REPO, [adapter('js-ts', [eslint, oxlint])])

    expect(result.runs.map((run) => run.tool)).toEqual(['eslint'])
    expect(oxlint.calls).toHaveLength(0)
  })

  /** Python owning its formatter says nothing about who formats the JavaScript. */
  it('resolves a standby against its own language, never across scopes', async () => {
    const ruff = fakeRunner(
      'ruff-format',
      'format',
      async () => ok(),
      async () => DETECTION,
    )
    const biome = ownedOnly('biome-format', 'format', async () => ({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'x',
    }))
    const prettier = fakeRunner('prettier', 'format', async () =>
      ok([makeFinding({ id: 'p', tool: 'prettier', category: 'format' })]),
    )

    const result = await runScan(REPO, [
      adapter('python', [ruff]),
      adapter('js-ts', [biome, prettier]),
    ])

    expect(result.findings.map((finding) => finding.id)).toEqual(['p'])
    expect(result.runs.find((run) => run.tool === 'prettier')?.result.reason).toBeUndefined()
    expect(result.warnings).toContain(
      'prettier: graded format on its default config because biome-format reported not-available',
    )
  })

  /**
   * The same tool can own a category in two languages and fare differently in
   * each — `ruff` formats Python and nothing else. So a standby is resolved
   * against the run in *its* language, not against whichever run happens to
   * share a name.
   */
  it('does not settle a standby against a same-named owner from another language', async () => {
    const inPython = fakeRunner(
      'shared-fmt',
      'format',
      async () => ok(),
      async () => DETECTION,
    )
    const inJs = ownedOnly('shared-fmt', 'format', async () => ({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'x',
    }))
    const prettier = fakeRunner('prettier', 'format', async () =>
      ok([makeFinding({ id: 'p', tool: 'prettier', category: 'format' })]),
    )

    const result = await runScan(REPO, [
      adapter('python', [inPython]),
      adapter('js-ts', [inJs, prettier]),
    ])

    expect(result.findings.map((finding) => finding.id)).toEqual(['p'])
    expect(result.warnings).toContain(
      'prettier: graded format on its default config because shared-fmt reported not-available',
    )
  })

  /**
   * A complementary runner never conferred ownership, so its success is not the
   * owner's — it cannot stand our default down, and it is not named as a reason
   * the default had to grade.
   */
  it('is not stood down by a complementary runner that happened to succeed', async () => {
    const eslint = ownedOnly('eslint', 'lint', async () => ({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'x',
    }))
    const extra: ToolRunner = {
      ...fakeRunner(
        'lint-extra',
        'lint',
        async () => ok([makeFinding({ id: 'x', tool: 'lint-extra', category: 'lint' })]),
        async () => DETECTION,
      ),
      complementary: true,
    }
    const oxlint = fakeRunner('oxlint', 'lint', async () =>
      ok([makeFinding({ id: 'o', tool: 'oxlint', category: 'lint' })]),
    )

    const result = await runScan(REPO, [adapter('js-ts', [eslint, extra, oxlint])])

    expect(result.warnings).toContain(
      'oxlint: graded lint on its default config because eslint reported not-available',
    )
    expect(result.findings.map((finding) => finding.id)).toContain('o')
  })

  /** No default beside the owner — as in `test-quality` — is nothing to keep. */
  it('schedules no standby in a category that has no default of ours', async () => {
    const stryker = ownedOnly('stryker', 'test-quality', async () => ok())
    const coverage: ToolRunner = {
      ...fakeRunner('coverage', 'test-quality', async () => ok()),
      complementary: true,
    }

    const result = await runScan(REPO, [adapter('js-ts', [stryker, coverage])], { deep: true })

    expect(result.runs.map((run) => run.tool)).toEqual(['stryker', 'coverage'])
    expect(result.runs.some((run) => run.result.reason?.startsWith('stood down'))).toBe(false)
  })

  /** A stood-down measurement is not part of the grade's denominator either. */
  it('drops a stood-down standby’s metrics before they can merge', async () => {
    const biome = ownedOnly('biome-format', 'format', async () => ({
      ...ok(),
      metrics: { formattableFiles: 4 },
    }))
    const prettier = fakeRunner('prettier', 'format', async () => ({
      ...ok(),
      metrics: { formattableFiles: 9 },
    }))

    const result = await runScan(REPO, [adapter('js-ts', [biome, prettier])])

    expect(result.metrics.format).toEqual({ formattableFiles: 4 })
  })
})

describe('runScan metrics', () => {
  const measuring = (tool: string, category: Category, metrics: ToolMetrics) =>
    fakeRunner(tool, category, async () => ({ ...ok(), metrics }))

  /**
   * Two tools in one language are counting the same files, so the count is the
   * better-informed of the two — never their sum, which would invent functions.
   */
  it('takes the larger count when two tools measured the same language', async () => {
    const result = await runScan(REPO, [
      adapter('js-ts', [
        measuring('fallow-health', 'complexity', { functionsTotal: 40, functionsOverCeiling: 3 }),
        measuring('other', 'complexity', { functionsTotal: 10, functionsOverCeiling: 1 }),
      ]),
    ])
    expect(result.metrics.complexity).toEqual({ functionsTotal: 40, functionsOverCeiling: 3 })
  })

  /**
   * Two languages are counting disjoint files, so a mixed repo's denominator is
   * their sum — this is what keeps a JS+Python repo from being graded against
   * the file count of whichever language happens to be bigger.
   */
  it('adds the counts across languages', async () => {
    const result = await runScan(REPO, [
      adapter('js-ts', [
        measuring('fallow-health', 'complexity', { functionsTotal: 40, functionsOverCeiling: 3 }),
      ]),
      adapter('python', [
        measuring('complexipy', 'complexity', { functionsTotal: 10, functionsOverCeiling: 1 }),
      ]),
    ])
    expect(result.metrics.complexity).toEqual({ functionsTotal: 50, functionsOverCeiling: 4 })
  })

  it('takes a whole-codebase percentage from the one tool that reports it', async () => {
    const result = await runScan(REPO, [
      adapter('common', [
        measuring('jscpd', 'duplication', { duplicationPercent: 7.5 }),
        fakeRunner('quiet', 'duplication', async () => ok()),
      ]),
    ])
    expect(result.metrics.duplication).toEqual({ duplicationPercent: 7.5 })
  })

  it('takes the largest denominator when several formatters report one', async () => {
    const result = await runScan(REPO, [
      adapter('js-ts', [
        measuring('prettier', 'format', { formattableFiles: 12 }),
        measuring('biome-format', 'format', { formattableFiles: 9 }),
      ]),
    ])
    expect(result.metrics.format).toEqual({ formattableFiles: 12 })
  })

  it('leaves a field absent when nothing measured it, rather than reporting zero', async () => {
    const result = await runScan(REPO, [
      adapter('js-ts', [fakeRunner('x', 'lint', async () => ok())]),
    ])
    expect(result.metrics.lint).toEqual({})
    expect(result.metrics.complexity).toEqual({})
  })

  it('ignores the metrics of a run that did not succeed', async () => {
    const broken = fakeRunner('broken', 'complexity', async () => ({
      state: 'error' as const,
      findings: [],
      rawFiles: [],
      metrics: { functionsTotal: 99 },
    }))
    const result = await runScan(REPO, [adapter('js-ts', [broken])])
    expect(result.metrics.complexity).toEqual({})
  })
})

describe('runScan concurrency', () => {
  it('never exceeds the cap', async () => {
    let inFlight = 0
    let peak = 0
    const runners = Array.from({ length: 9 }, (_, index) =>
      fakeRunner(`tool${index}`, 'lint', async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return ok()
      }),
    )

    await runScan(REPO, [adapter('common', runners)], { concurrency: 2 })

    expect(peak).toBe(2)
  })

  it('does not let one wedged tool hold up the others', async () => {
    const runners = [
      fakeRunner('hanger', 'lint', never),
      fakeRunner('quick', 'security', async () => ok()),
    ]
    const started = Date.now()
    const result = await runScan(REPO, [adapter('common', runners)], {
      timeoutMs: 30,
      concurrency: 1,
    })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.runs.map((run) => run.result.state)).toEqual(['timeout', 'ok'])
  })
})

describe('sortFindings', () => {
  it('orders by category priority, then file, line, rule and id', () => {
    const findings = [
      makeFinding({ id: 'b', category: 'lint', file: 'src/z.ts', range: line(1) }),
      makeFinding({ id: 'a', category: 'security', file: 'src/z.ts', range: line(9) }),
      makeFinding({ id: 'c', category: 'lint', file: 'src/a.ts', range: line(4) }),
      makeFinding({ id: 'd', category: 'lint', file: 'src/a.ts', range: line(2), rule: 'z-rule' }),
      makeFinding({ id: 'e', category: 'lint', file: 'src/a.ts', range: line(2), rule: 'a-rule' }),
      makeFinding({ id: 'f', category: 'types', file: 'src/z.ts', range: line(1) }),
    ]
    expect(sortFindings(findings).map((finding) => finding.id)).toEqual([
      'a',
      'f',
      'e',
      'd',
      'c',
      'b',
    ])
  })

  it('is a pure function of the input order', () => {
    const findings = [
      makeFinding({ id: '2', range: line(2) }),
      makeFinding({ id: '1', range: line(1) }),
    ]
    const once = sortFindings(findings)
    const twice = sortFindings(findings.toReversed())
    expect(once.map((finding) => finding.id)).toEqual(twice.map((finding) => finding.id))
    expect(findings[0]?.id).toBe('2')
  })

  it('aggregates findings from every runner in one sorted list', async () => {
    const result = await runScan(
      REPO,
      [
        adapter('common', [
          fakeRunner('late', 'lint', async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return ok([makeFinding({ id: 'lint-1', category: 'lint' })])
          }),
          fakeRunner('early', 'security', async () =>
            ok([makeFinding({ id: 'sec-1', category: 'security' })]),
          ),
        ]),
      ],
      { concurrency: 4 },
    )
    expect(result.findings.map((finding) => finding.id)).toEqual(['sec-1', 'lint-1'])
  })
})

function line(startLine: number) {
  return { startLine, startCol: 1, endLine: startLine, endCol: 2 }
}
