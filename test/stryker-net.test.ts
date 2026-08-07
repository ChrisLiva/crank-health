import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectDotnetTool } from '../src/adapters/csharp/dotnet-project.ts'
import {
  STRYKER_NET_TOOL,
  strykerNetOutcome,
  strykerNetRunner,
} from '../src/adapters/csharp/stryker-net.ts'
import {
  SURVIVED_RULE,
  mutationCounts,
  parseMutationReport,
  toPendingFindings,
} from '../src/adapters/mutation-report.ts'
import { inventoryOf, partitionProjects } from '../src/core/discover.ts'
import type { DetectContext, Detection, RunContext } from '../src/core/types.ts'
import { verifiedRepoVersion } from '../src/manifest.ts'
import { makeProject } from './factories.ts'

/**
 * Stryker.NET: ownership through the dotnet local-tool manifest, the pure
 * outcome ladder, and the shared mutation-report parser over a captured real
 * 4.16.0 run. The live mutation run is `test/deep-csharp-e2e.test.ts`'s, gated
 * behind `CRANK_DEEP_E2E=1`.
 */

const STRYKER_SPEC = { toolId: 'dotnet-stryker', packageName: 'dotnet-stryker' }

/** A real `dotnet new tool-manifest && dotnet tool install dotnet-stryker`. */
const MANIFEST_WITH_STRYKER = JSON.stringify({
  version: 1,
  isRoot: true,
  tools: { 'dotnet-stryker': { version: '4.16.0', commands: ['dotnet-stryker'] } },
})

/** A tools manifest that owns something else entirely. */
const MANIFEST_WITHOUT_STRYKER = JSON.stringify({
  version: 1,
  isRoot: true,
  tools: { csharpier: { version: '1.0.2', commands: ['csharpier'] } },
})

/** A project file that declares nothing. */
const PLAIN_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n'

/** A project file that declares Stryker.NET as a package dependency. */
const DECLARING_CSPROJ = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <ItemGroup>',
  '    <PackageReference Include="dotnet-stryker" Version="4.16.0" />',
  '  </ItemGroup>',
  '</Project>',
  '',
].join('\n')

/** Writes `tree` into a throwaway repo and detects for the project at `projectPath`. */
async function detectIn(
  tree: Readonly<Record<string, string>>,
  projectPath = '.',
  detect: (ctx: DetectContext) => Promise<Detection | null> = (ctx) =>
    detectDotnetTool(ctx, STRYKER_SPEC),
): Promise<Detection | null> {
  const root = await mkdtemp(join(tmpdir(), 'crank-dotnet-tool-'))
  try {
    for (const [file, contents] of Object.entries(tree)) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(join(root, dirname(file)), { recursive: true })
      // eslint-disable-next-line no-await-in-loop
      await writeFile(join(root, file), contents, 'utf8')
    }
    const files = inventoryOf(Object.keys(tree).toSorted())
    const project = partitionProjects(files).find((candidate) => candidate.path === projectPath)
    if (project === undefined) throw new Error(`no project at ${projectPath}`)
    return await detect({ repoRoot: root, project, files })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('detectDotnetTool', () => {
  it('owns the tool through a tools manifest that lists it, installed by declaration', async () => {
    const detection = await detectIn({
      '.config/dotnet-tools.json': MANIFEST_WITH_STRYKER,
      'App.csproj': PLAIN_CSPROJ,
      'Program.cs': 'class Program {}\n',
    })

    expect(detection).toEqual({
      reason: 'config',
      configFiles: ['.config/dotnet-tools.json'],
      ownedVia: '.config/dotnet-tools.json',
      installed: true,
    })
  })

  it('does not own through a manifest that lists only other tools', async () => {
    const detection = await detectIn({
      '.config/dotnet-tools.json': MANIFEST_WITHOUT_STRYKER,
      'App.csproj': PLAIN_CSPROJ,
      'Program.cs': 'class Program {}\n',
    })

    expect(detection).toBeNull()
  })

  it('inherits a tools manifest from an ancestor directory', async () => {
    const detection = await detectIn(
      {
        '.config/dotnet-tools.json': MANIFEST_WITH_STRYKER,
        'App/App.csproj': PLAIN_CSPROJ,
        'App/Program.cs': 'class Program {}\n',
      },
      'App',
    )

    expect(detection).toEqual({
      reason: 'config',
      configFiles: ['.config/dotnet-tools.json'],
      ownedVia: '.config/dotnet-tools.json',
      installed: true,
    })
  })

  it('owns through a csproj PackageReference alone, as a dependency', async () => {
    const detection = await detectIn({
      'App.csproj': DECLARING_CSPROJ,
      'Program.cs': 'class Program {}\n',
    })

    expect(detection).toEqual({
      reason: 'dependency',
      configFiles: [],
      ownedVia: 'App.csproj',
      installed: false,
    })
  })

  it('returns null when neither artifact exists', async () => {
    const detection = await detectIn({
      'App.csproj': PLAIN_CSPROJ,
      'Program.cs': 'class Program {}\n',
    })

    expect(detection).toBeNull()
  })

  it('treats a malformed manifest as declaring nothing', async () => {
    const detection = await detectIn({
      '.config/dotnet-tools.json': '{ not json',
      'App.csproj': PLAIN_CSPROJ,
      'Program.cs': 'class Program {}\n',
    })

    expect(detection).toBeNull()
  })
})

describe('the capture pin', () => {
  /** The version `test/captured/stryker-net-4.16.0.json` was captured with. */
  it('records 4.16.0 as the verified Stryker.NET', () => {
    expect(verifiedRepoVersion('dotnet-stryker')).toBe('4.16.0')
  })
})

/** A real 4.16.0 run over a two-method library and a deliberately weak suite. */
const CAPTURED = fileURLToPath(new URL('./captured/stryker-net-4.16.0.json', import.meta.url))

/**
 * The scratch root the capture ran in. Stryker.NET keys `files` by absolute
 * path, so the capture doubles as the parser's absolute-path case — the
 * StrykerJS capture (relative keys) covers the other branch.
 */
const CAPTURE_ROOT =
  '/private/tmp/claude-501/-Users-chris-crank-analysis/9cd0ed88-5084-4a88-aafa-b0a5b5d96661/scratchpad/stryker-capture'

describe('parsing a captured Stryker.NET report', () => {
  it('reads it through the shared parser: 7 mutants, hand-counted 2/5', async () => {
    const mutants = parseMutationReport(await readFile(CAPTURED, 'utf8'), CAPTURE_ROOT)

    expect(mutants).toHaveLength(7)
    expect(new Set(mutants.map((mutant) => mutant.file))).toEqual(new Set(['src/Lib/Calc.cs']))
    expect(mutationCounts(mutants)).toEqual({ detected: 2, undetected: 5 })
  })

  it('reports the hand-checked survived mutant, tagged stryker-net throughout', async () => {
    const mutants = parseMutationReport(await readFile(CAPTURED, 'utf8'), CAPTURE_ROOT)
    const findings = toPendingFindings(mutants, STRYKER_NET_TOOL)

    // 1 survived + 4 never-covered advisories; the 2 killed are not findings.
    expect(findings).toHaveLength(5)
    expect(findings.every((finding) => finding.tool === STRYKER_NET_TOOL)).toBe(true)

    const survived = findings.filter((finding) => finding.rule === SURVIVED_RULE)
    expect(survived).toHaveLength(1)
    // Hand-checked against Calc.cs: `IsPositive`'s `value > 0` on line 9,
    // weakened to `value >= 0`, and the weak suite noticed nothing.
    expect(survived[0]).toMatchObject({
      file: 'src/Lib/Calc.cs',
      range: { startLine: 9, startCol: 49 },
      gradeScope: true,
    })
    expect(survived[0]?.message).toContain('value >= 0')
  })
})

describe('the outcome ladder', () => {
  const EXECUTION = { stdout: 'done', stderr: '', exitCode: 0 }

  it('passes a process-level failure through unchanged', () => {
    const failure = { state: 'timeout' as const, reason: 'dotnet exceeded its time budget' }
    expect(strykerNetOutcome({ ...EXECUTION, failure }, undefined, '/repo')).toBe(failure)
  })

  it('reports a non-zero exit as an error quoting the exit code and stderr', () => {
    const outcome = strykerNetOutcome(
      { stdout: '', stderr: 'boom\nsecond line', exitCode: 1 },
      undefined,
      '/repo',
    )
    expect(outcome).toMatchObject({ state: 'error' })
    expect((outcome as { reason: string }).reason).toContain('exit 1')
    expect((outcome as { reason: string }).reason).toContain('boom')
  })

  it('treats a missing report as an error, never as zero mutants', () => {
    const outcome = strykerNetOutcome(EXECUTION, undefined, '/repo')
    expect(outcome).toMatchObject({ state: 'error' })
    expect((outcome as { reason: string }).reason).toContain('no mutation report')
  })

  it('treats an unparseable report as an error', () => {
    const outcome = strykerNetOutcome(EXECUTION, '{"mutants": []}', '/repo')
    expect(outcome).toMatchObject({ state: 'error' })
    expect((outcome as { reason: string }).reason).toContain('could not parse')
  })

  /** A run that produced no mutants measured nothing — an error, never an A. */
  it('refuses to score a report with an empty files object', () => {
    const outcome = strykerNetOutcome(EXECUTION, '{"files": {}}', '/repo')
    expect(outcome).toMatchObject({ state: 'error' })
    expect((outcome as { reason: string }).reason).toContain('no mutants')
  })

  it('returns the mutants of a good run', async () => {
    const outcome = strykerNetOutcome(EXECUTION, await readFile(CAPTURED, 'utf8'), CAPTURE_ROOT)
    expect(Array.isArray(outcome)).toBe(true)
    expect(outcome).toHaveLength(7)
  })
})

const CONTEXT: RunContext = {
  repoRoot: '/repo',
  project: makeProject(['Program.cs', 'App.csproj']),
  files: ['Program.cs'],
  scratch: '/scratch',
  runScratch: '/scratch',
  detection: null,
  timeoutMs: 1_000,
  deep: true,
}

describe('the runner’s posture', () => {
  it('is deep-only and never imposed on a repo that did not choose it', () => {
    expect(strykerNetRunner).toMatchObject({
      tool: STRYKER_NET_TOOL,
      category: 'test-quality',
      repoOwnedOnly: true,
      deepOnly: true,
    })
  })

  it('detects through the dotnet tools manifest', async () => {
    const detection = await detectIn(
      {
        '.config/dotnet-tools.json': MANIFEST_WITH_STRYKER,
        'App.csproj': PLAIN_CSPROJ,
        'Program.cs': 'class Program {}\n',
      },
      '.',
      (ctx) => strykerNetRunner.detect(ctx),
    )
    expect(detection).toMatchObject({ ownedVia: '.config/dotnet-tools.json', installed: true })
  })

  it('declines in the quick profile instead of executing repo code', async () => {
    const result = await strykerNetRunner.run({ ...CONTEXT, deep: false })
    expect(result).toMatchObject({ state: 'not-available', findings: [] })
    expect(result.reason).toContain('--deep')
  })

  /** Unreachable through the orchestrator (`repoOwnedOnly`); defensive parity. */
  it('names the tools manifest when asked to run unowned', async () => {
    const result = await strykerNetRunner.run(CONTEXT)
    expect(result).toMatchObject({ state: 'not-available', findings: [] })
    expect(result.reason).toContain('.config/dotnet-tools.json')
  })
})
