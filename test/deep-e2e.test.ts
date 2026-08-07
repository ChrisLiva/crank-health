import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gradeRatio } from '../src/core/grade.ts'
import { QUICK_MODE_DEEP_REASON } from '../src/core/orchestrator.ts'
import type { Finding } from '../src/core/types.ts'
import { buildAgentTasks } from '../src/render/agent-md.ts'
import { renderTerminal } from '../src/render/terminal.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan, scanTree } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'

/**
 * `--deep` against the real StrykerJS, on the `js-weak-tests` fixture: a
 * mutation run that executes the fixture's own `node --test` suite and produces
 * the test-quality grade of spec §5 and acceptance criterion 7.
 *
 * **Gated, because it installs.** Mutation testing only runs against a repo's
 * own installation (see `adapters/jsts/stryker.ts`), so this test has to `npm
 * install` the fixture's `@stryker-mutator/core` — a minute of network on a cold
 * cache, which does not belong in every `npm test`. Run it with:
 *
 * ```
 * CRANK_DEEP_E2E=1 npx vitest run test/deep-e2e.test.ts
 * ```
 *
 * Everything it proves that can be proven without the install is proven anyway:
 * the report parser against captured bytes (`stryker.test.ts`), the profile
 * plumbing against a stand-in tool (`deep.test.ts`).
 */

const ENABLED = process.env['CRANK_DEEP_E2E'] === '1'

/** Roomy: a cold `npm install` plus a full mutation run. */
const DEEP_TIMEOUT_MS = 300_000

describe.runIf(ENABLED)('--deep on a repo with a weak test suite', () => {
  let fixture: FixtureRepo
  let out: string
  let deep: HealthScanResult
  let survived: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-weak-tests')
    out = await mkdtemp(join(tmpdir(), 'crank-deep-out-'))
    await execa('npm', ['install', '--no-audit', '--no-fund', '--silent'], { cwd: fixture.root })

    deep = await runHealthScan({
      path: fixture.root,
      out,
      only: ['test-quality'],
      deep: true,
    })
    survived = deep.report.findings.filter((finding) => finding.rule === 'stryker/survived-mutant')
  }, DEEP_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(out, { recursive: true, force: true })
  })

  it('grades test quality from the mutation score', () => {
    const metrics = deep.report.metrics['test-quality']
    const score = metrics?.mutationScore
    expect(score).toBeDefined()
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(100)
    // The grade is the score put through spec §3's band table, and nothing else.
    expect(deep.report.categories['test-quality']).toEqual({
      status: 'graded',
      grade: gradeRatio('test-quality', score ?? 0),
    })
    expect((metrics?.mutantsDetected ?? 0) + (metrics?.mutantsUndetected ?? 0)).toBeGreaterThan(20)
    expect(deep.report.profile).toBe('deep')
  })

  it('reports the surviving mutants as the evidence behind the score', () => {
    expect(survived.length).toBeGreaterThan(0)
    expect(new Set(survived.map((finding) => finding.file))).toEqual(
      new Set(['src/calc.js', 'src/extra.js']),
    )
    expect(survived.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(survived.every((finding) => finding.gradeScope)).toBe(true)
  })

  it('runs the repo’s own installed Stryker, with the repo’s own config', () => {
    const stryker = deep.report.tools.find((tool) => tool.tool === 'stryker')
    expect(stryker).toMatchObject({
      category: 'test-quality',
      execution: 'repo-installed',
      provenance: 'repo-config',
      state: 'ok',
      version: '9.6.1',
      detection: { reason: 'config+dependency', configFiles: ['stryker.config.json'] },
    })
    expect(stryker?.raw).toContain('raw/stryker-mutation-report.json')
  })

  it('gives an agent one task per weakly tested file', () => {
    const tasks = buildAgentTasks(deep.report)
    expect(tasks.map((task) => task.title)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Strengthen the tests covering `src/calc.js`'),
      ]),
    )
    expect(tasks.every((task) => task.category === 'test-quality')).toBe(true)
  })

  it('says the score in the terminal summary and in report.md', () => {
    expect(deep.markdown).toContain('mutation score')
    expect(deep.markdown).toMatch(/mutants detected/)

    const terminal = renderTerminal(
      deep.report,
      { markdown: 'report.md', agent: 'agent.md', json: 'report.json' },
      { color: false },
    )
    expect(terminal).toMatch(/test quality {2}[A-F] +mutation score \d+\.\d%/)
  })

  it('leaves the target untouched: no reports/, no .stryker-tmp, no changed files', async () => {
    expect(await fixture.status()).toBe('')
    const entries = await readdir(fixture.root)
    expect(entries).not.toContain('reports')
    expect(entries).not.toContain('.stryker-tmp')
    expect(entries).not.toContain('stryker.log')
  })

  it(
    'scopes the mutation run to the changed files, the way a PR run does',
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'crank-deep-scoped-'))
      try {
        const tree = await scanTree({
          repoRoot: fixture.root,
          scratch,
          only: ['test-quality'],
          deep: true,
          changedFiles: ['src/calc.js'],
        })

        const files = new Set(tree.scan.findings.map((finding) => finding.file))
        expect(files).toEqual(new Set(['src/calc.js']))
        // The whole-repo run mutated both files; this one mutated one.
        const scoped = tree.scan.metrics['test-quality']
        const whole = deep.report.metrics['test-quality']
        expect((scoped?.mutantsDetected ?? 0) + (scoped?.mutantsUndetected ?? 0)).toBeLessThan(
          (whole?.mutantsDetected ?? 0) + (whole?.mutantsUndetected ?? 0),
        )
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    },
    DEEP_TIMEOUT_MS,
  )

  it('says "run --deep" for the same repo in the quick profile', async () => {
    const quick = await runHealthScan({ path: fixture.root, out, only: ['test-quality'] })

    expect(quick.report.profile).toBe('quick')
    expect(quick.report.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: QUICK_MODE_DEEP_REASON,
    })
    expect(quick.report.tools).toEqual([])
  })
})
