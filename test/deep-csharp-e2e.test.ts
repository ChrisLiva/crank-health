import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CA1502_SUPPRESSED_REASON } from '../src/adapters/csharp/build.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'

/**
 * `--deep` against the real .NET SDK: one `dotnet build` per project feeding
 * the `types`/`complexity`/`lint` trio.
 *
 * **Gated for the same reason as `deep-python-e2e.test.ts`**: real compilation
 * — restore, per-TFM builds, the injected netanalyzers pin resolving from
 * nuget.org. Run it with:
 *
 * ```
 * CRANK_DEEP_E2E=1 npx vitest run test/deep-csharp-e2e.test.ts
 * ```
 *
 * What it proves that no unit test can: the injected targets, globalconfig and
 * CodeMetricsConfig line up with the SDK as installed; the memoized build runs
 * once for three runners; a multi-targeting build's per-TFM duplicates
 * collapse; a repo's own analyzer config wins over ours; and full compilation
 * leaves the target byte-identical.
 */

const ENABLED = process.env['CRANK_DEEP_E2E'] === '1'

/** Roomy: a cold NuGet cache restores the analyzer pin before compiling. */
const DEEP_TIMEOUT_MS = 600_000

/** The compiled trio, graded from one build. */
const COMPILED = ['types', 'complexity', 'lint'] as const

describe.runIf(ENABLED)('--deep on cs-basic: the compiled trio lights up', () => {
  let fixture: FixtureRepo
  let out: string
  let entriesBefore: readonly string[]
  let deep: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-basic')
    out = await mkdtemp(join(tmpdir(), 'crank-deep-cs-out-'))
    entriesBefore = (await readdir(fixture.root)).toSorted()
    deep = await runHealthScan({ path: fixture.root, out, deep: true })
  }, DEEP_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(out, { recursive: true, force: true })
  })

  it('grades types, complexity and lint from one dotnet build', () => {
    for (const category of COMPILED) {
      expect(deep.report.categories[category]?.status).toBe('graded')
    }
  })

  /** The dormant complexity plant: `Classify` in complex.cs is over the ceiling. */
  it('counts the planted over-ceiling method into the complexity census', () => {
    const metrics = deep.report.metrics['complexity']
    expect(metrics?.functionsOverCeiling).toBeGreaterThanOrEqual(1)
    expect(metrics?.functionsTotal).toBeGreaterThan(metrics?.functionsOverCeiling ?? 0)
  })

  /** The dormant lint plant: the unused field in warnings.cs, as CA1823. */
  it('reports the planted CA lint finding in warnings.cs', () => {
    const planted = deep.report.findings.filter(
      (finding) => finding.category === 'lint' && finding.rule === 'CA1823',
    )
    expect(planted.map((finding) => finding.file)).toEqual(['warnings.cs'])
    expect(planted[0]?.tool).toBe('dotnet-build')
  })

  /**
   * The dead-code plant, from roslynator's ephemeral `find-symbol --unused`
   * run: the unreferenced public method in dead.cs placed at its declaration,
   * and the unused private field that doubles as the CA1823 lint plant — the
   * public-API half is why roslynator owns this category (knip/vulture parity)
   * rather than the build's private-only RCS/CA view.
   */
  it('grades dead-code, with the planted unused symbols at their declarations', () => {
    expect(deep.report.categories['dead-code']?.status).toBe('graded')
    const dead = deep.report.findings.filter((finding) => finding.category === 'dead-code')
    expect(dead.map((finding) => [finding.file, finding.rule, finding.range.startLine])).toEqual([
      ['dead.cs', 'unused-method', 10],
      ['warnings.cs', 'unused-field', 5],
    ])
    expect(dead.map((finding) => finding.tool)).toEqual(['roslynator', 'roslynator'])
    const record = report(deep).tools.find((tool) => tool.tool === 'roslynator')
    expect(record?.state).toBe('ok')
  })

  /**
   * The memo oracle: three tool records reference the build, and the build ran
   * once — exactly one SARIF staged into the project's raw dir.
   */
  it('runs the build once for three runners, restaging one SARIF', async () => {
    const records = report(deep).tools.filter((tool) => tool.tool === 'dotnet-build')
    expect(records.map((record) => record.category)).toEqual([...COMPILED])
    for (const record of records) {
      expect(record.state).toBe('ok')
      expect(record.raw).toContain('raw/root/dotnet-build.sarif.json')
    }
    const raw = await readdir(join(deep.outputDir, 'raw', 'root'))
    expect(raw.filter((name) => name.includes('.sarif'))).toEqual(['dotnet-build.sarif.json'])
  })

  /** Criterion 21 under full compilation: obj/, bin/ and restore all in scratch. */
  it('leaves the target byte-identical after compiling it', async () => {
    expect(await fixture.status()).toBe('')
    expect((await readdir(fixture.root)).toSorted()).toEqual(entriesBefore)
  })
})

describe.runIf(ENABLED)('--deep on cs-multi-target: per-TFM copies collapse', () => {
  let fixture: FixtureRepo
  let deep: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-multi-target')
    deep = await runHealthScan({
      path: fixture.root,
      only: ['types', 'complexity', 'lint'],
      deep: true,
    })
  }, DEEP_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /** Criterion 15 live: net8.0 and net10.0 each report it, the report says it once. */
  it('reports each planted diagnostic exactly once across the TFMs', () => {
    for (const rule of ['CS0219', 'CS0414', 'CA1823']) {
      expect(deep.report.findings.filter((finding) => finding.rule === rule)).toHaveLength(1)
    }
  })

  it('grades all three compiled categories from the merged log', () => {
    for (const category of COMPILED) {
      expect(deep.report.categories[category]?.status).toBe('graded')
    }
  })

  it('leaves the target untouched', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe.runIf(ENABLED)('--deep on cs-ca1502-suppressed: the repo wins the config tie', () => {
  let fixture: FixtureRepo
  let deep: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-ca1502-suppressed')
    deep = await runHealthScan({
      path: fixture.root,
      only: ['types', 'complexity', 'lint'],
      deep: true,
    })
  }, DEEP_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /** Criterion 17: a missing census reads as the repo's own suppression, honestly. */
  it('reports complexity not-assessed, naming the suppression', () => {
    expect(deep.report.categories['complexity']).toEqual({
      status: 'not-assessed',
      reason: CA1502_SUPPRESSED_REASON,
    })
  })

  it('still grades types and lint from the same build', () => {
    expect(deep.report.categories['types']?.status).toBe('graded')
    expect(deep.report.categories['lint']?.status).toBe('graded')
  })

  it('leaves the target untouched', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe.runIf(ENABLED)('--deep on cs-custom-targets: the injection coexists', () => {
  let fixture: FixtureRepo
  let deep: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-custom-targets')
    deep = await runHealthScan({
      path: fixture.root,
      only: ['types', 'complexity', 'lint'],
      deep: true,
    })
  }, DEEP_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /** Criterion 22: a repo already using the hook still builds and still grades. */
  it('completes with no errored build record', () => {
    const records = report(deep).tools.filter((tool) => tool.tool === 'dotnet-build')
    expect(records).toHaveLength(3)
    for (const record of records) expect(record.state).toBe('ok')
  })

  it('leaves the target untouched', async () => {
    expect(await fixture.status()).toBe('')
  })
})

interface ReportShape {
  readonly tools: {
    readonly tool: string
    readonly category: string
    readonly state: string
    readonly raw: readonly string[]
  }[]
}

function report(scan: HealthScanResult): ReportShape {
  return JSON.parse(scan.json) as ReportShape
}
