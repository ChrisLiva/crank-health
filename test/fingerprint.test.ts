import { describe, expect, it } from 'vitest'
import {
  computeAnchors,
  fingerprint,
  linkRelated,
  normalizeAnchor,
} from '../src/core/fingerprint.ts'
import type { Finding, PendingFinding, Range } from '../src/core/types.ts'
import { makeFinding } from './factories.ts'

function at(startLine: number, extra: Partial<PendingFinding> = {}): PendingFinding {
  const { id: _id, ...rest } = makeFinding()
  const range: Range = { startLine, startCol: 1, endLine: startLine, endCol: 10 }
  return { ...rest, range, ...extra }
}

describe('fingerprint', () => {
  it('is stable across calls', () => {
    const id = fingerprint('lint', 'oxlint', 'no-debugger', 'src/a.ts', 'debugger')
    expect(fingerprint('lint', 'oxlint', 'no-debugger', 'src/a.ts', 'debugger')).toBe(id)
  })

  it('is a short lowercase hex digest', () => {
    expect(fingerprint('lint', 'oxlint', 'r', 'a.ts', 'x')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('changes when any identity component changes', () => {
    const base = fingerprint('lint', 'oxlint', 'no-debugger', 'src/a.ts', 'debugger')
    expect(fingerprint('types', 'oxlint', 'no-debugger', 'src/a.ts', 'debugger')).not.toBe(base)
    expect(fingerprint('lint', 'eslint', 'no-debugger', 'src/a.ts', 'debugger')).not.toBe(base)
    expect(fingerprint('lint', 'oxlint', 'no-alert', 'src/a.ts', 'debugger')).not.toBe(base)
    expect(fingerprint('lint', 'oxlint', 'no-debugger', 'src/b.ts', 'debugger')).not.toBe(base)
    expect(fingerprint('lint', 'oxlint', 'no-debugger', 'src/a.ts', 'debugger()')).not.toBe(base)
    expect(fingerprint('lint', 'oxlint', 'no-debugger', 'src/a.ts', 'debugger', 1)).not.toBe(base)
  })

  it('cannot be confused by component boundaries', () => {
    expect(fingerprint('lint', 'a', 'b', 'c', 'd')).not.toBe(
      fingerprint('lint', 'a b', '', 'c', 'd'),
    )
  })

  it('ignores surrounding whitespace in the anchor', () => {
    const id = fingerprint('lint', 'oxlint', 'r', 'a.ts', 'const x = 1')
    expect(fingerprint('lint', 'oxlint', 'r', 'a.ts', '    const x = 1  ')).toBe(id)
    expect(fingerprint('lint', 'oxlint', 'r', 'a.ts', '\tconst x = 1\r')).toBe(id)
  })

  it('treats canonically equivalent unicode as the same anchor', () => {
    // NFC (precomposed) vs NFD (e + combining acute) spellings of the same line
    const nfc = 'const caf\u00e9 = 1'
    const nfd = 'const cafe\u0301 = 1'
    expect(nfc).not.toBe(nfd)
    expect(normalizeAnchor(nfd)).toBe(nfc)
    expect(fingerprint('lint', 't', 'r', 'a.ts', nfd)).toBe(
      fingerprint('lint', 't', 'r', 'a.ts', nfc),
    )
  })

  it('accepts an empty anchor', () => {
    expect(fingerprint('lint', 't', 'r', 'a.ts', '   ')).toBe(
      fingerprint('lint', 't', 'r', 'a.ts', ''),
    )
  })
})

/** Single-file source map for the anchor lookups below. */
const source = (text: string) => new Map([['src/a.ts', text]])

describe('computeAnchors', () => {
  it('anchors on the trimmed flagged source line', () => {
    const [finding] = computeAnchors([at(2)], source('const a = 1\n  debugger\nconst b = 2\n'))
    expect(finding?.id).toBe(
      fingerprint('lint', 'oxlint', 'no-unused-vars', 'src/a.ts', 'debugger', 0),
    )
  })

  it('keeps identity when the finding moves down the file', () => {
    const before = computeAnchors([at(2)], source('a\ndebugger\nb\n'))
    const after = computeAnchors([at(5)], source('x\ny\nz\na\ndebugger\nb\n'))
    expect(after[0]?.id).toBe(before[0]?.id)
  })

  it('keeps identity when only the range widens', () => {
    const wide = computeAnchors(
      [at(2, { range: { startLine: 2, startCol: 3, endLine: 9, endCol: 40 } })],
      source('a\ndebugger\nb\n'),
    )
    const narrow = computeAnchors([at(2)], source('a\ndebugger\nb\n'))
    expect(wide[0]?.id).toBe(narrow[0]?.id)
  })

  it('disambiguates identical anchors in the same file by occurrence', () => {
    const text = 'debugger\nconst x = 1\ndebugger\n'
    const findings = computeAnchors([at(1), at(3)], source(text))
    expect(findings).toHaveLength(2)
    expect(findings[0]?.id).not.toBe(findings[1]?.id)
    expect(findings[0]?.id).toBe(
      fingerprint('lint', 'oxlint', 'no-unused-vars', 'src/a.ts', 'debugger', 0),
    )
    expect(findings[1]?.id).toBe(
      fingerprint('lint', 'oxlint', 'no-unused-vars', 'src/a.ts', 'debugger', 1),
    )
  })

  it('numbers occurrences by position, not by the order runners emitted them', () => {
    const text = 'debugger\nconst x = 1\ndebugger\n'
    const forwards = computeAnchors([at(1), at(3)], source(text))
    const backwards = computeAnchors([at(3), at(1)], source(text))
    expect(backwards[1]?.id).toBe(forwards[0]?.id)
    expect(backwards[0]?.id).toBe(forwards[1]?.id)
  })

  it('does not share occurrence counters across rules or files', () => {
    const findings = computeAnchors(
      [at(1), at(1, { rule: 'other' }), at(1, { file: 'src/b.ts' })],
      new Map([
        ['src/a.ts', 'debugger\n'],
        ['src/b.ts', 'debugger\n'],
      ]),
    )
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(3)
    expect(findings[2]?.id).toBe(
      fingerprint('lint', 'oxlint', 'no-unused-vars', 'src/b.ts', 'debugger', 0),
    )
  })

  it('uses an explicit anchor for symbol-level findings', () => {
    const [finding] = computeAnchors(
      [at(42, { anchor: 'unusedExport', file: 'src/a.ts' })],
      source('only one line\n'),
    )
    expect(finding?.id).toBe(
      fingerprint('lint', 'oxlint', 'no-unused-vars', 'src/a.ts', 'unusedExport', 0),
    )
    expect(finding).not.toHaveProperty('anchor')
  })

  it('falls back to an empty anchor for blank lines and unreadable files', () => {
    const blank = computeAnchors([at(2)], source('a\n\nb\n'))
    const missing = computeAnchors([at(2)], new Map())
    const beyondEnd = computeAnchors([at(99)], source('a\n'))
    const empty = fingerprint('lint', 'oxlint', 'no-unused-vars', 'src/a.ts', '', 0)
    expect(blank[0]?.id).toBe(empty)
    expect(missing[0]?.id).toBe(empty)
    expect(beyondEnd[0]?.id).toBe(empty)
  })

  it('returns findings in input order', () => {
    const findings = computeAnchors([at(3), at(1), at(2)], source('one\ntwo\nthree\n'))
    expect(findings.map((finding) => finding.range.startLine)).toEqual([3, 1, 2])
  })
})

/**
 * The audit's crestArt case: one range in one file flagged by two categories at
 * once — a complexity finding on a function that also fails a type check, say.
 * Read one category at a time they are two problems; read together they are one
 * place to go, and the link is what lets a reader see that without diffing line
 * numbers by hand.
 */
/** A finding over a line range; the linking rule is about nothing else. */
function spanning(
  overrides: Partial<Finding> & { readonly startLine: number; readonly endLine: number },
): Finding {
  const { startLine, endLine, ...rest } = overrides
  return makeFinding({ range: { startLine, startCol: 1, endLine, endCol: 1 }, ...rest })
}

describe('linkRelated', () => {
  it('links findings of different categories over the same lines of one file', () => {
    const lint = spanning({ id: 'aaaaaaaaaaaaaaaa', category: 'lint', startLine: 10, endLine: 30 })
    const types = spanning({
      id: 'bbbbbbbbbbbbbbbb',
      category: 'types',
      startLine: 25,
      endLine: 25,
    })

    const [first, second] = linkRelated([lint, types])
    expect(first?.related).toEqual(['bbbbbbbbbbbbbbbb'])
    expect(second?.related).toEqual(['aaaaaaaaaaaaaaaa'])
  })

  it('leaves a finding nothing overlaps unlinked, rather than carrying an empty list', () => {
    const lint = spanning({ id: 'aaaaaaaaaaaaaaaa', category: 'lint', startLine: 10, endLine: 12 })
    const types = spanning({
      id: 'bbbbbbbbbbbbbbbb',
      category: 'types',
      startLine: 40,
      endLine: 40,
    })

    expect(linkRelated([lint, types]).every((entry) => entry.related === undefined)).toBe(true)
  })

  it('does not link two findings of the same category, or two files', () => {
    const one = spanning({ id: 'aaaaaaaaaaaaaaaa', category: 'lint', startLine: 1, endLine: 5 })
    const twin = spanning({ id: 'bbbbbbbbbbbbbbbb', category: 'lint', startLine: 2, endLine: 3 })
    const elsewhere = spanning({
      id: 'cccccccccccccccc',
      category: 'types',
      file: 'src/b.ts',
      startLine: 1,
      endLine: 5,
    })

    expect(linkRelated([one, twin, elsewhere]).every((entry) => entry.related === undefined)).toBe(
      true,
    )
  })

  it('sorts the links, so two runs cannot disagree on their order', () => {
    const lint = spanning({ id: 'aaaaaaaaaaaaaaaa', category: 'lint', startLine: 1, endLine: 9 })
    const types = spanning({ id: 'cccccccccccccccc', category: 'types', startLine: 1, endLine: 1 })
    const dead = spanning({
      id: 'bbbbbbbbbbbbbbbb',
      category: 'dead-code',
      startLine: 2,
      endLine: 2,
    })

    const [first] = linkRelated([lint, types, dead])
    expect(first?.related).toEqual(['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'])
  })
})
