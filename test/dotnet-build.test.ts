import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BUILD_FAILED_REASON,
  CA1502_MESSAGE,
  CA1502_SUPPRESSED_REASON,
  DOTNET_BUILD_TOOL,
  UNRESOLVED_PIN_REASON,
  buildFor,
  complexityResultFor,
  dotnetBuildComplexityRunner,
  dotnetBuildLintRunner,
  dotnetBuildTypesRunner,
  forgetBuilds,
  isUnresolvedPin,
  lintResultFor,
  mergeSarifLogs,
  parseBuildSarif,
  typesResultFor,
} from '../src/adapters/csharp/build.ts'
import type { CsBuild } from '../src/adapters/csharp/build.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'
import { pathFarm } from './support/path-farm.ts'

/**
 * The pure half of the `dotnet build` host, proven over captured real bytes:
 * a multi-targeting (`net8.0;net10.0`) scratch project compiled by SDK
 * 10.0.203 with the injected netanalyzers 10.0.302 assets. The capture's
 * per-TFM SARIF files were folded through `mergeSarifLogs` — the same
 * function the runtime uses — so what the parse tests pin is exactly what a
 * run parses.
 */

const captured = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'captured', name), 'utf8')

/** A minimal but valid SARIF 2.1 document, for merge/hostile-input cases. */
const sarif = (results: unknown[]): string =>
  JSON.stringify({ version: '2.1.0', runs: [{ results }] })

/** Where the capture scaffold lived; the SARIF's file URIs are under it. */
const CAPTURE_ROOT = '/private/tmp/crank-cs-capture/proj'
const BROKEN_ROOT = '/private/tmp/crank-cs-capture/proj-broken'

describe('parseBuildSarif partition', () => {
  const parsed = parseBuildSarif(captured('netanalyzers-10.0.302.sarif.json'), CAPTURE_ROOT)

  it('sends CS diagnostics to types, with SARIF levels mapped', () => {
    const flagged = parsed.types.filter((finding) => finding.rule === 'CS0219')
    expect(flagged.length).toBeGreaterThan(0)
    for (const finding of flagged) {
      expect(finding.category).toBe('types')
      expect(finding.severity).toBe('warning')
      expect(finding.file).toBe('Classifier.cs')
      expect(finding.range.startLine).toBe(7)
      expect(finding.range.startCol).toBe(13)
    }
    expect(parsed.lint.map((finding) => finding.rule)).not.toContain('CS0219')
  })

  it('grades compile errors as error-severity types findings', () => {
    const failed = parseBuildSarif(
      captured('netanalyzers-10.0.302.compile-failed.sarif.json'),
      BROKEN_ROOT,
    )
    const flagged = failed.types.filter((finding) => finding.rule === 'CS0029')
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged[0]?.severity).toBe('error')
    expect(flagged[0]?.file).toBe('Broken.cs')
    expect(failed.lint.map((finding) => finding.rule)).not.toContain('CS0029')
  })

  it('sends analyzer rules to lint — except CA1502, which is metrics only', () => {
    const rules = parsed.lint.map((finding) => finding.rule)
    expect(rules).toContain('CA1822')
    expect(rules).not.toContain('CA1502')
    expect(rules.some((rule) => /^CS\d/.test(rule))).toBe(false)
    // CA1822 fires at the analyzer-default `note` level → info severity.
    expect(parsed.lint.find((finding) => finding.rule === 'CA1822')?.severity).toBe('info')
  })

  it('marks compiler findings repo-config and analyzer findings default-config', () => {
    for (const finding of parsed.types) expect(finding.provenance).toBe('repo-config')
    for (const finding of parsed.lint) expect(finding.provenance).toBe('default-config')
  })

  /**
   * The extraction rule the capture decided (spec's two open extractions):
   * the capture carries no `logicalLocations`, so the method identity AND the
   * cyclomatic number both come from the CA1502 message text. The exact
   * symbols and numbers the capture yields are pinned here — a later SDK that
   * rewords the message fails this test instead of silently counting zero.
   */
  it('reads method identity and cyclomatic number from the CA1502 message', () => {
    const log = JSON.parse(captured('netanalyzers-10.0.302.sarif.json')) as {
      runs: { results: { ruleId: string; message: { text: string } }[] }[]
    }
    const extracted = log.runs
      .flatMap((run) => run.results)
      .filter((result) => result.ruleId === 'CA1502')
      .map((result) => {
        const match = CA1502_MESSAGE.exec(result.message.text)
        return { symbol: match?.groups?.['symbol'], complexity: Number(match?.groups?.['number']) }
      })
    expect(new Set(extracted.map((entry) => entry.symbol))).toEqual(
      new Set(['Classify', 'Triple', 'Twice']),
    )
    expect(extracted.find((entry) => entry.symbol === 'Classify')?.complexity).toBe(17)
  })

  it('counts every method once and the planted >15 method over the ceiling', () => {
    expect(parsed.complexity).toEqual({
      functionsTotal: 3,
      functionsOverCeiling: 1,
      ca1502Count: 3,
    })
  })
})

describe('multi-TFM dedupe', () => {
  /**
   * The capture is a `net8.0;net10.0` build: every diagnostic appears once
   * per TFM (two runs in the merged log), and exactly one copy may survive.
   */
  it('collapses the per-TFM copies the capture really holds', () => {
    const raw = captured('netanalyzers-10.0.302.sarif.json')
    expect(raw.match(/"ruleId":\s*"CS0219"/g)?.length).toBeGreaterThanOrEqual(2)

    const parsed = parseBuildSarif(raw, CAPTURE_ROOT)
    expect(parsed.types.filter((finding) => finding.rule === 'CS0219')).toHaveLength(1)
    // Two CA1822 sites (Classify, Triple) — not four.
    expect(parsed.lint.filter((finding) => finding.rule === 'CA1822')).toHaveLength(2)
  })

  it('keeps genuinely distinct diagnostics apart', () => {
    const parsed = parseBuildSarif(
      sarif([planted('CS0219', 3), planted('CS0219', 3), planted('CS0219', 9)]),
      '/repo',
    )
    expect(parsed.types).toHaveLength(2)
  })
})

/** A minimal SARIF result entry at a chosen line, for dedupe cases. */
function planted(ruleId: string, line: number): unknown {
  return {
    ruleId,
    level: 'warning',
    message: { text: 'planted' },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: 'file:///repo/A.cs' },
          region: { startLine: line, startColumn: 1, endLine: line, endColumn: 2 },
        },
      },
    ],
  }
}

describe('hostile SARIF inputs', () => {
  it('throws on bytes that are not JSON', () => {
    expect(() => parseBuildSarif('MSBuild version 17.14', '/repo')).toThrow()
  })

  /** A 1.0 log is a silently different format, never zero findings. */
  it('throws on SARIF 1.0, naming the version it saw', () => {
    expect(() => parseBuildSarif('{"version":"1.0","runs":[]}', '/repo')).toThrow(/'1\.0'/)
  })

  it('throws when runs or results are missing', () => {
    expect(() => parseBuildSarif('{"version":"2.1.0"}', '/repo')).toThrow(/runs/)
    expect(() => parseBuildSarif('{"version":"2.1.0","runs":[{}]}', '/repo')).toThrow(/results/)
  })

  /** A CA1502 record we cannot read is a throw, never a silent zero. */
  it('throws on a CA1502 record whose message hides the number', () => {
    const record = {
      ruleId: 'CA1502',
      level: 'warning',
      message: { text: 'something else entirely' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/A.cs' } } }],
    }
    expect(() => parseBuildSarif(sarif([record]), '/repo')).toThrow(/CA1502/)
  })
})

describe('isUnresolvedPin', () => {
  /** The `dotnet build` surface: restore fails loudly with NU1102. */
  it('recognizes the captured NU1102 build transcript', () => {
    expect(isUnresolvedPin(captured('netanalyzers-nu1102-10.0.203.build.txt'))).toBe(true)
  })

  /**
   * `dnx`'s pin failure is a different tool with different wording (no NuGet
   * error code) and a different consumer — one regex spanning both would let
   * a roslynator failure read as an analyzer-pin failure.
   */
  it('does not match dnx’s differently-worded pin failure', () => {
    expect(isUnresolvedPin(captured('dnx-unresolved-pin-10.0.203.stderr.txt'))).toBe(false)
  })

  /** Offline is not "the pin is gone" — NU1301 stays a quiet not-available. */
  it('does not match an unreachable-feed failure', () => {
    expect(
      isUnresolvedPin(
        'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.',
      ),
    ).toBe(false)
  })
})

describe('mergeSarifLogs', () => {
  it('folds per-TFM documents into one log, keeping every run', () => {
    const merged: unknown = JSON.parse(mergeSarifLogs([sarif([{ ruleId: 'CS0219' }]), sarif([])]))
    expect(merged).toEqual({
      version: '2.1.0',
      runs: [{ results: [{ ruleId: 'CS0219' }] }, { results: [] }],
    })
  })

  it('refuses a document that is not SARIF 2.1', () => {
    expect(() => mergeSarifLogs(['not json'])).toThrow()
    expect(() => mergeSarifLogs([sarif([]), '{"version":"1.0.0","runs":[]}'])).toThrow(/1\.0\.0/)
    expect(() => mergeSarifLogs(['{"version":"2.1.0"}'])).toThrow(/runs/)
  })

  it('refuses to merge nothing — a build with no SARIF is not an empty SARIF', () => {
    expect(() => mergeSarifLogs([])).toThrow()
  })
})

/** Where a test pretends the run staged the merged SARIF. */
const RAW_FILE = '/scratch/raw/dotnet-build.sarif.json'

/** The five {@link CsBuild} outcomes the runtime can hand a mapper. */
const okBuild: CsBuild = {
  state: 'ok',
  sarif: captured('netanalyzers-10.0.302.sarif.json'),
  rawFile: RAW_FILE,
}
const failedBuild: CsBuild = {
  state: 'compile-failed',
  sarif: captured('netanalyzers-10.0.302.compile-failed.sarif.json'),
  rawFile: RAW_FILE,
}
const quietlyUnavailable: CsBuild = {
  state: 'unavailable',
  reason: 'dotnet is not on PATH — install the .NET SDK (https://dotnet.microsoft.com/download)',
}
const loudlyUnavailable: CsBuild = {
  state: 'unavailable',
  reason: UNRESOLVED_PIN_REASON,
  loud: true,
}

/** The captured `ok` SARIF with every CA1502 record stripped (criterion 17). */
function withoutCa1502(): CsBuild {
  const document = JSON.parse(captured('netanalyzers-10.0.302.sarif.json')) as {
    runs: { results: { ruleId: string }[] }[]
  }
  for (const run of document.runs) {
    run.results = run.results.filter((result) => result.ruleId !== 'CA1502')
  }
  return { state: 'ok', sarif: JSON.stringify(document), rawFile: RAW_FILE }
}

describe('the three mappers over one ok build', () => {
  it('grades types from the compiler diagnostics', async () => {
    const result = await typesResultFor(okBuild, CAPTURE_ROOT)
    expect(result.state).toBe('ok')
    expect(result.findings.map((finding) => finding.rule)).toEqual(['CS0219'])
    expect(result.rawFiles).toEqual([RAW_FILE])
  })

  it('grades lint from the analyzer diagnostics', async () => {
    const result = await lintResultFor(okBuild, CAPTURE_ROOT)
    expect(result.state).toBe('ok')
    expect(result.findings.map((finding) => finding.rule)).toEqual(['CA1822', 'CA1822'])
    expect(result.rawFiles).toEqual([RAW_FILE])
  })

  it('reports the complexity census as metrics, never as findings', () => {
    const result = complexityResultFor(okBuild, true)
    expect(result.state).toBe('ok')
    expect(result.findings).toEqual([])
    expect(result.metrics).toEqual({ functionsTotal: 3, functionsOverCeiling: 1 })
  })
})

describe('the three mappers over one compile-failed build', () => {
  it('still grades types, from the diagnostics the failed build produced', async () => {
    const result = await typesResultFor(failedBuild, BROKEN_ROOT)
    expect(result.state).toBe('ok')
    expect(result.reason).toMatch(/build failed/)
    expect(result.findings.map((finding) => finding.rule)).toEqual(['CS0029', 'CS0219'])
    expect(result.findings[0]?.severity).toBe('error')
  })

  /**
   * Amendment 3: csc emits location-less diagnostics (CS5001) which the
   * flattener drops — zero findings with a failed build must be an `error`
   * that names the failure, never an `ok` that grades a flattering A.
   */
  it('reports error, never a clean A, when the only diagnostics carry no location', async () => {
    const locationless: CsBuild = {
      state: 'compile-failed',
      sarif: sarif([
        {
          ruleId: 'CS5001',
          level: 'error',
          message: { text: 'Program does not contain a static Main method' },
        },
      ]),
      rawFile: RAW_FILE,
    }
    const result = await typesResultFor(locationless, '/repo')
    expect(result.state).toBe('error')
    expect(result.findings).toEqual([])
    expect(result.reason).toMatch(/build failed/)
  })

  /** A partial multi-csproj build grades nothing: an unknown fraction flatters. */
  it('declines to grade lint and complexity on a partial build', async () => {
    const lint = await lintResultFor(failedBuild, BROKEN_ROOT)
    expect(lint.state).toBe('not-available')
    expect(lint.reason).toBe(BUILD_FAILED_REASON)
    expect(lint.findings).toEqual([])

    const complexity = complexityResultFor(failedBuild, true)
    expect(complexity.state).toBe('not-available')
    expect(complexity.reason).toBe(BUILD_FAILED_REASON)
    expect(complexity.metrics).toBeUndefined()
  })
})

describe('the three mappers over an unavailable build', () => {
  it('returns the identical reason from all three, as not-available', async () => {
    const types = await typesResultFor(quietlyUnavailable, '/repo')
    const lint = await lintResultFor(quietlyUnavailable, '/repo')
    const complexity = complexityResultFor(quietlyUnavailable, true)
    for (const result of [types, lint, complexity]) {
      expect(result.state).toBe('not-available')
      expect(result.reason).toBe(quietlyUnavailable.reason)
      expect(result.findings).toEqual([])
      expect(result.rawFiles).toEqual([])
    }
  })

  /**
   * Criterion 16: the captured NU1102 transcript is the loud branch — an
   * unresolved analyzer pin surfaces as tool `error` quoting the pin, never a
   * silent fallback to the SDK's bundled analyzers.
   */
  it('turns the captured unresolved-pin transcript into a loud error naming the pin', async () => {
    expect(isUnresolvedPin(captured('netanalyzers-nu1102-10.0.203.build.txt'))).toBe(true)

    const result = await lintResultFor(loudlyUnavailable, '/repo')
    expect(result.state).toBe('error')
    expect(result.reason).toContain('microsoft.codeanalysis.netanalyzers@10.0.302')
    expect(result.reason).toMatch(/did not resolve/)

    expect((await typesResultFor(loudlyUnavailable, '/repo')).state).toBe('error')
    expect(complexityResultFor(loudlyUnavailable, true).state).toBe('error')
  })
})

describe('CA1502 suppression inference (criterion 17)', () => {
  it('reads zero CA1502 records over real C# files as repo suppression', () => {
    const result = complexityResultFor(withoutCa1502(), true)
    expect(result.state).toBe('not-available')
    expect(result.reason).toBe(CA1502_SUPPRESSED_REASON)
  })

  it('claims no suppression when there are no C# files to census', () => {
    const result = complexityResultFor(withoutCa1502(), false)
    expect(result.state).toBe('ok')
    expect(result.metrics).toEqual({ functionsTotal: 0, functionsOverCeiling: 0 })
  })

  it('still grades types and lint from the same CA1502-less build', async () => {
    expect((await typesResultFor(withoutCa1502(), CAPTURE_ROOT)).state).toBe('ok')
    expect((await lintResultFor(withoutCa1502(), CAPTURE_ROOT)).state).toBe('ok')
  })
})

/** A deep-profile context whose scan-root scratch is `root`. */
function contextUnder(root: string): RunContext {
  return {
    repoRoot: '/repo',
    project: makeProject(['App.cs']),
    files: ['App.cs'],
    scratch: join(root, 'root'),
    runScratch: root,
    detection: null,
    timeoutMs: 30_000,
    deep: true,
  }
}

describe('the build memo, against a farm with no dotnet', () => {
  let farm: Awaited<ReturnType<typeof pathFarm>>
  let originalPath: string
  let runScratch: string

  beforeAll(async () => {
    farm = await pathFarm()
    originalPath = process.env['PATH'] ?? ''
    process.env['PATH'] = farm.path
    runScratch = await mkdtemp(join(tmpdir(), 'crank-build-memo-'))
  })

  afterAll(async () => {
    process.env['PATH'] = originalPath
    forgetBuilds(runScratch)
    await farm.remove()
    await rm(runScratch, { recursive: true, force: true })
  })

  it('caches the promise — three concurrent runners share one build', async () => {
    const first = buildFor(contextUnder(runScratch))
    const second = buildFor(contextUnder(runScratch))
    expect(second).toBe(first)
    expect((await first).state).toBe('unavailable')
  })

  it('yields a fresh result, not a cached one, after forgetBuilds', async () => {
    const before = buildFor(contextUnder(runScratch))
    forgetBuilds(runScratch)
    const after = buildFor(contextUnder(runScratch))
    expect(after).not.toBe(before)
    const build = await after
    expect(build.state).toBe('unavailable')
    if (build.state === 'unavailable') expect(build.reason).toContain('dotnet is not on PATH')
  })

  /** run-pr's finally holds the parent of both sides' scratch dirs. */
  it('forgets by path prefix, the way run-pr tears down', async () => {
    const nested = join(runScratch, 'head-scratch')
    const before = buildFor(contextUnder(nested))
    await before
    forgetBuilds(runScratch)
    expect(buildFor(contextUnder(nested))).not.toBe(before)
    forgetBuilds(runScratch)
  })
})

describe('the three build-backed runners', () => {
  it('declare one deep-only dotnet-build runner per compiled category', () => {
    expect(dotnetBuildTypesRunner.category).toBe('types')
    expect(dotnetBuildComplexityRunner.category).toBe('complexity')
    expect(dotnetBuildLintRunner.category).toBe('lint')
    for (const runner of [
      dotnetBuildTypesRunner,
      dotnetBuildComplexityRunner,
      dotnetBuildLintRunner,
    ]) {
      expect(runner.tool).toBe(DOTNET_BUILD_TOOL)
      expect(runner.deepOnly).toBe(true)
      expect(runner.pinnedVersion).toBe('10.0.302')
    }
  })

  /** Detection never spawns; the build is never repo-owned. */
  it('detect answers null without running anything', async () => {
    expect(
      await dotnetBuildTypesRunner.detect({
        repoRoot: '/repo',
        project: makeProject(['App.cs']),
        files: makeProject(['App.cs']).files,
      }),
    ).toBe(null)
  })
})
