import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mypyRunner } from '../src/adapters/python/mypy.ts'
import type { Finding } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import { makeProject } from './factories.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { COMMIT_IDENTITY, createFixtureRepo } from './support/fixture.ts'
import { expectGolden, normalizeReport } from './support/report.ts'
import { GOLDEN_TOOLCHAIN, SYSTEM_TOOLS } from './support/system-tools.ts'
import { reportFindings } from '../src/render/json.ts'

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
    tool: 'aislop',
    rule: 'ai-slop/unused-import',
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
    findings = reportFindings(result.report)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(outside, { recursive: true, force: true })
  })

  it('finds every planted finding, and nothing else', () => {
    expect(findings.map(shape)).toEqual(PLANTED.map((planted) => ({ ...planted })))
  })

  it('tags an untooled repo as default-config, run from the pinned versions', () => {
    const report = parse(json)
    expect(report.tools.map((tool) => tool.tool)).toEqual([
      // The common adapter runs against every repo; here bandit and jscpd have
      // something to look at and the rest report that they have not.
      'bandit',
      'gitleaks',
      'govulncheck',
      'opengrep',
      'osv-scanner',
      'zizmor',
      'pyright',
      'ty',
      'vulture',
      'complexipy',
      'jscpd',
      'aislop',
      'ruff-lint',
      'ruff-format',
    ])
    expect(report.tools.every((tool) => tool.provenance === 'default-config')).toBe(true)
    expect(report.tools.every((tool) => tool.execution === 'ephemeral-pinned')).toBe(true)
    expect(report.tools.every((tool) => tool.detection === null)).toBe(true)
    for (const tool of report.tools.filter((entry) => fromFetchableTool(entry.tool))) {
      if (tool.version !== null) expect(tool.version).toBe(tool.pinned)
    }
    expect(findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
  })

  /** Spec "Categories and tools": "ty (beta) → pyright when venv exists". */
  it('type-checks with ty and stands pyright down, because there is no virtualenv', () => {
    const byTool = new Map(parse(json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('ty')).toMatchObject({ state: 'ok', version: '0.0.75' })
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

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    await expectGolden('py-basic.report.json', normalizeReport(json))
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root })
      expect(normalizeReport(second.json)).toBe(normalizeReport(json))
      expect(reportFindings(second.report).map((finding) => finding.id)).toEqual(
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
      // Every tool's evidence is kept next to the report (spec §9), under the
      // project that produced it — one project here, so `raw/root/`.
      const raw = (await readdir(join(outside, 'raw', 'root'))).toSorted()
      expect(GOLDEN_TOOLCHAIN ? raw : raw.filter(fromFetchableTool)).toEqual([
        'aislop.json',
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
    expect(reportFindings(result.report).map(shape)).toEqual([
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
    expect(reportFindings(result.report).every((finding) => !finding.file.includes('.venv'))).toBe(
      true,
    )
    expect(result.report.metrics.complexity).toEqual({
      functionsTotal: 3,
      functionsOverCeiling: 0,
    })
  })
})

/**
 * The honest-degradation chain, end to end: a repo that owns mypy but has no
 * environment for it. mypy claims the types category, cannot run, and says why;
 * the default it displaced grades the category instead and the report says so.
 */
describe('quick scan of the py-mypy fixture (no virtualenv)', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult
  let byTool: Map<string, ReportShape['tools'][number]>

  beforeAll(async () => {
    fixture = await createFixtureRepo('py-mypy')
    result = await runHealthScan({ path: fixture.root })
    byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('warns that the grade came from a default config, not the repo’s own tool', () => {
    expect(result.report.warnings).toContain(
      'ty: graded types on its default config because mypy reported not-available',
    )
  })

  it('grades types from the promoted standby’s findings', () => {
    // ty was the standby whose owner never graded, so it is promoted and runs.
    expect(byTool.get('ty')).toMatchObject({
      state: 'ok',
      provenance: 'default-config',
      reason: null,
    })
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
    // Loose on the rule: which name ty gives the planted return-type error is
    // ty's contract, not this fixture's.
    expect(reportFindings(result.report)).toContainEqual(
      expect.objectContaining({ tool: 'ty', category: 'types', file: 'app.py' }),
    )
  })
})

/**
 * The same fixture with an environment, which is the case mypy was written for.
 * Two scans: one before the repo installs mypy, so the pinned copy runs, and one
 * after, so the repo's own binary does. In both modes mypy grades types alone —
 * the defaults it displaced stand down rather than report the same error a
 * second time.
 */
describe('quick scan of the py-mypy fixture with a virtualenv', () => {
  let fixture: FixtureRepo
  let outEphemeral: string
  let outInstalled: string
  let scan1: HealthScanResult
  let scan2: HealthScanResult

  // Two full Python scans plus a `uv venv` and a `uv pip install` do not fit the
  // single-scan budget the other suites here run on.
  beforeAll(async () => {
    fixture = await createFixtureRepo('py-mypy')
    // After the commit, so the virtualenv stays untracked and out of the file
    // partition; the fixture's own .gitignore keeps it out of `git status`.
    await execa('uv', ['venv'], { cwd: fixture.root })
    outEphemeral = await mkdtemp(join(tmpdir(), 'crank-mypy-out-'))
    outInstalled = await mkdtemp(join(tmpdir(), 'crank-mypy-out-'))

    scan1 = await runHealthScan({ path: fixture.root, out: outEphemeral })

    // …and now the repo owns a copy of its own, which is a different branch of
    // the invocation ladder and a different report.
    await execa(
      'uv',
      ['pip', 'install', '--quiet', '--python', '.venv/bin/python', 'mypy==2.3.0'],
      {
        cwd: fixture.root,
      },
    )
    scan2 = await runHealthScan({ path: fixture.root, out: outInstalled })
  }, 2 * SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await Promise.all(
      [outEphemeral, outInstalled].map((out) => rm(out, { recursive: true, force: true })),
    )
  })

  it('runs the pinned mypy against the virtualenv when the repo has not installed one', () => {
    const byTool = new Map(parse(scan1.json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('mypy')).toMatchObject({
      state: 'ok',
      execution: 'ephemeral-pinned',
      version: '2.3.1',
      provenance: 'repo-config',
    })
  })

  /**
   * Exactly one finding is also the no-double-report proof: pyright ran as a
   * standby and saw the same line, and standing it down cleared its findings.
   */
  it('reports the planted type error once, from the repo’s own tool', () => {
    expect(reportFindings(scan1.report).map(shape)).toEqual([
      {
        category: 'types',
        tool: 'mypy',
        rule: 'return-value',
        file: 'app.py',
        startLine: 6,
        severity: 'error',
        gradeScope: true,
      },
    ])
    // `shape()` carries no provenance, so it is asserted separately.
    expect(
      reportFindings(scan1.report).every((finding) => finding.provenance === 'repo-config'),
    ).toBe(true)
    expect(scan1.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
  })

  /**
   * Both defaults are standbys while mypy is uninstalled — neither can be
   * suppressed on the strength of a tool that still has to be fetched — so both
   * are rebuilt with the fixed stood-down reason. Each keeps the state it
   * earned: pyright ran, ty stood itself down over the virtualenv.
   */
  it('stands both default type checkers down, in the orchestrator’s fixed words', () => {
    const byTool = new Map(parse(scan1.json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('pyright')).toMatchObject({
      state: 'ok',
      reason: 'stood down: types graded by mypy',
    })
    expect(byTool.get('ty')).toMatchObject({
      state: 'not-available',
      reason: 'stood down: types graded by mypy',
    })
  })

  it('warns about nothing, because the repo’s own tool graded the category', () => {
    expect(scan1.report.warnings.filter((warning) => warning.includes('mypy'))).toEqual([])
  })

  /**
   * `version: null` is the load-bearing half. `execution` is derived from
   * detection and would read `repo-installed` even if the runner had wrongly
   * gone to `uvx`; `toolVersion` is set from the same flag that picks the
   * command, so a null version witnesses the repo's own binary.
   */
  it('runs the repo’s own mypy once it is installed', () => {
    const byTool = new Map(parse(scan2.json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('mypy')).toMatchObject({
      state: 'ok',
      execution: 'repo-installed',
      version: null,
      provenance: 'repo-config',
    })
    // The same single finding, whichever binary produced it.
    expect(reportFindings(scan2.report).map(shape)).toEqual([
      {
        category: 'types',
        tool: 'mypy',
        rule: 'return-value',
        file: 'app.py',
        startLine: 6,
        severity: 'error',
        gradeScope: true,
      },
    ])
    expect(
      reportFindings(scan2.report).every((finding) => finding.provenance === 'repo-config'),
    ).toBe(true)
  })

  /** An installed owner can be counted on, so the defaults are never planned. */
  it('plans no default type checker at all when the owner is installed', () => {
    const tools = parse(scan2.json).tools.map((tool) => tool.tool)
    expect(tools).not.toContain('ty')
    expect(tools).not.toContain('pyright')
  })

  it('leaves the target repo clean, mypy’s cache included', async () => {
    expect(await fixture.status()).toBe('')
    expect(await readdir(fixture.root)).not.toContain('.mypy_cache')
  })
})

/**
 * Which config mypy reads is the whole difference between grading a package
 * against its own strictness policy and grading it against a policy that
 * happened to be lying around. Two packages, the same untyped source, one
 * `mypy.ini` between them: the package that wrote it is the only one held to it.
 */
describe('quick scan of a monorepo where one package configures mypy', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await pyTempRepo({
      // No `[tool.mypy]` at the root: every package inherits ownership by
      // declaration alone, so the only config in play is the one api wrote.
      'pyproject.toml':
        '[project]\nname = "root"\nversion = "0.1.0"\n\n[dependency-groups]\ndev = ["mypy"]\n',
      'packages/api/pyproject.toml': '[project]\nname = "api"\nversion = "0.1.0"\n',
      'packages/api/mypy.ini': '[mypy]\ndisallow_untyped_defs = True\n',
      'packages/api/handler.py': UNTYPED_DEF,
      'packages/lib/pyproject.toml': '[project]\nname = "lib"\nversion = "0.1.0"\n',
      'packages/lib/util.py': UNTYPED_DEF,
    })
    // One environment at the root; both packages find it by ancestry.
    await execa('uv', ['venv'], { cwd: fixture.root })
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /**
   * The same source in both packages, and only one finding: api is checked
   * against its own `disallow_untyped_defs`, lib against mypy's defaults —
   * which is what `--config-file=` buys the package that only declared mypy.
   */
  it('holds only the package that configured mypy to its config', () => {
    expect(mypyFindings(result)).toEqual([
      { rule: 'no-untyped-def', file: 'packages/api/handler.py', startLine: 1 },
    ])
  })
})

/**
 * The hermeticity half of the same flag. A package that only *declares* mypy
 * has no config to be pointed at, and mypy's own discovery would then walk up
 * to whatever it finds — the repo's `setup.cfg` here, and on a developer's
 * machine `~/.mypy.ini`, which no portable test can plant and no report should
 * depend on.
 */
describe('quick scan of a repo that declares mypy without configuring it', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await pyTempRepo({
      'pyproject.toml':
        '[project]\nname = "x"\nversion = "0.1.0"\n\n[dependency-groups]\ndev = ["mypy"]\n',
      // Not one of mypy's config artifacts as far as detection is concerned, and
      // very much one as far as mypy is concerned.
      'setup.cfg': '[mypy]\ndisallow_untyped_defs = True\n',
      'app.py': `${UNTYPED_DEF}\n\ndef label(count: int) -> str:\n    return count\n`,
    })
    await execa('uv', ['venv'], { cwd: fixture.root })
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /**
   * `return-value` proves mypy ran at all; the absence of `no-untyped-def`
   * proves it never read the `setup.cfg` two lines above the source it checked.
   */
  it('runs mypy on its own defaults, reading no config the repo did not point it at', () => {
    expect(mypyFindings(result)).toEqual([{ rule: 'return-value', file: 'app.py', startLine: 6 }])
  })
})

/**
 * Zero footprint (spec §7) against a config that asks for the opposite. mypy's
 * report settings are config-settable, are honoured because the invocation
 * points `--config-file` at the repo's own config, and resolve relative to the
 * cwd — which is the repo. The scan must still leave the target untouched.
 */
describe('quick scan of a repo whose mypy config asks for report files', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult
  let entries: readonly string[]

  beforeAll(async () => {
    fixture = await pyTempRepo({
      'mypy.ini': '[mypy]\nlinecount_report = mypyreport\njunit_xml = junit.xml\n',
      'app.py': 'def label(count: int) -> str:\n    return count\n',
    })
    await execa('uv', ['venv'], { cwd: fixture.root })
    result = await runHealthScan({ path: fixture.root })
    entries = (await readdir(fixture.root)).toSorted()
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('leaves the target repo clean, the reports its config asked for included', async () => {
    // Without this the footprint assertions would pass on a mypy that never ran.
    expect(mypyFindings(result)).toEqual([{ rule: 'return-value', file: 'app.py', startLine: 2 }])
    expect(await fixture.status()).toBe('')
    expect(entries).not.toContain('mypyreport')
    expect(entries).not.toContain('junit.xml')
  })
})

/**
 * mypy cannot always speak. A repo whose layout it refuses to build gets an
 * `error` state quoting what mypy said — never an empty clean bill — the scan
 * still completes, and the default mypy displaced grades the category instead.
 */
describe('quick scan of a repo whose layout mypy refuses to check', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await pyTempRepo({
      'mypy.ini': '[mypy]\n',
      // Two top-level modules of the same name: mypy builds one dependency
      // graph over its whole file list and cannot hold both.
      'pkg1/util.py': 'x = 1\n',
      'pkg2/util.py': 'x = 1\n',
    })
    await execa('uv', ['venv'], { cwd: fixture.root })
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('grades types from the promoted default, and says the grade is not the repo’s', () => {
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'A' })
    expect(result.report.warnings).toEqual([
      'pyright: graded types on its default config because mypy reported error',
    ])
  })
})

/**
 * Spec §1's "multiple tools detected for one category → run all": two owners
 * both run and both report, and the default they displaced is not planned at
 * all — pyright *is* an owner here, so there is no standby left to stand down.
 */
describe('quick scan of a repo that owns both mypy and pyright', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await pyTempRepo({
      'mypy.ini': '[mypy]\n',
      'pyrightconfig.json': '{}\n',
      'app.py': await readFile(join(PY_VENV_FIXTURE, 'app.py'), 'utf8'),
      'main.py': await readFile(join(PY_VENV_FIXTURE, 'main.py'), 'utf8'),
    })
    // Neither tool is installed into it: ownership never required installation,
    // so both run from their pins against the repo's own configs.
    await execa('uv', ['venv'], { cwd: fixture.root })
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('runs both owners on the repo’s own configs, standing neither down', () => {
    const byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))
    for (const tool of ['mypy', 'pyright']) {
      expect(byTool.get(tool)).toMatchObject({ state: 'ok', provenance: 'repo-config' })
      expect(byTool.get(tool)?.reason ?? '').not.toMatch(/^stood down/)
    }
    // An owner that can be counted on suppresses the default outright.
    expect(parse(result.json).tools.map((tool) => tool.tool)).not.toContain('ty')
  })

  /**
   * Tool is part of finding identity, so the same error from two owners merges
   * as two findings under one graded category. They come back in the report's
   * own order — same category, same file, same line, so it is the rule name
   * that separates them, not which runner finished first.
   */
  it('reports the one type error once per owner, under one graded category', () => {
    expect(
      reportFindings(result.report)
        .filter((finding) => finding.category === 'types')
        .map((finding) => ({
          tool: finding.tool,
          rule: finding.rule,
          file: finding.file,
          startLine: finding.range.startLine,
        })),
    ).toEqual([
      { tool: 'pyright', rule: 'reportReturnType', file: 'app.py', startLine: 6 },
      { tool: 'mypy', rule: 'return-value', file: 'app.py', startLine: 6 },
    ])
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
  })
})

/**
 * mypy type-checks the transitive closure of what it is given, so a file the
 * job never listed can produce a diagnostic. Reporting it would attribute a
 * finding to a scan that was not asked about that file — in a PR delta, to a
 * package whose files nobody touched — so the runner drops it and keeps the raw
 * output that shows it happened. Driven through the orchestrator's own seam,
 * because the file list is exactly what the orchestrator controls.
 */
describe('the mypy runner given one file that imports another', () => {
  let fixture: FixtureRepo
  let scratch: string
  let result: Awaited<ReturnType<typeof mypyRunner.run>>

  beforeAll(async () => {
    fixture = await pyTempRepo({
      'mypy.ini': '[mypy]\n',
      'h.py': 'def f() -> str:\n    return 1\n',
      'i.py': 'import h\n',
    })
    await execa('uv', ['venv'], { cwd: fixture.root })
    scratch = await mkdtemp(join(tmpdir(), 'crank-mypy-scratch-'))
    result = await mypyRunner.run({
      repoRoot: fixture.root,
      project: makeProject(['h.py', 'i.py', 'mypy.ini']),
      files: ['i.py'],
      scratch,
      runScratch: scratch,
      detection: {
        reason: 'config',
        configFiles: ['mypy.ini'],
        ownedVia: 'mypy.ini',
        installed: false,
      },
      timeoutMs: SCAN_TIMEOUT_MS,
      deep: false,
    })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(scratch, { recursive: true, force: true })
  })

  it('reports nothing for the file it was not asked about, and keeps the evidence', () => {
    expect(result.state).toBe('ok')
    expect(result.findings).toEqual([])
    expect(result.rawFiles.map((file) => basename(file))).toContain('mypy.jsonl')
  })
})

/**
 * The pinned mypy runs outside the project's environment, so the interpreter it
 * resolves third-party imports against has to be handed to it. Without that
 * flag every import in the project comes back `import-not-found` — a confident
 * wall of noise — and this is the repo that tells the difference.
 */
describe('quick scan of a repo whose imports only resolve inside its virtualenv', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await pyTempRepo({
      'mypy.ini': '[mypy]\n',
      'app.py': 'import attrs\n\n\ndef f() -> str:\n    return attrs\n',
    })
    await execa('uv', ['venv'], { cwd: fixture.root })
    await execa('uv', ['pip', 'install', '--quiet', '--python', '.venv/bin/python', 'attrs'], {
      cwd: fixture.root,
    })
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('resolves the project’s dependencies through its virtualenv', () => {
    expect(mypyFindings(result)).toEqual([{ rule: 'return-value', file: 'app.py', startLine: 5 }])
    expect(
      reportFindings(result.report).some((finding) => finding.rule === 'import-not-found'),
    ).toBe(false)
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
    expect(reportFindings(result.report).map(shape)).toEqual([
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
    // Spec §3: one grade per category over the *combined* findings.
    expect(result.report.categories.format).toEqual({ status: 'graded', grade: 'D' })
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
    expect(result.report.categories['dead-code']).toEqual({ status: 'graded', grade: 'A' })
    expect(result.report.categories.complexity).toEqual({ status: 'graded', grade: 'A' })
  })

  /** Spec §3: "per-language breakdown in the report". */
  it('reports which language each category’s findings came from', () => {
    expect(result.report.languages).toEqual({
      'js-ts': { lint: 1, format: 1 },
      python: { types: 1, lint: 1, format: 1 },
    })
  })
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
  let symlinkScan: HealthScanResult
  let rootScan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('py-basic')
    linkDir = await mkdtemp(join(tmpdir(), 'crank-symlink-'))
    const link = join(linkDir, 'repo')
    await symlink(fixture.root, link) // explicit: bites on Linux and under any TMPDIR
    outA = await mkdtemp(join(tmpdir(), 'crank-symlink-out-'))
    outB = await mkdtemp(join(tmpdir(), 'crank-symlink-out-'))
    symlinkScan = await runHealthScan({ path: link, out: outA })
    rootScan = await runHealthScan({ path: fixture.root, out: outB })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(linkDir, { recursive: true, force: true })
    await rm(outA, { recursive: true, force: true })
    await rm(outB, { recursive: true, force: true })
  })

  it('produces the same report whether reached through the symlink or the real root', () => {
    expect(normalizeReport(symlinkScan.json)).toBe(normalizeReport(rootScan.json))
    expect(reportFindings(symlinkScan.report).map((f) => f.id)).toEqual(
      reportFindings(rootScan.report).map((f) => f.id),
    )
  })

  it('records the physical repo path', async () => {
    // Asserted directly: `normalizeReport` blanks `repo.path`, so the
    // report-identity case above cannot see it.
    expect(symlinkScan.report.repo.path).toBe(await realpath(fixture.root))
  })
})

/** The `py-venv` fixture's sources, borrowed by the both-owners scenario. */
const PY_VENV_FIXTURE = fileURLToPath(new URL('./fixtures/py-venv/', import.meta.url))

/** One untyped definition, planted wherever a strictness setting has to bite. */
const UNTYPED_DEF = 'def f(x):\n    return x\n'

/**
 * A throwaway git repo from a file map, committed before it is scanned.
 *
 * The hardening scenarios each need a tree no checked-in fixture has, and the
 * commit has to come first: discovery is `git ls-files`-based, so files written
 * afterwards would be invisible to it. This is `support/history.ts`'s base
 * commit without the second one — same frozen identity, same no-signing.
 *
 * Virtualenvs are created by the callers *after* this returns, so `.venv` stays
 * untracked and out of the file partition.
 */
async function pyTempRepo(files: Readonly<Record<string, string>>): Promise<FixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), 'crank-py-temp-'))
  const git = (args: string[]) => execa('git', args, { cwd: root, env: COMMIT_IDENTITY })

  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    // Sequential: a handful of files, and the order they are written in is the
    // order they read in.
    // eslint-disable-next-line no-await-in-loop
    await mkdir(dirname(target), { recursive: true })
    // eslint-disable-next-line no-await-in-loop
    await writeFile(target, content, 'utf8')
  }
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['add', '--all'])
  await git(['commit', '--quiet', '--no-gpg-sign', '--message', 'fixture'])
  const { stdout: commit } = await git(['rev-parse', 'HEAD'])

  return {
    root,
    commit: commit.trim(),
    status: async () => (await git(['status', '--porcelain'])).stdout,
    remove: () => rm(root, { recursive: true, force: true }),
  }
}

/** The parts of mypy's own findings the config-resolution oracles are about. */
function mypyFindings(result: HealthScanResult) {
  return reportFindings(result.report)
    .filter((finding) => finding.tool === 'mypy')
    .map((finding) => ({
      rule: finding.rule,
      file: finding.file,
      startLine: finding.range.startLine,
    }))
}

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
