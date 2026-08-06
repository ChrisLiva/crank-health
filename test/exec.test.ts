import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  dnxCommand,
  ephemeralCommand,
  execTool,
  repoCommand,
  uvxCommand,
  writeScratchRaw,
} from '../src/core/exec.ts'
import { pinnedDotnetVersion, verifiedRepoVersion, verifiedVersion } from '../src/manifest.ts'

/**
 * The subprocess layer's whole job is that nothing a tool does can throw at the
 * orchestrator (spec §8) — and that ephemeral runs are pinned (spec §6).
 */
describe('execTool', () => {
  let scratch: string

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'crank-exec-'))
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('captures both streams and does not treat a non-zero exit as a failure', async () => {
    const execution = await execTool(
      repoCommand('/bin/sh', ['-c', 'echo out; echo err 1>&2; exit 1']),
      { cwd: scratch, timeoutMs: 5_000 },
    )
    expect(execution.stdout).toBe('out')
    expect(execution.stderr).toBe('err')
    expect(execution.exitCode).toBe(1)
    expect(execution.failure).toBeUndefined()
  })

  it('reports a missing binary as not-available rather than throwing', async () => {
    const execution = await execTool(repoCommand('crank-no-such-binary', []), {
      cwd: scratch,
      timeoutMs: 5_000,
    })
    expect(execution.failure).toEqual({
      state: 'not-available',
      reason: 'crank-no-such-binary is not executable',
    })
  })

  it('reports a tool that outlives its budget as a timeout', async () => {
    const execution = await execTool(repoCommand('/bin/sh', ['-c', 'sleep 5']), {
      cwd: scratch,
      timeoutMs: 200,
    })
    expect(execution.failure?.state).toBe('timeout')
  })

  it('neutralizes colour so parsers never see escape sequences', async () => {
    const execution = await execTool(
      repoCommand('/bin/sh', ['-c', 'echo "$NO_COLOR:$FORCE_COLOR"']),
      {
        cwd: scratch,
        timeoutMs: 5_000,
      },
    )
    expect(execution.stdout).toBe('1:0')
  })
})

describe('ephemeralCommand', () => {
  it('pins an exact version — never a bare name, never @latest', () => {
    expect(ephemeralCommand('oxlint', ['--format', 'sarif'])).toEqual({
      command: 'npx',
      args: ['--yes', 'oxlint@1.77.0', '--format', 'sarif'],
      ephemeral: 'npx',
    })
  })
})

describe('uvxCommand', () => {
  it('pins an exact version of a Python tool the same way', () => {
    expect(uvxCommand('ruff', ['check'])).toEqual({
      command: 'uvx',
      args: ['ruff@0.16.1', 'check'],
      ephemeral: 'uvx',
    })
  })

  /** `uvx <dist>@<v>` runs the command named like the distribution; this is the rest. */
  it('names the command explicitly when it differs from the distribution', () => {
    expect(uvxCommand('ruff', ['--version'], 'ruff-lsp')).toEqual({
      command: 'uvx',
      args: ['--from', 'ruff==0.16.1', 'ruff-lsp', '--version'],
      ephemeral: 'uvx',
    })
  })

  it('explains how to get uv when it is not installed, instead of failing opaquely', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-uvx-'))
    try {
      const execution = await execTool(
        { command: 'crank-no-such-uvx', args: [], ephemeral: 'uvx' },
        { cwd: scratch, timeoutMs: 5_000 },
      )
      expect(execution.failure?.state).toBe('not-available')
      expect(execution.failure?.reason).toContain('install uv')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('reads uv’s unsolvable-requirement wording as "could not fetch", not as a tool failure', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-uvx-'))
    try {
      const execution = await execTool(
        {
          command: '/bin/sh',
          args: ['-c', 'echo "No solution found when resolving tool dependencies" 1>&2; exit 1'],
          ephemeral: 'uvx',
        },
        { cwd: scratch, timeoutMs: 5_000 },
      )
      expect(execution.failure).toEqual({
        state: 'not-available',
        reason: expect.stringContaining('uv cache') as unknown as string,
      })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe('dnxCommand', () => {
  it('pins an exact version, names the feed, and fences tool flags behind --', () => {
    expect(dnxCommand('roslynator.dotnet.cli', ['find-symbol'])).toEqual({
      command: 'dnx',
      args: [
        '-y',
        'roslynator.dotnet.cli@0.12.0',
        '--source',
        'https://api.nuget.org/v3/index.json',
        '--',
        'find-symbol',
      ],
      ephemeral: 'dnx',
    })
  })
})

describe('dnx classification', () => {
  let scratch: string

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'crank-dnx-'))
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('explains how to get the .NET SDK when dnx is not installed', async () => {
    const execution = await execTool(
      { command: 'crank-no-such-dnx', args: [], ephemeral: 'dnx' },
      { cwd: scratch, timeoutMs: 5_000 },
    )
    expect(execution.failure?.state).toBe('not-available')
    expect(execution.failure?.reason).toContain('.NET SDK')
  })

  it('names each fetcher’s own cache in the offline hint — NuGet for dnx, never uv’s', async () => {
    const offline = async (marker: string, pin: string, fetcher: 'npx' | 'uvx' | 'dnx') =>
      (
        await execTool(
          {
            command: '/bin/sh',
            args: ['-c', `echo "${marker}" 1>&2; exit 1`, pin],
            ephemeral: fetcher,
          },
          { cwd: scratch, timeoutMs: 5_000 },
        )
      ).failure
    expect(
      await offline(
        'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json',
        'roslynator.dotnet.cli@0.12.0',
        'dnx',
      ),
    ).toEqual({
      state: 'not-available',
      reason:
        'could not fetch roslynator.dotnet.cli@0.12.0: no network and nothing in the ' +
        'NuGet cache — run crank-health once with network access to warm the cache',
    })
    expect(await offline('ENOTFOUND', 'oxlint@1.77.0', 'npx')).toEqual({
      state: 'not-available',
      reason:
        'could not fetch oxlint@1.77.0: no network and nothing in the ' +
        'npm cache — run crank-health once with network access to warm the cache',
    })
    expect(await offline('failed to fetch', 'ruff@0.16.1', 'uvx')).toEqual({
      state: 'not-available',
      reason:
        'could not fetch ruff@0.16.1: no network and nothing in the ' +
        'uv cache — run crank-health once with network access to warm the cache',
    })
  })

  it('declines dnx’s unresolvable-pin wording: an unfetchable pin is never "offline"', async () => {
    // Real captured stderr from `dnx -y crank.health.nosuch.pkg@9.9.9 …`: the
    // pin does not exist on the feed. That is a tool error quoting the pin, not
    // "no network, warm your cache" — so classify must let it fall through to
    // the runner's own failure mapping.
    const captured = fileURLToPath(
      new URL('./captured/dnx-unresolved-pin-10.0.203.stderr.txt', import.meta.url),
    )
    const execution = await execTool(
      {
        command: '/bin/sh',
        args: ['-c', 'cat "$1" 1>&2; exit 1', 'sh', captured],
        ephemeral: 'dnx',
      },
      { cwd: scratch, timeoutMs: 5_000 },
    )
    expect(execution.stderr).toContain('is not found in NuGet feeds')
    expect(execution.exitCode).toBe(1)
    expect(execution.failure).toBeUndefined()
  })
})

describe('the dotnet pins', () => {
  it('pins the exact NuGet tool versions this release captured and tested against', () => {
    expect(pinnedDotnetVersion('roslynator.dotnet.cli')).toBe('0.12.0')
    expect(pinnedDotnetVersion('microsoft.codeanalysis.netanalyzers')).toBe('10.0.302')
  })

  it('records the verified floors for the SDK and the repo-owned mutation tool', () => {
    expect(verifiedVersion('dotnet')).toBe('10.0.203')
    expect(verifiedRepoVersion('dotnet-stryker')).toBe('4.16.0')
  })
})

describe('writeScratchRaw', () => {
  it('stages raw output outside the target repo', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-raw-'))
    try {
      const path = await writeScratchRaw(scratch, 'tool.json', '{}\n')
      expect(path).toBe(join(scratch, 'raw', 'tool.json'))
      expect(await readFile(path, 'utf8')).toBe('{}\n')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
