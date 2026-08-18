import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBiomeReport, toPendingFindings } from '../src/adapters/jsts/biome.ts'

/** Captured raw stdout from the pinned Biome, run against `test/fixtures/js-multi-tool`. */
const LINT = fileURLToPath(new URL('./captured/biome-lint-2.5.9.txt', import.meta.url))
const FORMAT = fileURLToPath(new URL('./captured/biome-format-2.5.9.txt', import.meta.url))

describe('parseBiomeReport', () => {
  it('reads category, severity, message and range from real lint output', async () => {
    expect(parseBiomeReport(await readFile(LINT, 'utf8'))).toEqual([
      {
        severity: 'error',
        category: 'lint/suspicious/noDoubleEquals',
        message: 'Using == may be unsafe if you are relying on type coercion.',
        file: 'src/both.js',
        startLine: 2,
        startCol: 12,
        endLine: 2,
        endCol: 14,
      },
    ])
  })

  it('reads a formatting failure, which Biome reports at line 0 for the whole file', async () => {
    const diagnostics = parseBiomeReport(await readFile(FORMAT, 'utf8'))
    expect(diagnostics).toEqual([
      {
        severity: 'error',
        category: 'format',
        message: 'Formatter would have printed the following content:',
        file: 'src/unformatted.js',
        // Clamped: the schema is 1-based everywhere a reader looks.
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
      },
    ])
  })

  it('finds the report even though Biome wraps it in decorated output', () => {
    const noisy = [
      'The `json` reporter is experimental and may change in patch releases.',
      '{"summary":{},"diagnostics":[],"command":"lint"}',
      'lint ━━━━━━━━━━━━━━━━━',
      '  × Some errors were emitted while running checks.',
    ].join('\n')
    expect(parseBiomeReport(noisy)).toEqual([])
  })

  it('rejects output with no Biome report in it at all', () => {
    expect(() => parseBiomeReport('lint ━━━\n  × boom\n')).toThrow('no biome JSON report')
    expect(() => parseBiomeReport('{"summary":{}}')).toThrow('no biome JSON report')
  })

  it('drops a diagnostic with no location rather than inventing one', () => {
    const document = JSON.stringify({
      diagnostics: [{ severity: 'error', category: 'internalError/io', message: 'x' }],
    })
    expect(parseBiomeReport(document)).toEqual([])
  })
})

describe('toPendingFindings', () => {
  const lint = [
    diagnostic({ severity: 'error', category: 'lint/suspicious/noDoubleEquals' }),
    diagnostic({ severity: 'warning', category: 'lint/correctness/noUnusedVariables' }),
    diagnostic({ severity: 'information', category: 'lint/style/useConst' }),
  ]

  it('maps Biome severities onto the severity vocabulary', () => {
    const severities = new Map(
      toPendingFindings(lint, 'lint').map((finding) => [finding.rule, finding.severity]),
    )
    expect(severities.get('lint/suspicious/noDoubleEquals')).toBe('error')
    expect(severities.get('lint/correctness/noUnusedVariables')).toBe('warning')
    expect(severities.get('lint/style/useConst')).toBe('info')
  })

  it('tags every lint finding repo-config and grades it', () => {
    const findings = toPendingFindings(lint, 'lint')
    expect(findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings.every((finding) => finding.category === 'lint')).toBe(true)
  })

  it('reduces a file’s formatting diagnostics to one graded, file-level finding', () => {
    const findings = toPendingFindings(
      [
        diagnostic({ category: 'format', file: 'src/a.js' }),
        diagnostic({ category: 'format', file: 'src/a.js' }),
        diagnostic({ category: 'format', file: 'src/b.js' }),
      ],
      'format',
    )
    expect(findings.map((finding) => finding.file)).toEqual(['src/a.js', 'src/b.js'])
    expect(findings.every((finding) => finding.rule === 'biome/format')).toBe(true)
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true)
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings.every((finding) => finding.category === 'format')).toBe(true)
    // File-level identity: not tied to whatever the first line happens to be.
    expect(findings.every((finding) => finding.anchor === '')).toBe(true)
  })

  it('reports a non-formatting diagnostic from a format run as advisory', () => {
    const findings = toPendingFindings(
      [diagnostic({ category: 'parse', severity: 'error' })],
      'format',
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: 'parse', severity: 'error', gradeScope: false })
  })
})

function diagnostic(overrides: { severity?: string; category: string; file?: string }) {
  return {
    severity: overrides.severity ?? 'error',
    category: overrides.category,
    message: `${overrides.category} fired`,
    file: overrides.file ?? 'src/a.js',
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 2,
  }
}
