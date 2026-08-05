import {
  COMPLEXITY_CEILING,
  GRADE_TABLE,
  failingFilePercent,
  weightedCount,
} from '../core/grade.ts'
import type { Category, Finding, Language, Severity } from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import { ADVISORY_TAG, CATEGORY_LABELS, location, percent, plural, stateLabel } from './display.ts'
import type { Report, ReportDelta, ReportTool } from './json.ts'

/**
 * `report.md` — the full human report (spec §9): every category's grade, what
 * drove it, which tool said so under whose config, and what to do about it.
 *
 * **Why the generated-at line is at the bottom.** Two runs of the same
 * crank-health on the same commit must produce the same report (spec §6), and a
 * timestamp in the header would put the one varying string in the first three
 * lines of every diff. Everything that reads a clock lives after
 * {@link TIMINGS_MARKER}, in a trailer a reader can ignore and a golden test can
 * cut — the same quarantine `report.json` applies with its `timings` key.
 *
 * **Why there are no source excerpts.** A renderer that quoted the flagged line
 * would quote gitleaks' flagged line too, and print the secret the scanner was
 * careful to redact. The renderers never read the repo; a finding's message is
 * all they have, by construction.
 */

/** Everything below this line was produced by a clock. See the module note. */
export const TIMINGS_MARKER = '<!-- crank-health:timings -->'

export interface ReportMarkdownOptions {
  /** Findings listed per category before the rest is left to `report.json`. */
  readonly maxFindingsPerCategory?: number | undefined
  /**
   * PR-mode delta (spec §4). M8 fills this in; today it is accepted and not
   * rendered, so adding the delta section is a change inside this file.
   */
  readonly delta?: ReportDelta | undefined
}

const DEFAULT_MAX_FINDINGS = 20

/** Renders the whole report, trailing newline included. */
export function renderReportMarkdown(report: Report, options: ReportMarkdownOptions = {}): string {
  const limit = options.maxFindingsPerCategory ?? DEFAULT_MAX_FINDINGS
  const blocks: string[] = [
    '# Codebase health',
    subtitle(report),
    '## Grades',
    gradesTable(report),
    ...languageBreakdown(report),
    ...measurements(report),
    ...CATEGORIES.flatMap((category) => categorySection(report, category, limit)),
    trailer(report),
  ]
  return `${blocks.join('\n\n')}\n`
}

function subtitle(report: Report): string {
  const commit = report.repo.commit ?? 'no commits yet'
  return `\`${report.repo.path}\` @ \`${commit}\` · crank-health ${report.crankHealth} · ${report.profile} profile`
}

/* -------------------------------------------------------------- the summary */

function gradesTable(report: Report): string {
  const rows = CATEGORIES.map((category) => {
    const state = report.categories[category]
    const basis = state.status === 'graded' ? gradeBasis(report, category) : state.reason
    return row([CATEGORY_LABELS[category], stateLabel(state), basis])
  })
  return table(['Category', 'Grade', 'Basis'], rows)
}

/**
 * The per-language split of spec §3, plus the bucket it cannot have.
 *
 * `languages` counts a finding under the language that owns its file, so
 * findings in workflow YAML, lockfiles and other non-source files belong to no
 * language at all. They are counted here as `other` rather than dropped,
 * because a table whose rows do not add up to the findings above it is worse
 * than no table.
 */
function languageBreakdown(report: Report): string[] {
  const languages = Object.keys(report.languages) as Language[]
  const other = otherCounts(report)
  const hasOther = sum(other) > 0
  const rows = [
    ...languages.map((language) => countRow(language, report.languages[language] ?? {})),
    ...(hasOther ? [countRow('other', other)] : []),
  ]
  if (rows.length < 2) return []
  return [
    '### Findings by language',
    table(['Source', ...CATEGORIES.map((category) => CATEGORY_LABELS[category]), 'total'], rows),
    ...(hasOther
      ? [
          '`other` is findings in files no language adapter owns — workflow YAML, lockfiles, config.',
        ]
      : []),
  ]
}

function countRow(label: string, counts: Partial<Record<Category, number>>): string {
  return row([
    label,
    ...CATEGORIES.map((category) => String(counts[category] ?? 0)),
    String(sum(counts)),
  ])
}

/** Findings in files no language owns: the total, minus what the languages claim. */
function otherCounts(report: Report): Partial<Record<Category, number>> {
  const counts: Partial<Record<Category, number>> = {}
  for (const category of CATEGORIES) {
    const total = report.findings.filter((finding) => finding.category === category).length
    const claimed = Object.values(report.languages).reduce(
      (running, byCategory) => running + (byCategory[category] ?? 0),
      0,
    )
    if (total - claimed > 0) counts[category] = total - claimed
  }
  return counts
}

/** The tool-reported numbers behind the ratio grades, spelled out once. */
function measurements(report: Report): string[] {
  const lines: string[] = []
  const complexity = report.metrics.complexity
  if (complexity?.functionsTotal !== undefined) {
    const over = complexity.functionsOverCeiling ?? 0
    lines.push(
      `- Complexity: ${over} of ${plural(complexity.functionsTotal, 'function')} over cognitive complexity ${COMPLEXITY_CEILING} (${percent(ratio(over, complexity.functionsTotal))}).`,
    )
  }
  const duplication = report.metrics.duplication?.duplicationPercent
  if (duplication !== undefined) {
    lines.push(`- Duplication: ${percent(duplication)} of tokens duplicated.`)
  }
  const formattable = report.metrics.format?.formattableFiles
  if (formattable !== undefined) {
    lines.push(`- Format: ${plural(formattable, 'file')} checked by a formatter.`)
  }
  const mutation = report.metrics['test-quality']?.mutationScore
  if (mutation !== undefined) lines.push(`- Test quality: mutation score ${percent(mutation)}.`)
  return lines.length === 0 ? [] : ['### Measurements', lines.join('\n')]
}

/* ---------------------------------------------------------- category detail */

function categorySection(report: Report, category: Category, limit: number): string[] {
  const state = report.categories[category]
  const mine = report.findings.filter((finding) => finding.category === category)
  const tools = report.tools.filter((tool) => tool.category === category)
  const graded = mine.filter((finding) => finding.gradeScope)
  const advisory = mine.filter((finding) => !finding.gradeScope)

  const blocks: string[] = [
    `## ${CATEGORY_LABELS[category]} — ${stateLabel(state)}`,
    state.status === 'graded'
      ? `${gradeBasis(report, category)}\n\nGraded on ${bandText(category)}`
      : `Not graded: ${state.reason}`,
  ]

  // Remediation only where there is something to remediate: a category at A
  // does not need advice, and advice under one reads as a demand.
  if (state.status === 'graded' && state.grade !== 'A') {
    blocks.push(`**Remediation.** ${REMEDIATION[category]}`)
  }
  if (tools.length > 0) blocks.push(toolTable(tools))
  blocks.push(...findingList('Findings', graded, limit))
  blocks.push(
    ...findingList('Advisory findings — reported, not counted toward the grade', advisory, limit),
  )
  const evidence = tools.flatMap((tool) => tool.raw)
  if (evidence.length > 0) {
    blocks.push(`Evidence: ${evidence.map((path) => `[${path}](${path})`).join(' · ')}`)
  }
  return blocks
}

/**
 * Per-tool state, provenance and version. A grade is only as trustworthy as the
 * tools behind it: security can be graded `D` while three scanners never ran,
 * and the reader has to be able to see that without opening `report.json`.
 */
function toolTable(tools: readonly ReportTool[]): string {
  const rows = tools.map((tool) =>
    row([
      tool.tool,
      tool.state === 'not-available' ? 'not available' : tool.state,
      `[${tool.provenance}]`,
      versionCell(tool),
      tool.reason ?? '—',
    ]),
  )
  return table(['Tool', 'State', 'Config', 'Version', 'Notes'], rows)
}

/** What ran, and what this release pins — the two can differ for PATH tools. */
function versionCell(tool: ReportTool): string {
  if (tool.version === null) return tool.pinned === null ? '—' : `— (pinned ${tool.pinned})`
  if (tool.pinned === null || tool.pinned === tool.version) return tool.version
  return `${tool.version} (pinned ${tool.pinned})`
}

function findingList(title: string, findings: readonly Finding[], limit: number): string[] {
  if (findings.length === 0) return []
  const shown = findings.slice(0, limit)
  const lines = shown.map((finding) => findingLine(finding))
  if (findings.length > shown.length) {
    lines.push(`- … ${findings.length - shown.length} more in \`report.json\`.`)
  }
  return [`**${title}** (${findings.length})`, lines.join('\n')]
}

function findingLine(finding: Finding): string {
  const tags = `(${finding.tool}) [${finding.provenance}]${finding.gradeScope ? '' : ` ${ADVISORY_TAG}`}`
  const fix = finding.fixHint === undefined ? '' : `\n  - fix: ${finding.fixHint}`
  return `- ${finding.severity} \`${location(finding)}\` \`${finding.rule}\` — ${finding.message} ${tags}${fix}`
}

/* --------------------------------------------------------------- the grades */

/**
 * What actually moved this category's grade, in its own formula's terms
 * (spec §3): counts for the absolute shape, the measured percentage for the
 * ratio shapes, weighted findings for the density shapes.
 */
function gradeBasis(report: Report, category: Category): string {
  const mine = report.findings.filter((finding) => finding.category === category)
  const graded = mine.filter((finding) => finding.gradeScope)
  const advisory = mine.length - graded.length
  const note =
    advisory === 0 ? '' : ` ${plural(advisory, 'advisory finding')} did not count toward the grade.`

  switch (GRADE_TABLE[category].shape) {
    case 'absolute':
      return graded.length === 0
        ? `Nothing counted toward the grade.${note}`
        : `${plural(graded.length, 'graded finding')}${severityBreakdown(graded)}.${note}`
    case 'density':
      return graded.length === 0
        ? `Nothing counted toward the grade.${note}`
        : `${plural(graded.length, 'graded finding')}${severityBreakdown(graded)}, weighted total ${round(weightedCount(graded))} (error ×5, warning ×1, info ×0.2).${note}`
    case 'ratio':
      return `${ratioBasis(report, category, graded)}${note}`
  }
}

function ratioBasis(report: Report, category: Category, graded: readonly Finding[]): string {
  const metrics = report.metrics[category]
  switch (category) {
    case 'complexity': {
      const total = metrics?.functionsTotal
      const over = metrics?.functionsOverCeiling ?? 0
      return total === undefined
        ? `${plural(over, 'function')} over the complexity ceiling.`
        : `${over} of ${plural(total, 'function')} over cognitive complexity ${COMPLEXITY_CEILING} (${percent(ratio(over, total))}).`
    }
    case 'duplication': {
      const share = metrics?.duplicationPercent
      const clones = report.findings.filter((finding) => finding.category === category).length
      if (share === undefined) return `${plural(clones, 'duplicated block')} reported.`
      return clones === 0
        ? `${percent(share)} of tokens duplicated.`
        : `${percent(share)} of tokens duplicated; the ${plural(clones, 'clone')} below are the evidence, not the grade.`
    }
    case 'format': {
      const files = metrics?.formattableFiles
      const failing = new Set(graded.map((finding) => finding.file)).size
      return files === undefined
        ? `${plural(failing, 'file')} fail the formatter.`
        : `${failing} of ${plural(files, 'checked file')} fail the formatter (${percent(failingFilePercent(graded, category, files))}).`
    }
    default: {
      const score = metrics?.mutationScore
      return score === undefined ? 'No measurement reported.' : `Mutation score ${percent(score)}.`
    }
  }
}

/** ` (2 error, 1 warning)`, or nothing when there is nothing to break down. */
function severityBreakdown(findings: readonly Finding[]): string {
  const order: readonly Severity[] = ['critical', 'error', 'warning', 'info']
  const parts = order
    .map(
      (severity) =>
        [severity, findings.filter((finding) => finding.severity === severity).length] as const,
    )
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/** The category's own bands, read off the one constant table (spec §3). */
function bandText(category: Category): string {
  const rule = GRADE_TABLE[category]
  if (rule.shape === 'absolute') {
    return 'absolute counts, never normalized: any critical → F, any error → D, no graded finding → A, otherwise B or C by the warning and info counts.'
  }
  const higherIsBetter = 'higherIsBetter' in rule && rule.higherIsBetter
  const unit = rule.shape === 'density' ? 'weighted findings per KLOC' : 'the measured percentage'
  const bands = (['A', 'B', 'C', 'D'] as const)
    .map((letter) => `${letter} ${higherIsBetter ? '≥' : '≤'}${rule.bands[letter]}`)
    .join(', ')
  return `${unit}: ${bands}, else F.`
}

/** Short, factual, category-generic: what fixing this category means. */
const REMEDIATION: Readonly<Record<Category, string>> = {
  security:
    'Treat a leaked credential as compromised: rotate it first, then remove it from the code and from history. For the rest, fix the flagged call site, upgrade the affected dependency, and pin third-party actions to a commit sha.',
  types:
    'Fix the reported errors where they are raised. Widening a type or adding a suppression moves the grade without changing what the code does wrong.',
  'dead-code':
    'Delete the unused export, file or dependency — or wire it up, if it was meant to be used. Check each one for dynamic or external use an analyzer cannot see before deleting it.',
  complexity: `Split the flagged functions: extract branch-heavy parts into named helpers and replace nested conditionals with early returns. The ceiling is cognitive complexity ${COMPLEXITY_CEILING}.`,
  duplication:
    'Extract the duplicated block into one shared function or module and call it from both sites. The grade is the duplicated-token share, so the largest clones move it most.',
  lint: 'Fix the reported violations. Where a rule is wrong for this repo, configure it in the repo’s own lint config rather than suppressing it line by line.',
  format:
    'Run the repo’s formatter over the listed files. Keep format-only changes in their own commit so they do not hide a behaviour change.',
  'test-quality':
    'Strengthen the tests covering the code the mutation run survived: assert on observable behaviour rather than on the implementation.',
}

/* -------------------------------------------------------------- primitives */

function trailer(report: Report): string {
  const seconds = (report.timings.durationMs / 1000).toFixed(1)
  return `---\n\n${TIMINGS_MARKER}\nGenerated ${report.timings.generatedAt} · scan took ${seconds}s.`
}

function table(headers: readonly string[], rows: readonly string[]): string {
  return [row(headers), row(headers.map(() => '---')), ...rows].join('\n')
}

function row(cells: readonly string[]): string {
  return `| ${cells.map((cell) => escapeCell(cell)).join(' | ')} |`
}

/** A tool's reason is free text; a `|` or a newline in it must not break the table. */
function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function sum(counts: Partial<Record<Category, number>>): number {
  return Object.values(counts).reduce((running, count) => running + count, 0)
}

function ratio(part: number, whole: number): number {
  return whole <= 0 ? 0 : (part / whole) * 100
}

/** One decimal place at most, and no trailing `.0` on a whole number. */
function round(value: number): string {
  return String(Math.round(value * 10) / 10)
}
