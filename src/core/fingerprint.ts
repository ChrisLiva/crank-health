import { createHash } from 'node:crypto'
import type { Category, Finding, PendingFinding } from './types.ts'

/**
 * Hex characters kept from the sha256. 16 hex chars = 64 bits: collision-safe
 * at any plausible finding count, short enough to read in a report.
 */
const ID_LENGTH = 16

/** Field separator: NUL cannot occur in a path, rule id or source line. */
const SEPARATOR = '\u0000'

/**
 * Stable identity of a finding (spec §2).
 *
 * Deliberately excludes the line/column range: an edit above a finding shifts
 * its line but must not churn its identity across a PR delta. The anchor —
 * trimmed source line, or a symbol name for symbol-level findings — carries the
 * location instead, and `occurrence` disambiguates identical anchors within the
 * same file.
 */
export function fingerprint(
  category: Category,
  tool: string,
  rule: string,
  file: string,
  anchor: string,
  occurrence = 0,
): string {
  const material = [category, tool, rule, file, normalizeAnchor(anchor), String(occurrence)].join(
    SEPARATOR,
  )
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, ID_LENGTH)
}

/**
 * Anchor normalization: NFC so that canonically equivalent unicode hashes the
 * same, then trimmed of surrounding whitespace so re-indentation does not churn
 * identity. An empty result (blank line, or source we could not read) is a
 * legal anchor — `occurrence` keeps such findings distinct.
 */
export function normalizeAnchor(anchor: string): string {
  return anchor.normalize('NFC').trim()
}

/**
 * Assigns anchors, occurrence indices and ids to findings that runners produced
 * with ranges only. This is where line numbers stop mattering: the range picks
 * the anchor line, and from then on identity is range-free.
 *
 * Findings are processed in (file, startLine, startCol) order so occurrence
 * indices are deterministic and survive uniform line shifts. A finding may
 * supply its own `anchor` (symbol name) to opt out of line lookup.
 *
 * @param findings runner output, without ids
 * @param fileContents repo-relative posix path → full file text; files that are
 * absent yield an empty anchor rather than an error
 * @returns findings with ids, in input order
 */
export function computeAnchors(
  findings: readonly PendingFinding[],
  fileContents: ReadonlyMap<string, string>,
): Finding[] {
  const lineCache = new Map<string, readonly string[]>()
  const seen = new Map<string, number>()
  const identified: Finding[] = []

  const order = findings.map((finding, index) => ({ finding, index })).toSorted(byLocation)

  for (const { finding, index } of order) {
    const anchor = normalizeAnchor(
      finding.anchor ?? sourceLine(finding.file, finding.range.startLine, fileContents, lineCache),
    )
    const key = [finding.category, finding.tool, finding.rule, finding.file, anchor].join(SEPARATOR)
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)

    const { anchor: _anchor, ...rest } = finding
    identified[index] = {
      ...rest,
      id: fingerprint(
        finding.category,
        finding.tool,
        finding.rule,
        finding.file,
        anchor,
        occurrence,
      ),
      // Kept so a PR delta can re-hash this finding under a renamed path
      // without re-reading a tree that may no longer be checked out.
      identity: { anchor, occurrence },
    }
  }

  return identified
}

/** Deterministic processing order for occurrence numbering. */
function byLocation(
  a: { readonly finding: PendingFinding; readonly index: number },
  b: { readonly finding: PendingFinding; readonly index: number },
): number {
  if (a.finding.file !== b.finding.file) return a.finding.file < b.finding.file ? -1 : 1
  if (a.finding.range.startLine !== b.finding.range.startLine) {
    return a.finding.range.startLine - b.finding.range.startLine
  }
  if (a.finding.range.startCol !== b.finding.range.startCol) {
    return a.finding.range.startCol - b.finding.range.startCol
  }
  return a.index - b.index
}

/** 1-based line lookup; empty string when out of range or file unavailable. */
function sourceLine(
  file: string,
  line: number,
  fileContents: ReadonlyMap<string, string>,
  cache: Map<string, readonly string[]>,
): string {
  let lines = cache.get(file)
  if (lines === undefined) {
    const text = fileContents.get(file)
    lines = text === undefined ? [] : text.split('\n')
    cache.set(file, lines)
  }
  return lines[line - 1] ?? ''
}

/**
 * Links findings that answer for the same place in the same file from different
 * categories: same path, overlapping line range, different category.
 *
 * The audit found one range flagged twice — a function over the complexity
 * ceiling that a type checker also fails, a duplicated block that is also dead.
 * Read one category at a time those are two problems in two sections of the
 * report, and the reader has to notice the line numbers agree to see that they
 * are one place to go. {@link Finding.related} is that noticing, done once.
 *
 * Same-category pairs are left alone: two lint findings on one line are the same
 * section of the report already, and linking them would say nothing a reader
 * could act on. Whole-file findings (the `1:1:1:1` range a formatter or a
 * lockfile scanner reports) overlap line 1 like any other range — which is the
 * honest answer, since that is the only position they claim.
 *
 * Pure and order-independent: the links are sorted by id, and grouping by file
 * first keeps this linear in the findings of any one file rather than in the
 * repo's.
 *
 * @returns the findings in input order, each carrying its links or none
 */
export function linkRelated(findings: readonly Finding[]): Finding[] {
  const byFile = new Map<string, Finding[]>()
  for (const finding of findings) {
    const group = byFile.get(finding.file)
    if (group === undefined) byFile.set(finding.file, [finding])
    else group.push(finding)
  }

  return findings.map((finding) => {
    const related = (byFile.get(finding.file) ?? [])
      .filter((other) => other.id !== finding.id && other.category !== finding.category)
      .filter((other) => overlaps(finding, other))
      .map((other) => other.id)
      .toSorted(compareIds)
    return related.length === 0 ? finding : { ...finding, related: [...new Set(related)] }
  })
}

/** Inclusive line-range overlap. Columns are display detail, never identity. */
function overlaps(one: Finding, other: Finding): boolean {
  return one.range.startLine <= other.range.endLine && other.range.startLine <= one.range.endLine
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
