import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { QUICK_MODE_DEEP_REASON } from '../src/core/orchestrator.ts'
import type {
  LanguageAdapter,
  RunContext,
  ToolMetrics,
  ToolResult,
  ToolRunner,
} from '../src/core/types.ts'
import { runPrScan } from '../src/run-pr.ts'
import { scanTree } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { createHistoryRepo } from './support/history.ts'

/**
 * The deep profile's plumbing (spec §5), with a stand-in for the mutation tool
 * so that what is under test is the pipeline rather than StrykerJS: which
 * runners a profile admits, what they are told about the diff, and how a
 * mutation score becomes the test-quality grade.
 *
 * The real tool end-to-end is `deep-e2e.test.ts`.
 */

describe('the two profiles', () => {
  let fixture: FixtureRepo
  let scratch: string

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
    scratch = await mkdtemp(join(tmpdir(), 'crank-deep-'))
  })

  afterAll(async () => {
    await fixture.remove()
    await rm(scratch, { recursive: true, force: true })
  })

  it('never runs a deep tool in a quick scan, and says why test quality has no grade', async () => {
    const mutation = fakeRunner({ metrics: { mutationScore: 90 } })
    const tree = await scanTree({
      repoRoot: fixture.root,
      scratch,
      adapters: [adapter(mutation)],
      only: ['test-quality'],
    })

    expect(mutation.calls).toEqual([])
    // Not "a tool declined": in quick mode no mutation tool is even asked.
    expect(tree.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: QUICK_MODE_DEEP_REASON,
    })
    // The reason is stamped where the deferral was decided — the scan's own
    // aggregation, not a downstream override.
    expect(tree.scan.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: QUICK_MODE_DEEP_REASON,
    })
    expect(tree.scan.runs).toEqual([])
  })

  it('calls an unrequested category excluded rather than deferred', async () => {
    const mutation = fakeRunner({})
    const unrequested = await scanTree({
      repoRoot: fixture.root,
      scratch,
      adapters: [adapter(mutation)],
      only: ['lint'],
    })

    // `--only lint` dropped the runner as unrequested — an exclusion, not a
    // deferral, and telling the reader to run `--deep` would not bring it back.
    expect(unrequested.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: 'not selected by --only',
    })
    expect(mutation.calls).toEqual([])
  })

  it('grades test quality from the mutation score in a deep scan', async () => {
    const mutation = fakeRunner({
      // 66 of 100 mutants detected → 66% → B (A ≥80, B ≥65).
      metrics: { mutationScore: 66, mutantsDetected: 66, mutantsUndetected: 34 },
    })
    const tree = await scanTree({
      repoRoot: fixture.root,
      scratch,
      adapters: [adapter(mutation)],
      only: ['test-quality'],
      deep: true,
    })

    expect(tree.categories['test-quality']).toEqual({ status: 'graded', grade: 'B' })
    expect(tree.scan.metrics['test-quality']).toEqual({
      mutationScore: 66,
      mutantsDetected: 66,
      mutantsUndetected: 34,
    })
  })

  it('recomputes one score over both languages rather than taking the better one', async () => {
    const strong = fakeRunner({
      metrics: { mutationScore: 90, mutantsDetected: 90, mutantsUndetected: 10 },
    })
    const weak = fakeRunner({
      metrics: { mutationScore: 20, mutantsDetected: 20, mutantsUndetected: 80 },
    })
    const tree = await scanTree({
      repoRoot: fixture.root,
      scratch,
      adapters: [adapter(strong, 'js-ts'), adapter(weak, 'python')],
      only: ['test-quality'],
      deep: true,
    })

    // 110 detected of 200 = 55% → C, not the JavaScript half's 90 → A.
    expect(tree.scan.metrics['test-quality']?.mutationScore).toBeCloseTo(55, 10)
    expect(tree.categories['test-quality']).toEqual({ status: 'graded', grade: 'C' })
  })

  it('leaves test quality not-assessed when a deep tool ran but scored nothing', async () => {
    const mutation = fakeRunner({ state: 'not-available', reason: 'no mutation tool installed' })
    const tree = await scanTree({
      repoRoot: fixture.root,
      scratch,
      adapters: [adapter(mutation)],
      only: ['test-quality'],
      deep: true,
    })

    // The tool's own reason survives: telling a reader to run `--deep` when
    // they just did would be the one useless thing to say here.
    expect(tree.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: 'no mutation tool installed',
    })
  })
})

describe('a deep PR run', () => {
  it('runs the mutation tool on head only, scoped to the files the diff touched', async () => {
    const mutation = fakeRunner({
      metrics: { mutationScore: 40, mutantsDetected: 4, mutantsUndetected: 6 },
    })
    const history = await createHistoryRepo({
      base: { 'src/keep.js': 'export const keep = 1\n', 'src/edit.js': 'export const edit = 1\n' },
      head: [{ write: 'src/edit.js', content: 'export const edit = 2\n' }],
    })
    const out = await mkdtemp(join(tmpdir(), 'crank-deep-pr-'))

    try {
      const result = await runPrScan({
        path: history.root,
        base: 'main',
        out,
        only: ['test-quality'],
        deep: true,
        adapters: [adapter(mutation)],
      })

      // One call, not two: the base worktree has no installed dependencies to
      // run a test suite with, and mutating it would double the slowest thing
      // crank-health does to answer a question the delta does not ask.
      expect(mutation.calls).toHaveLength(1)
      expect(mutation.calls[0]?.changedFiles).toEqual(['src/edit.js'])
      expect(result.report.profile).toBe('deep')
      expect(result.report.categories['test-quality']).toEqual({ status: 'graded', grade: 'D' })

      const movement = result.report.delta?.categories.find(
        (entry) => entry.category === 'test-quality',
      )
      expect(movement?.base).toEqual({
        status: 'not-assessed',
        reason: 'deep mutation testing runs on the head commit only',
      })
      expect(movement?.head).toEqual({ status: 'graded', grade: 'D' })
      expect(await history.status()).toBe('')
    } finally {
      await history.remove()
      await rm(out, { recursive: true, force: true })
    }
  })
})

interface FakeRunner extends ToolRunner {
  readonly calls: RunContext[]
}

/** A deep runner that reports whatever the test needs it to report. */
function fakeRunner(result: Partial<ToolResult> & { readonly metrics?: ToolMetrics }): FakeRunner {
  const calls: RunContext[] = []
  return {
    tool: 'fake-mutation',
    category: 'test-quality',
    pinnedVersion: '1.0.0',
    deepOnly: true,
    calls,
    detect: async () => null,
    run: async (ctx) => {
      calls.push(ctx)
      return { state: 'ok', findings: [], rawFiles: [], ...result }
    },
  }
}

function adapter(runner: ToolRunner, language: 'js-ts' | 'python' = 'js-ts'): LanguageAdapter {
  return { language, detect: async () => true, runners: [runner] }
}
