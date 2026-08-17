import {
  COMPLEXITY_CEILING,
  GRADE_TABLE,
  failingFilePercent,
  weightedCount,
} from '../core/grade.ts'
import type {
  Category,
  CategoryState,
  Finding,
  Language,
  Severity,
  ToolMetrics,
} from '../core/types.ts'
import { CATEGORIES } from '../core/types.ts'
import {
  ADVISORY_TAG,
  CATEGORY_LABELS,
  TOUCHED_TAG,
  collapseToolRows,
  hasProjectMovement,
  location,
  movedCategories,
  notSelectedNote,
  percent,
  plural,
  projectLabel,
  rootShellNote,
  standInNote,
  stateLabel,
  unselectedCategories,
} from './display.ts'
import type { CollapsedTool } from './display.ts'
import type {
  Report,
  ReportDelta,
  ReportNewFinding,
  ReportProject,
  ReportProjectTool,
  ReportTool,
} from './json.ts'

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
   * PR-mode delta (spec §4). A `--pr` report carries its own, so this is an
   * override for callers that render a delta the report does not have.
   */
  readonly delta?: ReportDelta | undefined
  /** New and resolved findings listed in the delta block. */
  readonly maxDeltaFindings?: number | undefined
}

const DEFAULT_MAX_FINDINGS = 20

/** Renders the whole report, trailing newline included. */
export function renderReportMarkdown(report: Report, options: ReportMarkdownOptions = {}): string {
  const limit = options.maxFindingsPerCategory ?? DEFAULT_MAX_FINDINGS
  const delta = options.delta ?? report.delta
  // Computed once and threaded down: the rollup's table, every project's table
  // and the category sections have to leave out the same categories.
  const omit = unselectedCategories(report)
  const blocks: string[] = [
    '# Codebase health',
    subtitle(report, delta),
    '## Grades',
    gradesTable(report.categories, rollupScope(report), delta, omit),
    ...(omit.length === 0 ? [] : [notSelectedNote(omit)]),
    ...scanNotes(report),
    ...languageBreakdown(report),
    ...measurements(report),
    ...deltaSection(delta, options.maxDeltaFindings ?? DEFAULT_MAX_FINDINGS),
    ...projectsSection(report, omit),
    ...CATEGORIES.filter((category) => !omit.includes(category)).flatMap((category) =>
      categorySection(report, category, limit, delta),
    ),
    trailer(report),
  ]
  return `${blocks.join('\n\n')}\n`
}

/**
 * What a set of grades was computed from: the whole repo's findings and
 * measurements, or one project's. Everything that explains a grade reads from
 * one of these, so the rollup's basis and a project's are the same sentences
 * about different numbers.
 */
interface GradeScope {
  readonly findings: readonly Finding[]
  readonly metrics: Readonly<Partial<Record<Category, ToolMetrics>>>
}

function rollupScope(report: Report): GradeScope {
  return { findings: report.findings, metrics: report.metrics }
}

function projectScope(report: Report, project: ReportProject): GradeScope {
  return {
    findings: report.findings.filter((finding) => finding.project === project.path),
    metrics: project.metrics,
  }
}

function subtitle(report: Report, delta: ReportDelta | undefined): string {
  const commit = report.repo.commit ?? 'no commits yet'
  const mode =
    delta === undefined
      ? ''
      : ` · PR vs \`${delta.baseRef}\` (merge-base \`${short(delta.mergeBase)}\`)`
  return `\`${report.repo.path}\` @ \`${commit}\` · crank-health ${report.crankHealth} · ${report.profile} profile${mode}`
}

/* ------------------------------------------------------------- the PR delta */

/**
 * What this change did (spec §4), between the whole-repo summary above and the
 * per-category detail below — because the delta is only readable next to the
 * grades it moved, and the grades are head's either way.
 *
 * The movement table lists every category, including the ones that did not
 * move: a PR that changes nothing in `security` should be able to say so, and
 * the base column is where a base-only tool failure becomes visible.
 */
function deltaSection(delta: ReportDelta | undefined, limit: number): string[] {
  if (delta === undefined) return []

  const { counts } = delta
  const blocks: string[] = [
    '## PR delta',
    `Against \`${delta.baseRef}\`, merge-base \`${short(delta.mergeBase)}\`. ` +
      `${plural(counts.new, 'new finding')} (${counts.touchedLine} on lines this change touched), ` +
      `${counts.resolved} resolved, ${counts.unchanged} unchanged.`,
    table(
      ['Category', 'Base', 'Head', 'New', 'Resolved'],
      delta.categories.map((movement) =>
        row([
          CATEGORY_LABELS[movement.category],
          stateLabel(movement.base),
          stateLabel(movement.head),
          String(movement.newFindings),
          String(movement.resolvedFindings),
        ]),
      ),
    ),
  ]

  // Only where it changes how a number should be read: a category nothing
  // assessed on either side has no movement to misread.
  const unreliable = delta.categories.filter(
    (movement) =>
      movement.base.status !== 'graded' &&
      (movement.head.status === 'graded' || movement.resolvedFindings > 0),
  )
  if (unreliable.length > 0) {
    blocks.push(
      `Nothing could assess ${unreliable.map((movement) => CATEGORY_LABELS[movement.category]).join(', ')} ` +
        'at the base, so there is no "before" to compare against: the counts above are what the ' +
        'base scan happened to see, not what was there.',
    )
  }

  blocks.push(...projectMovementBlock(delta))
  blocks.push(...findingList('New findings', delta.newFindings, limit))
  blocks.push(...findingList('Resolved findings', delta.resolvedFindings, limit))
  return blocks
}

/**
 * Which projects the change moved, and how — the delta's answer to the
 * `## Projects` section below it.
 *
 * Only the projects that moved get a row: in a repo of thirty packages the ones
 * a change did not touch are the noise the table exists to remove, so they are
 * counted in a sentence under it. A project this change added or removed always
 * counts as moved, and says which — its findings are all new or all resolved,
 * and "resolved" under a deleted package does not mean fixed.
 *
 * A single-project repo is the movement table above, restated; it renders
 * nothing here.
 */
function projectMovementBlock(delta: ReportDelta): string[] {
  if (delta.projects.length < 2) return []
  const moved = delta.projects.filter((project) => hasProjectMovement(project))
  const still = delta.projects.filter((project) => !hasProjectMovement(project))
  if (moved.length === 0) {
    return ['### Project movement', `No project moved: all ${still.length} are as they were.`]
  }

  const blocks = [
    '### Project movement',
    table(
      ['Project', 'State', 'New', 'Resolved', 'Grades that moved'],
      moved.map((project) =>
        row([
          projectLabel(project.path),
          project.churn === 'none' ? 'scanned on both sides' : `${project.churn} by this change`,
          String(project.newFindings),
          String(project.resolvedFindings),
          movedCategories(project).join(', ') || '—',
        ]),
      ),
    ),
  ]
  if (still.length > 0) {
    blocks.push(
      `${plural(still.length, 'other project')} unchanged: ` +
        `${still.map((project) => `\`${projectLabel(project.path)}\``).join(', ')}.`,
    )
  }
  return blocks
}

/** `abc1234` — enough of a sha to identify it, short enough to read. */
function short(sha: string): string {
  return sha.slice(0, 8)
}

/* -------------------------------------------------------------- the summary */

/**
 * The grades, one row per category, minus the ones in `omit` — the categories
 * `--only` left out, which the note under the table names in one line instead.
 *
 * `omit` is required rather than defaulted so that every call site has to say
 * what it leaves out: the rollup's table and each project's must not disagree.
 */
function gradesTable(
  states: Readonly<Record<Category, CategoryState>>,
  scope: GradeScope,
  delta: ReportDelta | undefined,
  omit: readonly Category[],
): string {
  const rows = CATEGORIES.filter((category) => !omit.includes(category)).map((category) => {
    const state = states[category]
    const basis = state.status === 'graded' ? gradeBasis(scope, category, delta) : state.reason
    return row([CATEGORY_LABELS[category], stateLabel(state), basis])
  })
  return table(['Category', 'Grade', 'Basis'], rows)
}

/**
 * What the scan did not look at, beside the grades it is read against
 * ({@link Report.warnings}, already sorted): the run's own fixed sentences,
 * quoted verbatim — nothing is composed here. A run with nothing to note
 * renders no block at all.
 *
 * The blank line after the bold lead keeps the bullets a list under every
 * Markdown renderer rather than relying on a list interrupting a paragraph.
 */
function scanNotes(report: Report): string[] {
  if (report.warnings.length === 0) return []
  return [`**Scan notes.**\n\n${report.warnings.map((warning) => `- ${warning}`).join('\n')}`]
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
  const testQuality = report.metrics['test-quality']
  if (testQuality?.mutationScore !== undefined) {
    lines.push(
      `- Test quality: mutation score ${percent(testQuality.mutationScore)}${mutantCounts(testQuality)}.`,
    )
  }
  if (testQuality?.lineCoveragePercent !== undefined) {
    lines.push(
      `- Coverage: ${percent(testQuality.lineCoveragePercent)} of lines executed by the test suite (context; the grade is the mutation score).`,
    )
  }
  return lines.length === 0 ? [] : ['### Measurements', lines.join('\n')]
}

/* ----------------------------------------------------------- the projects */

/**
 * The same questions answered per project, in path order, after the rollup they
 * add up to: each project's eight states against its own findings, its own
 * measurements and its own denominators, then the toolchain that produced them.
 *
 * A single-project repo *is* the rollup — the section would restate the grades
 * above it word for word — so it is rendered only where there is more than one
 * project, or where the root turned out to be a workspace shell: a one-package
 * workspace has a fact about its root that belongs nowhere else.
 */
function projectsSection(report: Report, omit: readonly Category[]): string[] {
  if (report.projects.length < 2 && report.rootShell === undefined) return []
  const count = report.projects.length
  const blocks = [
    '## Projects',
    `${plural(count, 'project')}, ${count === 1 ? 'graded' : 'each graded'} on its own files, ` +
      `its own toolchain and its own denominators; the grades above are ${rollupCoverage(report)}. ` +
      'A category marked `repo-scoped` is one a repo-spanning scan answered — secrets, dependency ' +
      'audits, workflow checks — so it is graded once, above, and not per project.',
  ]
  if (report.rootShell !== undefined) blocks.push(rootShellNote(report.rootShell))
  return [...blocks, ...report.projects.flatMap((project) => projectBlock(report, project, omit))]
}

/**
 * What the rollup is a rollup *of*. Under `--project` it is the selection and
 * not the repo — the tree outside it was never graded, and a report that said
 * "the repo as a whole" over a scoped run would be claiming a number nobody
 * computed. Repo-spanning scans still span the repo either way; that is what
 * their own rows say.
 */
function rollupCoverage(report: Report): string {
  const scoped = report.scopedTo
  if (scoped === undefined) return 'the repo as a whole'
  return `the ${plural(scoped.length, 'project')} this run was scoped to (${scoped
    .map((path) => `\`${projectLabel(path)}\``)
    .join(', ')})`
}

function projectBlock(report: Report, project: ReportProject, omit: readonly Category[]): string[] {
  const manifests = project.manifests.map((manifest) => `\`${manifest}\``)
  const languages = project.languages.length === 0 ? [] : [project.languages.join(', ')]
  return [
    `### ${projectLabel(project.path)}`,
    [...manifests, ...languages].join(' · '),
    gradesTable(project.categories, projectScope(report, project), undefined, omit),
    ...(project.toolchain.length === 0
      ? ['This project declares no tool of its own: it was analyzed on crank-health’s defaults.']
      : [projectToolTable(project.toolchain)]),
  ]
}

/**
 * What this project owns and what made it own it. `Owned via` is the manifest
 * or config that decided it, which in a monorepo is regularly an ancestor's —
 * that is how a hoisted dependency at the root becomes this package's toolchain.
 */
function projectToolTable(toolchain: readonly ReportProjectTool[]): string {
  const rows = toolchain.map((tool) =>
    row([
      tool.tool,
      CATEGORY_LABELS[tool.category],
      `${tool.reason}${tool.installed ? '' : ', not installed'}`,
      tool.ownedVia ?? '—',
      tool.version ?? '—',
    ]),
  )
  return table(['Tool', 'Category', 'Ownership', 'Owned via', 'Version'], rows)
}

/* ---------------------------------------------------------- category detail */

function categorySection(
  report: Report,
  category: Category,
  limit: number,
  delta: ReportDelta | undefined,
): string[] {
  const state = report.categories[category]
  const mine = report.findings.filter((finding) => finding.category === category)
  const tools = report.tools.filter((tool) => tool.category === category)
  const graded = mine.filter((finding) => finding.gradeScope)
  const advisory = mine.filter((finding) => !finding.gradeScope)

  const blocks: string[] = [
    `## ${CATEGORY_LABELS[category]} — ${stateLabel(state)}`,
    state.status === 'graded'
      ? `${gradeBasis(rollupScope(report), category, delta)}\n\nGraded on ${bandText(category)}`
      : `Not graded: ${state.reason}`,
  ]

  // Remediation only where there is something to remediate: a category at A
  // does not need advice, and advice under one reads as a demand.
  if (state.status === 'graded' && state.grade !== 'A') {
    blocks.push(`**Remediation.** ${REMEDIATION[category]}`)
  }
  if (tools.length > 0) {
    blocks.push(toolTable(collapseToolRows(tools), report.projects.length))
  }
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
function toolTable(tools: readonly CollapsedTool[], projectCount: number): string {
  // In PR mode the same tool ran twice, and which run a row is about is the
  // difference between "this change fixed it" and "the base scan failed".
  const sided = tools.some((tool) => tool.side !== undefined)
  const rows = tools.map((tool) =>
    row([
      tool.tool,
      ...(sided ? [tool.side ?? '—'] : []),
      tool.state === 'not-available' ? 'not available' : tool.state,
      `[${tool.provenance}]`,
      versionCell(tool),
      notesCell(tool, projectCount),
    ]),
  )
  return table(['Tool', ...(sided ? ['Scan'] : []), 'State', 'Config', 'Version', 'Notes'], rows)
}

/**
 * Why the tool says what it says, and — where the row stands in for more than
 * its own package — which projects that is about. A row with neither still has
 * a cell, because a markdown table has no empty ones.
 */
function notesCell(tool: CollapsedTool, projectCount: number): string {
  const parts = [tool.reason, standInNote(tool, projectCount)].filter((part) => part !== null)
  return parts.length === 0 ? '—' : parts.join(' ')
}

/** What ran, and what this release pins — the two can differ for PATH tools. */
function versionCell(tool: ReportTool): string {
  if (tool.version === null) return tool.pinned === null ? '—' : `— (pinned ${tool.pinned})`
  if (tool.pinned === null || tool.pinned === tool.version) return tool.version
  return `${tool.version} (pinned ${tool.pinned})`
}

function findingList(
  title: string,
  findings: readonly (Finding | ReportNewFinding)[],
  limit: number,
): string[] {
  if (findings.length === 0) return []
  const shown = findings.slice(0, limit)
  const lines = shown.map((finding) => findingLine(finding))
  if (findings.length > shown.length) {
    lines.push(`- … ${findings.length - shown.length} more in \`report.json\`.`)
  }
  return [`**${title}** (${findings.length})`, lines.join('\n')]
}

function findingLine(finding: Finding | ReportNewFinding): string {
  const touched = 'touchedLine' in finding && finding.touchedLine ? ` ${TOUCHED_TAG}` : ''
  const tags = `(${finding.tool}) [${finding.provenance}]${finding.gradeScope ? '' : ` ${ADVISORY_TAG}`}${touched}`
  const fix = finding.fixHint === undefined ? '' : `\n  - fix: ${finding.fixHint}`
  return `- ${finding.severity} \`${location(finding)}\` \`${finding.rule}\` — ${finding.message} ${tags}${fix}`
}

/* --------------------------------------------------------------- the grades */

/**
 * What actually moved this category's grade, in its own formula's terms
 * (spec §3): counts for the absolute shape, the measured percentage for the
 * ratio shapes, weighted findings for the density shapes.
 */
function gradeBasis(scope: GradeScope, category: Category, delta: ReportDelta | undefined): string {
  const mine = scope.findings.filter((finding) => finding.category === category)
  const graded = mine.filter((finding) => finding.gradeScope)
  const advisory = mine.length - graded.length
  const note =
    (advisory === 0
      ? ''
      : ` ${plural(advisory, 'advisory finding')} did not count toward the grade.`) +
    deltaNote(delta, category)

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
      return `${ratioBasis(scope, category, graded)}${note}`
  }
}

/** ` This change: 2 new, 1 resolved.` — silent where nothing moved. */
function deltaNote(delta: ReportDelta | undefined, category: Category): string {
  const movement = delta?.categories.find((entry) => entry.category === category)
  if (movement === undefined) return ''
  if (movement.newFindings === 0 && movement.resolvedFindings === 0) return ''
  return ` This change: ${movement.newFindings} new, ${movement.resolvedFindings} resolved.`
}

function ratioBasis(scope: GradeScope, category: Category, graded: readonly Finding[]): string {
  const metrics = scope.metrics[category]
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
      const clones = scope.findings.filter((finding) => finding.category === category).length
      if (share === undefined) return `${plural(clones, 'duplicated block')} reported.`
      // One clone is one finding, so the count reaches 1 — and at 1 the sentence
      // names the clone rather than counting it.
      if (clones === 0) return `${percent(share)} of tokens duplicated.`
      const evidence =
        clones === 1 ? 'the clone below is' : `the ${plural(clones, 'clone')} below are`
      return `${percent(share)} of tokens duplicated; ${evidence} the evidence, not the grade.`
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
      return score === undefined
        ? 'No measurement reported.'
        : `Mutation score ${percent(score)}${mutantCounts(metrics)}.`
    }
  }
}

/**
 * ` — 7 of 25 mutants detected`: the two numbers the mutation score is a ratio
 * of. "Detected" is killed plus timed out and "undetected" is survived plus
 * never covered, which is how the mutation-testing-elements score is defined and
 * what makes a percentage checkable against the findings under it.
 */
function mutantCounts(metrics: ToolMetrics | undefined): string {
  const detected = metrics?.mutantsDetected
  const undetected = metrics?.mutantsUndetected
  if (detected === undefined || undetected === undefined) return ''
  return ` — ${detected} of ${plural(detected + undetected, 'mutant')} detected`
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
