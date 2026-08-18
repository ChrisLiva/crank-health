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
import type { ToolCommand } from '../src/core/exec.ts'

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
      args: ['--quiet', 'ruff@0.16.1', 'check'],
      ephemeral: 'uvx',
    })
  })

  /** `uvx <dist>@<v>` runs the command named like the distribution; this is the rest. */
  it('names the command explicitly when it differs from the distribution', () => {
    expect(uvxCommand('ruff', ['--version'], 'ruff-lsp')).toEqual({
      command: 'uvx',
      args: ['--quiet', '--from', 'ruff==0.16.1', 'ruff-lsp', '--version'],
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
        '-v',
        'quiet',
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

/**
 * A cold cache must not change a report. Both fetchers narrate the install they
 * do the first time and say nothing on every run afterwards, so the same commit
 * scanned twice on one machine staged evidence the first time and not the
 * second — the determinism contract (spec §7), broken in a way a warm machine
 * can never reproduce. Measured before the flags went in: a cold-cache scan of
 * `test/fixtures/py-basic` produced six `<tool>.stderr.txt` files that the
 * second scan did not.
 *
 * Each fetcher's own switch does this rather than a filter over its output: a
 * pattern that has to keep matching uv's wording is a filter that can go
 * quietly dead, and nothing running on a warm machine would notice.
 */
describe('cold-cache quieting', () => {
  /**
   * The property itself, not the flag that implements it — so a cold cache is
   * forced (`UV_CACHE_DIR` into a fresh directory, which `ExecOptions.env`
   * passes through) and the unquieted command is run beside it as the control.
   * Without the control this test would pass on a machine where uv happened to
   * be silent for some other reason.
   *
   * Downloads the pinned ruff twice, once per cache, hence the budget.
   *
   * dnx has no twin here: its cold-cache line is pinned by the command-shape
   * assertion in `dnxCommand` above, because forcing a cold NuGet cache means
   * re-fetching the SDK's whole restore graph for one line of output.
   */
  it('leaves a cold uv cache silent, where the same command unquieted narrates', async () => {
    const base = await mkdtemp(join(tmpdir(), 'crank-cold-'))
    try {
      const coldRun = async (command: ToolCommand, cache: string) =>
        execTool(command, {
          cwd: base,
          timeoutMs: 240_000,
          env: { UV_CACHE_DIR: join(base, cache) },
        })

      const quieted = uvxCommand('ruff', ['--version'])
      const unquieted = { ...quieted, args: quieted.args.filter((arg) => arg !== '--quiet') }

      const narrating = await coldRun(unquieted, 'loud')
      const silent = await coldRun(quieted, 'quiet')

      // The control: a cold cache really does narrate, so the assertion below
      // is about the flag rather than about a cache that was warm all along.
      expect(narrating.stderr).not.toBe('')
      expect(silent.stderr).toBe('')
      // And the silence costs nothing the tool said.
      expect(silent.stdout).toBe(narrating.stdout)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }, 300_000)
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
