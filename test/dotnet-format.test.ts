import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  dotnetFormatRunner,
  parseDotnetFormatReport,
} from '../src/adapters/csharp/dotnet-format.ts'
import { dotnetEnv, sdkGate } from '../src/adapters/csharp/dotnet-project.ts'
import type { ToolFailure } from '../src/core/exec.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'
import { pathFarm } from './support/path-farm.ts'

/** The real 10.0.203 report; see the capture notes in the task record. */
const CAPTURED = fileURLToPath(new URL('./captured/dotnet-format-10.0.203.json', import.meta.url))

/** The scratch tree the capture ran against — the absolute paths in the bytes. */
const CAPTURE_ROOT = '/private/tmp/crank-dotnet-format-capture'

/**
 * The C# toolchain floor (`dotnet-project.ts`) and the `dotnet format` runner:
 * the environment every `dotnet` spawn carries, the SDK gate's ordered branches
 * driven through real subprocesses on a farmed `PATH`, and the report parser
 * over captured real bytes (SDK 10.0.203).
 */

describe('dotnetEnv', () => {
  it('pins exactly the five determinism and footprint variables', () => {
    const env = dotnetEnv()

    expect(env).toEqual({
      NUGET_PACKAGES: join(homedir(), '.nuget', 'packages'),
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      DOTNET_CLI_UI_LANGUAGE: 'en',
    })
    // The cache pin that defeats a hostile NuGet.config `globalPackagesFolder`
    // must be a real absolute path, and the machine's warm cache — never a
    // per-run scratch folder.
    expect(isAbsolute(env['NUGET_PACKAGES'] ?? '')).toBe(true)
  })
})

/** Real subprocesses on a farmed `PATH` — no in-process mocks. */
async function gateUnder(
  extras?: Readonly<Record<string, string>>,
): Promise<ToolFailure | undefined> {
  const farm = await pathFarm(extras)
  try {
    return await sdkGate({ cwd: tmpdir(), timeoutMs: 30_000, env: { PATH: farm.path } })
  } finally {
    await farm.remove()
  }
}

describe('sdkGate', () => {
  it('turns a missing SDK into the install hint', async () => {
    const failure = await gateUnder()

    expect(failure?.state).toBe('not-available')
    expect(failure?.reason).toContain('dotnet is not on PATH')
    expect(failure?.reason).toContain('https://dotnet.microsoft.com/download')
  })

  /**
   * The probed trap: with a `global.json` naming an uninstalled SDK,
   * `dotnet --version` exits 155 and prints the *installed-SDK list* on stdout
   * (first line `6.0.405 [...]`). Parsing a version out of that would report
   * "found 6.0.405, needs ≥ 10" — a confidently wrong reason for an unrelated
   * failure — so a non-zero exit quotes stderr and never stdout.
   */
  it('quotes stderr, never stdout, when the probe exits non-zero', async () => {
    const failure = await gateUnder({
      dotnet: '#!/bin/sh\necho "6.0.405 [/x]"\necho "no SDK" >&2\nexit 155',
    })

    expect(failure?.state).toBe('not-available')
    expect(failure?.reason).toContain('no SDK')
    expect(failure?.reason).not.toContain('6.0.405')
  })

  it('reports a probe that prints no version at all', async () => {
    const failure = await gateUnder({ dotnet: '#!/bin/sh\necho banner' })

    expect(failure?.state).toBe('not-available')
    expect(failure?.reason).toContain('banner')
  })

  it('names the found version and the floor when the SDK is too old', async () => {
    const failure = await gateUnder({ dotnet: '#!/bin/sh\necho 8.0.100' })

    expect(failure?.state).toBe('not-available')
    expect(failure?.reason).toContain('8.0.100')
    expect(failure?.reason).toContain('≥ 10')
  })

  it('passes a new-enough SDK through', async () => {
    expect(await gateUnder({ dotnet: '#!/bin/sh\necho 10.0.203' })).toBeUndefined()
  })
})

describe('the dotnet-format runner', () => {
  it('answers ok with nothing to measure when the project has no C# files', async () => {
    const ctx: RunContext = {
      repoRoot: '/repo',
      project: makeProject(['src/a.ts']),
      files: [],
      scratch: '/scratch',
      runScratch: '/scratch',
      detection: null,
      timeoutMs: 1_000,
      deep: false,
    }

    expect(await dotnetFormatRunner.run(ctx)).toEqual({
      state: 'ok',
      findings: [],
      rawFiles: [],
      reason: 'no C# files',
    })
  })

  it('records the format category and the verified SDK floor', () => {
    expect(dotnetFormatRunner.tool).toBe('dotnet-format')
    expect(dotnetFormatRunner.category).toBe('format')
    expect(dotnetFormatRunner.pinnedVersion).toBe('10.0.203')
  })
})

describe('parsing a dotnet format report', () => {
  it('reports one finding per failing file, never one per change', async () => {
    const findings = parseDotnetFormatReport(await readFile(CAPTURED, 'utf8'), CAPTURE_ROOT)

    // The captured run flagged 15 changes in Widget.cs and 10 in Program.cs —
    // the grade is a share of files, so each file is exactly one finding
    // (prettier/ruff-format parity).
    expect(findings.map((finding) => finding.file)).toEqual(['Program.cs', 'Widget.cs'])
    for (const finding of findings) {
      expect(finding.category).toBe('format')
      expect(finding.tool).toBe('dotnet-format')
      expect(finding.rule).toBe('dotnet-format/whitespace')
      expect(finding.severity).toBe('warning')
      expect(finding.range).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 1 })
      expect(finding.anchor).toBe('')
      expect(finding.provenance).toBe('repo-config')
      expect(finding.gradeScope).toBe(true)
    }
  })

  it('throws on JSON that is not the report array', () => {
    expect(() => parseDotnetFormatReport('{"FilePath":"x"}', '/repo')).toThrow()
  })

  it('parses an all-clean report to zero findings', () => {
    expect(parseDotnetFormatReport('[]', '/repo')).toEqual([])
  })

  it('drops a file the report lists without any changes', () => {
    const report = JSON.stringify([{ FilePath: '/repo/A.cs', FileChanges: [] }])
    expect(parseDotnetFormatReport(report, '/repo')).toEqual([])
  })

  it('leaves a file outside the repo to the analyzed filter', () => {
    const report = JSON.stringify([
      {
        FilePath: '/elsewhere/Other.cs',
        FileChanges: [{ LineNumber: 1, CharNumber: 1, DiagnosticId: 'WHITESPACE' }],
      },
    ])
    const findings = parseDotnetFormatReport(report, '/repo')

    // The parser relativizes without judging; the runner's `analyzed.has(file)`
    // filter — the same one every wrapper applies — is what drops it.
    expect(findings).toHaveLength(1)
    const analyzed = new Set(['src/A.cs'])
    expect(findings.filter((finding) => analyzed.has(finding.file))).toEqual([])
  })
})
