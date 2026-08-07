import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { QUICK_MODE_DEEP_REASON } from '../src/core/orchestrator.ts'
import { CATEGORIES } from '../src/core/types.ts'
import type { Category, Finding } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { pathFarm } from './support/path-farm.ts'
import { normalizeReport } from './support/report.ts'
import { GOLDEN_TOOLCHAIN, SYSTEM_TOOLS } from './support/system-tools.ts'

/**
 * The C# adapter end to end, on the machine's own .NET SDK: every planted
 * finding and nothing else · byte-identity across runs · zero footprint on the
 * target — including a booby-trapped `.csproj` that would prove the quick
 * profile evaluated MSBuild if anything ever did · honest degradation on a
 * farmed `PATH` with no usable SDK.
 *
 * These drive `runHealthScan` — the same entry point `cli.ts` uses. The SDK is
 * a machine prerequisite (the `uv` precedent): a machine without one sees the
 * degradation suites pass and the fixture suite fail its format expectations,
 * which is the honest signal.
 */

/** Roomy: the first run of a suite may be fetching jscpd into the npx cache. */
const SCAN_TIMEOUT_MS = 180_000

/**
 * Every quick-tier finding planted in `test/fixtures/cs-basic` — see that
 * fixture's README for the human-readable half. The complexity and lint plants
 * are dormant until the deep-only build and analyzer runners land (Tasks 6–9).
 */
const PLANTED = [
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'dupe-a.cs',
    startLine: 4,
    severity: 'warning',
    // The grade is the token percentage; the clones are the evidence.
    gradeScope: false,
  },
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'dupe-b.cs',
    startLine: 4,
    severity: 'warning',
    gradeScope: false,
  },
  {
    category: 'format',
    tool: 'dotnet-format',
    rule: 'dotnet-format/whitespace',
    file: 'unformatted.cs',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

/** Files planted deliberately clean; a finding in one of these is a false positive. */
const CLEAN_FILES = new Set(['clean.cs'])

/** The categories no C# runner in any profile answers at this point of the run. */
const UNANSWERED: readonly Category[] = ['dead-code', 'test-quality']

/** The build-backed trio: deep-only runners exist, so a quick scan defers them. */
const DEFERRED: readonly Category[] = ['types', 'complexity', 'lint']

describe('quick scan of the cs-basic fixture', () => {
  let fixture: FixtureRepo
  let outside: string
  let outsideAgain: string
  let entriesBefore: readonly string[]
  let unformattedBefore: string
  let scan: HealthScanResult
  let json: string
  let findings: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-basic')
    outside = await mkdtemp(join(tmpdir(), 'crank-cs-out-'))
    outsideAgain = await mkdtemp(join(tmpdir(), 'crank-cs-out-'))
    entriesBefore = (await readdir(fixture.root)).toSorted()
    unformattedBefore = await readFile(join(fixture.root, 'unformatted.cs'), 'utf8')
    scan = await runHealthScan({ path: fixture.root, out: outside })
    json = scan.json
    findings = scan.report.findings
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(outside, { recursive: true, force: true })
    await rm(outsideAgain, { recursive: true, force: true })
  })

  it('finds every planted finding, and nothing else', () => {
    expect(findings.filter(fromAlwaysAvailableTool).map(shape)).toEqual(
      PLANTED.map((planted) => ({ ...planted })),
    )
  })

  it('reports no findings in the deliberately clean files', () => {
    expect(findings.filter((finding) => CLEAN_FILES.has(finding.file))).toEqual([])
  })

  it('reports one C#-language project, and scopes every C# tool record to it', () => {
    const report = parse(json)
    expect(report.schemaVersion).toBe(1)
    expect(report.projects).toHaveLength(1)
    expect(report.projects[0]?.path).toBe('.')
    expect(report.projects[0]?.languages).toEqual(['csharp'])
    const csharp = report.tools.filter((tool) => tool.scope === 'csharp')
    expect(csharp.map((tool) => tool.tool)).toEqual(['dotnet-format'])
  })

  it('counts the .cs findings into the per-language breakdown', () => {
    expect(parse(json).languages).toEqual({ csharp: { duplication: 2, format: 1 } })
  })

  /**
   * Hand-computable against the formula table (spec §3): 1 of 6 `.cs` files
   * failing format = 16.7% → C (B ≤10, C ≤30); the duplicated 24-line
   * `Accumulate` body is well past the duplication D band's 20% of tokens.
   */
  it('grades format and duplication, and says why the rest have no grade', () => {
    const report = parse(json)
    expect(Object.keys(report.categories).toSorted()).toEqual([...CATEGORIES].toSorted())
    expect(report.categories.format).toEqual({ status: 'graded', grade: 'C' })
    expect(report.categories.duplication).toEqual({ status: 'graded', grade: 'F' })
    // Flips to `graded` when any of gitleaks/opengrep/osv-scanner is installed:
    // a security tool that ran and found nothing is an honest A.
    expect(report.categories.security?.status).toBe(GOLDEN_TOOLCHAIN ? 'not-assessed' : 'graded')
    // The compiled trio's runners exist but are deep-only, so a quick scan
    // defers them to `--deep`; the rest flip as Tasks 8–9 land their runners.
    for (const category of DEFERRED) {
      expect(report.categories[category]).toEqual({
        status: 'not-assessed',
        reason: QUICK_MODE_DEEP_REASON,
      })
    }
    for (const category of UNANSWERED) {
      expect(report.categories[category]).toEqual({
        status: 'not-assessed',
        reason: 'no tool available for this category',
      })
    }
  })

  it('reports the measurements the ratio grades were computed from', () => {
    const metrics = parse(json).metrics
    expect(metrics.format).toEqual({ formattableFiles: 6 })
    expect(metrics.duplication?.['duplicationPercent']).toBeGreaterThan(0)
  })

  /**
   * Criterion 6's teeth: a `dotnet format` run missing `--verify-no-changes`
   * would silently reformat `unformatted.cs` in place — byte-comparing the one
   * file the formatter objects to is what catches that.
   */
  it('leaves the fixture byte-identical, the file the formatter flagged included', async () => {
    expect(await readFile(join(fixture.root, 'unformatted.cs'), 'utf8')).toBe(unformattedBefore)
    expect(await fixture.status()).toBe('')
    expect((await readdir(fixture.root)).toSorted()).toEqual(entriesBefore)
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root, out: outsideAgain })
      expect(normalizeReport(second.json)).toBe(normalizeReport(json))
      expect(second.report.findings.map((finding) => finding.id)).toEqual(
        findings.map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )
})

/**
 * Criterion 5: the quick profile never executes repo code. The fixture's
 * `.csproj` carries a `Trap` target hooked before `Restore` and `CoreCompile` —
 * any MSBuild evaluation writes `evaluated.txt` into the repo. `dotnet format
 * whitespace --folder` treats the tree as plain files, so the trap must never
 * fire.
 */
describe('quick scan of the cs-booby-trap fixture', () => {
  let fixture: FixtureRepo
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-booby-trap')
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('completes without evaluating the project file', async () => {
    expect(scan.report.repo.commit).toBe(fixture.commit)
    expect(existsSync(join(fixture.root, 'evaluated.txt'))).toBe(false)
    expect(await fixture.status()).toBe('')
  })
})

/**
 * Criteria 10 and 11, over Task 4's `pathFarm`: a controlled `PATH` where
 * `dotnet` provably does not resolve (`/usr/bin/dotnet` does not exist on this
 * platform, and `dnx` ships only inside `/usr/local/share/dotnet`). Real
 * subprocess resolution — no in-process mocks. `beforeAll` resolving at all is
 * the "run exits 0" half: `cli.ts` only returns non-zero for `--fail-under` or
 * its own crash.
 */
describe('quick scan of cs-basic with no dotnet on PATH', () => {
  let fixture: FixtureRepo
  let farm: Awaited<ReturnType<typeof pathFarm>>
  let originalPath: string
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-basic')
    farm = await pathFarm()
    originalPath = process.env['PATH'] ?? ''
    process.env['PATH'] = farm.path
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    process.env['PATH'] = originalPath
    await fixture.remove()
    await farm.remove()
  })

  it('reports every C# tool as not-available, with the install hint', () => {
    const csharp = parse(scan.json).tools.filter((tool) => tool.scope === 'csharp')
    expect(csharp.length).toBeGreaterThan(0)
    for (const tool of csharp) {
      expect(tool.state).toBe('not-available')
      expect(tool.reason).toContain('dotnet is not on PATH')
      expect(tool.reason).toContain('https://dotnet.microsoft.com/download')
    }
  })

  it('still grades duplication, because jscpd resolves through the farm’s npx', () => {
    expect(parse(scan.json).categories.duplication?.status).toBe('graded')
  })
})

describe('quick scan of cs-basic with an SDK below the floor', () => {
  let fixture: FixtureRepo
  let farm: Awaited<ReturnType<typeof pathFarm>>
  let originalPath: string
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('cs-basic')
    farm = await pathFarm({ dotnet: '#!/bin/sh\necho 8.0.100\n' })
    originalPath = process.env['PATH'] ?? ''
    process.env['PATH'] = farm.path
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    process.env['PATH'] = originalPath
    await fixture.remove()
    await farm.remove()
  })

  it('reports every C# runner not-available, naming the found version and the floor', () => {
    const csharp = parse(scan.json).tools.filter((tool) => tool.scope === 'csharp')
    expect(csharp.length).toBeGreaterThan(0)
    for (const tool of csharp) {
      expect(tool.state).toBe('not-available')
      expect(tool.reason).toContain('8.0.100')
      expect(tool.reason).toContain('≥ 10')
    }
  })
})

/** Findings from the tools every machine has, because npx can fetch them. */
function fromAlwaysAvailableTool(finding: Finding): boolean {
  return !SYSTEM_TOOLS.some((tool) => (tool as string) === finding.tool)
}

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
  readonly schemaVersion: number
  readonly categories: Partial<
    Record<Category, { status: string; grade?: string; reason?: string }>
  >
  readonly metrics: Partial<Record<Category, Record<string, number>>>
  readonly languages: Record<string, Record<string, number>>
  readonly projects: readonly { readonly path: string; readonly languages: readonly string[] }[]
  readonly tools: {
    readonly tool: string
    readonly scope: string
    readonly state: string
    readonly reason: string | null
  }[]
}

function parse(json: string): ReportShape {
  return JSON.parse(json) as ReportShape
}
