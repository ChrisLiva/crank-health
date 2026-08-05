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
