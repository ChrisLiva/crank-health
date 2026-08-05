import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PYRIGHT_GENERAL_RULE,
  parsePyrightJson,
  pyrightRunner,
  toPendingFindings as toPyrightFindings,
} from '../src/adapters/python/pyright.ts'
import {
  parseGitlab,
  toPendingFindings as toTyFindings,
  tyRunner,
} from '../src/adapters/python/ty.ts'

/**
 * The Python type-checking pair. Which of them runs is a detection-time
 * decision (see `py-project.test.ts` for the venv rule and `py-scan.test.ts`
 * for it happening end to end); this file is about reading what they print.
 *
 * Captures are real output against `test/fixtures/py-basic` (ty) and
 * `test/fixtures/py-venv` (pyright), with the repo root rewritten to `/repo`.
 */
const TY = fileURLToPath(new URL('./captured/ty-0.0.66.gitlab.json', import.meta.url))
const PYRIGHT = fileURLToPath(new URL('./captured/pyright-1.1.411.json', import.meta.url))

describe('parseGitlab', () => {
  it('reads rule, severity, range and message from real ty output', async () => {
    expect(parseGitlab(await readFile(TY, 'utf8'))).toEqual([
      {
        rule: 'unresolved-reference',
        severity: 'major',
        file: 'undefined_name.py',
        startLine: 2,
        startCol: 23,
        endLine: 2,
        endCol: 35,
        // The rule name prefix that GitLab's format requires is stripped back off.
        message: 'Name `missing_name` used when not defined',
      },
    ])
  })

  it('treats no output as no diagnostics', () => {
    expect(parseGitlab('')).toEqual([])
  })

  it('rejects output that is not an array of code-quality entries', () => {
    expect(() => parseGitlab('{"oops":true}')).toThrow('not an array')
    expect(() => parseGitlab('nonsense')).toThrow()
  })
})

describe('ty toPendingFindings', () => {
  const diagnostics = [
    {
      rule: 'unresolved-reference',
      severity: 'major',
      file: 'a.py',
      startLine: 2,
      startCol: 1,
      endLine: 2,
      endCol: 3,
      message: 'Name `x` used when not defined',
    },
    {
      rule: 'unresolved-import',
      severity: 'major',
      file: 'a.py',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 3,
      message: 'Cannot resolve imported module `requests`',
    },
    {
      rule: 'possibly-unbound',
      severity: 'minor',
      file: 'b.py',
      startLine: 4,
      startCol: 1,
      endLine: 4,
      endCol: 3,
      message: 'Name may be unbound',
    },
  ]

  it('maps GitLab severities onto the vocabulary without minting a critical', () => {
    expect(toTyFindings(diagnostics, false, '/repo').map((finding) => finding.severity)).toEqual([
      'error',
      'error',
      'warning',
    ])
  })

  /**
   * Without a virtualenv there is nothing to resolve third-party imports
   * against, so on our config that diagnostic describes the environment, not
   * the code.
   */
  it('keeps unresolved imports advisory on our config and grades them on theirs', () => {
    const byRule = (repoConfig: boolean) =>
      new Map(
        toTyFindings(diagnostics, repoConfig, '/repo').map((finding) => [
          finding.rule,
          finding.gradeScope,
        ]),
      )
    expect(byRule(false).get('unresolved-import')).toBe(false)
    expect(byRule(false).get('unresolved-reference')).toBe(true)
    expect(byRule(true).get('unresolved-import')).toBe(true)
  })

  it('reports the types category with the tool that made the call', () => {
    const findings = toTyFindings(diagnostics, false, '/repo')
    expect(findings.every((finding) => finding.category === 'types')).toBe(true)
    expect(findings.every((finding) => finding.tool === 'ty')).toBe(true)
  })
})

describe('parsePyrightJson', () => {
  it('reads version, rule, severity and a 1-based range from real output', async () => {
    const report = parsePyrightJson(await readFile(PYRIGHT, 'utf8'))
    expect(report.version).toBe('1.1.411')
    expect(report.diagnostics).toMatchObject([
      {
        rule: 'reportReturnType',
        severity: 'error',
        file: '/repo/app.py',
        // pyright counts lines and characters from 0; the schema counts from 1.
        startLine: 6,
        startCol: 12,
        endLine: 6,
        endCol: 17,
      },
    ])
    // pyright indents the explanation under the headline with non-breaking
    // spaces; the schema's `message` is the headline and the rest stays raw.
    expect(report.diagnostics[0]?.message.split('\n')).toHaveLength(2)
    expect(report.diagnostics[0]?.message.split('\n')[0]).toBe(
      'Type "int" is not assignable to return type "str"',
    )
  })

  it('falls back to a rule id for a diagnostic that carries none', () => {
    const document = JSON.stringify({
      version: '1.1.411',
      generalDiagnostics: [
        {
          file: '/repo/a.py',
          severity: 'error',
          message: 'Expected expression',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    })
    expect(parsePyrightJson(document).diagnostics[0]?.rule).toBe(PYRIGHT_GENERAL_RULE)
  })

  it('rejects output that is not a pyright report', () => {
    expect(() => parsePyrightJson('{"oops":true}')).toThrow('generalDiagnostics')
    expect(() => parsePyrightJson('nonsense')).toThrow()
  })
})

describe('pyright toPendingFindings', () => {
  const diagnostics = [
    {
      rule: 'reportReturnType',
      severity: 'error',
      file: '/repo/app.py',
      startLine: 6,
      startCol: 12,
      endLine: 6,
      endCol: 17,
      message: 'Type "int" is not assignable to return type "str"\n  "int" is not assignable',
    },
    {
      rule: 'reportMissingImports',
      severity: 'error',
      file: '/repo/app.py',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 9,
      message: 'Import "requests" could not be resolved',
    },
    {
      rule: 'reportUnusedExpression',
      severity: 'warning',
      file: '/repo/b.py',
      startLine: 3,
      startCol: 1,
      endLine: 3,
      endCol: 5,
      message: 'Expression value is unused',
    },
  ]

  it('keeps the message to one line and relativizes the path', () => {
    expect(toPyrightFindings(diagnostics, false, '/repo')[1]).toMatchObject({
      file: 'app.py',
      message: 'Type "int" is not assignable to return type "str"',
    })
  })

  it('keeps environment diagnostics advisory on our config, graded on theirs', () => {
    const byRule = (repoConfig: boolean) =>
      new Map(
        toPyrightFindings(diagnostics, repoConfig, '/repo').map((finding) => [
          finding.rule,
          finding.gradeScope,
        ]),
      )
    expect(byRule(false).get('reportMissingImports')).toBe(false)
    expect(byRule(false).get('reportReturnType')).toBe(true)
    expect(byRule(true).get('reportMissingImports')).toBe(true)
  })

  it('maps pyright severities onto the vocabulary', () => {
    const bySeverity = new Map(
      toPyrightFindings(diagnostics, false, '/repo').map((finding) => [
        finding.rule,
        finding.severity,
      ]),
    )
    expect(bySeverity.get('reportReturnType')).toBe('error')
    expect(bySeverity.get('reportUnusedExpression')).toBe('warning')
  })
})

describe('the type-checking runners', () => {
  it('both claim the types category, and neither is imposed only when owned', () => {
    expect(tyRunner.category).toBe('types')
    expect(pyrightRunner.category).toBe('types')
    expect(tyRunner.repoOwnedOnly).toBeUndefined()
    expect(pyrightRunner.repoOwnedOnly).toBeUndefined()
  })
})
