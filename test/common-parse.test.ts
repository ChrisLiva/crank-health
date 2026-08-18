import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { BanditIssue } from '../src/adapters/common/bandit.ts'
import {
  BANDIT_TOOL,
  parseBanditJson,
  sanitizeRawJson as sanitizeBanditRaw,
  toPendingFindings as toBanditFindings,
} from '../src/adapters/common/bandit.ts'
import {
  GITLEAKS_TOOL,
  parseGitleaksReport,
  toPendingFindings as toGitleaksFindings,
} from '../src/adapters/common/gitleaks.ts'
import type { JscpdClone } from '../src/adapters/common/jscpd.ts'
import {
  JSCPD_RULE,
  JSCPD_TOOL,
  parseJscpdReport,
  toPendingFindings as toJscpdFindings,
} from '../src/adapters/common/jscpd.ts'
import { OPENGREP_RULE_IDS, OPENGREP_RULES } from '../src/adapters/common/opengrep-rules.ts'
import {
  parseOpengrepJson,
  ruleOf,
  sanitizeRawJson as sanitizeOpengrepRaw,
  toPendingFindings as toOpengrepFindings,
} from '../src/adapters/common/opengrep.ts'
import {
  parseOsvReport,
  severityOf,
  toPendingFindings as toOsvFindings,
} from '../src/adapters/common/osv-scanner.ts'
import {
  parseZizmorJson,
  toPendingFindings as toZizmorFindings,
} from '../src/adapters/common/zizmor.ts'
import { computeAnchors } from '../src/core/fingerprint.ts'
import { gradeAbsolute } from '../src/core/grade.ts'
import type { Finding, PendingFinding } from '../src/core/types.ts'

/**
 * Per-wrapper parse tests against checked-in captured output (plan M6 checks).
 *
 * Every recording here came out of the real pinned tool run against
 * `test/fixtures/sec-basic`; only the repo root (`/repo`) and opengrep's
 * scratch-dir rule namespace were rewritten, so the bytes are not tied to the
 * machine that made them. These run everywhere, including on a machine that
 * has none of the three release-binary tools installed — which is exactly why
 * the parsers are tested from bytes rather than only end to end.
 */

const captured = (name: string): string =>
  fileURLToPath(new URL(`./captured/${name}`, import.meta.url))

async function read(name: string): Promise<string> {
  return readFile(captured(name), 'utf8')
}

async function readAsJson(name: string): Promise<unknown> {
  return JSON.parse(await read(name))
}

describe('parseGitleaksReport', () => {
  it('reads the rule, range and file from a real redacted report', async () => {
    expect(parseGitleaksReport(await readAsJson('gitleaks-8.30.1.json'), '/repo')).toEqual([
      {
        ruleId: 'aws-access-token',
        description:
          'Identified a pattern that may indicate AWS credentials, risking unauthorized ' +
          'cloud resource access and data breaches on AWS platforms.',
        file: 'src/config.py',
        startLine: 8,
        startColumn: 23,
        endLine: 8,
        endColumn: 42,
      },
    ])
  })

  /** The whole point of `--redact`: the value must not be in our data at all. */
  it('carries no secret material anywhere in the parsed result', async () => {
    const leaks = parseGitleaksReport(await readAsJson('gitleaks-8.30.1.json'), '/repo')
    const findings = toGitleaksFindings(leaks, false)
    const serialized = JSON.stringify([leaks, findings])
    expect(serialized).not.toContain('AKIA')
    expect(serialized).not.toContain('REDACTED')
    expect(findings.every((finding) => finding.anchor === finding.rule)).toBe(true)
  })

  it('treats an empty or null report as no leaks', () => {
    expect(parseGitleaksReport([])).toEqual([])
    expect(parseGitleaksReport(null)).toEqual([])
  })

  it('rejects output that is not gitleaks’ array of leaks', () => {
    expect(() => parseGitleaksReport({ oops: true })).toThrow('not an array')
  })

  /** Spec §3: "any secret or critical → F", under anybody's config. */
  it('maps every leak to a critical, graded finding — a secret is an F', async () => {
    const findings = toGitleaksFindings(
      parseGitleaksReport(await readAsJson('gitleaks-8.30.1.json'), '/repo'),
      false,
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      category: 'security',
      tool: GITLEAKS_TOOL,
      rule: 'aws-access-token',
      severity: 'critical',
      gradeScope: true,
      provenance: 'default-config',
    })
    expect(gradeAbsolute('security', findings.map(identified))).toBe('F')
  })
})

describe('parseOpengrepJson', () => {
  it('reads rule, range, severity and message from real scan output', async () => {
    expect(parseOpengrepJson(await read('opengrep-1.26.0.json'))).toEqual([
      {
        rule: 'python-subprocess-shell-true',
        file: '/repo/src/config.py',
        startLine: 13,
        startCol: 12,
        endLine: 13,
        endCol: 71,
        severity: 'ERROR',
        message: expect.stringContaining('shell=True'),
      },
      {
        rule: 'js-eval-call',
        file: '/repo/src/handler.js',
        startLine: 2,
        startCol: 10,
        endLine: 2,
        endCol: 25,
        severity: 'ERROR',
        message: expect.stringContaining('eval()'),
      },
    ])
  })

  /**
   * opengrep namespaces `check_id` with the path of the file the rule came
   * from, and that path is the scratch dir — different on every run. Leaving it
   * in would make finding ids differ between two scans of one commit.
   */
  it('strips opengrep’s scratch-dir rule namespace from the rule id', () => {
    expect(ruleOf('tmp.crank-health-abc123.opengrep.js-eval-call')).toBe('js-eval-call')
    expect(ruleOf('js-eval-call')).toBe('js-eval-call')
  })

  it('treats no output as no results', () => {
    expect(parseOpengrepJson('')).toEqual([])
  })

  it('rejects output that is not opengrep’s result envelope', () => {
    expect(() => parseOpengrepJson('{"oops":true}')).toThrow('no results array')
  })

  it('maps ERROR/WARNING/INFO onto our severities and grades them all', async () => {
    const findings = toOpengrepFindings(
      parseOpengrepJson(await read('opengrep-1.26.0.json')),
      '/repo',
    )
    expect(findings.map((finding) => [finding.file, finding.rule, finding.severity])).toEqual([
      ['src/config.py', 'python-subprocess-shell-true', 'error'],
      ['src/handler.js', 'js-eval-call', 'error'],
    ])
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
  })
})

describe('the bundled opengrep ruleset', () => {
  /**
   * The constraint `ruleOf` depends on: a dot in a rule id would make the last
   * segment something other than the id.
   */
  it('gives every rule a dot-free id, so the namespace strip is exact', () => {
    for (const id of OPENGREP_RULE_IDS) {
      expect(id).not.toContain('.')
      expect(OPENGREP_RULES).toContain(`  - id: ${id}\n`)
    }
  })

  it('declares exactly the rules it lists, and nothing else', () => {
    const declared = [...OPENGREP_RULES.matchAll(/^ {2}- id: (\S+)$/gm)].map((match) => match[1])
    expect(declared).toEqual([...OPENGREP_RULE_IDS])
  })

  /** The plan's license check, at the ruleset level: nothing is fetched. */
  it('references no registry pack, URL or remote rule source', () => {
    expect(OPENGREP_RULES).not.toMatch(/https?:\/\//)
    expect(OPENGREP_RULES).not.toMatch(/\bp\/[a-z-]+/)
    expect(OPENGREP_RULES).not.toContain('auto')
  })
})

describe('parseZizmorJson', () => {
  it('reads audit, severity, route and one-based location from real output', async () => {
    const findings = parseZizmorJson(await read('zizmor-1.29.0.json'), '/repo')
    expect(
      findings.map((finding) => [
        finding.ident,
        finding.severity,
        finding.startLine,
        finding.route,
      ]),
    ).toEqual([
      ['artipacked', 'Medium', 8, 'jobs.build.steps.0'],
      ['excessive-permissions', 'Medium', 5, 'jobs.build'],
      ['dangerous-triggers', 'High', 2, 'on'],
      ['unpinned-uses', 'High', 8, 'jobs.build.steps.0.uses'],
    ])
    expect(findings.every((finding) => finding.file === '.github/workflows/ci.yml')).toBe(true)
  })

  it('treats no output as no findings', () => {
    expect(parseZizmorJson('')).toEqual([])
  })

  it('rejects output that is not zizmor’s array of findings', () => {
    expect(() => parseZizmorJson('{"oops":true}')).toThrow('not an array')
  })

  it('maps High to error and Medium to warning, and anchors on the document route', async () => {
    const findings = toZizmorFindings(
      parseZizmorJson(await read('zizmor-1.29.0.json'), '/repo'),
      false,
    )
    expect(findings.map((finding) => [finding.rule, finding.severity, finding.anchor])).toEqual([
      ['dangerous-triggers', 'error', 'on'],
      ['excessive-permissions', 'warning', 'jobs.build'],
      ['artipacked', 'warning', 'jobs.build.steps.0'],
      ['unpinned-uses', 'warning', 'jobs.build.steps.0.uses'],
    ])
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
  })

  it('keeps zizmor’s low tier advisory on a default config', () => {
    const low = toZizmorFindings(
      [
        {
          ident: 'hygiene',
          description: 'a note',
          url: '',
          severity: 'Low',
          confidence: 'Low',
          file: '.github/workflows/ci.yml',
          startLine: 1,
          startCol: 1,
          endLine: 1,
          endCol: 1,
          annotation: '',
          route: 'on',
        },
      ],
      false,
    )
    expect(low[0]).toMatchObject({ severity: 'info', gradeScope: false })
    // The repo's own zizmor config means they opted in: then it counts.
    expect(
      toZizmorFindings(
        [
          {
            ident: 'hygiene',
            description: 'a note',
            url: '',
            severity: 'Low',
            confidence: 'Low',
            file: '.github/workflows/ci.yml',
            startLine: 1,
            startCol: 1,
            endLine: 1,
            endCol: 1,
            annotation: '',
            route: 'on',
          },
        ],
        true,
      )[0],
    ).toMatchObject({ gradeScope: true, provenance: 'repo-config' })
  })

  /**
   * Pin-a-digest audits are chores, not exploitable weaknesses: they stay
   * graded, but they may not cap the category at D on their own (see
   * `zizmor.ts`'s severity mapping).
   */
  it('demotes pure-hygiene audits to warning, whatever severity zizmor gives them', () => {
    const hygiene = toZizmorFindings([zizmorFinding({ ident: 'unpinned-images' })], false)
    expect(hygiene[0]).toMatchObject({ severity: 'warning', gradeScope: true })
    // The control: the same High/High shape under an exploitable ident.
    const exploitable = toZizmorFindings([zizmorFinding({ ident: 'dangerous-triggers' })], false)
    expect(exploitable[0]).toMatchObject({ severity: 'error', gradeScope: true })
  })
})

/** A High/High zizmor finding; override the one field a test is about. */
function zizmorFinding(overrides: { ident: string }) {
  return {
    description: 'a workflow problem',
    url: '',
    severity: 'High',
    confidence: 'High',
    file: '.github/workflows/ci.yml',
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 1,
    annotation: '',
    route: 'on',
    ...overrides,
  }
}

describe('parseBanditJson', () => {
  it('reads test id, severity, confidence and range from real output', async () => {
    const issues = parseBanditJson(await read('bandit-1.9.4.json'), '/repo')
    expect(issues.map((issue) => [issue.testId, issue.severity, issue.line, issue.file])).toEqual([
      ['B404', 'LOW', 3, 'src/config.py'],
      ['B602', 'HIGH', 13, 'src/config.py'],
    ])
    expect(issues[1]?.moreInfo).toContain('bandit.readthedocs.io')
  })

  it('treats no output as no issues', () => {
    expect(parseBanditJson('')).toEqual([])
  })

  it('rejects output that is not bandit’s result envelope', () => {
    expect(() => parseBanditJson('{"oops":true}')).toThrow('no results array')
  })

  /** HIGH/MEDIUM graded, LOW advisory — see `bandit.ts`. */
  it('grades the high tier and leaves the low tier advisory', async () => {
    const findings = toBanditFindings(
      parseBanditJson(await read('bandit-1.9.4.json'), '/repo'),
      false,
    )
    expect(findings.map((finding) => [finding.rule, finding.severity, finding.gradeScope])).toEqual(
      [
        ['B404', 'info', false],
        ['B602', 'error', true],
      ],
    )
    expect(findings.every((finding) => finding.tool === BANDIT_TOOL)).toBe(true)
    expect(findings.every((finding) => finding.category === 'security')).toBe(true)
  })

  /**
   * bandit's high tier is an `error` only when bandit is also confident. Below
   * that the finding is a `warning` — still graded, never silenced. `High` and
   * `high` are the case controls, `''` the unknown-value control: anything that
   * is not exactly `HIGH` lands on the lenient side.
   */
  it.each(['MEDIUM', 'LOW', 'UNDEFINED', 'High', 'high', ''])(
    'demotes a high-severity finding at %s confidence to warning',
    (confidence) => {
      const [finding] = toBanditFindings(
        [banditIssue({ testId: 'B602', severity: 'HIGH', confidence })],
        false,
      )
      expect([finding?.severity, finding?.gradeScope]).toEqual(['warning', true])
    },
  )

  /** Only the high tier is gated on confidence; the rest keep bandit's map. */
  it.each([
    ['MEDIUM', 'warning', true],
    ['LOW', 'info', false],
    ['UNDEFINED', 'info', false],
    ['NONSENSE', 'info', false],
  ])('maps %s severity at high confidence unchanged', (severity, expected, graded) => {
    const [finding] = toBanditFindings(
      [banditIssue({ testId: 'B602', severity, confidence: 'HIGH' })],
      false,
    )
    expect([finding?.severity, finding?.gradeScope]).toEqual([expected, graded])
  })

  /**
   * bandit's hardcoded-secret tests quote the literal they found, and a
   * finding's message is copied verbatim into `report.json`, `report.md` and
   * `agent.md`. A secrets finding that carries the secret has published it.
   */
  it.each([
    ['B105', 'HIGH', 'HIGH'],
    ['B105', 'HIGH', 'MEDIUM'],
    ['B105', 'MEDIUM', 'MEDIUM'],
    ['B105', 'LOW', 'HIGH'],
    ['B106', 'HIGH', 'MEDIUM'],
    ['B107', 'HIGH', 'LOW'],
  ])(
    'redacts the literal %s quotes at %s severity / %s confidence',
    (testId, severity, confidence) => {
      const [finding] = toBanditFindings(
        [
          banditIssue({
            testId,
            severity,
            confidence,
            message: `Possible hardcoded password: '${SECRET}'`,
          }),
        ],
        false,
      )
      expect(finding?.message).not.toContain(SECRET)
      expect(finding?.message).toContain("'<redacted>'")
    },
  )

  it('leaves every other test’s message alone, quotes included', () => {
    const [finding] = toBanditFindings(
      [banditIssue({ testId: 'B602', message: "subprocess call with shell=True: 'tar czf'" })],
      false,
    )
    expect(finding?.message).toContain("'tar czf'")
  })
})

/**
 * `raw/` is the evidence a reader opens and the thing they attach to a ticket.
 * Both security scanners copy the source line they matched into their reports,
 * and that is the one line worth keeping out of the run directory.
 */
describe('raw evidence sanitizing', () => {
  it('drops bandit’s code excerpts and keeps everything else', async () => {
    const sanitized = sanitizeBanditRaw(await read('bandit-1.9.4.json'))

    expect(sanitized).not.toContain('import subprocess\n')
    expect(sanitized).toContain('"code": "<omitted>"')
    // Still a bandit report, and still says where to look.
    expect(parseBanditJson(sanitized, '/repo').map((issue) => [issue.testId, issue.line])).toEqual([
      ['B404', 3],
      ['B602', 13],
    ])
  })

  it('drops opengrep’s matched lines and keeps everything else', async () => {
    const sanitized = sanitizeOpengrepRaw(await read('opengrep-1.26.0.json'))

    expect(sanitized).not.toContain('shell=True)')
    expect(sanitized).toContain('"lines": "<omitted>"')
    expect(parseOpengrepJson(sanitized).map((result) => [result.rule, result.startLine])).toEqual([
      ['python-subprocess-shell-true', 13],
      ['js-eval-call', 2],
    ])
  })

  /** Output nothing can be made of is the only clue to why; it is kept as-is. */
  it.each([
    ['', ''],
    ['not json at all', 'not json at all'],
    ['{"oops":true}', '{"oops":true}'],
  ])('passes through output that is not a result envelope: %s', (stdout, expected) => {
    expect(sanitizeBanditRaw(stdout)).toBe(expected)
    expect(sanitizeOpengrepRaw(stdout)).toBe(expected)
  })
})

describe('parseOsvReport', () => {
  it('reads one finding per advisory group from a real lockfile scan', async () => {
    const vulnerabilities = parseOsvReport(await readAsJson('osv-scanner-2.4.0.json'), '/repo')
    expect(vulnerabilities.every((entry) => entry.file === 'package-lock.json')).toBe(true)
    expect(vulnerabilities.every((entry) => entry.packageName === 'lodash')).toBe(true)
    expect(vulnerabilities.every((entry) => entry.packageVersion === '4.17.15')).toBe(true)
    expect(vulnerabilities.map((entry) => entry.id)).toEqual([
      'GHSA-29mw-wpgm-hmr9',
      'GHSA-35jh-r3h4-6jhm',
      'GHSA-f23m-r3pf-42rh',
      'GHSA-p6mc-m468-83gw',
    ])
    expect(vulnerabilities[0]?.maxSeverity).toBe(5.3)
    expect(vulnerabilities[0]?.summary).toContain('lodash')
  })

  it('treats a project with nothing to scan as no vulnerabilities', () => {
    expect(parseOsvReport({ results: null })).toEqual([])
  })

  it('rejects output that is not osv-scanner’s result envelope', () => {
    expect(() => parseOsvReport({ oops: true })).toThrow('no results array')
    expect(() => parseOsvReport('nope')).toThrow('not an object')
  })

  it('bands CVSS scores onto our severities', () => {
    expect(severityOf(9.8)).toBe('error')
    expect(severityOf(7)).toBe('error')
    expect(severityOf(6.9)).toBe('warning')
    expect(severityOf(4)).toBe('warning')
    expect(severityOf(3.9)).toBe('info')
    expect(severityOf(undefined)).toBe('info')
  })

  /**
   * The fix is in the OSV record, not in the group summary: each advisory's
   * `affected[]` carries the ranges, and only the entries about *this* package
   * count — a lodash advisory also lists lodash-es and lodash.trim.
   */
  it('walks the affected ranges for the version each advisory was fixed in', async () => {
    const vulnerabilities = parseOsvReport(await readAsJson('osv-scanner-2.4.0.json'), '/repo')
    expect(vulnerabilities.map((entry) => [entry.id, entry.fixedIn] as const)).toEqual([
      // A group is fixed once every id in it is: GHSA-35jh is fixed in 4.17.21
      // and its group-mate GHSA-r5fr not until 4.18.0.
      ['GHSA-29mw-wpgm-hmr9', '4.17.21'],
      ['GHSA-35jh-r3h4-6jhm', '4.18.0'],
      ['GHSA-f23m-r3pf-42rh', '4.18.0'],
      ['GHSA-p6mc-m468-83gw', '4.17.19'],
    ])
  })

  /**
   * One finding per vulnerable dependency, not per advisory. Four rows saying
   * "lodash@4.17.15 is affected by …" are one upgrade, and reading them as four
   * problems is what made a dependency audit unreadable.
   */
  it('reports one finding per package, with the advisories nested under it', async () => {
    const findings = toOsvFindings(
      parseOsvReport(await readAsJson('osv-scanner-2.4.0.json'), '/repo'),
      false,
    )
    expect(findings).toHaveLength(1)
    const [finding] = findings
    expect(finding?.rule).toBe('osv/package')
    expect(finding?.package).toEqual({ name: 'lodash', version: '4.17.15', ecosystem: 'npm' })
    expect(finding?.packageAdvisories?.map((advisory) => advisory.id)).toEqual([
      'GHSA-29mw-wpgm-hmr9',
      'GHSA-35jh-r3h4-6jhm',
      'GHSA-f23m-r3pf-42rh',
      'GHSA-p6mc-m468-83gw',
    ])
    expect(finding?.packageAdvisories?.[0]).toEqual({
      id: 'GHSA-29mw-wpgm-hmr9',
      aliases: ['CVE-2020-28500', 'GHSA-29mw-wpgm-hmr9'],
      severity: 'warning',
      summary: 'Regular Expression Denial of Service (ReDoS) in lodash',
      fixedIn: '4.17.21',
    })
    // The worst of the four (8.1 → error), and the highest fix among them.
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toBe('lodash@4.17.15 (npm): 4 advisories; fix: upgrade to ≥4.18.0')
  })

  /** The lockfile is the file; the pinned package is the anchor (spec §2). */
  it('anchors on the pinned package, not on a line in a generated lockfile', async () => {
    const findings = toOsvFindings(
      parseOsvReport(await readAsJson('osv-scanner-2.4.0.json'), '/repo'),
      false,
    )
    expect(findings.every((finding) => finding.anchor === 'lodash@4.17.15')).toBe(true)
    expect(findings.every((finding) => finding.range.startLine === 1)).toBe(true)
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
  })

  /**
   * Recommendation 9's structural half: a vulnerability with no published fix
   * is not work anyone can do, so it is advisory — and the row says why, rather
   * than leaving a reader to notice the missing `fixedIn`.
   */
  it('demotes a package with no fixed version to advisory, with the receipt', () => {
    const [finding] = toOsvFindings(parseOsvReport(unfixable()), false)
    expect(finding?.gradeScope).toBe(false)
    expect(finding?.message).toBe('leftpad@1.0.0 (npm): 1 advisory; no fixed version available')
    expect(finding?.packageAdvisories?.[0]?.fixedIn).toBeUndefined()
  })

  /**
   * The demotion is per advisory, not per package. A package carrying a critical
   * CVE with a released fix *and* an unfixable low one is work somebody can do
   * this afternoon — upgrading clears the critical — so it stays graded, and the
   * message says exactly how far the upgrade gets rather than claiming there is
   * nothing to upgrade to.
   */
  it('keeps a package graded when one of its advisories has a fix, and says what it clears', () => {
    const [finding] = toOsvFindings(parseOsvReport(mixedFixability()), false)

    expect(finding?.gradeScope).toBe(true)
    expect(finding?.message).toBe(
      'mixedpkg@1.0.0 (npm): 2 advisories; fix: upgrade to ≥2.0.0 ' +
        '(clears 1 of 2; the rest have no published fix)',
    )
    expect(finding?.fixHint).toContain('Upgrade mixedpkg to ≥2.0.0')
    // The receipts are untouched: each advisory still says for itself.
    expect(finding?.packageAdvisories?.map((advisory) => advisory.fixedIn)).toEqual([
      '2.0.0',
      undefined,
    ])
  })
})

/** One package with a fixable advisory and an unfixable one — the mixed case. */
function mixedFixability(): unknown {
  return {
    results: [
      {
        source: { path: 'package-lock.json' },
        packages: [
          {
            package: { name: 'mixedpkg', version: '1.0.0', ecosystem: 'npm' },
            groups: [
              { ids: ['GHSA-aaaa-0001'], aliases: [], max_severity: '9.8' },
              { ids: ['GHSA-aaaa-0002'], aliases: [], max_severity: '3.1' },
            ],
            vulnerabilities: [
              {
                id: 'GHSA-aaaa-0001',
                summary: 'critical, and fixed',
                affected: [
                  {
                    package: { name: 'mixedpkg', ecosystem: 'npm' },
                    ranges: [
                      {
                        type: 'SEMVER',
                        events: [{ introduced: '0' }, { fixed: '2.0.0' }],
                      },
                    ],
                  },
                ],
              },
              {
                id: 'GHSA-aaaa-0002',
                summary: 'low, and unfixed',
                affected: [
                  {
                    package: { name: 'mixedpkg', ecosystem: 'npm' },
                    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/** An advisory whose `affected` range never closes: nothing to upgrade to. */
function unfixable(): unknown {
  return {
    results: [
      {
        source: { path: 'package-lock.json' },
        packages: [
          {
            package: { name: 'leftpad', version: '1.0.0', ecosystem: 'npm' },
            groups: [{ ids: ['GHSA-dead-beef'], aliases: [], max_severity: '9.1' }],
            vulnerabilities: [
              {
                id: 'GHSA-dead-beef',
                summary: 'unfixed',
                affected: [
                  {
                    package: { name: 'leftpad', ecosystem: 'npm' },
                    ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

/** One clone pair; override only what the assertion is about. */
function jscpdClone(overrides: Partial<JscpdClone> = {}): JscpdClone {
  return {
    firstFile: 'src/a.ts',
    firstStartLine: 5,
    firstEndLine: 15,
    secondFile: 'src/b.ts',
    secondStartLine: 30,
    secondEndLine: 40,
    lines: 11,
    tokens: 111,
    format: 'typescript',
    ...overrides,
  }
}

/**
 * A clone as two findings, one per side — what the pair looks like when each
 * side carries its own identity. Run through {@link computeAnchors} it yields
 * the ids a side has on its own, which is what the collapsed finding is
 * measured against.
 */
function bothSides(clone: JscpdClone): PendingFinding[] {
  const oneSide = (
    file: string,
    startLine: number,
    endLine: number,
    twinFile: string,
  ): PendingFinding => ({
    category: 'duplication',
    tool: JSCPD_TOOL,
    rule: JSCPD_RULE,
    severity: 'warning',
    file,
    range: { startLine, startCol: 1, endLine, endCol: 1 },
    message: `${clone.lines} lines (${clone.tokens} tokens) duplicated from ${twinFile}`,
    provenance: 'default-config',
    gradeScope: false,
    anchor: twinFile,
  })
  return [
    oneSide(clone.firstFile, clone.firstStartLine, clone.firstEndLine, clone.secondFile),
    oneSide(clone.secondFile, clone.secondStartLine, clone.secondEndLine, clone.firstFile),
  ]
}

/** Each finding's start line beside the occurrence index identity gave it. */
function numbering(findings: readonly Finding[]): (number | undefined)[][] {
  return findings.map((finding) => [finding.range.startLine, finding.identity?.occurrence])
}

/** The id of the finding at `file`, or at `startLine` where the file repeats. */
function idAt(findings: readonly Finding[], where: string | number): string | undefined {
  return findings.find((finding) =>
    typeof where === 'string' ? finding.file === where : finding.range.startLine === where,
  )?.id
}

describe('parseJscpdReport', () => {
  it('reads clone pairs and the token percentage from a real report', async () => {
    const report = parseJscpdReport(await readAsJson('jscpd-5.0.14.json'), '/repo')
    expect(report.duplicationPercent).toBeCloseTo(47.033_898_305_084_75)
    expect(report.clones).toEqual([
      {
        firstFile: 'src/handler.js',
        firstStartLine: 5,
        firstEndLine: 15,
        secondFile: 'src/report.js',
        secondStartLine: 1,
        secondEndLine: 11,
        lines: 11,
        tokens: 111,
        format: 'javascript',
      },
    ])
  })

  it('rejects output that has no token percentage to grade on', () => {
    expect(() => parseJscpdReport({ duplicates: [] })).toThrow('percentageTokens')
  })

  /**
   * The grade is the percentage; the clones are the evidence. Counting them
   * too would grade one duplication twice — see `jscpd.ts`. One clone is one
   * finding: both sides describe the same duplication, and the side that
   * carries it is the one `byLocation` orders first of the two.
   */
  it('reports a clone pair as one advisory finding anchored on the twin', async () => {
    const report = parseJscpdReport(await readAsJson('jscpd-5.0.14.json'), '/repo')
    const findings = toJscpdFindings(report.clones)
    expect(findings.map((finding) => [finding.file, finding.anchor])).toEqual([
      ['src/handler.js', 'src/report.js'],
    ])
    expect(findings.every((finding) => finding.gradeScope === false)).toBe(true)
    expect(findings.every((finding) => finding.rule === JSCPD_RULE)).toBe(true)
    expect(findings.every((finding) => finding.category === 'duplication')).toBe(true)
  })

  it('reports nothing for a report with no clones in it', () => {
    expect(toJscpdFindings([])).toEqual([])
  })

  /** The pair is one finding, so the survivor has to carry the twin's location. */
  it('names the twin’s file and line range in the surviving finding’s message', async () => {
    const report = parseJscpdReport(await readAsJson('jscpd-5.0.14.json'), '/repo')
    const [finding] = toJscpdFindings(report.clones)
    expect(finding?.message).toBe('11 lines (111 tokens) duplicated from src/report.js:1-11')
  })

  /**
   * Identity is range-free (spec §2), so collapsing a cross-file pair drops the
   * twin's id and leaves the survivor's exactly as it was — the delta after an
   * upgrade sees one finding resolved, not two findings replaced by one.
   */
  it('keeps a cross-file survivor’s id byte-identical to the id that side carried alone', async () => {
    const report = parseJscpdReport(await readAsJson('jscpd-5.0.14.json'), '/repo')
    const clone = report.clones.at(0)
    if (clone === undefined) throw new Error('the capture holds no clone')

    const before = computeAnchors(bothSides(clone), new Map())
    const after = computeAnchors(toJscpdFindings(report.clones), new Map())

    const twinId = idAt(before, 'src/report.js')
    expect(new Set(before.map((finding) => finding.id)).size).toBe(2)
    expect(new Set(after.map((finding) => finding.id))).toEqual(
      new Set(before.map((finding) => finding.id).filter((id) => id !== twinId)),
    )
    expect(idAt(after, 'src/handler.js')).toBe(idAt(before, 'src/handler.js'))
  })

  /**
   * The one identity churn the collapse causes, and it takes a file that
   * duplicates itself twice to see it: both sides of a same-file clone share
   * one `(category, tool, rule, file, anchor)` group, so dropping the twins
   * closes the gaps in `occurrence` and the second survivor renumbers.
   */
  it('renumbers the second survivor when one file holds two clones of itself', () => {
    const clones = [
      jscpdClone({
        firstFile: 'src/a.ts',
        firstStartLine: 5,
        firstEndLine: 15,
        secondFile: 'src/a.ts',
        secondStartLine: 30,
        secondEndLine: 40,
      }),
      jscpdClone({
        firstFile: 'src/a.ts',
        firstStartLine: 50,
        firstEndLine: 60,
        secondFile: 'src/a.ts',
        secondStartLine: 80,
        secondEndLine: 90,
      }),
    ]
    const before = computeAnchors(clones.flatMap(bothSides), new Map())
    const after = computeAnchors(toJscpdFindings(clones), new Map())

    expect(numbering(before)).toEqual([
      [5, 0],
      [30, 1],
      [50, 2],
      [80, 3],
    ])
    expect(numbering(after)).toEqual([
      [5, 0],
      [50, 1],
    ])
    expect(idAt(after, 5)).toBe(idAt(before, 5))
    expect(idAt(after, 50)).not.toBe(idAt(before, 50))
  })

  /** Collapsing the pair must not collapse two pairs into one another. */
  it('keeps two clones between the same two files apart, as two occurrences', () => {
    const clones = [
      jscpdClone(),
      jscpdClone({
        firstStartLine: 100,
        firstEndLine: 110,
        secondStartLine: 200,
        secondEndLine: 210,
      }),
    ]
    const pending = toJscpdFindings(clones)
    expect(pending.map((finding) => [finding.file, finding.anchor])).toEqual([
      ['src/a.ts', 'src/b.ts'],
      ['src/a.ts', 'src/b.ts'],
    ])

    const findings = computeAnchors(pending, new Map())
    expect(findings.map((finding) => finding.identity?.occurrence)).toEqual([0, 1])
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(2)
  })
})

/** A synthetic secret, so no real-looking credential is checked in twice. */
const SECRET = 'hunter2-not-a-real-password'

/** One bandit issue; override only what the assertion is about. */
function banditIssue(overrides: Partial<BanditIssue> = {}): BanditIssue {
  return {
    testId: 'B105',
    testName: 'hardcoded_password_string',
    file: 'src/config.py',
    line: 4,
    endLine: 4,
    column: 12,
    endColumn: 40,
    message: 'Possible hardcoded password',
    severity: 'LOW',
    confidence: 'MEDIUM',
    moreInfo: '',
    ...overrides,
  }
}

/** A pending finding with an id, for the grading helpers. */
function identified(finding: Omit<Finding, 'id'> & { readonly anchor?: string }): Finding {
  const { anchor: _anchor, ...rest } = finding
  return { ...rest, id: 'test' }
}
