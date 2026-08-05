import pc from 'picocolors'
import { CliUsageError, HELP_TEXT, parseCliArgs } from './args.ts'
import { VERSION } from './version.ts'

/**
 * Exit codes are part of the CLI contract:
 * 0 scan completed · 1 --fail-under gate tripped · 2 crank-health errored.
 */
function run(argv: readonly string[]): number {
  const options = parseCliArgs(argv)

  if (options.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  // TODO(M2+): discover files, run adapters, grade, render. Until then the
  // scaffold only proves the surface parses and the binary is executable.
  const profile = options.deep ? 'deep' : 'quick'
  const mode = options.pr === undefined ? 'whole repo' : `PR delta vs ${options.pr}`
  process.stdout.write(
    `${pc.bold('crank-health')} ${VERSION} — scaffold only, scanning is not implemented yet.\n` +
      `  target:  ${options.path}\n` +
      `  profile: ${profile}\n` +
      `  mode:    ${mode}\n` +
      `Run ${pc.cyan('crank-health --help')} for the full surface.\n`,
  )
  return 0
}

function fail(message: string, hint?: string): number {
  process.stderr.write(`${pc.red('error')} ${message}\n${hint === undefined ? '' : `${hint}\n`}`)
  return 2
}

try {
  process.exitCode = run(process.argv.slice(2))
} catch (error) {
  process.exitCode =
    error instanceof CliUsageError
      ? fail(error.message, 'Run `crank-health --help` for usage.')
      : fail(error instanceof Error ? error.message : String(error))
}
