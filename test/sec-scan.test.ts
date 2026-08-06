import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Category, Finding, LanguageAdapter } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { normalizeMarkdown, normalizeReport } from './support/report.ts'
import { GOLDEN_TOOLCHAIN, SYSTEM_TOOLS, installedSystemTools } from './support/system-tools.ts'

/**
 * The common adapter, end to end on `test/fixtures/sec-basic`.
 *
 * Three of its six tools — gitleaks, opengrep and osv-scanner — are release
 * binaries with no npm or PyPI distribution, so on most machines they are
 * simply absent. That is not a hole in the test: spec §8's degradation is one
 * of the behaviours worth proving, and this file asserts *both* paths. The
 * findings those tools would produce are covered from captured bytes in
 * `common-parse.test.ts`, which runs everywhere.
 */

const GOLDEN = fileURLToPath(new URL('./golden/sec-basic.report.json', import.meta.url))
const GOLDEN_MD = fileURLToPath(new URL('./golden/sec-basic.report.md', import.meta.url))
const GOLDEN_AGENT = fileURLToPath(new URL('./golden/sec-basic.agent.md', import.meta.url))

/** The fake AWS key planted in `src/config.py`; see that fixture's README. */
const PLANTED_SECRET = 'AKIAZ7QK4TGVN2XR6WPD'

/** Roomy: the first run of a suite may be fetching tools into the caches. */
const SCAN_TIMEOUT_MS = 180_000

const installed = await installedSystemTools()

/**
 * The security and duplication findings `test/fixtures/sec-basic` plants, from
 * the tools that run on every machine — see that fixture's README. The three
 * system tools add to this list when they are installed; they never change it.
 */
const PLANTED = [
  {
    category: 'security',
    tool: 'zizmor',
    rule: 'dangerous-triggers',
    file: '.github/workflows/ci.yml',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'security',
    tool: 'zizmor',
    rule: 'excessive-permissions',
    file: '.github/workflows/ci.yml',
    startLine: 5,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'security',
    tool: 'zizmor',
    rule: 'artipacked',
    file: '.github/workflows/ci.yml',
    startLine: 8,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'security',
    tool: 'zizmor',
    rule: 'unpinned-uses',
    file: '.github/workflows/ci.yml',
    startLine: 8,
    // A pin-a-digest chore: demoted from zizmor's High, still graded.
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'security',
    tool: 'bandit',
    rule: 'B404',
    file: 'src/config.py',
    startLine: 3,
    severity: 'info',
    // bandit's LOW tier: reported, never graded (see `bandit.ts`).
    gradeScope: false,
  },
  {
    category: 'security',
    tool: 'bandit',
    rule: 'B602',
    file: 'src/config.py',
    startLine: 13,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'src/handler.js',
    startLine: 5,
    severity: 'warning',
    // The grade is the token percentage; the clones are the evidence.
    gradeScope: false,
  },
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'src/report.js',
    startLine: 1,
    severity: 'warning',
    gradeScope: false,
  },
] as const

describe('quick scan of the sec-basic fixture', () => {
  let fixture: FixtureRepo
  let outside: string
  let scan: HealthScanResult
  let json: string
  let findings: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('sec-basic')
    outside = await mkdtemp(join(tmpdir(), 'crank-sec-out-'))
    scan = await runHealthScan({ path: fixture.root })
    json = scan.json
    findings = scan.report.findings
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(outside, { recursive: true, force: true })
  })

  it('finds every planted security and duplication finding', () => {
    const relevant = findings.filter(
      (finding) => finding.category === 'security' || finding.category === 'duplication',
    )
    expect(relevant.filter(fromAlwaysAvailableTool).map(shape)).toEqual(
      PLANTED.map((planted) => ({ ...planted })),
    )
  })

  /**
   * Nothing outside the planted set moves a grade. The fixture also carries a
   * handful of deliberately advisory findings (`fallow/complexity` on the
   * duplicated function); they are `gradeScope: false` and may be there.
   */
  it('plants nothing else that counts toward a grade', () => {
    const graded = findings
      .filter((finding) => finding.gradeScope)
      .filter(fromAlwaysAvailableTool)
      .map(shape)
    expect(graded).toEqual([
      ...PLANTED.filter((planted) => planted.gradeScope),
      // The same `eval` a linter also objects to; see the fixture README.
      {
        category: 'lint',
        tool: 'oxlint',
        rule: 'eslint(no-eval)',
        file: 'src/handler.js',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
    ])
  })

  /**
   * A finding's id is hash(category, tool, rule, file, anchor, occurrence) —
   * never its severity (see `fingerprint.ts`). Re-tiering an audit therefore
   * has to leave every id where it was, or a PR delta would report the whole
   * security category as fixed-and-reintroduced. These ids are frozen: only the
   * two tools every machine has, so the list does not depend on the toolchain.
   */
  it('keeps finding ids stable across a severity change', () => {
    const stable = findings.filter(
      (finding) =>
        finding.category === 'security' && (finding.tool === 'zizmor' || finding.tool === 'bandit'),
    )
    expect(stable.map((finding) => `${finding.tool}/${finding.rule} ${finding.id}`)).toEqual([
      'zizmor/dangerous-triggers ddcf1cc8f8861c2e',
      'zizmor/excessive-permissions 7cdf78dbce1787a4',
      'zizmor/artipacked 5f7e4c17a696413a',
      'zizmor/unpinned-uses 963be61c2e2585e1',
      'bandit/B404 13559debab826f4d',
      'bandit/B602 2dda43453c99d548',
    ])
  })

  /**
   * Spec §3's absolute shape: any error/high → at best D. Which grade this is
   * depends on whether gitleaks ran — a secret is an F on its own, which is the
   * conditional assertion below.
   */
  it('grades security from the union of every security tool that ran', () => {
    const state = parse(json).categories.security
    expect(state?.status).toBe('graded')
    expect(state?.grade).toBe(installed.has('gitleaks') ? 'F' : 'D')
  })

  it.runIf(installed.has('gitleaks'))(
    'reports the planted secret as critical, which is an F on its own',
    () => {
      const secrets = findings.filter((finding) => finding.tool === 'gitleaks')
      expect(secrets.map(shape)).toEqual([
        {
          category: 'security',
          tool: 'gitleaks',
          rule: 'aws-access-token',
          file: 'src/config.py',
          startLine: 8,
          severity: 'critical',
          gradeScope: true,
        },
      ])
      expect(parse(json).categories.security?.grade).toBe('F')
    },
  )

  /**
   * The secret is redacted at the adapter (see `gitleaks.ts`), and no renderer
   * may put it back: none of them reads the repo, so none of them can quote the
   * flagged line. This asserts the property over every artifact a run writes,
   * whether or not gitleaks was there to find it.
   */
  it('never puts the planted secret into any artifact, raw evidence included', async () => {
    for (const artifact of [json, scan.markdown, scan.agentMarkdown]) {
      expect(artifact).not.toContain(PLANTED_SECRET)
      expect(artifact).not.toContain('AKIA')
    }
    await expectNoSecretUnder(scan.outputDir)
  })

  it.runIf(installed.has('opengrep'))('reports the planted SAST findings', () => {
    expect(
      findings.filter((finding) => finding.tool === 'opengrep').map((finding) => finding.rule),
    ).toEqual(['python-subprocess-shell-true', 'js-eval-call'])
  })

  it.runIf(installed.has('osv-scanner'))('reports the vulnerable pinned dependency', () => {
    const vulnerabilities = findings.filter((finding) => finding.tool === 'osv-scanner')
    expect(vulnerabilities.length).toBeGreaterThan(0)
    expect(vulnerabilities.every((finding) => finding.file === 'package-lock.json')).toBe(true)
    expect(vulnerabilities.every((finding) => finding.gradeScope)).toBe(true)
  })

  /** Spec §8: a missing prerequisite is not-available *with an install hint*. */
  it.each(SYSTEM_TOOLS.filter((tool) => !installed.has(tool)))(
    'degrades cleanly when %s is not installed, and says how to install it',
    (tool) => {
      const record = parse(json).tools.find((entry) => entry.tool === tool)
      expect(record).toMatchObject({ state: 'not-available', version: null })
      expect(record?.reason).toContain('is not on PATH')
      expect(record?.reason).toContain('brew install')
    },
  )

  /**
   * jscpd's token percentage is the duplication grade (spec §3): 47% of tokens
   * duplicated is well past the D band's 20%.
   */
  it('grades duplication on jscpd’s token percentage, not on the clone count', () => {
    const report = parse(json)
    expect(report.metrics.duplication?.['duplicationPercent']).toBeCloseTo(47.03, 1)
    expect(report.categories.duplication).toEqual({ status: 'graded', grade: 'F' })
  })

  it('runs the common adapter’s six tools, all on default configs', () => {
    const common = parse(json).tools.filter((tool) => tool.scope === 'common')
    expect(common.map((tool) => tool.tool)).toEqual([
      'bandit',
      'gitleaks',
      'opengrep',
      'osv-scanner',
      'zizmor',
      'jscpd',
    ])
    expect(common.every((tool) => tool.provenance === 'default-config')).toBe(true)
    expect(common.every((tool) => tool.detection === null)).toBe(true)
  })

  /**
   * The golden records the degradation path, because that is the one every
   * machine can reproduce: a report from a machine with gitleaks, opengrep and
   * osv-scanner installed contains their findings and versions and cannot be
   * byte-compared with one from a machine without them. Determinism itself is
   * asserted unconditionally by the run-twice test below, which is the spec's
   * actual promise (§6).
   */
  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    expect(normalizeReport(json)).toBe(await readFile(GOLDEN, 'utf8'))
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden report.md and agent.md', async () => {
    expect(normalizeMarkdown(scan.markdown, scan.report.repo.path)).toBe(
      await readFile(GOLDEN_MD, 'utf8'),
    )
    expect(normalizeMarkdown(scan.agentMarkdown, scan.report.repo.path)).toBe(
      await readFile(GOLDEN_AGENT, 'utf8'),
    )
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
   * jscpd's default reporter writes `report/` next to wherever it started, and
   * gitleaks and osv-scanner both write a report file. All three are pointed at
   * the scratch dir; this is the assertion that keeps them there.
   */
  it('leaves the target repo clean, tool reports included', async () => {
    expect(await fixture.status()).toBe('')
    const entries = await readdir(fixture.root)
    expect(entries).not.toContain('report')
    expect(entries).not.toContain('jscpd-report.json')
    expect(entries).not.toContain('gitleaks.json')
    expect(entries).not.toContain('osv-scanner.json')
  })

  it(
    'writes every tool’s evidence next to the report, and nothing into the repo',
    async () => {
      await rm(join(fixture.root, '.codebase-health'), { recursive: true, force: true })
      const result = await runHealthScan({ path: fixture.root, out: outside })

      expect(result.outputDir).toBe(outside)
      expect(await fixture.status()).toBe('')
      expect((await readdir(join(outside, 'raw'))).toSorted()).toEqual(['repo', 'root'])
      const perProject = await readdir(join(outside, 'raw', 'root'))
      expect(perProject).toContain('jscpd-report.json')
      expect(perProject).toContain('bandit.json')
      // Workflow auditing is the repo's, not any one project's.
      expect(await readdir(join(outside, 'raw', 'repo'))).toContain('zizmor.json')
    },
    SCAN_TIMEOUT_MS,
  )
})

/** A ruff-shaped runner: category `lint`, emitting a `security` finding. */
const ruffLike = (findings: readonly Finding[]): LanguageAdapter => ({
  language: 'python',
  detect: () => Promise.resolve(true),
  runners: [
    {
      tool: 'ruff-lint',
      category: 'lint',
      pinnedVersion: '0.16.1',
      detect: () => Promise.resolve(null),
      run: () => Promise.resolve({ state: 'ok', findings, rawFiles: [] }),
    },
  ],
})

const securityRunner: LanguageAdapter = {
  language: 'common',
  detect: () => Promise.resolve(true),
  runners: [
    {
      tool: 'bandit',
      category: 'security',
      pinnedVersion: '1.9.4',
      complementary: true,
      detect: () => Promise.resolve(null),
      run: () => Promise.resolve({ state: 'ok', findings: [], rawFiles: [] }),
    },
  ],
}

const ruffSecurityFinding: Finding = {
  id: 'ruff-s602',
  category: 'security',
  tool: 'ruff-lint',
  rule: 'S602',
  severity: 'error',
  file: 'src/config.py',
  range: { startLine: 13, startCol: 12, endLine: 13, endCol: 70 },
  message: 'subprocess call with shell=True',
  provenance: 'repo-config',
  gradeScope: true,
}

/**
 * The handoff M5 left behind: ruff routes its `S` rules to the security
 * category, but until a security runner reported, `categories.security` stayed
 * `not-assessed` and those findings reached no grade at all. These two tests
 * pin the behaviour in both directions.
 */
describe('security findings from a tool in another category', () => {
  let fixture: FixtureRepo

  beforeAll(async () => {
    fixture = await createFixtureRepo('sec-basic')
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('folds them into the security grade once any security runner reports', async () => {
    const result = await runHealthScan({
      path: fixture.root,
      adapters: [ruffLike([ruffSecurityFinding]), securityRunner],
    })
    // The finding came out of a lint runner and graded as security.
    expect(result.report.categories.security).toEqual({ status: 'graded', grade: 'D' })
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'A' })
  })

  it('leaves the category not-assessed when no security runner reports at all', async () => {
    const result = await runHealthScan({
      path: fixture.root,
      adapters: [ruffLike([ruffSecurityFinding])],
    })
    expect(result.report.categories.security).toEqual({
      status: 'not-assessed',
      reason: 'no tool available for this category',
    })
    // Still reported — a finding nobody grades is not a finding nobody sees.
    expect(result.report.findings.map((finding) => finding.rule)).toEqual(['S602'])
  })
})

describe('zero footprint', () => {
  it(
    'leaves sec-basic untouched after a full scan',
    async () => {
      const fixture = await createFixtureRepo('sec-basic')
      const outside = await mkdtemp(join(tmpdir(), 'crank-sec-zero-'))
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
 * A stub gitleaks: `version` answers, `dir` writes the canned report to
 * whatever `--report-path` names. The bytes are shaped exactly like a real
 * `--redact=100` report — `Secret` and `Match` already `REDACTED` — because
 * that is the only input this runner is ever given.
 */
const STUB_GITLEAKS = `#!/bin/sh
if [ "$1" = "version" ]; then echo "8.30.1"; exit 0; fi
report=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--report-path" ]; then shift; report="$1"; fi
  shift
done
cat > "$report" <<'JSON'
[
  {
    "RuleID": "aws-access-token",
    "Description": "Identified a pattern that may indicate AWS credentials",
    "File": "src/config.py",
    "StartLine": 8,
    "StartColumn": 21,
    "EndLine": 8,
    "EndColumn": 40,
    "Secret": "REDACTED",
    "Match": "REDACTED"
  }
]
JSON
exit 0
`

/**
 * The chain spec §3 cares about most — planted secret → `critical` → security
 * F, with the value itself never leaving the repo — used to run only on a
 * machine with gitleaks installed, which is precisely the machine the goldens
 * do not apply to. A stub on `PATH` runs it everywhere: crank-health only ever
 * reads the JSON report gitleaks writes, so canned bytes are the same input.
 *
 * The leak is pointed at `src/config.py:8`, the line that really does hold the
 * planted key. Nothing in the run may quote it — a secrets finding anchors on
 * its rule id rather than on its source line, and that is what this proves.
 */
describe('a leaked credential, with gitleaks stubbed onto PATH', () => {
  let fixture: FixtureRepo
  let binDirectory: string
  let originalPath: string
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('sec-basic')
    binDirectory = await mkdtemp(join(tmpdir(), 'crank-stub-bin-'))
    await writeFile(join(binDirectory, 'gitleaks'), STUB_GITLEAKS, { mode: 0o755 })
    originalPath = process.env['PATH'] ?? ''
    process.env['PATH'] = `${binDirectory}${delimiter}${originalPath}`

    scan = await runHealthScan({ path: fixture.root, only: ['security'] })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    process.env['PATH'] = originalPath
    await fixture.remove()
    await rm(binDirectory, { recursive: true, force: true })
  })

  it('reports the leak as a critical, graded finding', () => {
    const secrets = scan.report.findings.filter((finding) => finding.tool === 'gitleaks')
    expect(secrets.map(shape)).toEqual([
      {
        category: 'security',
        tool: 'gitleaks',
        rule: 'aws-access-token',
        file: 'src/config.py',
        startLine: 8,
        severity: 'critical',
        gradeScope: true,
      },
    ])
  })

  it('grades security F on that finding alone', () => {
    expect(scan.report.categories.security).toEqual({ status: 'graded', grade: 'F' })
  })

  it('writes the secret nowhere in the run directory', async () => {
    for (const artifact of [scan.json, scan.markdown, scan.agentMarkdown]) {
      expect(artifact).not.toContain(PLANTED_SECRET)
      expect(artifact).not.toContain('AKIA')
    }
    await expectNoSecretUnder(scan.outputDir)
  })

  it('tells the reader to rotate the credential rather than quoting it', () => {
    const secret = scan.report.findings.find((finding) => finding.tool === 'gitleaks')
    expect(secret?.message).toContain('aws access token')
    expect(secret?.fixHint).toContain('Rotate the credential')
  })
})

/**
 * The whole run directory, `raw/` included: the artifacts are not the only
 * thing a user hands to somebody else. Security scanners quote the line they
 * matched, so this is the assertion that keeps their raw output sanitized (see
 * `sanitizeRawResults`).
 */
async function expectNoSecretUnder(runDirectory: string): Promise<void> {
  const names = await readdir(runDirectory, { recursive: true })
  const files: string[] = []
  for (const name of names) {
    const path = join(runDirectory, name)
    // eslint-disable-next-line no-await-in-loop
    if ((await stat(path)).isFile()) files.push(path)
  }
  // A run that wrote nothing would pass this vacuously.
  expect(files.length).toBeGreaterThan(3)

  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const contents = await readFile(file, 'utf8')
    const where = relative(runDirectory, file)
    expect(contents, `${where} carries the planted secret`).not.toContain(PLANTED_SECRET)
    expect(contents, `${where} carries the planted secret`).not.toContain('AKIA')
  }
}

/** Tools that are on every machine, because npx and uvx can fetch them. */
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
  readonly categories: Partial<
    Record<Category, { status: string; grade?: string; reason?: string }>
  >
  readonly metrics: Partial<Record<Category, Record<string, number>>>
  readonly tools: {
    readonly tool: string
    readonly scope: string
    readonly provenance: string
    readonly version: string | null
    readonly state: string
    readonly reason: string | null
    readonly detection: unknown
  }[]
}

function parse(json: string): ReportShape {
  return JSON.parse(json) as ReportShape
}
