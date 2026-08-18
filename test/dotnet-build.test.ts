import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILD_FAILED_REASON,
  CA1502_SUPPRESSED_REASON,
  UNRESOLVED_PIN_REASON,
  complexityResultFor,
  isUnresolvedPin,
  lintResultFor,
  mergeSarifLogs,
  parseBuildSarif,
  typesResultFor,
} from '../src/adapters/csharp/build.ts'
import type { CsBuild } from '../src/adapters/csharp/build.ts'

/**
 * The pure half of the `dotnet build` host, proven over captured real bytes:
 * a multi-targeting (`net8.0;net10.0`) scratch project compiled by SDK
 * 10.0.203 with the injected netanalyzers 10.0.400 assets. The capture's
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
  const parsed = parseBuildSarif(captured('netanalyzers-10.0.400.sarif.json'), CAPTURE_ROOT)

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
      captured('netanalyzers-10.0.400.compile-failed.sarif.json'),
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
    const raw = captured('netanalyzers-10.0.400.sarif.json')
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
  sarif: captured('netanalyzers-10.0.400.sarif.json'),
  rawFile: RAW_FILE,
}
const failedBuild: CsBuild = {
  state: 'compile-failed',
  sarif: captured('netanalyzers-10.0.400.compile-failed.sarif.json'),
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
  const document = JSON.parse(captured('netanalyzers-10.0.400.sarif.json')) as {
    runs: { results: { ruleId: string }[] }[]
  }
  for (const run of document.runs) {
    run.results = run.results.filter((result) => result.ruleId !== 'CA1502')
  }
  return { state: 'ok', sarif: JSON.stringify(document), rawFile: RAW_FILE }
}

describe('the three mappers over one ok build', () => {
  it('grades types from the compiler diagnostics, and lint from the analyzer ones', async () => {
    const types = await typesResultFor(okBuild, CAPTURE_ROOT)
    expect(types.state).toBe('ok')
    expect(types.findings.map((finding) => finding.rule)).toEqual(['CS0219'])
    expect(types.rawFiles).toEqual([RAW_FILE])

    const lint = await lintResultFor(okBuild, CAPTURE_ROOT)
    expect(lint.state).toBe('ok')
    expect(lint.findings.map((finding) => finding.rule)).toEqual(['CA1822', 'CA1822'])
    expect(lint.rawFiles).toEqual([RAW_FILE])
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
    expect(result.reason).toContain('microsoft.codeanalysis.netanalyzers@10.0.400')
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
})
