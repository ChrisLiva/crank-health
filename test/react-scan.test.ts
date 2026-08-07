import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reactDoctorRunner } from '../src/adapters/jsts/react-doctor.ts'
import { gradeCategory } from '../src/core/grade.ts'
import type { Finding, RunContext } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import { makeProject } from './factories.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'

/**
 * End to end through the real seam on `js-react`: an untooled React app whose
 * only new content is react-doctor's own output. The suite drives
 * `runHealthScan` — the entry `cli.ts` uses — so what is proven here is what
 * the binary does: every planted finding and nothing else, the pinned
 * ephemeral tool record, raw evidence on disk, zero footprint, and the
 * advisory invariant (react-doctor findings move no grade in any category).
 *
 * No golden here on purpose: js-react joins no golden set, because its only
 * new content would need re-capturing on every daily-cadence pin bump to
 * re-assert exactly what the planted-finding table already asserts by name.
 */

/** react-doctor's own cold `npx` fetch is large — pr-scan's value, not scan's. */
const SCAN_TIMEOUT_MS = 240_000

/** Every finding planted in `test/fixtures/js-react` — that fixture's README's oracle. */
const PLANTED = [
  {
    category: 'lint',
    tool: 'react-doctor',
    rule: 'react-doctor/rerender-state-only-in-handlers',
    file: 'src/Counter.jsx',
    startLine: 4,
    severity: 'warning',
    gradeScope: false,
  },
  {
    category: 'lint',
    tool: 'react-doctor',
    rule: 'react-doctor/control-has-associated-label',
    file: 'src/Counter.jsx',
    startLine: 16,
    severity: 'warning',
    gradeScope: false,
  },
  {
    category: 'lint',
    tool: 'react-doctor',
    rule: 'react-doctor/no-array-index-as-key',
    file: 'src/List.jsx',
    startLine: 5,
    severity: 'warning',
    gradeScope: false,
  },
  {
    category: 'format',
    tool: 'prettier',
    rule: 'prettier/format',
    file: 'src/Counter.jsx',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'prettier',
    rule: 'prettier/format',
    file: 'src/List.jsx',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'prettier',
    rule: 'prettier/format',
    file: 'src/index.jsx',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

describe('quick scan of the js-react fixture', () => {
  let fixture: FixtureRepo
  let listingBefore: string[]
  let outside: string
  let scan: HealthScanResult
  let findings: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-react')
    listingBefore = (await readdir(fixture.root)).toSorted()
    outside = await mkdtemp(join(tmpdir(), 'crank-react-out-'))
    scan = await runHealthScan({ path: fixture.root, out: outside })
    findings = scan.report.findings
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(outside, { recursive: true, force: true })
  })

  it('finds every planted finding, and nothing else', () => {
    expect(findings.map(shape)).toEqual(PLANTED.map((planted) => ({ ...planted })))
  })

  it('tags every react-doctor finding default-config, each with a fix hint', () => {
    const doctor = findings.filter((finding) => finding.tool === 'react-doctor')
    expect(doctor).toHaveLength(3)
    for (const finding of doctor) {
      expect(finding.provenance).toBe('default-config')
      expect(finding.fixHint).toBeDefined()
      expect(finding.fixHint?.length).toBeGreaterThan(0)
    }
  })

  it('ran the pinned ephemeral react-doctor, which reports no lint metrics', () => {
    const byTool = new Map(parse(scan.json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('react-doctor')).toMatchObject({
      state: 'ok',
      version: '0.9.5',
      pinned: '0.9.5',
      execution: 'ephemeral-pinned',
      provenance: 'default-config',
      detection: null,
    })
    // The report-level form of "the runner reports no ToolMetrics": nothing in
    // the lint category was measured, only found.
    expect(scan.report.metrics.lint ?? {}).toEqual({})
    // No tsconfig and no .ts* sources — the fixture stays install-free.
    expect(byTool.get('tsc')).toMatchObject({ state: 'not-available' })
  })

  it('keeps react-doctor raw evidence next to the report', async () => {
    const raw = await readFile(join(scan.outputDir, 'raw', 'root', 'react-doctor.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ reactDetected: true })
    // 0.9.5 always prints its output-dir notice to stderr, and evidence is kept.
    const stderr = await readFile(
      join(scan.outputDir, 'raw', 'root', 'react-doctor.stderr.txt'),
      'utf8',
    )
    expect(stderr.length).toBeGreaterThan(0)
  })

  it('leaves the target repo untouched', async () => {
    expect(await fixture.status()).toBe('')
    expect((await readdir(fixture.root)).toSorted()).toEqual(listingBefore)
  })

  /**
   * The advisory invariant, driven directly: strip every react-doctor finding
   * and no category's grade moves. The four ratio categories are covered by
   * the facts asserted above — `format` grades on category-filtered findings,
   * and complexity/duplication/test-quality read only `ToolMetrics`, which
   * this runner never reports.
   */
  it('moves no grade in any category', () => {
    const all = scan.report.findings
    const without = all.filter((finding) => finding.tool !== 'react-doctor')
    expect(without).toHaveLength(all.length - 3)
    for (const finding of all) {
      if (finding.tool !== 'react-doctor') continue
      expect(finding.category).toBe('lint')
      expect(finding.gradeScope).toBe(false)
    }
    // The denominator is held fixed on purpose; only the findings differ.
    for (const category of ['lint', 'types', 'dead-code'] as const) {
      expect(gradeCategory(category, { shape: 'density', findings: all, kloc: 1 })).toBe(
        gradeCategory(category, { shape: 'density', findings: without, kloc: 1 }),
      )
    }
    // This is the assertion that fails the day someone maps a react-doctor
    // rule into security.
    expect(gradeCategory('security', { shape: 'absolute', findings: all })).toBe(
      gradeCategory('security', { shape: 'absolute', findings: without }),
    )
  })
})

/**
 * The owned-not-installed branch: the repo declares react-doctor but has no
 * `node_modules`, so the pinned version runs through `npx` under the repo's
 * ownership. `run()` is the production seam the orchestrator itself calls, and
 * `detection` is the same object shape `detectNodeTool` returns for a
 * declared-but-uninstalled tool.
 */
describe('react-doctor owned by the repo but not installed', () => {
  it(
    'runs the pin through npx and tags every finding repo-config',
    async () => {
      const copy = await mkdtemp(join(tmpdir(), 'crank-react-owned-'))
      const scratch = await mkdtemp(join(tmpdir(), 'crank-react-scratch-'))
      try {
        await cp(fileURLToPath(new URL('./fixtures/js-react', import.meta.url)), copy, {
          recursive: true,
        })
        const files = ['src/Counter.jsx', 'src/List.jsx', 'src/index.jsx']
        const ctx: RunContext = {
          repoRoot: copy,
          project: makeProject(['package.json', ...files]),
          files,
          scratch,
          detection: {
            reason: 'dependency',
            configFiles: [],
            ownedVia: 'package.json',
            installed: false,
          },
          timeoutMs: 240_000,
          deep: false,
        }
        const result = await reactDoctorRunner.run(ctx)

        expect(result.state).toBe('ok')
        expect(result.findings).toHaveLength(3)
        expect(result.findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
        // No detection.version: the pin is the honest fallback.
        expect(result.toolVersion).toBe('0.9.5')
      } finally {
        await rm(copy, { recursive: true, force: true })
        await rm(scratch, { recursive: true, force: true })
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

/** The parts of a finding a planted-finding table is about. */
function shape(finding: Finding) {
  return {
    category: finding.category,
    tool: finding.tool,
    rule: finding.rule,
    file: finding.file,
    startLine: finding.range.startLine,
    severity: finding.severity,
    gradeScope: finding.gradeScope,
  }
}

interface ReportShape {
  readonly tools: {
    readonly tool: string
    readonly state: string
    readonly execution: string
    readonly provenance: string
    readonly version: string | null
    readonly pinned: string | null
    readonly detection: unknown
  }[]
}

function parse(json: string): ReportShape {
  return JSON.parse(json) as ReportShape
}
