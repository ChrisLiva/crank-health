import { describe, expect, it } from 'vitest'
import { runScan, sortFindings } from '../src/core/orchestrator.ts'
import type {
  Category,
  Detection,
  Finding,
  LanguageAdapter,
  RepoContext,
  RunContext,
  RunnerScope,
  ToolMetrics,
  ToolResult,
  ToolRunner,
} from '../src/core/types.ts'
import { makeFinding } from './factories.ts'

const REPO: RepoContext = {
  repoRoot: '/repo',
  files: {
    all: ['src/a.ts', 'src/b.py', 'README.md'],
    byLanguage: { 'js-ts': ['src/a.ts'], python: ['src/b.py'] },
  },
  scratch: '/scratch',
}

interface FakeRunner extends ToolRunner {
  readonly calls: RunContext[]
}

function fakeRunner(
  tool: string,
  category: Category,
  run: (ctx: RunContext) => Promise<ToolResult>,
  detect: () => Promise<Detection | null> = async () => null,
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
      scratch: '/scratch',
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
