import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  RUFF_FORMAT_RULE,
  RUFF_SYNTAX_CODE,
  parseRuffJson,
  ruffFormatRunner,
  ruffLintRunner,
  toFormatFindings,
  toLintFindings,
} from '../src/adapters/python/ruff.ts'

/**
 * Captured raw output from the pinned ruff, run against `test/fixtures/
 * py-basic`. Only the repo root was rewritten to `/repo`, so the recordings are
 * not tied to the machine that made them.
 */
const LINT = fileURLToPath(new URL('./captured/ruff-lint-0.16.1.json', import.meta.url))
const FORMAT = fileURLToPath(new URL('./captured/ruff-format-0.16.1.json', import.meta.url))

describe('parseRuffJson', () => {
  it('reads code, range, message and rule documentation from real check output', async () => {
    const diagnostics = parseRuffJson(await readFile(LINT, 'utf8'))
    expect(diagnostics).toEqual([
      {
        code: 'F401',
        file: '/repo/dead.py',
        startLine: 1,
        startCol: 8,
        endLine: 1,
        endCol: 10,
        message: '`os` imported but unused',
        url: 'https://docs.astral.sh/ruff/rules/unused-import',
      },
      {
        code: 'F821',
        file: '/repo/undefined_name.py',
        startLine: 2,
        startCol: 23,
        endLine: 2,
        endCol: 35,
        message: 'Undefined name `missing_name`',
        url: 'https://docs.astral.sh/ruff/rules/undefined-name',
      },
    ])
  })

  /** `ruff format --check --output-format json` is the same envelope. */
  it('reads the formatter’s verdict from real format output', async () => {
    const diagnostics = parseRuffJson(await readFile(FORMAT, 'utf8'))
    expect(diagnostics).toMatchObject([
      { code: 'unformatted', file: '/repo/unformatted.py', message: 'File would be reformatted' },
    ])
  })

  it('treats no output as no diagnostics — a clean repo prints nothing', () => {
    expect(parseRuffJson('')).toEqual([])
  })

  it('rejects output that is not ruff’s array of diagnostics', () => {
    expect(() => parseRuffJson('{"oops":true}')).toThrow('not an array')
    expect(() => parseRuffJson('nonsense')).toThrow()
  })
})

describe('toLintFindings', () => {
  const diagnostics = [
    {
      code: 'F821',
      file: '/repo/a.py',
      startLine: 2,
      startCol: 1,
      endLine: 2,
      endCol: 4,
      message: 'Undefined name',
    },
    {
      code: 'E402',
      file: '/repo/a.py',
      startLine: 9,
      startCol: 1,
      endLine: 9,
      endCol: 4,
      message: 'Import not at top',
    },
    {
      code: 'invalid-syntax',
      file: '/repo/b.py',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 2,
      message: 'Expected `)`',
    },
    {
      code: 'S105',
      file: '/repo/c.py',
      startLine: 3,
      startCol: 1,
      endLine: 3,
      endCol: 9,
      message: 'Possible hardcoded password',
    },
  ]

  /** Spec §1: on our config only the correctness classes count toward the grade. */
  it('grades pyflakes and syntax on our default config, and leaves style advisory', () => {
    expect(
      toLintFindings(diagnostics, false, '/repo').map((finding) => [
        finding.rule,
        finding.gradeScope,
      ]),
    ).toEqual([
      ['F821', true],
      ['E402', false],
      ['invalid-syntax', true],
      ['S105', false],
    ])
  })

  it('grades everything on the repo’s own config: they chose these rules', () => {
    expect(toLintFindings(diagnostics, true, '/repo').every((finding) => finding.gradeScope)).toBe(
      true,
    )
    expect(
      toLintFindings(diagnostics, true, '/repo').every(
        (finding) => finding.provenance === 'repo-config',
      ),
    ).toBe(true)
  })

  /** Spec "Categories and tools": Python security is "+ bandit, ruff `S`". */
  it('routes the S family to the security category, not to lint', () => {
    const byRule = new Map(
      toLintFindings(diagnostics, true, '/repo').map((finding) => [finding.rule, finding.category]),
    )
    expect(byRule.get('S105')).toBe('security')
    expect(byRule.get('F821')).toBe('lint')
  })

  it('maps unparseable source and undefined names to error, the rest to warning', () => {
    const bySeverity = new Map(
      toLintFindings(diagnostics, true, '/repo').map((finding) => [finding.rule, finding.severity]),
    )
    expect(bySeverity.get(RUFF_SYNTAX_CODE)).toBe('error')
    expect(bySeverity.get('F821')).toBe('error')
    expect(bySeverity.get('E402')).toBe('warning')
    expect(bySeverity.get('S105')).toBe('warning')
  })

  it('relativizes the absolute paths ruff reports', () => {
    expect(toLintFindings(diagnostics, false, '/repo')[0]?.file).toBe('a.py')
  })

  it('never reports the formatter’s verdict as a lint finding', () => {
    const formatting = [
      {
        code: 'unformatted',
        file: '/repo/a.py',
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
        message: 'File would be reformatted',
      },
    ]
    expect(toLintFindings(formatting, false, '/repo')).toEqual([])
  })
})

describe('toFormatFindings', () => {
  const diagnostics = [
    {
      code: 'unformatted',
      file: '/repo/a.py',
      startLine: 1,
      startCol: 11,
      endLine: 2,
      endCol: 3,
      message: 'File would be reformatted',
    },
    {
      code: 'unformatted',
      file: '/repo/a.py',
      startLine: 4,
      startCol: 1,
      endLine: 4,
      endCol: 3,
      message: 'File would be reformatted',
    },
    {
      code: 'invalid-syntax',
      file: '/repo/b.py',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 2,
      message: 'Expected `)`',
    },
  ]

  it('reports one finding per failing file, whatever the tool pointed at', () => {
    const findings = toFormatFindings(diagnostics, false, '/repo')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      category: 'format',
      rule: RUFF_FORMAT_RULE,
      file: 'a.py',
      severity: 'warning',
      // File-level identity: not tied to whichever line the formatter flagged.
      anchor: '',
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    })
  })

  /** A formatter has one verdict, so it is graded under either provenance. */
  it('grades the verdict on our config too, and says whose formatting it is', () => {
    expect(toFormatFindings(diagnostics, false, '/repo')[0]).toMatchObject({
      gradeScope: true,
      provenance: 'default-config',
      message: expect.stringContaining('ruff’s default formatting') as unknown as string,
    })
    expect(toFormatFindings(diagnostics, true, '/repo')[0]).toMatchObject({
      gradeScope: true,
      provenance: 'repo-config',
      message: expect.stringContaining('repo’s ruff format configuration') as unknown as string,
    })
  })

  it('leaves an unparseable file to the linter, which reports it as one', () => {
    expect(toFormatFindings(diagnostics, false, '/repo').map((finding) => finding.file)).toEqual([
      'a.py',
    ])
  })
})

describe('the ruff runners', () => {
  it('cover lint and format from one pinned binary, as defaults', () => {
    expect(ruffLintRunner.category).toBe('lint')
    expect(ruffFormatRunner.category).toBe('format')
    expect(ruffLintRunner.pinnedVersion).toBe(ruffFormatRunner.pinnedVersion)
    expect(ruffLintRunner.repoOwnedOnly).toBeUndefined()
    expect(ruffFormatRunner.repoOwnedOnly).toBeUndefined()
  })

  /** The bundled default is the correctness-leaning subset, not ruff's full set. */
  it('bundles a default config that selects only the historic default families', () => {
    expect(DEFAULT_CONFIG).toContain('select = ["E4", "E7", "E9", "F"]')
  })
})
