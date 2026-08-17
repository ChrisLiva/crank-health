import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RUN_DIRNAME_PATTERN } from '../src/core/output.ts'
import { weightedCount } from '../src/core/grade.ts'
import type { Finding, RunContext, ToolRunner } from '../src/core/types.ts'
import { CATEGORIES } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan, scanTree } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import type { HistoryRepo } from './support/history.ts'
import { createHistoryRepo } from './support/history.ts'
import { expectGolden, normalizeMarkdown, normalizeReport } from './support/report.ts'
import { GOLDEN_TOOLCHAIN, SYSTEM_TOOLS } from './support/system-tools.ts'
import { reportFindings } from '../src/render/json.ts'

/**
 * The four spec-level executable promises, on the fixtures that exercise the
 * whole JS/TS adapter: every planted finding and nothing else · a golden
 * normalized report · byte-identity across runs · zero footprint on the target.
 *
 * These drive `runHealthScan` — the same entry point `cli.ts` uses — so what is
 * proven here is what the binary does. Each fixture is scanned once and the
 * assertions share the result; these runs fetch real pinned tools.
 */

/** Roomy: the first run of a suite may be fetching tools from the npm cache. */
const SCAN_TIMEOUT_MS = 180_000

/** Every finding planted in `test/fixtures/js-basic` — see that fixture's README. */
const PLANTED = [
  {
    category: 'dead-code',
    tool: 'fallow-dead-code',
    rule: 'fallow/unused-export',
    file: 'src/clean.js',
    startLine: 5,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'dead-code',
    tool: 'knip',
    rule: 'knip/unused-exports',
    file: 'src/clean.js',
    startLine: 5,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'complexity',
    tool: 'fallow-health',
    rule: 'fallow/complexity',
    file: 'src/complex.js',
    startLine: 1,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'oxc(no-accumulating-spread)',
    file: 'src/accumulate.js',
    startLine: 2,
    severity: 'warning',
    // A `perf`-class rule: reported, not graded, on our default config (spec §1).
    gradeScope: false,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-const-assign)',
    file: 'src/const-assign.js',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-dupe-keys)',
    file: 'src/dupe-keys.js',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-unreachable)',
    file: 'src/unreachable.js',
    startLine: 6,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'prettier',
    rule: 'prettier/format',
    file: 'src/unformatted.js',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

/** Files planted deliberately clean; a finding in one of these is a false positive. */
const CLEAN_FILES = new Set(['src/index.js', 'src/util/format.js'])

describe('quick scan of the js-basic fixture', () => {
  let fixture: FixtureRepo
  let outside: string
  let scan: HealthScanResult
  let json: string
  let findings: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
    outside = await mkdtemp(join(tmpdir(), 'crank-out-'))
    scan = await runHealthScan({ path: fixture.root })
    json = scan.json
    findings = reportFindings(scan.report)
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
      // The common adapter runs against every repo; on a JS-only one with no
      // workflows most of it has nothing to look at, and says so.
      'bandit',
      'gitleaks',
      'govulncheck',
      'opengrep',
      'osv-scanner',
      'zizmor',
      'tsc',
      'fallow-dead-code',
      'knip',
      'fallow-health',
      'fta',
      'jscpd',
      'oxlint',
      'react-doctor',
      'prettier',
    ])
    expect(report.tools.every((tool) => tool.provenance === 'default-config')).toBe(true)
    expect(report.tools.every((tool) => tool.execution === 'ephemeral-pinned')).toBe(true)
    expect(report.tools.every((tool) => tool.detection === null)).toBe(true)
    // Every tool that produced a version reports the one this release pins.
    for (const tool of report.tools) {
      if (tool.version !== null) expect(tool.version).toBe(tool.pinned)
    }
    expect(findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
  })

  /**
   * A letter without its arithmetic is not checkable. Every graded category
   * says the two numbers its formula divided and what one of them counts, so a
   * reader can redo the sum — and a category nothing graded says nothing,
   * rather than a zero that would read as a clean measurement.
   */
  it('shows the arithmetic behind every grade, and only the graded ones', () => {
    const { categories, gradeBasis, metrics } = scan.report
    expect(Object.keys(gradeBasis)).toEqual(
      CATEGORIES.filter((category) => categories[category].status === 'graded'),
    )

    expect(gradeBasis.lint?.value).toBe(
      weightedCount(
        findings.filter((finding) => finding.category === 'lint' && finding.gradeScope),
      ),
    )
    expect(gradeBasis.lint?.unit).toBe('weighted findings per KLOC')
    expect(gradeBasis.lint?.denominator).toBeGreaterThan(0)

    expect(gradeBasis.format).toEqual({
      value: new Set(
        findings
          .filter((finding) => finding.category === 'format' && finding.gradeScope)
          .map((finding) => finding.file),
      ).size,
      denominator: metrics.format?.formattableFiles,
      unit: 'files failing the formatter',
    })
  })

  /**
   * That this repo has no Python is a fact about the repo, not about each of
   * its packages: bandit is asked once, over the repo, and the row says what it
   * did not scan rather than repeating that sentence per project.
   */
  it('asks bandit once, about the repo, when the repo has no Python at all', () => {
    expect(
      parse(json)
        .tools.filter((tool) => tool.tool === 'bandit')
        .map((tool) => ({
          project: tool.project,
          repoWide: tool.repoWide,
          state: tool.state,
          reason: tool.reason,
        })),
    ).toEqual([
      {
        project: 'repo',
        repoWide: true,
        state: 'not-available',
        reason: 'no Python files, so bandit assessed nothing',
      },
    ])
  })

  it('gates react-doctor out of a repo with no React, without costing lint its grade', () => {
    const report = parse(json)
    // The manifest gate answers before anything runs: no version was ever
    // produced, only the pin says what would have run.
    expect(report.tools.find((tool) => tool.tool === 'react-doctor')).toMatchObject({
      state: 'not-available',
      reason: 'no React dependency detected',
      version: null,
      pinned: '0.9.5',
      execution: 'ephemeral-pinned',
      provenance: 'default-config',
      raw: [],
    })
    // Criterion 15: a category is assessed when *any* of its runs is ok, and
    // oxlint's is — one unavailable complement never un-grades lint.
    expect(report.categories['lint']).toMatchObject({ status: 'graded', grade: 'F' })
  })

  it('grades every category a JS/TS-only repo can reach, and pins the commit', () => {
    const report = parse(json)
    expect(report.repo.commit).toBe(fixture.commit)
    expect(report.categories).toMatchObject({
      // No tsconfig.json and no TypeScript sources: nothing owns types here.
      types: {
        status: 'not-assessed',
        reason: 'no tsconfig.json and no TypeScript sources — nothing owns the types category',
      },
      'dead-code': { status: 'graded', grade: 'F' },
      complexity: { status: 'graded', grade: 'D' },
      // jscpd found no clones: 0% duplicated tokens → A (A ≤3).
      duplication: { status: 'graded', grade: 'A' },
      lint: { status: 'graded', grade: 'F' },
      format: { status: 'graded', grade: 'C' },
      'test-quality': { status: 'not-assessed', reason: 'not assessed — run `--deep`' },
    })
  })

  /**
   * Security has no grade here, and that is the point: this fixture has no
   * Python for bandit and no workflows for zizmor, and the three release-binary
   * scanners are not installed on this machine. A grade of A would have meant
   * "no problems found" when the honest answer is "nothing looked" (spec §8).
   */
  it.runIf(GOLDEN_TOOLCHAIN)(
    'refuses to grade security when nothing actually scanned for it',
    () => {
      const security = parse(json).categories['security']
      expect(security).toMatchObject({ status: 'not-assessed' })
      expect(security?.reason).toContain('assessed nothing')
    },
  )

  /** The ratio grades are only readable next to the numbers they came from. */
  it('reports the measurements the ratio grades were computed from', () => {
    const report = parse(json)
    expect(report.metrics).toEqual({
      // 1 of 9 functions over cognitive 15 = 11.1% → D (C ≤10, D ≤20).
      complexity: { functionsTotal: 9, functionsOverCeiling: 1 },
      // Nothing is copy-pasted in this fixture.
      duplication: { duplicationPercent: 0 },
      // 1 of 9 files failing = 11.1% → C (B ≤10, C ≤30).
      format: { formattableFiles: 9 },
    })
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    await expectGolden('js-basic.report.json', normalizeReport(json))
  })

  /** Spec §9: one run, four artifacts — and the bytes on disk are the bytes it returned. */
  it('writes report.md and agent.md alongside report.json', async () => {
    expect(await readFile(scan.markdownPath, 'utf8')).toBe(scan.markdown)
    expect(await readFile(scan.agentPath, 'utf8')).toBe(scan.agentMarkdown)
    expect(await readdir(scan.outputDir)).toEqual(
      expect.arrayContaining(['report.json', 'report.md', 'agent.md', 'raw']),
    )
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden report.md and agent.md', async () => {
    await expectGolden(
      'js-basic.report.md',
      normalizeMarkdown(scan.markdown, scan.report.repo.path),
    )
    await expectGolden(
      'js-basic.agent.md',
      normalizeMarkdown(scan.agentMarkdown, scan.report.repo.path),
    )
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

  it('leaves the target repo clean: the run directory ignores itself', async () => {
    expect(await fixture.status()).toBe('')
    expect(basename(scan.outputDir)).toMatch(RUN_DIRNAME_PATTERN)
    expect(dirname(scan.outputDir)).toBe(join(fixture.root, '.codebase-health'))
    expect(await readdir(scan.outputDir)).toContain('report.json')
  })

  it(
    'writes nothing at all into the repo when --out points elsewhere',
    async () => {
      await rm(join(fixture.root, '.codebase-health'), { recursive: true, force: true })
      const result = await runHealthScan({ path: fixture.root, out: outside })

      expect(result.outputDir).toBe(outside)
      expect(await fixture.status()).toBe('')
      expect(await readdir(fixture.root)).toEqual(['.git', 'README.md', 'package.json', 'src'])
      // Every tool's evidence is kept next to the report (spec §9), under the
      // project that produced it — one project here, so `raw/root/`. A machine
      // with the release-binary security tools also has a `raw/repo/`.
      expect(await readdir(join(outside, 'raw'))).toContain('root')
      const raw = (await readdir(join(outside, 'raw', 'root'))).toSorted()
      expect(GOLDEN_TOOLCHAIN ? raw : raw.filter(fromFetchableTool)).toEqual([
        'fallow-dead-code.json',
        'fallow-dead-code.stderr.txt',
        'fallow-health.json',
        'fallow-health.stderr.txt',
        'fta.json',
        'jscpd-report.json',
        'knip.json',
        'oxlint.sarif.json',
        'prettier.txt',
      ])
    },
    SCAN_TIMEOUT_MS,
  )

  it('keeps raw tool evidence next to the report', async () => {
    const raw = await readFile(join(outside, 'raw', 'root', 'oxlint.sarif.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: '2.1.0' })
  })
})

/**
 * Every rule id that names an *export*-kind dead-code result. These are the
 * ones a library demotes: its exports are the product, consumed from outside
 * the repo, so "nothing here imports it" is not evidence they are dead.
 */
const DEMOTED_EXPORT_RULES = new Set([
  'knip/unused-exports',
  'knip/unused-types',
  'knip/unused-enumMembers',
  'knip/unused-namespaceMembers',
  'fallow/unused-export',
])

describe('quick scan of the js-library fixture', () => {
  let fixture: FixtureRepo
  let scan: HealthScanResult
  let findings: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-library')
    scan = await runHealthScan({ path: fixture.root })
    findings = reportFindings(scan.report)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /**
   * `src/util.js` is byte-identical to js-basic's `src/clean.js`, where the
   * same two findings are graded. The only difference is the manifest: this one
   * declares `exports`/`types`, so both tools' verdicts are still reported, at
   * the same severity, rule and anchor, and neither one moves the grade.
   */
  it('reports both tools’ unused-export findings, and grades neither', () => {
    const exports = findings.filter((finding) => DEMOTED_EXPORT_RULES.has(finding.rule))
    expect(
      exports.map((finding) => ({ ...shape(finding), provenance: finding.provenance })),
    ).toEqual([
      {
        category: 'dead-code',
        tool: 'fallow-dead-code',
        rule: 'fallow/unused-export',
        file: 'src/util.js',
        startLine: 5,
        severity: 'warning',
        gradeScope: false,
        provenance: 'default-config',
      },
      {
        category: 'dead-code',
        tool: 'knip',
        rule: 'knip/unused-exports',
        file: 'src/util.js',
        startLine: 5,
        severity: 'warning',
        gradeScope: false,
        provenance: 'default-config',
      },
    ])
    // The demotion has to reach the grade, or "advisory" is only a label: the
    // identical fixture with an application manifest grades dead-code F.
    expect(scan.report.categories['dead-code']).toEqual({ status: 'graded', grade: 'A' })
  })

  it('marks them advisory in report.md, under their own heading', () => {
    expect(scan.markdown).toContain('Advisory findings — reported, not counted toward the grade')
    expect(scan.markdown).toMatch(/`fallow\/unused-export`.*\[advisory\]/)
    expect(scan.markdown).toMatch(/`knip\/unused-exports`.*\[advisory\]/)
    expect(scan.markdown).toContain('`src/util.js:5`')
  })

  /**
   * agent.md asks a coding agent to *do* something, and there is nothing to do
   * here: a category at A produces no task (`needsWork`). That absence is the
   * demotion arriving at the artifact an agent actually reads — an advisory
   * finding is reported in report.md and never becomes work.
   */
  it('raises no agent task for an advisory finding', () => {
    expect(scan.agentMarkdown).toContain('No tasks: every assessed category is graded A.')
    expect(scan.agentMarkdown).not.toContain('src/util.js')
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root })
      expect(normalizeReport(second.json)).toBe(normalizeReport(scan.json))
      expect(reportFindings(second.report).map((finding) => finding.id)).toEqual(
        findings.map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )
})

/**
 * The other half of the standby rule: ts-owned proves our default stands down
 * when the repo's own linter grades the category, and this fixture proves it is
 * promoted when the owner cannot. ESLint is declared here and configured only
 * through `.eslintrc.json`, which the pinned ESLint no longer reads, and there
 * is no `node_modules` to fall back on — so the owner reports `not-available`
 * and the category would go ungraded if oxlint had been dropped for it.
 */
describe('quick scan of the js-legacy-eslint fixture', () => {
  let fixture: FixtureRepo
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-legacy-eslint')
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('promotes the standby when the repo’s own linter cannot speak', () => {
    const byTool = new Map(parse(scan.json).tools.map((tool) => [tool.tool, tool]))
    expect(byTool.get('eslint')).toMatchObject({
      state: 'not-available',
      reason: expect.stringContaining('no longer reads') as unknown as string,
    })
    // Not stood down: nothing graded lint but oxlint itself.
    expect(byTool.get('oxlint')).toMatchObject({ state: 'ok', reason: null })
    expect(scan.report.warnings).toEqual([
      'oxlint: graded lint on its default config because eslint reported not-available',
    ])
  })

  /**
   * The promotion has to reach the grade, or the warning is only a label: a
   * graded lint category is what lets `--fail-under` hold this repo to a
   * standard without `--allow-missing`.
   */
  it('grades lint from the promoted standby’s findings', () => {
    expect(scan.report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
    expect(
      reportFindings(scan.report)
        .filter((finding) => finding.category === 'lint')
        .map((finding) => [finding.tool, finding.rule, finding.severity, finding.gradeScope]),
    ).toEqual([['oxlint', 'eslint(no-const-assign)', 'error', true]])
  })

  it('tells the agent where the grade came from', () => {
    expect(scan.agentMarkdown).toContain(
      '> How this run was graded: oxlint: graded lint on its default config because eslint reported not-available',
    )
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root })
      expect(normalizeReport(second.json)).toBe(normalizeReport(scan.json))
      expect(reportFindings(second.report).map((finding) => finding.id)).toEqual(
        reportFindings(scan.report).map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('quick scan of the ts-owned fixture', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('ts-owned')
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('finds every planted finding, and nothing else', () => {
    expect(reportFindings(result.report).map(shape)).toEqual([
      {
        category: 'types',
        tool: 'tsc',
        rule: 'TS2322',
        file: 'src/types.ts',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'fallow-dead-code',
        rule: 'fallow/unused-file',
        file: 'src/lint.js',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'knip',
        rule: 'knip/unused-file',
        file: 'src/lint.js',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'fallow-dead-code',
        rule: 'fallow/unused-export',
        file: 'src/util.ts',
        startLine: 5,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'knip',
        rule: 'knip/unused-exports',
        file: 'src/util.ts',
        startLine: 5,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'complexity',
        tool: 'fallow-health',
        rule: 'fallow/complexity',
        file: 'src/complex.ts',
        startLine: 1,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'lint',
        tool: 'eslint',
        rule: 'no-unused-vars',
        file: 'src/lint.js',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'lint',
        tool: 'eslint',
        rule: 'eqeqeq',
        file: 'src/lint.js',
        startLine: 3,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'format',
        tool: 'prettier',
        rule: 'prettier/format',
        file: 'src/unformatted.ts',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
    ])
  })

  it('honours the repo’s own configs, ephemerally, and tags them repo-config', () => {
    const byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))

    expect(byTool.get('tsc')).toMatchObject({
      execution: 'ephemeral-pinned',
      provenance: 'repo-config',
      state: 'ok',
      version: '7.0.2',
      detection: { reason: 'config+dependency', configFiles: ['tsconfig.json'], installed: false },
    })
    expect(byTool.get('eslint')).toMatchObject({
      provenance: 'repo-config',
      state: 'ok',
      detection: { reason: 'config+dependency', configFiles: ['eslint.config.js'] },
    })
    expect(byTool.get('prettier')).toMatchObject({
      provenance: 'repo-config',
      state: 'ok',
      detection: { reason: 'config+dependency', configFiles: ['.prettierrc.json'] },
    })
  })

  /**
   * Spec §1: owned → their tool; not owned → ours. The branches are exclusive —
   * but eslint is declared here and not installed, so it has to be fetched
   * before it can say anything. Our default runs behind it and stands down once
   * eslint has actually graded lint, which is why the row is still in the report
   * saying exactly why it contributed nothing.
   */
  it('stands oxlint down, because this repo already owns a linter', () => {
    const byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))
    expect([...byTool.keys()]).toContain('eslint')
    expect(byTool.get('oxlint')).toMatchObject({
      state: 'ok',
      reason: 'stood down: lint graded by eslint',
    })
  })

  it('grades types and dead code, which the untooled fixture could not reach', () => {
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
    expect(result.report.categories['dead-code']).toEqual({ status: 'graded', grade: 'F' })
  })

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe('quick scan of a repo that owns two linters and a formatter', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-multi-tool')
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /** Spec §1: "run all, merge findings … grade on the union". */
  it('merges both linters’ findings, each tagged with the tool that made it', () => {
    const lint = reportFindings(result.report).filter((finding) => finding.category === 'lint')
    expect(lint.map((finding) => [finding.tool, finding.rule, finding.file])).toEqual([
      ['eslint', 'eqeqeq', 'src/both.js'],
      ['biome-lint', 'lint/suspicious/noDoubleEquals', 'src/both.js'],
    ])
    // Two tools, one line, two distinct identities — the tool is in the hash.
    expect(new Set(lint.map((finding) => finding.id)).size).toBe(2)
    expect(lint.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(lint.every((finding) => finding.gradeScope)).toBe(true)
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
  })

  it('stands both of our defaults down: this repo owns lint and format', () => {
    const byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))
    expect([...byTool.keys()]).toEqual(
      expect.arrayContaining(['eslint', 'biome-lint', 'biome-format']),
    )
    expect(byTool.get('oxlint')).toMatchObject({
      state: 'ok',
      reason: 'stood down: lint graded by biome-lint, eslint',
    })
    expect(byTool.get('prettier')).toMatchObject({
      state: 'ok',
      reason: 'stood down: format graded by biome-format',
    })
  })

  /**
   * The proof of `complementary: true`: a non-complementary default is dropped
   * from the plan entirely in a repo that owns ESLint and Biome, so a tool
   * record existing at all — with the React gate's reason, not a "stood down"
   * one — means react-doctor survived ownership suppression.
   */
  it('keeps react-doctor in the plan even though the repo owns two linters', () => {
    const byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))
    expect([...byTool.keys()]).toContain('react-doctor')
    expect(byTool.get('react-doctor')).toMatchObject({
      state: 'not-available',
      reason: 'no React dependency detected',
    })
  })

  /** And the human report says so in the Notes column, not only the JSON. */
  it('says in report.md why our defaults contributed nothing', () => {
    expect(result.markdown).toContain('stood down: lint graded by biome-lint, eslint')
  })

  it('grades format from Biome’s verdict alone', () => {
    expect(
      reportFindings(result.report).filter((finding) => finding.category === 'format'),
    ).toMatchObject([{ tool: 'biome-format', rule: 'biome/format', file: 'src/unformatted.js' }])
    expect(result.report.metrics.format).toEqual({ formattableFiles: 4 })
    expect(result.report.categories.format).toEqual({ status: 'graded', grade: 'C' })
  })

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe('the same rule class under two provenances', () => {
  it(
    'tags a formatting failure repo-config where the repo owns prettier, default-config where it does not',
    async () => {
      const owned = await createFixtureRepo('ts-owned')
      const untooled = await createFixtureRepo('js-basic')
      try {
        const [byRepo, byDefault] = await Promise.all([
          runHealthScan({ path: owned.root }),
          runHealthScan({ path: untooled.root }),
        ])

        expect(pick(byRepo)).toMatchObject({ provenance: 'repo-config', gradeScope: true })
        expect(pick(byDefault)).toMatchObject({ provenance: 'default-config', gradeScope: true })
        // Same rule, same tool, different repos — and therefore different ids.
        expect(pick(byRepo)?.id).not.toBe(pick(byDefault)?.id)
      } finally {
        await owned.remove()
        await untooled.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('zero footprint', () => {
  it.each(['js-basic', 'js-owned', 'ts-owned', 'js-multi-tool', 'js-library', 'js-legacy-eslint'])(
    'leaves %s untouched after a full scan',
    async (name) => {
      const fixture = await createFixtureRepo(name)
      const outside = await mkdtemp(join(tmpdir(), 'crank-zero-'))
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

describe('quick scan of a repo that owns oxlint but has not installed it', () => {
  it(
    'honours the repo config, ephemerally, and grades what that config flags',
    async () => {
      const fixture = await createFixtureRepo('js-owned')
      try {
        const result = await runHealthScan({ path: fixture.root, only: ['lint'] })

        expect(result.report.tools[0]).toMatchObject({
          tool: 'oxlint',
          execution: 'ephemeral-pinned',
          provenance: 'repo-config',
          version: '1.77.0',
          state: 'ok',
          detection: {
            reason: 'config+dependency',
            configFiles: ['.oxlintrc.json'],
            installed: false,
            version: null,
          },
        })
        // Their config turns correctness off and one style rule on; a repo is
        // graded on the standard it chose for itself, style rules included.
        expect(
          reportFindings(result.report).map((finding) => ({
            rule: finding.rule,
            severity: finding.severity,
            provenance: finding.provenance,
            gradeScope: finding.gradeScope,
          })),
        ).toEqual([
          {
            rule: 'unicorn(prefer-ternary)',
            severity: 'warning',
            provenance: 'repo-config',
            gradeScope: true,
          },
        ])
        expect(await fixture.status()).toBe('')
      } finally {
        await fixture.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('quick scan of crank-health itself', () => {
  it(
    'runs the repo-installed binaries with the repo config',
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'crank-self-'))
      try {
        const result = await runHealthScan({
          path: fileURLToPath(new URL('..', import.meta.url)),
          out,
          only: ['lint'],
        })
        // crank-health's own root project. `test/fixtures/` holds manifests of
        // its own, so crank-health scanning itself is a multi-project scan, and
        // a fixture that owns Biome contributes a lint tool record too.
        expect(
          result.report.tools.find((tool) => tool.tool === 'oxlint' && tool.project === '.'),
        ).toMatchObject({
          tool: 'oxlint',
          execution: 'repo-installed',
          provenance: 'repo-config',
          state: 'ok',
          detection: {
            reason: 'config+dependency',
            configFiles: ['.oxlintrc.json'],
            installed: true,
          },
        })
        expect(result.report.categories.format).toEqual({
          status: 'not-assessed',
          reason: 'not selected by --only',
        })
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('a repo whose own linter is broken', () => {
  it(
    'reports the category as error and still writes a complete report',
    async () => {
      const fixture = await repoWithBrokenOxlint('echo "boom" 1>&2; exit 1')
      try {
        const result = await runHealthScan({ path: fixture.root, only: ['lint'] })

        expect(result.report.categories.lint).toEqual({
          status: 'error',
          reason: expect.stringContaining('boom') as unknown as string,
        })
        expect(result.report.tools[0]?.state).toBe('error')
        // The other seven categories are still reported, and the artifact exists.
        expect(Object.keys(result.report.categories)).toHaveLength(8)
        expect(await readFile(result.reportPath, 'utf8')).toBe(result.json)
      } finally {
        await fixture.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )

  it(
    'treats unparseable output as an error rather than as zero findings',
    async () => {
      const fixture = await repoWithBrokenOxlint('echo "definitely not sarif"')
      try {
        const result = await runHealthScan({ path: fixture.root, only: ['lint'] })
        expect(result.report.categories.lint).toMatchObject({ status: 'error' })
        expect(result.report.tools[0]?.reason).toContain('could not parse oxlint output')
        // The evidence is kept even though nothing could be made of it (spec §8).
        expect(result.report.tools[0]?.raw).toEqual(['raw/root/oxlint.sarif.json'])
      } finally {
        await fixture.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

/** Plants a repo-owned oxlint whose binary does `sabotage` instead of linting. */
async function repoWithBrokenOxlint(sabotage: string): Promise<FixtureRepo> {
  const fixture = await createFixtureRepo('js-basic')
  await writeFile(join(fixture.root, '.oxlintrc.json'), '{}\n')
  await mkdir(join(fixture.root, 'node_modules', '.bin'), { recursive: true })
  await writeFile(
    join(fixture.root, 'node_modules', '.bin', 'oxlint'),
    `#!/bin/sh\n${sabotage}\n`,
    {
      mode: 0o755,
    },
  )
  return fixture
}

/** The one formatting finding a scan produced. */
function pick(result: HealthScanResult): Finding | undefined {
  return reportFindings(result.report).find((finding) => finding.rule === 'prettier/format')
}

/**
 * Raw-output files from the tools every machine can fetch. The three
 * release-binary scanners contribute evidence only where they are installed —
 * see `support/system-tools.ts`.
 */
function fromFetchableTool(name: string): boolean {
  return !SYSTEM_TOOLS.some((tool) => name.startsWith(tool))
}

/** Records what each run was told about its project, without running a tool. */
function nestingProbe(): { runner: ToolRunner; nested: string[][] } {
  const nested: string[][] = []
  return {
    runner: {
      tool: 'jscpd',
      category: 'duplication',
      pinnedVersion: '1.0.0',
      repoWidePass: true,
      detect: async () => null,
      run: async (ctx: RunContext) => {
        nested.push([...(ctx.nestedProjects ?? [])])
        return { state: 'ok', findings: [], rawFiles: [] }
      },
    },
    nested,
  }
}

/**
 * What `--project` narrows, and what it must not.
 *
 * Scoping picks which projects are graded. A project's own measurement is not
 * one of those things: the packages inside it are inside it however the run was
 * scoped, and a runner handed a directory has to be told so — or scoping the
 * parent would fold its packages' code into the parent's own grade.
 */
describe('--project scoping and what a project is measured over', () => {
  let repo: HistoryRepo
  let scratch: string

  beforeAll(async () => {
    repo = await createHistoryRepo({
      base: {
        'package.json': '{ "name": "root" }\n',
        'src/a.ts': 'export const a = 1\n',
        'packages/web/package.json': '{ "name": "web" }\n',
        'packages/web/src/b.ts': 'export const b = 2\n',
      },
      head: [],
    })
    scratch = await mkdtemp(join(tmpdir(), 'crank-scope-'))
  })

  afterAll(async () => {
    await repo.remove()
    await rm(scratch, { recursive: true, force: true })
  })

  async function nestedFor(projects?: readonly string[]): Promise<string[][]> {
    const { runner, nested } = nestingProbe()
    await scanTree({
      repoRoot: repo.root,
      scratch,
      only: ['duplication'],
      adapters: [{ language: 'common', runners: [runner], detect: async () => true }],
      ...(projects === undefined ? {} : { projects }),
    })
    return nested
  }

  it('tells the root project the same nested projects, scoped or not', async () => {
    expect(await nestedFor(['.'])).toEqual([['packages/web']])

    // The unscoped run adds the package's own pass and the repo-wide one, which
    // the pool may finish in any order — so this is about which lists were
    // handed out, not about when. The root's own list is the same list.
    const unscoped = await nestedFor()
    expect(unscoped).toHaveLength(3)
    expect(unscoped).toContainEqual(['packages/web'])
    expect(unscoped.filter((nested) => nested.length === 0)).toHaveLength(2)
  })
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
  readonly repo: { readonly commit: string }
  readonly categories: Record<string, { status: string; grade?: string; reason?: string }>
  readonly metrics: Record<string, Record<string, number>>
  readonly tools: {
    readonly tool: string
    readonly project: string
    readonly repoWide?: boolean
    readonly state: string
    readonly reason: string | null
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
