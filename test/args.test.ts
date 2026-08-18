import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CliUsageError, parseCliArgs } from '../src/args.ts'
import { VERSION } from '../src/version.ts'

describe('parseCliArgs', () => {
  it('defaults the path to the current directory and every flag to off', () => {
    expect(parseCliArgs([])).toEqual({
      path: '.',
      pr: undefined,
      deep: false,
      out: undefined,
      only: undefined,
      projects: undefined,
      failUnder: undefined,
      timeoutSeconds: undefined,
      allowMissing: false,
      json: false,
      interactive: false,
      help: false,
      version: false,
    })
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
      '--project',
      'packages/api',
      '--fail-under',
      'B',
      '--allow-missing',
      '--json',
      '--timeout',
      '30',
      'repo',
    ])
    expect(options).toEqual({
      path: 'repo',
      pr: 'main',
      deep: true,
      out: '/tmp/health',
      only: ['lint', 'types', 'security'],
      projects: ['packages/api'],
      failUnder: 'B',
      timeoutSeconds: 30,
      allowMissing: true,
      json: true,
      interactive: false,
      help: false,
      version: false,
    })
  })

  it.each(['0', '-5', '1.5', 'soon', ''])(
    'rejects --timeout %s, which would time every tool out',
    (value) => {
      expect(() => parseCliArgs(['--timeout', value])).toThrow(CliUsageError)
    },
  )

  it('trims and normalizes --only and --fail-under', () => {
    const options = parseCliArgs(['--only', 'lint, types ,', '--fail-under', 'c'])
    expect(options.only).toEqual(['lint', 'types'])
    expect(options.failUnder).toBe('C')
    // Spec §5: the per-tool budget is "120s (configurable)"; this is the knob.
    expect(parseCliArgs(['--timeout', ' 45 ']).timeoutSeconds).toBe(45)
  })

  /** Spec CLI surface: `--project` is repeatable, and each one is a project. */
  it('collects every --project into the scan scope', () => {
    expect(
      parseCliArgs(['--project', 'packages/api', '--project', 'packages/web']).projects,
    ).toEqual(['packages/api', 'packages/web'])
  })

  it('normalizes --project paths to the identity discovery uses', () => {
    expect(parseCliArgs(['--project', ' ./packages/api/ ']).projects).toEqual(['packages/api'])
    expect(parseCliArgs(['--project', './']).projects).toEqual(['.'])
    expect(parseCliArgs(['--project', '.']).projects).toEqual(['.'])
  })

  it('collapses a --project repeated with itself', () => {
    expect(
      parseCliArgs(['--project', 'packages/api', '--project', 'packages/api/']).projects,
    ).toEqual(['packages/api'])
  })

  it('rejects a --project that names no path', () => {
    expect(() => parseCliArgs(['--project', '  '])).toThrow(CliUsageError)
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

  it('supports -i as well as --interactive', () => {
    expect(parseCliArgs(['-i']).interactive).toBe(true)
    expect(parseCliArgs(['--interactive']).interactive).toBe(true)
  })
})

describe('VERSION', () => {
  it('matches package.json', () => {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
    const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    expect((packageJson as { version: string }).version).toBe(VERSION)
  })
})
