import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'

/**
 * The quick profile's time budget (spec §5: "target <1 min mid-size").
 *
 * Opt-in — `CRANK_PERF=1 npm test` — because it measures wall-clock on whatever
 * machine runs it and a cold npm/uv cache spends minutes downloading before any
 * analysis starts. Off by default it would either be flaky or meaningless; on
 * demand it is the repeatable form of the M10 timed probe, which measured 1.5s
 * on this fixture and 2.8s on a 39-KLOC mixed OSS repo, both warm.
 */

const BUDGET_MS = 60_000

/** The budget plus room to observe a breach instead of timing out inside it. */
const TIMEOUT_MS = 180_000

describe.skipIf(process.env['CRANK_PERF'] !== '1')('quick profile performance', () => {
  let fixture: FixtureRepo
  let out: string

  beforeAll(async () => {
    fixture = await createFixtureRepo('mixed-basic')
    out = await mkdtemp(join(tmpdir(), 'crank-perf-'))
  })

  afterAll(async () => {
    await fixture.remove()
    await rm(out, { recursive: true, force: true })
  })

  it(
    'scans the mixed fixture within the quick-profile budget',
    async () => {
      // Warm the caches first: the budget is about crank-health's own work, not
      // about how long npm and uv take to fetch the pinned toolchain once.
      await runHealthScan({ path: fixture.root, out: join(out, 'warmup') })

      const startedAt = Date.now()
      await runHealthScan({ path: fixture.root, out: join(out, 'measured') })
      const elapsedMs = Date.now() - startedAt

      expect(elapsedMs).toBeLessThan(BUDGET_MS)
    },
    TIMEOUT_MS,
  )
})
