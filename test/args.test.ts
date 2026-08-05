import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CliUsageError, HELP_TEXT, parseCliArgs } from '../src/args.ts'
import { VERSION } from '../src/version.ts'

describe('parseCliArgs', () => {
  it('defaults the path to the current directory and every flag to off', () => {
    expect(parseCliArgs([])).toEqual({
      path: '.',
      pr: undefined,
      deep: false,
      out: undefined,
      only: undefined,
      failUnder: undefined,
      allowMissing: false,
      json: false,
      help: false,
      version: false,
    })
  })

  it('accepts a single positional path', () => {
    expect(parseCliArgs(['../some/repo']).path).toBe('../some/repo')
  })

  it('rejects a second positional path', () => {
    expect(() => parseCliArgs(['a', 'b'])).toThrow(CliUsageError)
  })

  it('parses the full flag surface', () => {
    const options = parseCliArgs([
      '--pr',
      'main',
      '--deep',
      '--out',
      '/tmp/health',
      '--only',
      'lint,types,security',
      '--fail-under',
      'B',
      '--allow-missing',
      '--json',
      'repo',
    ])
    expect(options).toEqual({
      path: 'repo',
      pr: 'main',
      deep: true,
      out: '/tmp/health',
      only: ['lint', 'types', 'security'],
      failUnder: 'B',
      allowMissing: true,
      json: true,
      help: false,
      version: false,
    })
  })

  it('trims and normalizes --only and --fail-under', () => {
    const options = parseCliArgs(['--only', 'lint, types ,', '--fail-under', 'c'])
    expect(options.only).toEqual(['lint', 'types'])
    expect(options.failUnder).toBe('C')
  })

  it('rejects an empty --only list', () => {
    expect(() => parseCliArgs(['--only', ' , '])).toThrow(CliUsageError)
  })

  it('rejects a --fail-under value that is not a grade', () => {
    expect(() => parseCliArgs(['--fail-under', 'good'])).toThrow(CliUsageError)
  })

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow(CliUsageError)
  })

  it('rejects a flag that is missing its value', () => {
    expect(() => parseCliArgs(['--pr'])).toThrow(CliUsageError)
  })

  it('supports -h as well as --help', () => {
    expect(parseCliArgs(['-h']).help).toBe(true)
    expect(parseCliArgs(['--help']).help).toBe(true)
    expect(parseCliArgs(['--version']).version).toBe(true)
  })
})

describe('HELP_TEXT', () => {
  it('documents every flag in the approved surface', () => {
    for (const flag of [
      '--pr <base>',
      '--deep',
      '--out <dir>',
      '--only <cats>',
      '--fail-under <B>',
      '--allow-missing',
      '--json',
      '-h, --help',
      '--version',
    ]) {
      expect(HELP_TEXT).toContain(flag)
    }
  })

  it('documents the exit-code semantics', () => {
    expect(HELP_TEXT).toContain('0  scan completed')
    expect(HELP_TEXT).toContain('1  --fail-under gate tripped')
    expect(HELP_TEXT).toContain('2  crank-health errored')
  })
})

describe('VERSION', () => {
  it('matches package.json', () => {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    expect((packageJson as { version: string }).version).toBe(VERSION)
  })
})
