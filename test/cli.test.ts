import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { HELP_TEXT } from '../src/args.ts'
import { VERSION } from '../src/version.ts'

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

/** Runs the CLI as a real process so exit codes and streams are the real ones. */
function runCli(args: readonly string[]) {
  return execa('node', [CLI_ENTRY, ...args], { reject: false })
}

describe('crank-health binary', () => {
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

  it('exits 0 on a stubbed scan', async () => {
    const result = await runCli(['.'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('not implemented yet')
  })
})
