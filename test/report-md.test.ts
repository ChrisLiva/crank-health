import { describe, expect, it } from 'vitest'
import type { CategoryState } from '../src/core/types.ts'
import { CATEGORIES } from '../src/core/types.ts'
import { CATEGORY_LABELS } from '../src/render/display.ts'
import type { ReportProject, ResolvedRun } from '../src/render/json.ts'
import { renderReportMarkdown } from '../src/render/report-md.ts'
import { TIMINGS_MARKER } from '../src/render/report-md.ts'
import {
  allGraded,
  allNotAssessed,
  makeFinding,
  makeProjectScan,
  makeReport,
  noMetrics,
  projectAt,
} from './factories.ts'
import { expectGolden, normalizeMarkdown, readGoldenReport } from './support/report.ts'

/**
 * `report.md` (spec §9). The renderer is a pure function of a `Report`, so the
 * goldens are recorded against the checked-in golden `report.json` files rather
 * than against a scan: same bytes on every machine, no tool has to run, and a
 * change in the report *is* a change in the golden. That the pipeline writes
 * exactly what this renders is asserted in the fixture scans.
 */

const FIXTURES = ['cs-basic', 'js-basic', 'mono-js', 'mono-mixed', 'py-basic', 'sec-basic'] as const

/** The golden form: the timings trailer cut, the repo path already `<repo>`. */
async function render(name: string): Promise<string> {
  return normalizeMarkdown(renderReportMarkdown(await readGoldenReport(name)), '<repo>')
}

/** One `##` section, from its heading to the next one. */
function section(markdown: string, heading: string): string {
  const [, rest = ''] = markdown.split(heading)
  return rest.split('\n## ')[0] ?? ''
}

/** One project's `###` block, from its heading to the next heading of any level. */
function projectBlock(markdown: string, heading: string): string {
  const [, rest = ''] = markdown.split(heading)
  return rest.split('\n### ')[0]?.split('\n## ')[0] ?? ''
}

/**
 * Every per-category tool table in a report, by the category it sits under —
 * its data rows only, header and separator dropped. The per-project toolchain
 * table starts `| Tool | Category |` and is deliberately not one of these: it
 * says which project owns what, and repeats a row on purpose.
 */
function toolTables(markdown: string): Map<string, string[]> {
  const tables = new Map<string, string[]>()
  let category = ''
  let rows: string[] | undefined
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      category = line.slice(3)
      rows = undefined
    }
    if (line.startsWith('| Tool | State |') || line.startsWith('| Tool | Scan |')) {
      rows = []
      tables.set(category, rows)
    } else if (rows !== undefined && line.startsWith('|') && !line.startsWith('| --- |')) {
      rows.push(line)
    } else if (!line.startsWith('|')) {
      rows = undefined
    }
  }
  return tables
}

/** One category's tool table as the reader sees it, or `''` where it has none. */
function toolTable(markdown: string, category: string): string {
  for (const [heading, rows] of toolTables(markdown)) {
    if (heading.startsWith(`${category} —`)) return rows.join('\n')
  }
  return ''
}

/** One project's run of a scanner that is not installed: the row every project repeats. */
function missingScan(project: string): ResolvedRun {
  return {
    record: {
      tool: 'opengrep',
      category: 'security',
      scope: 'common',
      project,
      repoWide: false,
      rollupOnly: false,
      pinnedVersion: '1.26.0',
      detection: null,
      result: {
        state: 'not-available',
        findings: [],
        rawFiles: [],
        reason: 'opengrep is not on PATH',
      },
      durationMs: 1,
      standby: false,
    },
    raw: [],
  }
}

/** One project's successful lint run, with the raw output it left behind. */
function lintScan(project: string, raw: readonly string[]): ResolvedRun {
  return {
    record: {
      tool: 'oxlint',
      category: 'lint',
      scope: 'js-ts',
      project,
      repoWide: false,
      rollupOnly: false,
      pinnedVersion: '1.77.0',
      detection: null,
      result: { state: 'ok', findings: [], rawFiles: [], toolVersion: '1.77.0' },
      durationMs: 1,
      standby: false,
    },
    raw,
  }
}

/** A graded duplication category measured at 12.5%, with `clones` clones under it. */
function evidence(clones: number): string {
  return renderReportMarkdown(
    makeReport({
      categories: { ...allNotAssessed(), duplication: { status: 'graded', grade: 'C' } },
      metrics: { ...noMetrics(), duplication: { duplicationPercent: 12.5 } },
      findings: Array.from({ length: clones }, (_, index) =>
        makeFinding({
          id: `clone-${index}`,
          category: 'duplication',
          file: `src/dupe${index}.ts`,
          gradeScope: false,
        }),
      ),
    }),
  )
}

describe('renderReportMarkdown', () => {
  it.each(FIXTURES)('matches the golden report.md for %s', async (name) => {
    await expectGolden(`${name}.report.md`, await render(name))
  })

  it('renders byte-identical output from the same report', async () => {
    const report = await readGoldenReport('sec-basic')
    expect(renderReportMarkdown(report)).toBe(renderReportMarkdown(report))
  })

  it('quarantines everything a clock produced behind the trailer marker', async () => {
    const report = await readGoldenReport('sec-basic')
    const [body = '', trailer = ''] = renderReportMarkdown(report).split(TIMINGS_MARKER)
    expect(trailer).toContain(report.timings.generatedAt)
    expect(body).not.toContain(report.timings.generatedAt)
    // The part that is not the trailer does not move when the clock does.
    const later = renderReportMarkdown({
      ...report,
      timings: { generatedAt: '2030-06-01T12:00:00.000Z', durationMs: 99_999, tools: [] },
    })
    expect(later.split(TIMINGS_MARKER)[0]).toBe(body)
  })

  it('names every category, its grade or its reason, and how it is graded', async () => {
    const markdown = await render('sec-basic')
    expect(markdown).toContain('## security — D')
    expect(markdown).toContain('## test quality — not assessed')
    expect(markdown).toContain('Not graded: not assessed — run `--deep`')
    expect(markdown).toContain('any critical → F')
  })

  /** Spec §9: the report carries provenance tags. */
  it('tags every tool and every finding with whose config decided it', () => {
    const markdown = renderReportMarkdown(
      makeReport({
        categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
        findings: [
          makeFinding({ id: 'a', provenance: 'repo-config' }),
          makeFinding({ id: 'b', file: 'src/b.ts', provenance: 'default-config' }),
        ],
      }),
    )
    expect(markdown).toContain('[repo-config]')
    expect(markdown).toContain('[default-config]')
  })

  it('separates advisory findings and labels them', async () => {
    const markdown = await render('sec-basic')
    expect(markdown).toContain('Advisory findings — reported, not counted toward the grade')
    expect(markdown).toMatch(/`B404`.*\[advisory\]/)
    // The graded findings are not labelled advisory.
    expect(markdown).not.toMatch(/`B602`.*\[advisory\]/)
  })

  /**
   * A grade is only as trustworthy as the tools behind it: security can be
   * graded while three scanners never ran, and the reason has to say so — with
   * the install hint that makes it actionable (spec §8).
   */
  it('shows each tool’s state next to the grade, install hints included', async () => {
    const markdown = await render('sec-basic')
    expect(markdown).toContain('| gitleaks | not available |')
    expect(markdown).toContain('brew install gitleaks')
    expect(markdown).toContain('| bandit | ok |')
  })

  /**
   * The clones under a duplication grade are its evidence, and one clone is one
   * finding — so the sentence has to read as well at one as at seven.
   */
  it('counts the clones under the duplication grade, grammatical at every count', () => {
    expect(evidence(0)).toContain('12.5% of tokens duplicated.')
    expect(evidence(1)).toContain(
      '12.5% of tokens duplicated; the clone below is the evidence, not the grade.',
    )
    expect(evidence(7)).toContain(
      '12.5% of tokens duplicated; the 7 clones below are the evidence, not the grade.',
    )
  })

  it('reports the measurement that drove each ratio grade', async () => {
    const markdown = await render('sec-basic')
    expect(markdown).toContain('47.0% of tokens duplicated')
    expect(markdown).toContain('0 of 5 functions over cognitive complexity 15')
  })

  /**
   * `languages` counts a finding under the language owning its file, so
   * zizmor's workflow findings belong to neither. The table has to add up.
   */
  it('breaks findings down by language, with a bucket for the files no language owns', async () => {
    const markdown = await render('sec-basic')
    expect(markdown).toContain('### Findings by language')
    expect(markdown).toContain('| other | 4 |')
    // One language and nothing else: the table would say only what the grades did.
    expect(await render('js-basic')).not.toContain('### Findings by language')
  })

  /**
   * A grade is read against what was measured, so what the scan did not look at
   * belongs beside the grades — and the sentences are the run's own, quoted
   * verbatim rather than composed a second time here.
   */
  it('notes the scan’s scope under the grades, above the language breakdown', () => {
    const scope =
      'scan scope: 1 file under .crank/ was not scanned ' +
      '(hidden directories other than .github/ are not source)'
    const standby = 'lint graded by oxlint: the repo’s own ESLint could not run'
    const markdown = renderReportMarkdown(
      makeReport({
        warnings: [scope, standby],
        findings: [
          makeFinding({ id: 'a', file: 'src/a.ts' }),
          makeFinding({ id: 'b', file: 'src/b.py' }),
        ],
      }),
    )

    // `buildReport` sorts the warnings, so the block is asserted by membership.
    expect(markdown).toContain('**Scan notes.**\n\n- ')
    expect(markdown).toContain(`- ${scope}\n`)
    expect(markdown).toContain(`- ${standby}\n`)
    expect(markdown.split('**Scan notes.**')).toHaveLength(2)
    expect(markdown.indexOf('**Scan notes.**')).toBeGreaterThan(markdown.indexOf('## Grades'))
    expect(markdown.indexOf('**Scan notes.**')).toBeLessThan(
      markdown.indexOf('### Findings by language'),
    )
  })

  it('renders no scan-notes block when the run had nothing to note', () => {
    expect(renderReportMarkdown(makeReport({ warnings: [] }))).not.toContain('**Scan notes.**')
  })

  it('gives a whole-file finding no line number to go looking at', async () => {
    const markdown = await render('js-basic')
    expect(markdown).toContain('`src/unformatted.js` `prettier/format`')
    expect(markdown).not.toContain('src/unformatted.js:1')
  })

  it('offers remediation where there is something to remediate, and not otherwise', async () => {
    const markdown = await render('js-basic')
    expect(section(markdown, '## lint — F')).toContain('**Remediation.**')
    expect(section(markdown, '## duplication — A')).not.toContain('**Remediation.**')
  })

  it('links the raw evidence with run-directory-relative paths', async () => {
    expect(await render('js-basic')).toContain(
      '[raw/root/oxlint.sarif.json](raw/root/oxlint.sarif.json)',
    )
  })

  it('keeps a tool’s free-text reason from breaking the tool table', () => {
    const report = makeReport({
      runs: [
        {
          record: {
            tool: 'oxlint',
            category: 'lint',
            scope: 'js-ts',
            project: '.',
            repoWide: false,
            rollupOnly: false,
            pinnedVersion: '1.77.0',
            detection: null,
            result: { state: 'error', findings: [], rawFiles: [], reason: 'a | b\nc' },
            durationMs: 1,
            standby: false,
          },
          raw: [],
        },
      ],
    })
    const line = renderReportMarkdown(report)
      .split('\n')
      .find((row) => row.startsWith('| oxlint |'))
    expect(line).toBe('| oxlint | error | [default-config] | — (pinned 1.77.0) | a \\| b c |')
  })

  /**
   * The same runner in four packages, unavailable for the same reason, is one
   * fact. A tool table holding two rows a reader cannot tell apart is the noise
   * the collapse exists to remove, whatever the row counts happen to be.
   */
  it.each(FIXTURES)('renders no two identical tool rows under a category for %s', async (name) => {
    const tables = toolTables(await render(name))
    expect(tables.size).toBeGreaterThan(0)
    for (const [category, rows] of tables) {
      expect([category, new Set(rows).size]).toEqual([category, rows.length])
    }
  })

  /**
   * Collapsing is removal and nothing else: no count marker, no suffix, no list
   * of the projects that were folded in. The table reads as if the run had
   * happened once.
   */
  it('adds no count, suffix or project list to a collapsed row', () => {
    const one = renderReportMarkdown(makeReport({ runs: [missingScan('packages/api')] }))
    const many = renderReportMarkdown(
      makeReport({
        runs: [missingScan('packages/api'), missingScan('packages/web'), missingScan('packages/z')],
      }),
    )
    expect(toolTable(many, 'security')).toBe(toolTable(one, 'security'))
    expect(toolTable(one, 'security')).toContain('| opengrep | not available |')
  })

  /**
   * The evidence line is the reader's way back to what each run actually
   * produced, so it reads the uncollapsed list: one row above it, one link per
   * run under it.
   */
  it('links every run’s raw output under a collapsed tool row', () => {
    const markdown = renderReportMarkdown(
      makeReport({
        runs: [
          lintScan('packages/api', ['raw/packages/api/oxlint.sarif.json']),
          lintScan('packages/web', ['raw/packages/web/oxlint.sarif.json']),
        ],
      }),
    )
    expect(toolTable(markdown, 'lint').split('\n')).toEqual([
      '| oxlint | ok | [default-config] | 1.77.0 | — |',
    ])
    expect(markdown).toContain(
      'Evidence: [raw/packages/api/oxlint.sarif.json](raw/packages/api/oxlint.sarif.json) · ' +
        '[raw/packages/web/oxlint.sarif.json](raw/packages/web/oxlint.sarif.json)',
    )
  })

  it('caps the findings it lists and says where the rest are', () => {
    const findings = Array.from({ length: 30 }, (_, index) =>
      makeFinding({ id: `f${index}`, file: `src/f${index}.ts` }),
    )
    const markdown = renderReportMarkdown(
      makeReport({
        categories: { ...allGraded(), lint: { status: 'graded', grade: 'F' } },
        findings,
      }),
      { maxFindingsPerCategory: 5 },
    )
    expect(markdown).toContain('**Findings** (30)')
    expect(markdown).toContain('… 25 more in `report.json`.')
  })
})

/**
 * The per-project half of the report (spec's per-project grades): the rollup
 * first, then every project in path order, each graded on its own findings and
 * its own measurements. A single-project repo is the rollup, so it gets no
 * section at all — the goldens above are what a one-project repo renders, and
 * the last test here holds them to it with a project list of exactly one.
 */
describe('renderReportMarkdown projects', () => {
  const REPO_SCOPED: CategoryState = { status: 'not-assessed', reason: 'repo-scoped' }

  const report = makeReport({
    categories: { ...allGraded('A'), lint: { status: 'graded', grade: 'D' } },
    projects: [
      makeProjectScan({
        project: projectAt('packages/web'),
        categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'F' } },
      }),
      makeProjectScan({
        project: projectAt('packages/api'),
        categories: { ...allNotAssessed(), security: REPO_SCOPED },
      }),
    ],
    rootShell: { declaredBy: ['package.json', 'pnpm-workspace.yaml'] },
    findings: [
      makeFinding({ id: 'w1', file: 'packages/web/src/a.ts', project: 'packages/web' }),
      makeFinding({
        id: 'w2',
        severity: 'error',
        file: 'packages/web/src/b.ts',
        project: 'packages/web',
      }),
      makeFinding({ id: 'a1', file: 'packages/api/api/main.py', project: 'packages/api' }),
    ],
    runs: [
      {
        record: {
          tool: 'oxlint',
          category: 'lint',
          scope: 'js-ts',
          project: 'packages/web',
          repoWide: false,
          rollupOnly: false,
          pinnedVersion: '1.77.0',
          detection: {
            reason: 'dependency',
            configFiles: [],
            // The hoisted case: the root manifest is what makes this package own it.
            ownedVia: 'package.json',
            installed: true,
            version: '1.70.0',
          },
          result: { state: 'ok', findings: [], rawFiles: [], toolVersion: '1.70.0' },
          durationMs: 1,
          standby: false,
        },
        raw: [],
      },
    ],
  })

  const markdown = renderReportMarkdown(report)

  it('puts the projects after the rollup, in path order', () => {
    expect(markdown.indexOf('## Projects')).toBeGreaterThan(markdown.indexOf('## Grades'))
    expect(markdown.indexOf('### packages/api')).toBeGreaterThan(markdown.indexOf('## Projects'))
    expect(markdown.indexOf('### packages/web')).toBeGreaterThan(
      markdown.indexOf('### packages/api'),
    )
  })

  it('grades each project on its own findings, not the repo’s', () => {
    expect(projectBlock(markdown, '### packages/web')).toContain(
      '| lint | F | 2 graded findings (1 error, 1 warning), weighted total 6',
    )
    // The rollup's own basis counts all three, and is where it always was.
    expect(section(markdown, '## Grades')).toContain('| lint | D | 3 graded findings')
  })

  it('gives every project all eight category states, in priority order', () => {
    for (const project of ['### packages/api', '### packages/web']) {
      const [, table = ''] = projectBlock(markdown, project).split('| Category | Grade | Basis |\n')
      const rows = (table.split('\n\n')[0] ?? '').split('\n').slice(1)
      expect(rows.map((row) => row.split(' | ')[0]?.slice(2))).toEqual(
        CATEGORIES.map((category) => CATEGORY_LABELS[category]),
      )
    }
  })

  it('says a repo-scoped category was answered for the repo, not for the project', () => {
    expect(projectBlock(markdown, '### packages/api')).toContain(
      '| security | not assessed | repo-scoped |',
    )
    expect(markdown).toContain(
      'A category marked `repo-scoped` is one a repo-spanning scan answered',
    )
  })

  it('names each project’s manifests, languages and what made it own a tool', () => {
    const web = projectBlock(markdown, '### packages/web')
    expect(web).toContain('`packages/web/package.json` · js-ts')
    expect(web).toContain('| oxlint | lint | dependency | package.json | 1.70.0 |')
    expect(projectBlock(markdown, '### packages/api')).toContain('declares no tool of its own')
  })

  it('records the workspace-shell root as a note rather than as a project', () => {
    expect(markdown).toContain('The repo root is a workspace shell (declared by package.json')
    expect(markdown).not.toContain('### repo root')
  })

  /**
   * A workspace with one package in it still has a root a reader would otherwise
   * take for the project they are looking at.
   */
  it('still explains the shell root in a one-package workspace', () => {
    const single = renderReportMarkdown(
      makeReport({
        projects: [makeProjectScan({ project: projectAt('packages/web') })],
        rootShell: { declaredBy: ['pnpm-workspace.yaml'] },
      }),
    )
    expect(single).toContain('The repo root is a workspace shell (declared by pnpm-workspace.yaml)')
    // …in a sentence written for one project rather than for several.
    expect(single).toContain('1 project, graded on its own files')
    expect(single).not.toContain('1 project, each graded')
  })

  it('says "each" only where there is more than one project', () => {
    expect(markdown).toContain('2 projects, each graded on its own files')
  })

  it('says the grades are the repo as a whole when nothing scoped the run', () => {
    expect(markdown).toContain('the grades above are the repo as a whole')
  })

  /**
   * Under `--project` the rollup is computed over the selection, so the sentence
   * that calls it the repo would be describing a number this run never took.
   */
  it('says which projects the grades cover when the run was scoped', () => {
    const scoped = renderReportMarkdown(
      makeReport({
        scopedTo: ['packages/web', 'packages/api'],
        projects: [
          makeProjectScan({ project: projectAt('packages/web') }),
          makeProjectScan({ project: projectAt('packages/api') }),
        ],
      }),
    )
    expect(scoped).toContain(
      'the grades above are the 2 projects this run was scoped to ' +
        '(`packages/api`, `packages/web`)',
    )
    expect(scoped).not.toContain('the repo as a whole')
  })

  it('leaves a single-project report exactly as it was', async () => {
    const golden = await readGoldenReport('js-basic')
    const one: ReportProject = {
      path: '.',
      manifests: ['package.json'],
      languages: ['js-ts'],
      categories: golden.categories,
      metrics: golden.metrics,
      toolchain: [],
    }
    expect(renderReportMarkdown({ ...golden, projects: [one] })).toBe(renderReportMarkdown(golden))
    await expectGolden(
      'js-basic.report.md',
      normalizeMarkdown(renderReportMarkdown({ ...golden, projects: [one] }), '<repo>'),
    )
  })
})
