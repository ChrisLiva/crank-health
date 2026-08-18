import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseRoslynatorSymbols,
  roslynatorFailure,
  roslynatorRunner,
  symbolFindings,
} from '../src/adapters/csharp/roslynator.ts'
import { makeProject } from './factories.ts'
import type { RunContext } from '../src/core/types.ts'

/**
 * Roslynator's `find-symbol --unused` output is plain text with no locations at
 * any verbosity (verified against the 0.12.0 CLI and its `FindSymbolCommand`
 * source), so the contract has two halves: the symbol-line parse over captured
 * bytes, and the declaration search that places each symbol — sound because an
 * unreferenced symbol's only occurrence in the analyzed sources *is* its
 * declaration.
 *
 * The capture is real output against a scratch project with a planted
 * unreferenced public method and an unused private field.
 */
const CAPTURED = fileURLToPath(new URL('./captured/roslynator-0.12.0.txt', import.meta.url))

describe('parseRoslynatorSymbols', () => {
  it('reads kind, display, name and containing type from real output', async () => {
    expect(parseRoslynatorSymbols(await readFile(CAPTURED, 'utf8'))).toEqual([
      {
        kind: 'method',
        display: 'Cap.Dead.NeverCalled(int value)',
        name: 'NeverCalled',
        container: 'Dead',
      },
      {
        kind: 'field',
        display: 'Cap.Holder.unusedCount',
        name: 'unusedCount',
        container: 'Holder',
      },
    ])
  })

  it('skips the loader, counter and summary lines around the symbols', () => {
    const stdout = [
      "Loading project '/repo/App.csproj'...",
      "Analyze 'App'",
      '',
      '1 field symbols',
      '2 symbols found',
      'not a symbol line at all',
      '',
    ].join('\n')
    expect(parseRoslynatorSymbols(stdout)).toEqual([])
  })

  it('reads a type symbol, whose container is its namespace', () => {
    expect(parseRoslynatorSymbols('class Cap.Dead\n')).toEqual([
      { kind: 'class', display: 'Cap.Dead', name: 'Dead', container: 'Cap' },
    ])
  })

  it('strips generic arguments when deriving the symbol name', () => {
    expect(parseRoslynatorSymbols('method Cap.Dead.Convert<T>(T value)\n')).toEqual([
      {
        kind: 'method',
        display: 'Cap.Dead.Convert<T>(T value)',
        name: 'Convert',
        container: 'Dead',
      },
    ])
  })
})

describe('symbolFindings', () => {
  /** The capture's two symbols, placed in sources shaped like its project. */
  const sources = new Map([
    [
      'Dead.cs',
      [
        'namespace Cap;',
        '',
        'public static class Dead',
        '{',
        '    public static int NeverCalled(int value)',
        '    {',
        '        return value + 1;',
        '    }',
        '}',
        '',
      ].join('\n'),
    ],
    [
      'Holder.cs',
      [
        'namespace Cap;',
        '',
        'public sealed class Holder',
        '{',
        '    private readonly int unusedCount = 7;',
        '}',
        '',
      ].join('\n'),
    ],
  ])

  const symbols = [
    {
      kind: 'method',
      display: 'Cap.Dead.NeverCalled(int value)',
      name: 'NeverCalled',
      container: 'Dead',
    },
    { kind: 'field', display: 'Cap.Holder.unusedCount', name: 'unusedCount', container: 'Holder' },
  ]

  it('places each symbol at its declaration, hand-checked file and line', () => {
    const findings = symbolFindings(symbols, sources)
    expect(
      findings.map((finding) => [finding.file, finding.range.startLine, finding.rule]),
    ).toEqual([
      ['Dead.cs', 5, 'unused-method'],
      ['Holder.cs', 5, 'unused-field'],
    ])
  })

  it('builds graded dead-code warnings anchored on the symbol name', () => {
    const findings = symbolFindings(symbols, sources)
    for (const finding of findings) {
      expect(finding.category).toBe('dead-code')
      expect(finding.tool).toBe('roslynator')
      expect(finding.severity).toBe('warning')
      expect(finding.gradeScope).toBe(true)
      expect(finding.provenance).toBe('default-config')
    }
    // The anchor is finding identity (fingerprint.ts), so it is the symbol's
    // own name and not the display string the message quotes.
    expect(findings.map((finding) => finding.anchor)).toEqual(['NeverCalled', 'unusedCount'])
  })

  /** Same member name in two files: the declaring type decides. */
  it('prefers the file that declares the containing type', () => {
    const ambiguous = new Map([
      ['a.cs', 'namespace Cap;\n\npublic class Other\n{\n    private int unusedCount;\n}\n'],
      ['b.cs', 'namespace Cap;\n\npublic class Holder\n{\n    private int unusedCount;\n}\n'],
    ])
    const findings = symbolFindings(
      [
        {
          kind: 'field',
          display: 'Cap.Holder.unusedCount',
          name: 'unusedCount',
          container: 'Holder',
        },
      ],
      ambiguous,
    )
    expect(findings.map((finding) => finding.file)).toEqual(['b.cs'])
  })

  it('drops a symbol whose declaration is in no analyzed source', () => {
    expect(
      symbolFindings(
        [{ kind: 'method', display: 'Gen.Ghost.Emit()', name: 'Emit', container: 'Ghost' }],
        sources,
      ),
    ).toEqual([])
  })
})

describe('roslynatorFailure', () => {
  /**
   * Criterion 16's standard for the analyzer pin, applied to the tool pin: dnx
   * reports an unresolvable pin with this exact wording (captured on SDK
   * 10.0.203), it is deliberately not an offline marker, and it must be a loud
   * error quoting our pin — never empty stdout read as zero dead code.
   */
  it('reports an unresolvable pin as an error quoting roslynator.dotnet.cli@0.12.0', async () => {
    const stderr = await readFile(
      fileURLToPath(new URL('./captured/dnx-unresolved-pin-10.0.203.stderr.txt', import.meta.url)),
      'utf8',
    )
    const failure = roslynatorFailure({ stdout: '', stderr, exitCode: 1 })
    expect(failure?.state).toBe('error')
    expect(failure?.reason).toContain('roslynator.dotnet.cli@0.12.0')
    expect(failure?.reason).toContain('is not found in NuGet feeds')
  })

  it('reports any other non-zero exit as an error quoting the exit code and stderr', () => {
    const failure = roslynatorFailure({
      stdout: '',
      stderr: 'System.AggregateException: One or more errors occurred.\n   at Roslynator…',
      exitCode: 2,
    })
    expect(failure?.state).toBe('error')
    expect(failure?.reason).toContain('exit 2')
    expect(failure?.reason).toContain('System.AggregateException: One or more errors occurred.')
  })

  it('passes an execution-level failure through unchanged', () => {
    const failure = roslynatorFailure({
      stdout: '',
      stderr: '',
      exitCode: undefined,
      failure: { state: 'timeout', reason: 'dnx exceeded its time budget' },
    })
    expect(failure).toEqual({ state: 'timeout', reason: 'dnx exceeded its time budget' })
  })

  it('accepts a clean exit', () => {
    expect(roslynatorFailure({ stdout: '2 symbols found\n', stderr: '', exitCode: 0 })).toBe(
      undefined,
    )
  })
})

describe('the roslynator runner', () => {
  it('answers a project with no C# files without running anything', async () => {
    const result = await roslynatorRunner.run(contextFor([]))
    expect(result).toEqual({ state: 'ok', findings: [], rawFiles: [], reason: 'no C# files' })
  })

  /** A stray .cs file in a project with no .csproj: nothing roslynator can load. */
  it('degrades honestly when the project has no .csproj to analyze', async () => {
    const result = await roslynatorRunner.run(contextFor(['src/a.cs']))
    expect(result.state).toBe('not-available')
    expect(result.reason).toContain('.csproj')
  })
})

function contextFor(files: readonly string[]): RunContext {
  return {
    repoRoot: '/repo',
    project: makeProject(files),
    files,
    scratch: '/scratch',
    runScratch: '/scratch',
    detection: null,
    timeoutMs: 1_000,
    deep: true,
  }
}
