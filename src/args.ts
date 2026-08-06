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
  /**
   * `--project <path>`, repeatable: analyze only these projects, as
   * repo-relative posix paths (`.` for the root project). Undefined means every
   * discovered project. Paths are normalized here; whether they exist is a
   * question only discovery can answer, so it is asked in `run.ts`.
   */
  projects: string[] | undefined
  /** Lowest passing grade for the exit-1 gate; undefined means the gate is off. */
  failUnder: string | undefined
  /**
   * `--timeout <seconds>`: the per-tool budget for the quick tier (spec §5,
   * "per-tool timeout 120s (configurable)"). Undefined leaves the default.
   * The deep tier keeps its own, much larger budget — a mutation run and a
   * linter are not the same kind of wait, and one number cannot serve both.
   */
  timeoutSeconds: number | undefined
  /** Do not trip the `--fail-under` gate on not-assessed categories. */
  allowMissing: boolean
  /** Print report.json to stdout instead of the terminal summary. */
  json: boolean
  /** `-i` / `--interactive`: pick options through keyboard menus tailored to the repo. */
  interactive: boolean
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
  --project <path>    scope per-project analysis to <path>; repeatable (default: every project)
  --deep              add mutation testing / test-suite tier
  --out <dir>         output dir (default <path>/.codebase-health/)
  --only <cats>       subset, e.g. --only lint,types,security
  --fail-under <B>    exit 1 if any category grades below B (off by default)
  --allow-missing     not-assessed categories do not trip the gate
  --json              print report.json to stdout instead of terminal summary
  --timeout <secs>    per-tool budget for the quick tier (default 120)
  -i, --interactive   choose options through arrow-key menus tailored to the repo
  -h, --help          show this help
  --version           print version

Exit codes:
  0  scan completed (findings never fail a plain run)
  1  --fail-under gate tripped
  2  crank-health errored

--fail-under trips on any scanned project or the rollup, and treats not-assessed/error
categories as gate failures unless --allow-missing.
--deep runs mutation testing in every project that owns a mutation tool; --project is
how you bound what that costs.
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
    projects: parseProjects(values.project),
    failUnder,
    timeoutSeconds: parseTimeout(values.timeout),
    allowMissing: values['allow-missing'] ?? false,
    json: values.json ?? false,
    interactive: values.interactive ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  }
}

/**
 * `--project <path>`, repeatable, as the repo-relative posix paths discovery
 * uses for project identity: a trailing slash and a leading `./` are how a
 * shell completes a directory name, so both are accepted and neither is
 * identity, and `.` is the root project. Repeats of one path are the same
 * selection, so they collapse.
 *
 * @throws {CliUsageError} on a value that names no path at all
 */
function parseProjects(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined
  const paths = values.map((value) => {
    const path = value.trim().replace(/\/+$/, '').replace(/^\.\//, '')
    if (path.length === 0) {
      throw new CliUsageError(
        `--project expects a project path, e.g. --project packages/api (or . for the repo root), got "${value}"`,
      )
    }
    return path
  })
  return [...new Set(paths)]
}

/**
 * `--timeout <seconds>`, as a whole number of seconds greater than zero. A
 * fractional or zero budget is a typo, not a very short scan: every tool would
 * time out and the report would say `not-assessed` eight times over.
 *
 * @throws {CliUsageError} on anything that is not a positive integer
 */
function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const seconds = Number(value.trim())
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new CliUsageError(`--timeout expects a whole number of seconds, got "${value}"`)
  }
  return seconds
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
  project: { type: 'string', multiple: true },
  'fail-under': { type: 'string' },
  'allow-missing': { type: 'boolean' },
  json: { type: 'boolean' },
  timeout: { type: 'string' },
  interactive: { type: 'boolean', short: 'i' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const
