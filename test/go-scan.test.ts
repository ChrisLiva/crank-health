import { readdir } from 'node:fs/promises'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { gofmtArgs, parseListed, toPendingFindings } from '../src/adapters/go/gofmt.ts'
import { reportFindings } from '../src/render/json.ts'
import type { Finding } from '../src/core/types.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { expectGolden, normalizeReport } from './support/report.ts'
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

/** Every finding planted in `test/fixtures/go-basic` — see that fixture's README. */
const PLANTED = [
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

  beforeAll(async () => {
    fixture = await createFixtureRepo('go-basic')
    const result = await runHealthScan({ path: fixture.root })
    json = result.json
    findings = reportFindings(result.report)
    report = JSON.parse(json) as ReportShape
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('finds every planted finding, and nothing else', () => {
    expect(findings.map(shape)).toEqual(PLANTED.map((planted) => ({ ...planted })))
  })

  /** One module, one project — and the vendored `go.mod` is not a second one. */
  it('discovers exactly the root module as a Go project', () => {
    expect(report.projects.map((project) => [project.path, project.languages])).toEqual([
      ['.', ['go']],
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
   * The vendored dependency is unformatted and carries a third copy of the
   * accumulator body, and neither shows: `vendor/` is a copied dependency, not
   * the repo's own source. Its bookkeeping file is still a file the scan read.
   */
  it('measures nothing under vendor/', () => {
    expect(findings.every((finding) => !finding.file.startsWith('vendor/'))).toBe(true)
    // The `format` denominator is the four root `.go` files; the vendored one
    // would have made it five and turned 1-of-4 into 1-of-5.
    expect(report.metrics['format']).toEqual({ formattableFiles: 4 })
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
    readonly version: string | null
    readonly state: string
    readonly reason: string | null
  }[]
}
