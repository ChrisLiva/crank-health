import { parseArgs } from 'node:util'

/** Options after parsing, before any semantic validation of values. */
export interface CliOptions {
  /** Target repo path; defaults to '.'. */
  path: string
  /** Base ref for PR delta mode, or undefined for a whole-repo scan. */
  pr: string | undefined
  /** Add the mutation / test-suite tier. */
  deep: boolean
  /** Output directory override; defaults to `<path>/.codebase-health/`. */
  out: string | undefined
  /** Category subset, e.g. ['lint', 'types']; undefined means all. */
  only: string[] | undefined
  /** Lowest passing grade for the exit-1 gate; undefined means the gate is off. */
  failUnder: string | undefined
  /** Do not trip the `--fail-under` gate on not-assessed categories. */
  allowMissing: boolean
  /** Print report.json to stdout instead of the terminal summary. */
  json: boolean
  help: boolean
  version: boolean
}

/** Thrown for anything the user can fix by re-typing the command. Exit code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export const HELP_TEXT = `crank-health — deterministic codebase health grades for JS/TS and Python repos.

Usage:
  npx crank-health [path]               quick scan, whole repo (path defaults to .)
  npx crank-health --pr <base> [path]   two-scan delta vs merge-base with <base>

Options:
  --pr <base>         two-scan delta vs merge-base with <base>
  --deep              add mutation testing / test-suite tier
  --out <dir>         output dir (default <path>/.codebase-health/)
  --only <cats>       subset, e.g. --only lint,types,security
  --fail-under <B>    exit 1 if any category grades below B (off by default)
  --allow-missing     not-assessed categories do not trip the gate
  --json              print report.json to stdout instead of terminal summary
  -h, --help          show this help
  --version           print version

Exit codes:
  0  scan completed (findings never fail a plain run)
  1  --fail-under gate tripped
  2  crank-health errored

--fail-under treats not-assessed/error categories as gate failures unless --allow-missing.
`

const GRADES = ['A', 'B', 'C', 'D', 'E', 'F']

/**
 * Parses crank-health's argv tail (everything after `node cli.js`).
 *
 * @throws {CliUsageError} on unknown flags, missing flag values, or more than
 * one positional argument.
 */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values, positionals } = parseStrict(argv)

  if (positionals.length > 1) {
    throw new CliUsageError(
      `expected at most one path argument, got ${positionals.length}: ${positionals.join(' ')}`,
    )
  }

  const only = values.only
    ?.split(',')
    .map((category) => category.trim())
    .filter((category) => category.length > 0)
  if (values.only !== undefined && (only === undefined || only.length === 0)) {
    throw new CliUsageError('--only needs at least one category, e.g. --only lint,types')
  }

  const failUnder = values['fail-under']?.trim().toUpperCase()
  if (failUnder !== undefined && !GRADES.includes(failUnder)) {
    throw new CliUsageError(
      `--fail-under expects a grade (${GRADES.join(', ')}), got "${failUnder}"`,
    )
  }

  return {
    path: positionals[0] ?? '.',
    pr: values.pr,
    deep: values.deep ?? false,
    out: values.out,
    only,
    failUnder,
    allowMissing: values['allow-missing'] ?? false,
    json: values.json ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  }
}

/** parseArgs, with its errors restated as CliUsageError. */
function parseStrict(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: OPTION_CONFIG,
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }
}

const OPTION_CONFIG = {
  pr: { type: 'string' },
  deep: { type: 'boolean' },
  out: { type: 'string' },
  only: { type: 'string' },
  'fail-under': { type: 'string' },
  'allow-missing': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const
