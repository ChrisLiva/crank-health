import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GO_COVERAGE_REASON } from '../src/adapters/go/go-test.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import { COMMIT_IDENTITY } from './support/fixture.ts'

/**
 * `--deep` against the real Go toolchain: gremlins mutating a scratch module
 * whose suite is deliberately weak, and `go test` measuring the same suite's
 * coverage.
 *
 * **Gated for the same reason as `deep-csharp-e2e.test.ts`**: it runs the
 * repo's own tests, and on a cold module cache it fetches the pinned gremlins
 * first. Run it with:
 *
 * ```
 * CRANK_DEEP_E2E=1 npx vitest run test/deep-go-e2e.test.ts
 * ```
 *
 * A Go toolchain is a prerequisite of this file, not a condition of it: a
 * machine that asked for the deep Go e2e and has no `go` should fail loudly.
 *
 * What it proves that no unit test can: the pinned gremlins actually runs under
 * the installed toolchain and writes the report the parser was written against
 * (`test/captured/gremlins-0.6.0.json` is that run's output), the two
 * test-quality runners coexist rather than standing each other down, and the
 * score the report carries is the one recomputed from the counts.
 *
 * Assertions are on the **reported** numbers throughout — never on gremlins'
 * own file, which is the thing under test.
 */

const ENABLED = process.env['CRANK_DEEP_E2E'] === '1'

/** Roomy: a cold module cache builds gremlins before mutating anything. */
const DEEP_TIMEOUT_MS = 600_000

describe.runIf(ENABLED)('--deep on a scratch Go module that owns gremlins', () => {
  let repo: string
  let out: string
  let deep: HealthScanResult

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-go-weak-'))
    out = await mkdtemp(join(tmpdir(), 'crank-go-weak-out-'))
    for (const [file, contents] of Object.entries(WEAK_TESTS_TREE)) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(join(repo, dirname(file)), { recursive: true })
      // eslint-disable-next-line no-await-in-loop
      await writeFile(join(repo, file), contents, 'utf8')
    }
    // Committed, with the fixtures' own frozen identity: an uncommitted tree
    // would report every file as untracked and make the zero-footprint check
    // below vacuous.
    await git(repo, ['init', '--quiet', '--initial-branch=main'])
    await git(repo, ['add', '--all'])
    await git(repo, ['commit', '--quiet', '--no-gpg-sign', '--message', 'weak go module'])

    deep = await runHealthScan({ path: repo, out, deep: true, only: ['test-quality'] })
  }, DEEP_TIMEOUT_MS)

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  })

  /**
   * `Max`'s boundary is never tested and `IsPositive` is tested only at 5, so
   * mutants both survive and get killed — which pins the score strictly between
   * 0 and 100 rather than at either flattering end.
   */
  it('grades test-quality from the real mutation score', () => {
    expect(deep.report.categories['test-quality']?.status).toBe('graded')
    const metrics = deep.report.metrics['test-quality']
    expect(metrics?.mutantsDetected).toBeGreaterThanOrEqual(1)
    expect(metrics?.mutantsUndetected).toBeGreaterThanOrEqual(1)
    // Recomputed by the orchestrator from the two counts — gremlins reports no
    // score of its own.
    expect(metrics?.mutationScore).toBeGreaterThan(0)
    expect(metrics?.mutationScore).toBeLessThan(100)
  })

  it('records the mutation run against the config that owns it', () => {
    const record = report(deep).tools.find((tool) => tool.tool === 'gremlins')
    expect(record?.state).toBe('ok')
    expect(record?.version).toBe('v0.6.0')
    expect(record?.detection?.ownedVia).toBe('.gremlins.yaml')
  })

  /**
   * Coverage is context, not a grade: `go test` reports a percentage beside the
   * mutation score, says which coverage Go actually measured, and lists no
   * findings of its own.
   */
  it('reports coverage beside the mutation score, and says what Go measured', () => {
    const record = report(deep).tools.find((tool) => tool.tool === 'go-test')
    expect(record?.state).toBe('ok')
    // The toolchain's own commands report no version (`gofmt`'s precedent).
    expect(record?.version).toBeNull()
    expect(record?.reason).toBe(GO_COVERAGE_REASON)
    const percent = deep.report.metrics['test-quality']?.lineCoveragePercent
    expect(percent).toBeGreaterThan(0)
    expect(percent).toBeLessThan(100)
  })

  /** Neither mutation nor coverage stands the other down (`complementary`). */
  it('runs both test-quality tools, and neither reports findings', () => {
    expect(
      report(deep)
        .tools.filter((tool) => tool.category === 'test-quality')
        .map((tool) => tool.tool)
        .toSorted(),
    ).toEqual(['go-test', 'gremlins'])
    expect(deep.report.findings.filter((finding) => finding.category === 'test-quality')).toEqual(
      [],
    )
  })

  /**
   * The deep tier executes the repo's code; it still leaves the repo alone.
   * `go test -coverprofile` writes wherever it is pointed, and it is pointed at
   * scratch — a bare `-coverprofile=coverage.out` would land beside the code.
   */
  it('leaves the target repo clean after running its tests', async () => {
    expect((await git(repo, ['status', '--porcelain'])).stdout).toBe('')
  })
})

function git(cwd: string, args: readonly string[]) {
  return execa('git', args, { cwd, env: COMMIT_IDENTITY })
}

/**
 * The scratch module. `IsPositive` is tested only at 5, so weakening `>` to
 * `>=` survives; `Max` has no test at all, so its mutants are never covered —
 * one of each, which is what makes the score a number rather than 0 or 100.
 *
 * The module path is deliberately not a bare word: Go 1.26 ships a `weak`
 * stdlib package, and a module named after one shadows it into an ambiguous
 * import before any tool gets a chance to run.
 */
const WEAK_TESTS_TREE: Readonly<Record<string, string>> = {
  'go.mod': ['module example.com/weaklib', '', 'go 1.25', ''].join('\n'),
  // gremlins reads its configuration from here, and its presence is what makes
  // the tool repo-owned at all (`repoOwnedOnly`).
  //
  // `timeout-coefficient` is what keeps this test about mutants rather than
  // about the machine: gremlins derives each mutant's test timeout from how
  // long gathering coverage took, and on a module this small that baseline is
  // milliseconds — so the coverage run this scan starts *in parallel* (both
  // test-quality runners are planned at once) is enough to push every mutant
  // over it and report a module of timeouts. A generous coefficient makes the
  // verdicts the tests' rather than the scheduler's.
  '.gremlins.yaml': ['unleash:', '  dry-run: false', '  timeout-coefficient: 60', ''].join('\n'),
  'calc.go': [
    'package weaklib',
    '',
    'func IsPositive(value int) bool {',
    '\treturn value > 0',
    '}',
    '',
    'func Max(a int, b int) int {',
    '\tif a > b {',
    '\t\treturn a',
    '\t}',
    '\treturn b',
    '}',
    '',
    'func Add(a int, b int) int {',
    '\treturn a + b',
    '}',
    '',
  ].join('\n'),
  'calc_test.go': [
    'package weaklib',
    '',
    'import "testing"',
    '',
    'func TestIsPositive(t *testing.T) {',
    '\tif !IsPositive(5) {',
    '\t\tt.Fatal("expected positive")',
    '\t}',
    '}',
    '',
    'func TestAdd(t *testing.T) {',
    '\tif Add(2, 2) != 4 {',
    '\t\tt.Fatal("expected 4")',
    '\t}',
    '}',
    '',
  ].join('\n'),
}

interface ReportShape {
  readonly tools: {
    readonly tool: string
    readonly category: string
    readonly state: string
    readonly version: string | null
    readonly reason: string | null
    readonly detection: { readonly ownedVia: string | null } | null
  }[]
}

function report(scan: HealthScanResult): ReportShape {
  return JSON.parse(scan.json) as ReportShape
}
