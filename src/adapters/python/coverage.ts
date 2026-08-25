import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execTool, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { verifiedRepoVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  byLocation,
  errorMessage,
  exists,
  failed,
  firstLine,
  identify,
  readFileOrUndefined,
  repoRelative,
  unavailable,
} from '../support.ts'
import type { Venv } from './py-project.ts'
import { detectPythonTool, findVenv } from './py-project.ts'

/**
 * coverage.py — the deep tier's Python coverage run (plan M9: "coverage.py +
 * diff-cover wiring").
 *
 * **It is context, never a grade.** Spec §3's table has no band for coverage:
 * test quality is graded on the mutation score, because a line can be executed
 * by a test that asserts nothing. What coverage adds is the number that makes a
 * mutation score readable — "62% of mutants detected" means something different
 * at 95% line coverage than at 30% — and, in a PR, the specific lines this
 * change added that no test runs. Both arrive as metrics and advisory findings.
 *
 * **Why it only runs against the project's own virtualenv.** Running the tests
 * is the measurement, and the tests import the project's dependencies; an
 * ephemeral coverage with no access to them would measure an ImportError. So
 * this needs a virtualenv with `coverage` and `pytest` installed in it, and says
 * so when there is not one (spec §8).
 *
 * **Zero footprint (spec §7) takes three settings**, all of them environment:
 * `COVERAGE_FILE` puts the data file in scratch (coverage.py writes `.coverage`
 * into the working directory otherwise), `PYTHONDONTWRITEBYTECODE` stops the
 * interpreter leaving `__pycache__` directories through the target, and
 * `-p no:cacheprovider` stops pytest writing `.pytest_cache`.
 *
 * **diff-cover is not used**, and does not need to be: it is a reporting tool
 * over exactly the two things this runner already holds — a coverage report and
 * the diff's changed files. Adding a dependency (and a third invocation) to
 * re-derive an intersection we can compute directly would buy nothing but its
 * output format, which nothing here reads.
 */

const COVERAGE_TOOL = 'coverage'

/** PyPI distribution; coverage.py's command and distribution names coincide. */
const COVERAGE_DISTRIBUTION = 'coverage'

/** Config artifacts that make coverage.py repo-owned (spec §1, first check). */
const COVERAGE_CONFIG_FILES: readonly string[] = ['.coveragerc']

/** `pyproject.toml` sections that make coverage.py repo-owned. */
const COVERAGE_SECTIONS: readonly string[] = ['tool.coverage']

/** The rule uncovered lines are reported under. */
const UNCOVERED_LINE_RULE = 'coverage/uncovered-line'

/** Uncovered changed lines listed before the rest is left to the raw report. */
export const UNCOVERED_FINDING_LIMIT = 50

/** What to tell a project that cannot be measured as it stands. */
const COVERAGE_SETUP_HINT =
  'install `coverage` and `pytest` in the project virtualenv (e.g. `uv pip install coverage ' +
  'pytest`) to measure deep-tier coverage'

/**
 * Environment for both invocations. `COVERAGE_FILE` is the one that matters
 * most: without it coverage.py writes `.coverage` into the target.
 */
function coverageEnv(dataFile: string): Record<string, string> {
  return {
    COVERAGE_FILE: dataFile,
    // No `__pycache__` directories left behind in the repo (spec §7).
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

/** pytest arguments: quiet, and with its own cache directory switched off. */
const PYTEST_ARGS: readonly string[] = ['-q', '-p', 'no:cacheprovider']

export const coverageRunner: ToolRunner = {
  tool: COVERAGE_TOOL,
  category: 'test-quality',
  pinnedVersion: verifiedRepoVersion(COVERAGE_DISTRIBUTION),
  deepOnly: true,
  // Coverage and mutation testing measure different things about the same
  // suite; neither stands the other down (see `ToolRunner.complementary`).
  complementary: true,
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: COVERAGE_CONFIG_FILES,
      distribution: COVERAGE_DISTRIBUTION,
      sections: COVERAGE_SECTIONS,
    }),
  run: runCoverage,
}

async function runCoverage(ctx: RunContext): Promise<ToolResult> {
  if (!ctx.deep) return unavailable('coverage runs in the deep profile only — pass `--deep`')
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }

  const venv = await findVenv(ctx.repoRoot, ctx.project.path)
  if (venv === undefined) {
    return unavailable(
      `this project has no virtualenv to run its tests in — ${COVERAGE_SETUP_HINT}`,
    )
  }
  if (!(await hasModule(venv, COVERAGE_DISTRIBUTION))) {
    return unavailable(`coverage.py is not installed in ${venv.directory} — ${COVERAGE_SETUP_HINT}`)
  }
  if (!(await hasModule(venv, 'pytest'))) {
    return unavailable(`pytest is not installed in ${venv.directory} — ${COVERAGE_SETUP_HINT}`)
  }

  const workingDir = join(ctx.scratch, COVERAGE_TOOL)
  await mkdir(workingDir, { recursive: true })
  const env = coverageEnv(join(workingDir, '.coverage'))
  const jsonPath = join(workingDir, 'coverage.json')

  const run = await execTool(
    repoCommand(venv.interpreter, ['-m', 'coverage', 'run', '-m', 'pytest', ...PYTEST_ARGS]),
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs, env },
  )

  const rawFiles: string[] = []
  if (run.stdout.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'coverage-pytest.txt', run.stdout))
  }
  if (run.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'coverage.stderr.txt', run.stderr))
  }
  if (run.failure !== undefined) {
    return failed(run.failure, rawFiles)
  }

  // The test suite's own exit code is not this runner's verdict — a failing
  // suite still produces coverage data, and its failures belong to the tests.
  const report = await execTool(
    repoCommand(venv.interpreter, ['-m', 'coverage', 'json', '-o', jsonPath, '--quiet']),
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs, env },
  )
  const json = await readFileOrUndefined(jsonPath)
  if (json !== undefined) {
    rawFiles.unshift(await writeScratchRaw(ctx.scratch, 'coverage.json', json))
  }
  if (json === undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `coverage.py produced no report (exit ${report.exitCode ?? 'signal'}): ` +
        `${firstLine(report.stderr) || firstLine(run.stderr) || firstLine(run.stdout) || 'no output'}`,
    }
  }

  let coverage: CoverageReport
  try {
    coverage = parseCoverageJson(json, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse the coverage report: ${errorMessage(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(coverage, ctx.changedFiles, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    rawFiles,
    ...(coverage.linePercent === undefined
      ? {}
      : { metrics: { lineCoveragePercent: coverage.linePercent } }),
  }
}

/** What a `coverage json` report says, reduced to what a report needs. */
export interface CoverageReport {
  /** Line coverage over everything measured, as coverage.py computed it. */
  readonly linePercent: number | undefined
  /** Executable lines no test ran, per repo-relative posix path. */
  readonly missingLines: ReadonlyMap<string, readonly number[]>
}

/**
 * Parses `coverage json` output. Exported so a format shift fails a test
 * instead of quietly reporting no coverage (plan M9 checks).
 *
 * @throws {Error} when the payload is not a coverage.py report
 */
export function parseCoverageJson(text: string, repoRoot = ''): CoverageReport {
  const document = asRecord(JSON.parse(text))
  const files = asRecord(document?.['files'])
  if (document === undefined || files === undefined) {
    throw new Error('no files object in the coverage report')
  }

  const missingLines = new Map<string, readonly number[]>()
  for (const [name, entry] of Object.entries(files)) {
    const missing = (asArray(asRecord(entry)?.['missing_lines']) ?? []).flatMap((line) => {
      const value = asNumber(line)
      return value === undefined ? [] : [value]
    })
    if (missing.length > 0)
      missingLines.set(repoRelative(name, repoRoot), missing.toSorted(ascending))
  }

  return {
    linePercent: asNumber(asRecord(document['totals'])?.['percent_covered']),
    missingLines,
  }
}

/**
 * Uncovered lines → advisory findings, in a PR only.
 *
 * A whole-repo scan reports the percentage and nothing else: "line 47 is not
 * covered" repeated four thousand times is not a report, and the mutation
 * findings already say where the tests are weak. In a PR the same fact is
 * actionable and specific — these are lines *this change* added or edited that
 * no test runs — which is what plan M9's diff-cover wiring is for.
 *
 * Always advisory: coverage never moves a grade (see the module note).
 */
export function toPendingFindings(
  coverage: CoverageReport,
  changedFiles: readonly string[] | undefined,
  repoConfig: boolean,
): PendingFinding[] {
  if (changedFiles === undefined) return []
  const changed = new Set(changedFiles)

  return [...coverage.missingLines]
    .filter(([file]) => changed.has(file))
    .flatMap(([file, lines]) =>
      lines.map((line) => ({
        category: 'test-quality' as const,
        tool: COVERAGE_TOOL,
        rule: UNCOVERED_LINE_RULE,
        severity: 'info' as const,
        file,
        range: { startLine: line, startCol: 1, endLine: line, endCol: 1 },
        message: 'This line is not executed by any test',
        provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
        gradeScope: false,
      })),
    )
    .toSorted(byLocation)
    .slice(0, UNCOVERED_FINDING_LIMIT)
}

/** True when the virtualenv can import `module` as a command (`python -m …`). */
async function hasModule(venv: Venv, module: string): Promise<boolean> {
  const root = venv.interpreter.replace(/[/\\](bin|Scripts)[/\\][^/\\]+$/, '')
  for (const directory of ['bin', 'Scripts']) {
    // Ordered and short: a virtualenv has one of these, and the executable is
    // the same evidence `python -m <module>` needs without spawning anything.
    // eslint-disable-next-line no-await-in-loop
    if (await exists(join(root, directory, module))) return true
  }
  return false
}

function ascending(a: number, b: number): number {
  return a - b
}
