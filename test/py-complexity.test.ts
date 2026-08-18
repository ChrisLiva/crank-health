import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  COMPLEXIPY_RULE,
  parseComplexipyJson,
  parseComplexipySarif,
  toPendingFindings,
} from '../src/adapters/python/complexipy.ts'
import { COMPLEXITY_CEILING } from '../src/core/grade.ts'

/**
 * complexipy answers spec §3's complexity ratio in two files: the JSON report
 * is every function it measured (the denominator) and the SARIF report is the
 * ones over the ceiling (the findings, with the line numbers JSON omits).
 *
 * Both captures are real output against `test/fixtures/py-basic`, with the repo
 * root rewritten to `/repo`.
 */
const JSON_REPORT = fileURLToPath(new URL('./captured/complexipy-6.2.0.json', import.meta.url))
const SARIF_REPORT = fileURLToPath(
  new URL('./captured/complexipy-6.2.0.sarif.json', import.meta.url),
)

describe('parseComplexipyJson', () => {
  it('reads every measured function — the grade’s denominator', async () => {
    const functions = parseComplexipyJson(await readFile(JSON_REPORT, 'utf8'), '/repo')
    expect(functions).toHaveLength(7)
    expect(functions[1]).toEqual({ file: 'complex.py', name: 'classify', complexity: 38 })
    expect(functions.filter((entry) => entry.complexity > COMPLEXITY_CEILING)).toHaveLength(1)
  })

  it('rejects output that is not complexipy’s array of functions', () => {
    expect(() => parseComplexipyJson('{"oops":true}')).toThrow('not an array')
    expect(() => parseComplexipyJson('nonsense')).toThrow()
  })
})

describe('parseComplexipySarif', () => {
  it('reads the over-ceiling functions with the locations only SARIF carries', async () => {
    expect(parseComplexipySarif(await readFile(SARIF_REPORT, 'utf8'), '/repo')).toEqual([
      {
        file: 'complex.py',
        name: 'classify',
        startLine: 1,
        endLine: 28,
        message:
          "Function 'classify' has a cognitive complexity of 38, which exceeds the maximum allowed complexity of 15.",
      },
    ])
  })

  it('rejects output that is not a SARIF document', () => {
    expect(() => parseComplexipySarif('{"oops":true}')).toThrow('no SARIF run')
    expect(() => parseComplexipySarif('nonsense')).toThrow()
  })
})

describe('complexipy toPendingFindings', () => {
  const violations = [
    {
      file: 'complex.py',
      name: 'classify',
      startLine: 1,
      endLine: 28,
      message: "Function 'classify' has a cognitive complexity of 38…",
    },
  ]

  it('marks every over-ceiling function, anchored on the function name', () => {
    expect(toPendingFindings(violations, false)[0]).toMatchObject({
      category: 'complexity',
      tool: 'complexipy',
      rule: COMPLEXIPY_RULE,
      severity: 'warning',
      file: 'complex.py',
      range: { startLine: 1, startCol: 1, endLine: 28, endCol: 1 },
      gradeScope: true,
      anchor: 'classify',
      provenance: 'default-config',
    })
    // The repo's own complexipy config is what the other provenance is for.
    expect(toPendingFindings(violations, true)[0]?.provenance).toBe('repo-config')
  })
})
