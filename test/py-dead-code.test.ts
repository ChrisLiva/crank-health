import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GRADED_CONFIDENCE,
  MIN_CONFIDENCE,
  parseVulture,
  toPendingFindings,
} from '../src/adapters/python/vulture.ts'

/**
 * vulture's confidence tiers are the whole design here (spec §3: "≥90% graded,
 * 60% advisory"), and its output is plain text, so the regex is the contract.
 *
 * The capture is real output against `test/fixtures/py-basic`.
 */
const CAPTURED = fileURLToPath(new URL('./captured/vulture-2.16.txt', import.meta.url))

describe('parseVulture', () => {
  it('reads path, line, kind, symbol and confidence from real output', async () => {
    expect(parseVulture(await readFile(CAPTURED, 'utf8'))).toEqual([
      { file: 'dead.py', line: 1, kind: 'unused import', symbol: 'os', confidence: 90 },
      {
        file: 'dead.py',
        line: 8,
        kind: 'unused function',
        symbol: 'never_called',
        confidence: 60,
      },
    ])
  })

  it('reads the results that name no symbol', () => {
    expect(
      parseVulture("pkg/a.py:12: unreachable code after 'return' (100% confidence)\n"),
    ).toEqual([
      { file: 'pkg/a.py', line: 12, kind: 'unreachable code', symbol: '', confidence: 100 },
    ])
  })

  it('ignores anything that is not a result line', () => {
    expect(parseVulture('scanning...\n\ndone\n')).toEqual([])
  })
})

describe('vulture toPendingFindings', () => {
  const results = [
    { file: 'a.py', line: 1, kind: 'unused import', symbol: 'os', confidence: 90 },
    { file: 'a.py', line: 9, kind: 'unused function', symbol: 'helper', confidence: 60 },
    { file: 'b.py', line: 4, kind: 'unreachable code', symbol: '', confidence: 100 },
  ]

  /** Spec §3: the high-confidence tier grades, the 60% tier is advisory. */
  it('grades at or above 90% confidence and leaves the rest advisory', () => {
    expect(
      toPendingFindings(results, false).map((finding) => [finding.rule, finding.gradeScope]),
    ).toEqual([
      ['vulture/unused-import', true],
      ['vulture/unused-function', false],
      ['vulture/unreachable-code', true],
    ])
    expect(GRADED_CONFIDENCE).toBe(90)
    expect(MIN_CONFIDENCE).toBe(60)
  })

  /** Identity survives edits above the symbol (spec §2). */
  it('anchors on the symbol name, and on the line only when there is no symbol', () => {
    const findings = toPendingFindings(results, false)
    expect(findings.map((finding) => finding.anchor)).toEqual(['os', 'helper', undefined])
  })
})
