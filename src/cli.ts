import pc from 'picocolors'
import { CliUsageError, HELP_TEXT, parseCliArgs } from './args.ts'
import { isBelow } from './core/grade.ts'
import type { Category, CategoryState, Grade } from './core/types.ts'
import { CATEGORIES } from './core/types.ts'
import { createTerminalIO, isPromptCancelled, runInteractiveSession } from './interactive.ts'
import type { Report } from './render/json.ts'
import { renderTerminal } from './render/terminal.ts'
import { runPrScan } from './run-pr.ts'
import { REPO_SCOPED_REASON, runHealthScan } from './run.ts'
import { VERSION } from './version.ts'

const MS_PER_SECOND = 1000

/**
 * Exit codes are part of the CLI contract:
 * 0 scan completed · 1 --fail-under gate tripped · 2 crank-health errored.
 *
 * Everything below the argument handling belongs to `run.ts`; this file only
 * turns options into a scan and a scan into an exit code.
 */
async function run(argv: readonly string[]): Promise<number> {
  let options = parseCliArgs(argv)

  if (options.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (options.interactive) {
    if (!process.stdin.isTTY) {
      throw new CliUsageError('--interactive needs a terminal on stdin')
    }
    const io = createTerminalIO()
    try {
      const session = await runInteractiveSession(options, io)
      if (!session.run) return 0
      options = session.options
    } catch (error) {
      if (!isPromptCancelled(error)) throw error
      process.stderr.write('interactive session cancelled — nothing was run\n')
      return 0
    } finally {
      io.close()
    }
  }
  const scan = {
    path: options.path,
    out: options.out,
    only: parseCategories(options.only),
    projects: options.projects,
    deep: options.deep,
    // Spec §5's configurable per-tool budget, in the unit a user thinks in.
    ...(options.timeoutSeconds === undefined
      ? {}
      : { timeoutMs: options.timeoutSeconds * MS_PER_SECOND }),
  }
  const result =
    options.pr === undefined
      ? await runHealthScan(scan)
      : await runPrScan({ ...scan, base: options.pr })

  process.stdout.write(
    options.json
      ? result.json
      : renderTerminal(result.report, {
          markdown: result.markdownPath,
          agent: result.agentPath,
          json: result.reportPath,
        }),
  )

  if (options.failUnder === undefined) return 0
  const tripped = gateFailures(result.report, options.failUnder as Grade, options.allowMissing)
  if (tripped.length === 0) return 0
  process.stderr.write(
    `${pc.red('fail-under')} ${options.failUnder}: ${tripped.join(', ')}\n` +
      `Pass ${pc.cyan('--allow-missing')} to ignore categories nothing assessed.\n`,
  )
  return 1
}

/**
 * The `--fail-under` gate (spec CLI surface): the rollup **or any scanned
 * project** grading below the threshold trips it.
 *
 * Per project and not only in the blend, because a blend is exactly where a
 * small failing package hides behind a large healthy one — the gate would pass
 * a change nobody would merge. In PR mode that includes a project the change
 * added: its grades are head's, and head is what this report is about.
 *
 * A single-project repo is not asked twice. Its one project's states are the
 * rollup's, and naming both would report one failure as two.
 */
function gateFailures(report: Report, threshold: Grade, allowMissing: boolean): string[] {
  const rollup = belowThreshold(report.selected, report.categories, threshold, allowMissing)
  if (report.projects.length < 2) return rollup
  return [
    ...rollup,
    ...report.projects.flatMap((project) =>
      belowThreshold(report.selected, project.categories, threshold, allowMissing).map(
        (failure) => `${project.path} ${failure}`,
      ),
    ),
  ]
}

/**
 * One set of category states against the threshold. A selected category nothing
 * could assess trips the gate too — a missing signal is not a passing one —
 * unless `--allow-missing`. Categories excluded by `--only` are not selected, so
 * they never trip it.
 *
 * The one state that never trips it is a project's `not-assessed(repo-scoped)`:
 * it does not mean nothing assessed the category, it means the repo did, and the
 * repo's answer is gated in the rollup. Failing a package for the rollup's
 * finding would fail it twice; failing it for the rollup's *A* would be absurd.
 */
function belowThreshold(
  selected: readonly Category[],
  states: Readonly<Record<Category, CategoryState>>,
  threshold: Grade,
  allowMissing: boolean,
): string[] {
  return selected.flatMap((category) => {
    const state = states[category]
    if (state.status === 'graded') {
      return isBelow(state.grade, threshold) ? [`${category} ${state.grade}`] : []
    }
    if (state.status === 'not-assessed' && state.reason === REPO_SCOPED_REASON) return []
    return allowMissing ? [] : [`${category} ${state.status}`]
  })
}

/** Validates `--only` against the eight real categories. */
function parseCategories(only: readonly string[] | undefined): Category[] | undefined {
  if (only === undefined) return undefined
  return only.map((name) => {
    const category = CATEGORIES.find((known) => known === name)
    if (category === undefined) {
      throw new CliUsageError(
        `unknown category "${name}"; expected one of ${CATEGORIES.join(', ')}`,
      )
    }
    return category
  })
}

function fail(message: string, hint?: string): number {
  process.stderr.write(`${pc.red('error')} ${message}\n${hint === undefined ? '' : `${hint}\n`}`)
  return 2
}

try {
  process.exitCode = await run(process.argv.slice(2))
} catch (error) {
  process.exitCode =
    error instanceof CliUsageError
      ? fail(error.message, 'Run `crank-health --help` for usage.')
      : fail(error instanceof Error ? error.message : String(error))
}
