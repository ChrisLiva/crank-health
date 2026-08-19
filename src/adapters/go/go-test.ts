import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type { RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import { firstLine } from '../support.ts'
import {
  MINIMUM_GO_MINOR,
  goExecOptions,
  withGoGate,
  withoutFetchNarration,
} from './go-toolchain.ts'

/**
 * `go test` — the deep tier's Go coverage run, the toolchain's own and nothing
 * fetched: `go test -coverprofile=…` writes the profile, `go tool cover -func`
 * totals it.
 *
 * **It is context, never a grade** — the `coverage.py` posture, for the
 * `coverage.py` reason: spec §3's table has no band for coverage, because a
 * line can be executed by a test that asserts nothing. What it adds is the
 * number that makes a mutation score readable, so it arrives as one metric and
 * no findings.
 *
 * **What Go actually measures is statement coverage**, not line coverage. The
 * shared metric is `lineCoveragePercent` and renaming it would fork the
 * vocabulary for one language, so the number is recorded there and the
 * difference is stated in the record's own `reason`
 * ({@link GO_COVERAGE_REASON}) rather than left for a reader to assume.
 *
 * **`complementary`**: coverage and mutation testing measure different things
 * about the same suite, and neither stands the other down — so a repo that owns
 * gremlins gets both rows.
 *
 * **No `toolVersion`**: `go test` and `go tool cover` ship with the toolchain
 * and have no version of their own to report, exactly like `gofmt` and
 * `go vet` (rendered `version: null`).
 *
 * **No `timeoutMs`**: a `deepOnly` runner takes the deep budget before its own
 * declaration is read (`orchestrator.ts` `budgetFor`).
 */

export const GO_TEST_TOOL = 'go-test'

/** `go` is the toolchain's one entry point; see `go-toolchain.ts`. */
const GO_BINARY = 'go'

/** The honesty sentence every `go test` coverage record carries. */
export const GO_COVERAGE_REASON =
  'Go reports statement coverage; recorded as the shared line-coverage context metric'

/**
 * Not a pin crank-health can enforce — `go test` and `go tool cover` are the
 * machine's own toolchain, and `go` is deliberately absent from
 * `SYSTEM_TOOL_MANIFEST` (`gofmt`'s precedent). What can be stated is the floor
 * the gate holds it to.
 */
const GO_TEST_FLOOR = `1.${MINIMUM_GO_MINOR}`

/** Names the suite's own output and the coverage totals are staged under. */
const TEST_RAW_NAME = 'go-test.txt'
const COVERAGE_RAW_NAME = 'go-test-coverage.txt'

export const goTestRunner: ToolRunner = {
  tool: GO_TEST_TOOL,
  category: 'test-quality',
  pinnedVersion: GO_TEST_FLOOR,
  deepOnly: true,
  // Coverage and mutation testing measure different things about the same
  // suite; neither stands the other down (see `ToolRunner.complementary`).
  complementary: true,
  // `go test` is the toolchain's, not the repo's: every Go module can be tested
  // by it and no repo declares it, so there is nothing to detect.
  detect: () => Promise.resolve(null),
  run: withGoGate(runGoTest),
}

async function runGoTest(ctx: RunContext): Promise<ToolResult> {
  if (!ctx.deep) {
    return unavailable('coverage runs in the deep profile only — pass `--deep`')
  }
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' }
  }

  const workingDir = join(ctx.scratch, GO_TEST_TOOL)
  await mkdir(workingDir, { recursive: true })
  // Never beside the code: `-coverprofile` writes wherever it is pointed, and
  // the zero-footprint contract (spec §7) says that is scratch.
  const profilePath = join(workingDir, 'coverage.out')

  const options = goExecOptions(ctx)
  const test = await execTool(
    systemCommand(GO_BINARY, ['test', `-coverprofile=${profilePath}`, './...']),
    options,
  )
  if (test.failure !== undefined) {
    return { state: test.failure.state, findings: [], rawFiles: [], reason: test.failure.reason }
  }

  // The suite's own exit code is not this runner's verdict — a failing test
  // still produces coverage data, and its failures belong to the tests
  // (`coverage.ts`'s precedent). A run that wrote no profile is the failure.
  const totals = await execTool(
    systemCommand(GO_BINARY, ['tool', 'cover', `-func=${profilePath}`]),
    options,
  )
  if (totals.failure !== undefined || totals.exitCode !== 0) {
    return {
      state: totals.failure?.state ?? 'error',
      findings: [],
      rawFiles: [],
      reason:
        totals.failure?.reason ??
        `go tool cover exited ${totals.exitCode ?? 'signal'}: ` +
          (firstLine(withoutFetchNarration(totals.stderr)) ||
            firstLine(withoutFetchNarration(test.stderr)) ||
            firstLine(test.stdout) ||
            'no output'),
    }
  }

  const rawFiles = [
    await writeScratchRaw(ctx.scratch, COVERAGE_RAW_NAME, totals.stdout),
    await writeScratchRaw(ctx.scratch, TEST_RAW_NAME, test.stdout),
  ]
  const percent = parseCoverageTotal(totals.stdout)

  return {
    state: 'ok',
    findings: [],
    rawFiles,
    reason: GO_COVERAGE_REASON,
    ...(percent === undefined ? {} : { metrics: { lineCoveragePercent: percent } }),
  }
}

/**
 * The `total:` line of `go tool cover -func`, as a percentage.
 *
 * Probed on Go 1.26.6, the line is literally
 * `total:\t\t\t\t(statements)\t40.0%` — the label is what it is addressed by,
 * because a positional read of the last line breaks the first time the
 * toolchain prints anything after it. A run that measured nothing has no total
 * line at all, and that is `undefined` rather than a flattering zero.
 */
export function parseCoverageTotal(funcOutput: string): number | undefined {
  const lines = funcOutput.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const matched = /^total:\s+\(statements\)\s+(?<percent>\d+(?:\.\d+)?)%/.exec(lines[index] ?? '')
    const percent = matched?.groups?.['percent']
    if (percent !== undefined) return Number(percent)
  }
  return undefined
}

function unavailable(reason: string): ToolResult {
  return { state: 'not-available', findings: [], rawFiles: [], reason }
}
