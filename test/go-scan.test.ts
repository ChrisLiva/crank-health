import { readdir } from 'node:fs/promises'
import { sep } from 'node:path'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { gofmtArgs, parseListed, toPendingFindings } from '../src/adapters/go/gofmt.ts'
import { QUICK_MODE_DEEP_REASON } from '../src/core/orchestrator.ts'
import { reportFindings } from '../src/render/json.ts'
import type { Finding } from '../src/core/types.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { expectGolden, normalizeReport } from './support/report.ts'
import { expectNoSecretUnder } from './support/secrets.ts'
import { GOLDEN_TOOLCHAIN, onPath } from './support/system-tools.ts'

/**
 * The Go adapter's journey over `test/fixtures/go-basic`: every planted finding
 * and nothing else, the vendored copy of a dependency measured by nobody, a
 * golden normalized report, and zero footprint on the target.
 *
 * It drives `runHealthScan` — the same entry point `cli.ts` uses — and it runs
 * the machine's real Go toolchain, so the whole block is gated on `go` being
 * on `PATH`: a machine without one has a different toolchain and a different,
 * equally correct, report.
 */

/** Roomy: the first run of a suite may be fetching analyzers into the module cache. */
const SCAN_TIMEOUT_MS = 180_000

const HAVE_GO = await onPath('go')

/** Every tool a Go project's grade comes from — the ones a usable `go` makes answerable. */
const GO_TOOLS: ReadonlySet<string> = new Set([
  'gosec',
  'staticcheck',
  'gocognit',
  'go-vet',
  'gofmt',
  'govulncheck',
])

/** Security tools that are release binaries, so a machine either has one or does not. */
const SYSTEM_SCANNERS: ReadonlySet<string> = new Set(['gitleaks', 'opengrep', 'osv-scanner'])

/** The fake AWS key planted in `main.go`; see that fixture's README. */
const PLANTED_SECRET = 'AKIA4XZQ7WPD2NR6VK8TJ1'

/** Every finding planted in `test/fixtures/go-basic` — see that fixture's README. */
const PLANTED = [
  {
    category: 'security',
    tool: 'gosec',
    rule: 'G101',
    file: 'main.go',
    startLine: 5,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'types',
    tool: 'staticcheck',
    rule: 'compile',
    file: 'brokenpkg/broken.go',
    startLine: 5,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'dead-code',
    tool: 'staticcheck',
    rule: 'U1000',
    file: 'checks.go',
    startLine: 12,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'dupe_a.go',
    startLine: 4,
    severity: 'warning',
    // Duplication is graded as a percentage of tokens, so the clone rows are
    // evidence rather than counted findings.
    gradeScope: false,
  },
  {
    category: 'lint',
    tool: 'staticcheck',
    rule: 'S1002',
    file: 'checks.go',
    startLine: 5,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'staticcheck',
    rule: 'SA5009',
    file: 'main.go',
    startLine: 13,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'go-vet',
    rule: 'printf',
    file: 'main.go',
    startLine: 13,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'gofmt',
    rule: 'gofmt/unformatted',
    file: 'unformatted.go',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

describe.runIf(HAVE_GO)('quick scan of the go-basic fixture', () => {
  let fixture: FixtureRepo
  let json: string
  let findings: readonly Finding[]
  let report: ReportShape
  let outputDir: string

  beforeAll(async () => {
    fixture = await createFixtureRepo('go-basic')
    const result = await runHealthScan({ path: fixture.root })
    outputDir = result.outputDir
    json = result.json
    findings = reportFindings(result.report)
    report = JSON.parse(json) as ReportShape
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /**
   * The three release-binary scanners are left out of the comparison, not out
   * of the run: gitleaks, opengrep and osv-scanner are absent on most machines
   * (and on the golden toolchain by construction — `system-tools.ts`), and a
   * machine that has gitleaks installed reads the planted credential a second
   * time as `generic-api-key`. What those tools say about a planted secret is
   * `sec-scan.test.ts`'s subject; what this fixture pins is the Go adapter.
   */
  it('finds every planted finding, and nothing else', () => {
    expect(findings.filter((finding) => !SYSTEM_SCANNERS.has(finding.tool)).map(shape)).toEqual(
      PLANTED.map((planted) => ({ ...planted })),
    )
  })

  /**
   * Two modules, two projects — and the vendored `go.mod` is not a third one.
   * `brokenpkg` carries its own `go.mod`, which is what keeps its compile error
   * out of the root module's analysis and gives it its own denominators.
   */
  it('discovers each module as a Go project, and the vendored one as none', () => {
    expect(report.projects.map((project) => [project.path, project.languages])).toEqual([
      ['.', ['go']],
      ['brokenpkg', ['go']],
    ])
  })

  /**
   * `gofmt` ships with the toolchain and reports no version of its own, so the
   * record's `version` is null — the report never invents one.
   */
  it('records gofmt as a toolchain tool with no version to report', () => {
    expect(byTool(report).get('gofmt')).toMatchObject({ state: 'ok', version: null })
  })

  /**
   * `go vet` is per project, and one project's refusal is not the other's: the
   * root module type-checks, so its vet run completed and its `printf`
   * diagnostic is graded; `brokenpkg` does not, so vet exits non-zero there and
   * reports the package it could not load rather than half a stream. `lint` is
   * still graded — one project's tool failing never takes a category down.
   */
  it('completes vet on the root module and refuses it on brokenpkg', () => {
    const vet = report.tools.filter((tool) => tool.tool === 'go-vet')

    expect(vet.map((tool) => [tool.project, tool.state, tool.version])).toEqual([
      ['.', 'ok', null],
      ['brokenpkg', 'error', null],
    ])
    expect(vet[1]?.reason).toContain('brokenpkg')
    expect(report.categories['lint']).toMatchObject({ status: 'graded' })
  })

  /**
   * The vendored dependency is unformatted and carries a third copy of the
   * accumulator body, and neither shows: `vendor/` is a copied dependency, not
   * the repo's own source. Its bookkeeping file is still a file the scan read.
   */
  it('measures nothing under vendor/', () => {
    expect(findings.every((finding) => !finding.file.startsWith('vendor/'))).toBe(true)
    // The `format` denominator is the six root `.go` files plus `brokenpkg`'s
    // one; the vendored file would have made it eight and turned 1-of-7 into
    // 1-of-8.
    expect(report.metrics['format']).toEqual({ formattableFiles: 7 })
    // The census denominator, likewise: the vendored file carries two functions
    // of its own, and gocognit — handed a directory — walked straight into them.
    expect(report.metrics['complexity']).toEqual({ functionsTotal: 8, functionsOverCeiling: 1 })
  })

  /**
   * The complexity census is metrics and no findings: the grade is a share of
   * every function measured, so the denominator is the whole answer.
   *
   * `brokenpkg` gets its own completed census beside the root's, which is the
   * point of a pure-AST tool: the module whose packages do not type-check — the
   * one whose `go vet` errored and whose staticcheck minted a compile record —
   * still has countable functions.
   */
  it('censuses both modules’ functions, including the one that does not compile', () => {
    expect(
      report.tools
        .filter((tool) => tool.tool === 'gocognit')
        .map((tool) => [tool.project, tool.state, tool.version]),
    ).toEqual([
      ['.', 'ok', 'v1.2.1'],
      ['brokenpkg', 'ok', 'v1.2.1'],
    ])
    expect(findings.every((finding) => finding.tool !== 'gocognit')).toBe(true)
    expect(report.categories['complexity']).toMatchObject({ status: 'graded' })
  })

  /**
   * The quick profile never executes the repo's code, and the report says so
   * rather than flattering it: `test-quality`'s deep runners were not asked, so
   * the category names the flag as its reason and neither `gremlins` nor
   * `go-test` has a record — no `go test` was spawned against this fixture.
   */
  it('defers test-quality to --deep without running the repo’s tests', () => {
    expect(report.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: QUICK_MODE_DEEP_REASON,
    })
    expect(report.tools.map((tool) => tool.tool)).not.toContain('gremlins')
    expect(report.tools.map((tool) => tool.tool)).not.toContain('go-test')
  })

  /** The planted pair is duplication the repo-wide jscpd pass has to see. */
  it('reports the planted clone pair as duplication in the rollup', () => {
    expect(report.metrics['duplication']?.['duplicationPercent']).toBeGreaterThan(0)
    expect(report.categories['duplication']).toMatchObject({ status: 'graded' })
  })

  /** Spec §3: all eight always appear, `not-assessed(reason)` where nothing measured. */
  it('answers for all eight categories', () => {
    expect(Object.keys(report.categories)).toEqual([
      'security',
      'types',
      'dead-code',
      'complexity',
      'duplication',
      'lint',
      'format',
      'test-quality',
    ])
    for (const state of Object.values(report.categories)) {
      expect(state.status === 'graded' ? state.grade : state.reason).toBeDefined()
    }
  })

  /**
   * One `staticcheck` process per project, three tool records reading it: the
   * evidence is staged once and all three records cite that one file, which is
   * what a reader checks "these three grades came from one analysis" against.
   */
  it('runs staticcheck once per project and has all three records cite it', async () => {
    const staged = (await readdir(outputDir, { recursive: true }))
      .map((file) => file.split(sep).join('/'))
      .filter((file) => file.endsWith('staticcheck.jsonl'))

    expect(staged.toSorted()).toEqual([
      'raw/brokenpkg/staticcheck.jsonl',
      'raw/root/staticcheck.jsonl',
    ])
    expect(
      report.tools
        .filter((tool) => tool.tool === 'staticcheck')
        .map((tool) => [tool.project, tool.category, tool.raw]),
    ).toEqual([
      ['.', 'types', ['raw/root/staticcheck.jsonl']],
      ['brokenpkg', 'types', ['raw/brokenpkg/staticcheck.jsonl']],
      ['.', 'dead-code', ['raw/root/staticcheck.jsonl']],
      ['brokenpkg', 'dead-code', ['raw/brokenpkg/staticcheck.jsonl']],
      ['.', 'lint', ['raw/root/staticcheck.jsonl']],
      ['brokenpkg', 'lint', ['raw/brokenpkg/staticcheck.jsonl']],
    ])
  })

  /**
   * gosec is `complementary`: a security scanner is not an alternative another
   * security scanner stands down for, so the Go SAST row runs beside every
   * repo-scoped security tool rather than instead of one.
   */
  it('runs gosec beside the repo-scoped security tools, not instead of them', () => {
    const security = report.tools.filter((tool) => tool.category === 'security')

    // One gosec run per Go project, and the root's is the one that graded: the
    // module whose packages do not load has no analysis to report.
    expect(
      security
        .filter((tool) => tool.tool === 'gosec')
        .map((tool) => [tool.project, tool.state, tool.version]),
    ).toEqual([
      ['.', 'ok', 'v2.28.0'],
      ['brokenpkg', 'error', null],
    ])
    // The repo-scoped scanners still have their say — a Go repo scanned by
    // gosec has not thereby declined its secrets, SAST or dependency scan.
    expect([...new Set(security.map((tool) => tool.tool))].toSorted()).toEqual([
      'bandit',
      'gitleaks',
      'gosec',
      'govulncheck',
      'opengrep',
      'osv-scanner',
      'zizmor',
    ])
    expect(report.categories['security']).toMatchObject({ status: 'graded' })
  })

  /**
   * gosec quotes three lines of the file it flagged, and on the planted G101 the
   * middle one is the credential. The sweep walks the whole run directory, raw
   * evidence included — the prefix as well as the literal, so a truncated leak
   * cannot pass.
   */
  it('quotes the planted credential nowhere in the run directory', async () => {
    for (const artifact of [json]) {
      expect(artifact).not.toContain(PLANTED_SECRET)
      expect(artifact).not.toContain('AKIA')
    }
    await expectNoSecretUnder(outputDir, [PLANTED_SECRET, 'AKIA'])
  })

  /**
   * Spec §6: same crank-health, same commit, same toolchain ⇒ the same report,
   * down to the bytes, once the two things that legitimately vary — how long it
   * took and where the repo sat — are normalized away.
   */
  it(
    'produces the same report twice',
    async () => {
      const again = await runHealthScan({ path: fixture.root })

      expect(normalizeReport(again.json)).toEqual(normalizeReport(json))
    },
    SCAN_TIMEOUT_MS,
  )

  /**
   * The positive guard on the golden toolchain: a capture run whose farm `PATH`
   * failed to resolve part of the Go toolchain would write a golden full of
   * `not-available` rows and then compare cleanly against itself forever. The
   * golden toolchain *has* Go at or above the floor, so every Go-graded tool
   * this fixture reaches has something to say and `not-available` is the one
   * state none of their records may carry. (The three release-binary scanners
   * are `not-available` by construction on that toolchain — that is what makes
   * it the golden one — so the guard is over the Go tools, not every row.)
   */
  it.runIf(GOLDEN_TOOLCHAIN)('leaves no Go tool unavailable under the golden toolchain', () => {
    expect(
      report.tools
        .filter((tool) => GO_TOOLS.has(tool.tool) && tool.state === 'not-available')
        .map((tool) => [tool.tool, tool.project, tool.reason]),
    ).toEqual([])
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    await expectGolden('go-basic.report.json', normalizeReport(json))
  })

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
    expect(await readdir(fixture.root)).not.toContain('go.sum')
  })
})

/**
 * The runner's pure seams, machine-independent: what gofmt is pointed at, and
 * what its output is read as. Both are the difference between grading the
 * repo's own source and grading whatever happened to be under the directory.
 */
describe('the gofmt invocation and its output', () => {
  it('names every file explicitly and never a directory', () => {
    expect(gofmtArgs(['a.go', 'pkg/b.go'])).toEqual(['-l', 'a.go', 'pkg/b.go'])
  })

  it('reads a perfectly formatted project as zero failures', () => {
    expect(parseListed('')).toEqual([])
    expect(parseListed('\n\n')).toEqual([])
  })

  it('reads one listed path per line, blank lines ignored', () => {
    expect(parseListed('a.go\n\npkg/b.go\n')).toEqual(['a.go', 'pkg/b.go'])
  })

  /**
   * Identity is `(category, tool, rule, file)`: "unformatted" is a verdict about
   * the whole file, so an explicit empty anchor is what stops `identify` from
   * anchoring it on line 1's text and churning the finding id every time the
   * file's first line moves.
   */
  it('makes one file-level finding per listed file, anchored on nothing', () => {
    const findings = toPendingFindings(['pkg/b.go', 'a.go', 'a.go'])
    expect(findings.map((finding) => finding.file)).toEqual(['a.go', 'pkg/b.go'])
    expect(findings.every((finding) => finding.anchor === '')).toBe(true)
    expect(findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
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

function byTool(report: ReportShape): Map<string, ReportShape['tools'][number]> {
  return new Map(report.tools.map((tool) => [tool.tool, tool]))
}

interface ReportShape {
  readonly repo: { readonly commit: string }
  readonly categories: Record<string, { status: string; grade?: string; reason?: string }>
  readonly metrics: Record<string, Record<string, number>>
  readonly projects: { readonly path: string; readonly languages: readonly string[] }[]
  readonly tools: {
    readonly tool: string
    readonly category: string
    readonly project: string
    readonly version: string | null
    readonly state: string
    readonly reason: string | null
    readonly raw: readonly string[]
  }[]
}
