import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { QUICK_MODE_DEEP_REASON } from '../src/core/orchestrator.ts'
import { CATEGORIES } from '../src/core/types.ts'
import type { Category, Finding } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { REPO_SCOPED_REASON, runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { pathFarm } from './support/path-farm.ts'
import { expectGolden, normalizeReport } from './support/report.ts'
import { GOLDEN_TOOLCHAIN, SYSTEM_TOOLS } from './support/system-tools.ts'
import { reportFindings } from '../src/render/json.ts'

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
 * fixture's README for the human-readable half. The complexity, lint and
 * dead-code plants belong to the deep-only runners and fire under `--deep`
 * (`test/deep-csharp-e2e.test.ts`).
 */
const PLANTED = [
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'dupe-a.cs',
    startLine: 4,
    severity: 'warning',
    // The grade is the token percentage; the clones are the evidence, and the
    // pair is one of them: `dupe-b.cs` is named in this finding's message.
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

/**
 * Every C# category no quick-profile runner reaches — the build-backed types
 * and complexity, roslynator's dead-code, and stryker-net's test-quality — so a
 * quick scan defers all four. Stryker is also `repoOwnedOnly` and cs-basic has
 * no tools manifest, but quick mode never asks: `deepOnly` alone decides the
 * deferral. `lint` is not here: aislop reads `.cs` files without a build, so a
 * quick scan grades lint from its diagnostics while NetAnalyzers waits for
 * `--deep`.
 */
const DEFERRED: readonly Category[] = ['types', 'dead-code', 'complexity', 'test-quality']

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
    findings = reportFindings(scan.report)
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

  it('reports one C#-language project, and scopes every C# tool record to it', () => {
    const report = parse(json)
    expect(report.schemaVersion).toBe(2)
    expect(report.projects).toHaveLength(1)
    expect(report.projects[0]?.path).toBe('.')
    expect(report.projects[0]?.languages).toEqual(['csharp'])
    const csharp = report.tools.filter((tool) => tool.scope === 'csharp')
    expect(csharp.map((tool) => tool.tool)).toEqual(['dotnet-format'])
  })

  /**
   * opengrep's ruleset reads JavaScript, TypeScript and Python, so a C#-only
   * tree gives it nothing to scan — and it says so, whatever this machine has
   * installed, instead of pointing a ruleless scan at the `.cs` files.
   */
  it('gives opengrep nothing to scan on a C#-only tree, and asks it once', () => {
    expect(toolRows('opengrep')).toEqual([
      {
        project: 'repo',
        repoWide: true,
        state: 'not-available',
        reason: 'no JavaScript, TypeScript or Python files, so opengrep assessed nothing',
      },
    ])
  })

  /**
   * Every security runner here spans the repo — neither of the two that name
   * their languages finds one in this tree — so the project has no security run
   * of its own and never gets a grade for one.
   *
   * Which reason it carries is a fact about the machine, not about the repo:
   * the repo-spanning scanners are release binaries this one may not have, and
   * `repo-scoped` is what the repo having *graded* the category looks like.
   */
  it('gives the project no security state its own runs did not earn', () => {
    const security = scan.report.projects[0]?.categories.security
    expect(security?.status).toBe('not-assessed')

    const spanningGraded = parse(json).tools.some(
      (tool) => tool.repoWide === true && tool.category === 'security' && tool.state === 'ok',
    )
    expect(security).toMatchObject(
      spanningGraded
        ? { reason: REPO_SCOPED_REASON }
        : { reason: 'no tool available for this category' },
    )
  })

  /**
   * Hand-computable against the formula table (spec §3): 1 of 8 `.cs` files
   * failing format = 12.5% → C (B ≤10, C ≤30); the duplicated 24-line
   * `Accumulate` body, diluted by `main.cs` and `dead.cs` joining the token
   * pool, sits in the duplication D band (>10%, ≤20% of tokens).
   */
  it('grades format and duplication, and says why the rest have no grade', () => {
    const report = parse(json)
    expect(Object.keys(report.categories).toSorted()).toEqual([...CATEGORIES].toSorted())
    expect(report.categories.format).toEqual({ status: 'graded', grade: 'C' })
    expect(report.categories.duplication).toEqual({ status: 'graded', grade: 'D' })
    // Flips to `graded` when any of gitleaks/opengrep/osv-scanner is installed:
    // a security tool that ran and found nothing is an honest A.
    expect(report.categories.security?.status).toBe(GOLDEN_TOOLCHAIN ? 'not-assessed' : 'graded')
    // aislop needs no build, so it grades lint on a C# project the quick
    // profile reaches nothing else in; cs-basic has no ai-slop diagnostics.
    expect(report.categories.lint).toEqual({ status: 'graded', grade: 'A' })
    // Every remaining C# category's runners are all deep-only, so a quick scan
    // defers those four with one reason.
    for (const category of DEFERRED) {
      expect(report.categories[category]).toEqual({
        status: 'not-assessed',
        reason: QUICK_MODE_DEEP_REASON,
      })
    }
  })

  it('reports the measurements the ratio grades were computed from', () => {
    const metrics = parse(json).metrics
    expect(metrics.format).toEqual({ formattableFiles: 8 })
    // The exact token share jscpd reports for the duplicated `Accumulate`
    // body against this fixture — inside the D band (>10%, ≤20%) the
    // duplication grade above is read from.
    expect(metrics.duplication?.['duplicationPercent']).toBe(18.38235294117647)
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

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    await expectGolden('cs-basic.report.json', normalizeReport(json))
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root, out: outsideAgain })
      expect(normalizeReport(second.json)).toBe(normalizeReport(json))
      expect(reportFindings(second.report).map((finding) => finding.id)).toEqual(
        findings.map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )

  /** One tool's `tools[]` rows, in the fields planning decides. */
  function toolRows(tool: string) {
    return parse(json)
      .tools.filter((entry) => entry.tool === tool)
      .map((entry) => ({
        project: entry.project,
        repoWide: entry.repoWide,
        state: entry.state,
        reason: entry.reason,
      }))
  }
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

/**
 * Every quick-tier finding planted in `test/fixtures/mixed-cs` — see that
 * fixture's README for the human-readable half. Each language's plants stay in
 * the project that owns them: the JS pair at the root, the C# pair in `dotnet/`.
 */
const MIXED_CS_PLANTED = [
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'dotnet/dupe-a.cs',
    project: 'dotnet',
    startLine: 4,
    severity: 'warning',
    gradeScope: false,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-dupe-keys)',
    file: 'dupe-keys.js',
    project: '.',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'dotnet-format',
    rule: 'dotnet-format/whitespace',
    file: 'dotnet/unformatted.cs',
    project: 'dotnet',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'prettier',
    rule: 'prettier/format',
    file: 'unformatted.js',
    project: '.',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

/**
 * Criteria 4 and 26: a repo whose root is a JS project and whose `dotnet/`
 * directory holds **two manifests** — `App.csproj` and a `package.json` — but
 * only C# source. The manifest alone declares `js-ts` into that project's
 * `languages`, while the JS/TS adapter (which detects on *files*) has nothing
 * to run there — so the dotnet entry's deep categories keep the quick profile's
 * deferral reason, and the root entry is the standing guard that the scan-wide
 * deferral never leaks into a project whose own runners did answer.
 */
describe('quick scan of the mixed-cs fixture', () => {
  let fixture: FixtureRepo
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('mixed-cs')
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('discovers the root JS project and the two-manifest dotnet project', () => {
    expect(
      scan.report.projects.map((project) => [project.path, project.languages, project.manifests]),
    ).toEqual([
      ['.', ['js-ts'], ['package.json']],
      // `languages` in canonical `LANGUAGES` order: the `package.json` declares
      // `js-ts` even though every source file in the directory is C#.
      ['dotnet', ['js-ts', 'csharp'], ['dotnet/App.csproj', 'dotnet/package.json']],
    ])
  })

  it('finds every planted finding, and nothing else', () => {
    expect(
      reportFindings(scan.report).filter(fromAlwaysAvailableTool).map(shapeWithProject),
    ).toEqual(MIXED_CS_PLANTED.map((planted) => ({ ...planted })))
  })

  /**
   * The standing guard on the scan-wide deferred set: the C# adapter deferred
   * `types`/`dead-code`/`complexity`/`lint` to `--deep`, but the root project's
   * own quick runners (tsc, fallow, knip, fallow-health, fta, oxlint) each
   * produced a record there — so those categories are graded, never handed the
   * deep reason. Only `test-quality`, which no quick runner anywhere answers,
   * keeps it.
   */
  it('grades the root project from its own runs, untouched by the C# deferrals', () => {
    expect(categories('.')).toMatchObject({
      types: { status: 'graded', grade: 'A' },
      'dead-code': { status: 'graded', grade: 'A' },
      complexity: { status: 'graded', grade: 'A' },
      lint: { status: 'graded', grade: 'F' },
      format: { status: 'graded', grade: 'C' },
      duplication: { status: 'graded', grade: 'A' },
      'test-quality': { status: 'not-assessed', reason: QUICK_MODE_DEEP_REASON },
    })
  })

  /**
   * Criterion 26's other half: every C# category behind a `deepOnly` runner is
   * deferred with the profile's reason — and the declared-but-fileless `js-ts`
   * never plants a quick JS record here to contradict that. Lint is the one
   * category a quick profile still grades on a C# project, from aislop.
   */
  it('defers the dotnet project’s deep categories with the quick-mode reason', () => {
    for (const category of DEFERRED) {
      expect(categories('dotnet')?.[category]).toEqual({
        status: 'not-assessed',
        reason: QUICK_MODE_DEEP_REASON,
      })
    }
    expect(categories('dotnet')).toMatchObject({
      lint: { status: 'graded', grade: 'A' },
      format: { status: 'graded', grade: 'C' },
      duplication: { status: 'graded', grade: 'F' },
    })
  })

  /** Spec §3's mixed-language rule: one rollup grade over the combined findings. */
  it('grades the rollup over both projects’ findings', () => {
    const report = parse(scan.json)
    expect(Object.keys(report.categories).toSorted()).toEqual([...CATEGORIES].toSorted())
    expect(report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
    expect(report.categories.format).toEqual({ status: 'graded', grade: 'C' })
    expect(report.categories.duplication).toEqual({ status: 'graded', grade: 'F' })
    expect(report.categories.types).toEqual({ status: 'graded', grade: 'A' })
    // The combined denominator: four formattable files per project, added.
    expect(report.metrics.format).toEqual({ formattableFiles: 8 })
    expect(report.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: QUICK_MODE_DEEP_REASON,
    })
    expect(report.categories.security?.status).toBe(GOLDEN_TOOLCHAIN ? 'not-assessed' : 'graded')
  })

  it('counts both languages into the per-language breakdown', () => {
    expect(parse(scan.json).languages).toEqual({
      'js-ts': { lint: 1, format: 1 },
      csharp: { duplication: 1, format: 1 },
    })
  })

  function categories(path: string) {
    return scan.report.projects.find((project) => project.path === path)?.categories
  }
})

/** Findings from the tools every machine has, because npx can fetch them. */
function fromAlwaysAvailableTool(finding: Finding): boolean {
  return !SYSTEM_TOOLS.some((tool) => (tool as string) === finding.tool)
}

/** {@link shape}, plus the project the finding was attributed to. */
function shapeWithProject(finding: Finding) {
  return { ...shape(finding), project: finding.project }
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
    readonly category: string
    readonly project: string
    readonly repoWide?: boolean
    readonly scope: string
    readonly state: string
    readonly reason: string | null
  }[]
}

function parse(json: string): ReportShape {
  return JSON.parse(json) as ReportShape
}
