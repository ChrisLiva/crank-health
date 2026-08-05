import { mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Finding } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { normalizeReport } from './support/report.ts'
import { GOLDEN_TOOLCHAIN, SYSTEM_TOOLS } from './support/system-tools.ts'

/**
 * The four spec-level executable promises again, on the fixtures that exercise
 * the Python adapter and the mixed-language rules: every planted finding and
 * nothing else · a golden normalized report · byte-identity across runs · zero
 * footprint on the target.
 *
 * These drive `runHealthScan` — the same entry point `cli.ts` uses — and they
 * fetch the real pinned tools through `uvx`, so a machine without `uv` will see
 * these categories degrade rather than pass silently.
 */

const GOLDEN = fileURLToPath(new URL('./golden/py-basic.report.json', import.meta.url))

/** Roomy: the first run of a suite may be fetching tools into the uv cache. */
const SCAN_TIMEOUT_MS = 180_000

/** Every finding planted in `test/fixtures/py-basic` — see that fixture's README. */
const PLANTED = [
  {
    category: 'types',
    tool: 'ty',
    rule: 'unresolved-reference',
    file: 'undefined_name.py',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'dead-code',
    tool: 'vulture',
    rule: 'vulture/unused-import',
    file: 'dead.py',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'dead-code',
    tool: 'vulture',
    rule: 'vulture/unused-function',
    file: 'dead.py',
    startLine: 8,
    severity: 'info',
    // vulture's 60% tier: reported, never graded (spec §3).
    gradeScope: false,
  },
  {
    category: 'complexity',
    tool: 'complexipy',
    rule: 'complexipy/cognitive-complexity',
    file: 'complex.py',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'ruff-lint',
    rule: 'F401',
    file: 'dead.py',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'ruff-lint',
    rule: 'F821',
    file: 'undefined_name.py',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'ruff-format',
    rule: 'ruff/format',
    file: 'unformatted.py',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

/** Files planted deliberately clean; a finding in one of these is a false positive. */
const CLEAN_FILES = new Set(['clean.py', 'main.py'])

describe('quick scan of the py-basic fixture', () => {
  let fixture: FixtureRepo
  let outside: string
  let json: string
  let findings: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('py-basic')
    outside = await mkdtemp(join(tmpdir(), 'crank-py-out-'))
    const result = await runHealthScan({ path: fixture.root })
    json = result.json
    findings = result.report.findings
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(outside, { recursive: true, force: true })
  })

  it('finds every planted finding, and nothing else', () => {
    expect(findings.map(shape)).toEqual(PLANTED.map((planted) => ({ ...planted })))
  })

  it('reports no findings in the deliberately clean files', () => {
    expect(findings.filter((finding) => CLEAN_FILES.has(finding.file))).toEqual([])
  })

  it('tags an untooled repo as default-config, run from the pinned versions', () => {
    const report = parse(json)
    expect(report.tools.map((tool) => tool.tool)).toEqual([
      // The common adapter runs against every repo; here bandit and jscpd have
      // something to look at and the rest report that they have not.
      'bandit',
      'gitleaks',
      'opengrep',
      'osv-scanner',
      'zizmor',
      'pyright',
      'ty',
      'vulture',
      'complexipy',
      'jscpd',
      'ruff-lint',
      'ruff-format',
    ])
    expect(report.tools.every((tool) => tool.provenance === 'default-config')).toBe(true)
    expect(report.tools.every((tool) => tool.execution === 'ephemeral-pinned')).toBe(true)
    expect(report.tools.every((tool) => tool.detection === null)).toBe(true)
    for (const tool of report.tools) {
      if (tool.version !== null) expect(tool.version).toBe(tool.pinned)
    }
    expect(findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
  })

  /** Spec "Categories and tools": "ty (beta) → pyright when venv exists". */
  it('type-checks with ty and stands pyright down, because there is no virtualenv', () => {
    const byTool = new Map(parse(json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('ty')).toMatchObject({ state: 'ok', version: '0.0.66' })
    expect(byTool.get('pyright')).toMatchObject({
      state: 'not-available',
      reason: 'standing down: this project has no virtualenv, so ty type-checks it',
    })
  })

  /**
   * Hand-computable against the formula table (spec §3), over the fixture's 62
   * physical lines of Python — 0.062 KLOC:
   *
   * - types: one error, weight 5 → 80.6/KLOC → F (D ≤15)
   * - dead code: one graded warning, weight 1 → 16.1/KLOC → F (D ≤10)
   * - lint: one error and one warning → 6/0.062 = 96.8/KLOC → F (D ≤40)
   * - complexity: 1 of 7 functions over the ceiling = 14.3% → D (C ≤10, D ≤20)
   * - format: 1 of 6 files failing = 16.7% → C (B ≤10, C ≤30)
   */
  it('grades every category a Python-only repo can reach, and pins the commit', () => {
    const report = parse(json)
    expect(report.repo.commit).toBe(fixture.commit)
    expect(report.categories).toEqual({
      // bandit scanned the Python and found nothing: an honest A (spec §3's
      // absolute shape — zero graded findings is A).
      security: { status: 'graded', grade: 'A' },
      types: { status: 'graded', grade: 'F' },
      'dead-code': { status: 'graded', grade: 'F' },
      complexity: { status: 'graded', grade: 'D' },
      // jscpd found no clones: 0% duplicated tokens → A (A ≤3).
      duplication: { status: 'graded', grade: 'A' },
      lint: { status: 'graded', grade: 'F' },
      format: { status: 'graded', grade: 'C' },
      'test-quality': { status: 'not-assessed', reason: 'not assessed — run `--deep`' },
    })
  })

  it('reports the measurements the ratio grades were computed from', () => {
    expect(parse(json).metrics).toEqual({
      complexity: { functionsTotal: 7, functionsOverCeiling: 1 },
      duplication: { duplicationPercent: 0 },
      format: { formattableFiles: 6 },
    })
  })

  it('breaks the findings down by language, which is all one language here', () => {
    expect(parse(json).languages).toEqual({
      python: { types: 1, 'dead-code': 2, complexity: 1, lint: 2, format: 1 },
    })
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    expect(normalizeReport(json)).toBe(await readFile(GOLDEN, 'utf8'))
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root })
      expect(normalizeReport(second.json)).toBe(normalizeReport(json))
      expect(second.report.findings.map((finding) => finding.id)).toEqual(
        findings.map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )

  /**
   * complexipy writes a `.complexipy_cache/` that cannot be disabled, next to
   * wherever it was started — so it is started in the scratch dir. This is the
   * assertion that keeps it there.
   */
  it('leaves the target repo clean, cache directories included', async () => {
    expect(await fixture.status()).toBe('')
    expect(await readdir(fixture.root)).not.toContain('.complexipy_cache')
  })

  it(
    'writes nothing at all into the repo when --out points elsewhere',
    async () => {
      await rm(join(fixture.root, '.codebase-health'), { recursive: true, force: true })
      const result = await runHealthScan({ path: fixture.root, out: outside })

      expect(result.outputDir).toBe(outside)
      expect(await fixture.status()).toBe('')
      // Every tool's evidence is kept next to the report (spec §9).
      const raw = (await readdir(join(outside, 'raw'))).toSorted()
      expect(GOLDEN_TOOLCHAIN ? raw : raw.filter(fromFetchableTool)).toEqual([
        'bandit.json',
        'complexipy.json',
        'complexipy.sarif.json',
        'jscpd-report.json',
        'ruff-format.json',
        'ruff-lint.json',
        'ty.gitlab.json',
        'vulture.txt',
      ])
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('quick scan of a Python repo with a virtualenv', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('py-venv')
    // A virtualenv cannot be checked in, and pyright needs a real interpreter
    // to resolve against — `uv venv` is the cheapest way to have one. The
    // fixture's own .gitignore is what keeps it out of `git status`.
    await execa('uv', ['venv'], { cwd: fixture.root })
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /** The plan's retiring check for "ty beta quality": the fallback engages. */
  it('type-checks with pyright and stands ty down, because a virtualenv exists', () => {
    const byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('pyright')).toMatchObject({
      state: 'ok',
      version: '1.1.411',
      provenance: 'default-config',
      execution: 'ephemeral-pinned',
    })
    expect(byTool.get('ty')).toMatchObject({
      state: 'not-available',
      reason: 'standing down: this project has a virtualenv (.venv), so pyright type-checks it',
    })
  })

  it('finds the planted type error, and nothing else', () => {
    expect(result.report.findings.map(shape)).toEqual([
      {
        category: 'types',
        tool: 'pyright',
        rule: 'reportReturnType',
        file: 'app.py',
        startLine: 6,
        severity: 'error',
        gradeScope: true,
      },
    ])
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
  })

  /** The virtualenv is a dependency directory: never scanned (spec §7). */
  it('never scans the virtualenv it type-checks against', () => {
    expect(result.report.findings.every((finding) => !finding.file.includes('.venv'))).toBe(true)
    expect(result.report.metrics.complexity).toEqual({
      functionsTotal: 3,
      functionsOverCeiling: 0,
    })
  })

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe('quick scan of a mixed JS + Python repo', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('mixed-basic')
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('runs both adapters and finds every planted finding, in either language', () => {
    expect(result.report.findings.map(shape)).toEqual([
      {
        category: 'types',
        tool: 'ty',
        rule: 'unresolved-reference',
        file: 'app.py',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'lint',
        tool: 'ruff-lint',
        rule: 'F821',
        file: 'app.py',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'lint',
        tool: 'oxlint',
        rule: 'eslint(no-dupe-keys)',
        file: 'dupe-keys.js',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'format',
        tool: 'prettier',
        rule: 'prettier/format',
        file: 'unformatted.js',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'format',
        tool: 'ruff-format',
        rule: 'ruff/format',
        file: 'unformatted.py',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
    ])
  })

  /** Spec §3: one grade per category over the *combined* findings. */
  it('grades each category once, over both languages together', () => {
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
    expect(result.report.categories['dead-code']).toEqual({ status: 'graded', grade: 'A' })
    expect(result.report.categories.complexity).toEqual({ status: 'graded', grade: 'A' })
  })

  /**
   * The denominators are the repo's, not one language's: three JS sources plus
   * three Python sources, so two failing files is 33% → D (C ≤30, D ≤60). Taking
   * either formatter's count alone would have said 67% → F.
   */
  it('counts both languages into the ratio denominators', () => {
    expect(result.report.metrics.format).toEqual({ formattableFiles: 6 })
    expect(result.report.metrics.complexity).toEqual({
      // 2 JS functions (fallow) + 3 Python functions (complexipy).
      functionsTotal: 5,
      functionsOverCeiling: 0,
    })
    expect(result.report.categories.format).toEqual({ status: 'graded', grade: 'D' })
  })

  /** Spec §3: "per-language breakdown in the report". */
  it('reports which language each category’s findings came from', () => {
    expect(result.report.languages).toEqual({
      'js-ts': { lint: 1, format: 1 },
      python: { types: 1, lint: 1, format: 1 },
    })
  })

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe('zero footprint', () => {
  it.each(['py-basic', 'mixed-basic'])(
    'leaves %s untouched after a full scan',
    async (name) => {
      const fixture = await createFixtureRepo(name)
      const outside = await mkdtemp(join(tmpdir(), 'crank-py-zero-'))
      const before = (await readdir(fixture.root)).toSorted()
      try {
        await runHealthScan({ path: fixture.root, out: outside })
        expect(await fixture.status()).toBe('')
        expect((await readdir(fixture.root)).toSorted()).toEqual(before)
      } finally {
        await fixture.remove()
        await rm(outside, { recursive: true, force: true })
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

/**
 * A scan target reached through a symlink (stock macOS `TMPDIR`, symlinked
 * checkouts) must behave exactly like one reached through its physical path:
 * tools that canonicalize their output paths (ruff) report inside the physical
 * root, and the findings must still land inside the repo.
 */
describe('quick scan of the py-basic fixture reached through a symlink', () => {
  let fixture: FixtureRepo
  let linkDir: string
  let outA: string
  let outB: string
  let before: readonly string[]
  let symlinkScan: HealthScanResult
  let rootScan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('py-basic')
    linkDir = await mkdtemp(join(tmpdir(), 'crank-symlink-'))
    const link = join(linkDir, 'repo')
    await symlink(fixture.root, link) // explicit: bites on Linux and under any TMPDIR
    outA = await mkdtemp(join(tmpdir(), 'crank-symlink-out-'))
    outB = await mkdtemp(join(tmpdir(), 'crank-symlink-out-'))
    before = (await readdir(fixture.root)).toSorted()
    symlinkScan = await runHealthScan({ path: link, out: outA })
    rootScan = await runHealthScan({ path: fixture.root, out: outB })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(linkDir, { recursive: true, force: true })
    await rm(outA, { recursive: true, force: true })
    await rm(outB, { recursive: true, force: true })
  })

  it('finds every planted finding through the symlink', () => {
    expect(symlinkScan.report.findings.map(shape)).toEqual(
      PLANTED.map((planted) => ({ ...planted })),
    )
  })

  it('produces the same report whether reached through the symlink or the real root', () => {
    expect(normalizeReport(symlinkScan.json)).toBe(normalizeReport(rootScan.json))
    expect(symlinkScan.report.findings.map((f) => f.id)).toEqual(
      rootScan.report.findings.map((f) => f.id),
    )
  })

  it('records the physical repo path', async () => {
    // Asserted directly: `normalizeReport` blanks `repo.path`, so the
    // report-identity case above cannot see it.
    expect(symlinkScan.report.repo.path).toBe(await realpath(fixture.root))
  })

  it('leaves the target clean when reached through the symlink', async () => {
    expect(await fixture.status()).toBe('')
    expect((await readdir(fixture.root)).toSorted()).toEqual(before)
  })
})

/**
 * Raw-output files from the tools every machine can fetch. The three
 * release-binary scanners contribute evidence only where they are installed —
 * see `support/system-tools.ts`.
 */
function fromFetchableTool(name: string): boolean {
  return !SYSTEM_TOOLS.some((tool) => name.startsWith(tool))
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
  readonly repo: { readonly commit: string }
  readonly categories: Record<string, { status: string; grade?: string; reason?: string }>
  readonly metrics: Record<string, Record<string, number>>
  readonly languages: Record<string, Record<string, number>>
  readonly tools: {
    readonly tool: string
    readonly execution: string
    readonly provenance: string
    readonly version: string | null
    readonly pinned: string | null
    readonly state: string
    readonly reason: string | null
    readonly detection: unknown
  }[]
}

function parse(json: string): ReportShape {
  return JSON.parse(json) as ReportShape
}
