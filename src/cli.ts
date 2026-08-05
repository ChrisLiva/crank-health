import pc from 'picocolors'
import { CliUsageError, HELP_TEXT, parseCliArgs } from './args.ts'
import { isBelow } from './core/grade.ts'
import type { Category, Grade } from './core/types.ts'
import { CATEGORIES } from './core/types.ts'
import type { Report } from './render/json.ts'
import { renderTerminal } from './render/terminal.ts'
import { runPrScan } from './run-pr.ts'
import { runHealthScan } from './run.ts'
import { VERSION } from './version.ts'

/**
 * Exit codes are part of the CLI contract:
 * 0 scan completed · 1 --fail-under gate tripped · 2 crank-health errored.
 *
 * Everything below the argument handling belongs to `run.ts`; this file only
 * turns options into a scan and a scan into an exit code.
 */
async function run(argv: readonly string[]): Promise<number> {
  const options = parseCliArgs(argv)

  if (options.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  // Specified and planned (spec §5) but not in this build. Exiting 2 rather
  // than silently running a quick scan: a CI job that asked for the deep tier
  // must not be told everything is fine.
  if (options.deep) return unimplemented('--deep')

  const scan = {
    path: options.path,
    out: options.out,
    only: parseCategories(options.only),
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
 * The `--fail-under` gate (spec CLI surface): any selected category grading
 * below the threshold trips it, and so does any selected category nothing could
 * assess — a missing signal is not a passing one — unless `--allow-missing`.
 * Categories excluded by `--only` are not selected, so they never trip it.
 */
function gateFailures(report: Report, threshold: Grade, allowMissing: boolean): string[] {
  return report.selected.flatMap((category) => {
    const state = report.categories[category]
    if (state.status === 'graded') {
      return isBelow(state.grade, threshold) ? [`${category} ${state.grade}`] : []
    }
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

function unimplemented(flag: string): number {
  process.stderr.write(
    `${pc.red('error')} ${flag} is not implemented in this build (${VERSION}).\n` +
      `Run ${pc.cyan('crank-health [path]')} for a quick whole-repo scan.\n`,
  )
  return 2
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
