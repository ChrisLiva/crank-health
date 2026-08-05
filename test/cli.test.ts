import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HELP_TEXT } from '../src/args.ts'
import { VERSION } from '../src/version.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

/** Runs the CLI as a real process so exit codes and streams are the real ones. */
function runCli(args: readonly string[], env: Record<string, string> = {}) {
  return execa('node', [CLI_ENTRY, ...args], { reject: false, env, extendEnv: true })
}

describe('crank-health binary', () => {
  let fixture: FixtureRepo
  let out: string

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
    out = await mkdtemp(join(tmpdir(), 'crank-cli-'))
  })

  afterAll(async () => {
    await fixture.remove()
    await rm(out, { recursive: true, force: true })
  })

  it('prints the approved surface for --help and exits 0', async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(HELP_TEXT.trim())
  })

  it('prints the version and exits 0', async () => {
    const result = await runCli(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(VERSION)
  })

  it('exits 2 with a message on an unknown flag', async () => {
    const result = await runCli(['--bogus'])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('--bogus')
    expect(result.stderr).toContain('--help')
  })

  it('exits 2 on an unknown --only category', async () => {
    const result = await runCli(['--only', 'vibes', fixture.root])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('unknown category "vibes"')
  })

  it('exits 2 on a path that is not a directory', async () => {
    const result = await runCli([join(fixture.root, 'README.md')])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('not a directory')
  })

  it('scans a repo and prints the grades table, exit 0', async () => {
    const result = await runCli(['--out', out, fixture.root], { NO_COLOR: '1' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('lint')
    expect(result.stdout).toContain('test quality')
    expect(result.stdout).toContain('not assessed — run `--deep`')
    expect(result.stdout).toContain('eslint(no-const-assign)')
    // NO_COLOR is honoured: not one escape sequence on the way out.
    expect(result.stdout).not.toContain('\u001B[')
  })

  it('prints report.json and nothing else with --json', async () => {
    const result = await runCli(['--json', '--out', out, fixture.root])
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout) as { findings: unknown[]; schemaVersion: number }
    expect(report.schemaVersion).toBe(1)
    expect(report.findings).toHaveLength(4)
  })

  it('exits 1 when --fail-under is tripped, naming the categories', async () => {
    const result = await runCli(['--only', 'lint', '--fail-under', 'B', '--out', out, fixture.root])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('lint F')
  })

  it('exits 0 when every selected category clears --fail-under', async () => {
    const result = await runCli(['--only', 'lint', '--fail-under', 'F', '--out', out, fixture.root])
    expect(result.exitCode).toBe(0)
  })

  it('trips the gate on categories nothing assessed, unless --allow-missing', async () => {
    const strict = await runCli(['--fail-under', 'F', '--out', out, fixture.root])
    expect(strict.exitCode).toBe(1)
    expect(strict.stderr).toContain('security not-assessed')

    const lenient = await runCli([
      '--fail-under',
      'F',
      '--allow-missing',
      '--out',
      out,
      fixture.root,
    ])
    expect(lenient.exitCode).toBe(0)
  })

  it('refuses the modes this build does not implement instead of scanning anyway', async () => {
    const results = await Promise.all(
      [['--pr', 'main'], ['--deep']].map((args) => runCli([...args, fixture.root])),
    )
    for (const result of results) {
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('not implemented in this build')
    }
  })
})
