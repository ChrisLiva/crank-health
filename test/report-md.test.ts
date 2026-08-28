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
  makeProject,
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

const FIXTURES = [
  'cs-basic',
  'go-basic',
  'js-basic',
  'mono-js',
  'mono-mixed',
  'py-basic',
  'sec-basic',
] as const

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

/** One project's owned run of a tool, with the artifact that decided it. */
function ownedScan(project: string, tool: string, ownedVia: string): ResolvedRun {
  return {
    record: {
      tool,
      category: tool === 'oxlint' ? 'lint' : 'format',
      scope: 'js-ts',
      project,
      repoWide: false,
      rollupOnly: false,
      pinnedVersion: '1.0.0',
      detection: {
        reason: 'dependency',
        configFiles: [],
        ownedVia,
        installed: true,
        version: '1.0.0',
      },
      result: { state: 'ok', findings: [], rawFiles: [], toolVersion: '1.0.0' },
      durationMs: 1,
      standby: false,
    },
    raw: [],
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

  /**
   * A page of advisory rows buries the graded ones above it. What a reader
   * needs is how many there are, what they are made of, enough of them to
   * recognize the shape, and where the rest are.
   */
  it('collapses advisory findings to a count, a shape, three exemplars and a pointer', () => {
    const markdown = renderReportMarkdown(
      makeReport({
        categories: { ...allGraded(), lint: { status: 'graded', grade: 'C' } },
        findings: [
          ...Array.from({ length: 5 }, (_, index) =>
            makeFinding({
              id: `s${index}`,
              tool: 'ruff',
              rule: 'S101',
              file: `src/t${index}.py`,
              gradeScope: false,
            }),
          ),
          ...Array.from({ length: 2 }, (_, index) =>
            makeFinding({
              id: `b${index}`,
              tool: 'bandit',
              rule: 'B404',
              file: `src/c${index}.py`,
              gradeScope: false,
            }),
          ),
        ],
      }),
    )

    const lint = section(markdown, '## lint — C')
    expect(lint).toContain(
      '**Advisory findings** (7) — reported, not counted toward the grade: ' +
        '5 × `ruff` `S101`, 2 × `bandit` `B404`.',
    )
    expect(lint.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(3)
    expect(lint).toContain('All 7 are in `report.json`, under `advisories`.')
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

  /**
   * A letter on its own is not checkable: `lint: D` says nothing about whether
   * the repo has forty warnings in a thousand lines or four hundred in ten
   * thousand. The two numbers the formula divided go beside the letter.
   */
  it('annotates each grade with the numbers its formula divided', () => {
    const markdown = renderReportMarkdown(
      makeReport({
        categories: {
          ...allNotAssessed(),
          security: { status: 'graded', grade: 'C' },
          duplication: { status: 'graded', grade: 'A' },
          lint: { status: 'graded', grade: 'D' },
          format: { status: 'graded', grade: 'B' },
        },
        gradeBasis: {
          security: { value: 3, denominator: null, unit: 'graded findings' },
          duplication: { value: 4.72, denominator: null, unit: '% of tokens duplicated' },
          lint: { value: 56, denominator: 0.784, unit: 'weighted findings per KLOC' },
          format: { value: 1, denominator: 12, unit: 'files failing the formatter' },
        },
      }),
    )

    const grades = gradeRows(section(markdown, '## Grades')).map((line) => line.split(' | ')[1])
    expect(grades).toEqual([
      'C — 3 graded findings',
      'not assessed',
      'not assessed',
      'not assessed',
      'A — 4.7% of tokens duplicated',
      'D — 56 weighted findings per 0.78 KLOC',
      'B — 1 of 12 files failing the formatter',
      'not assessed',
    ])

    // …and the noun agrees with the count it belongs to — which in the `of`
    // shape is the denominator, not the value.
    const singular = renderReportMarkdown(
      makeReport({
        categories: {
          ...allNotAssessed(),
          security: { status: 'graded', grade: 'C' },
          lint: { status: 'graded', grade: 'D' },
          format: { status: 'graded', grade: 'B' },
        },
        gradeBasis: {
          security: { value: 1, denominator: null, unit: 'graded findings' },
          lint: { value: 1, denominator: 0.8, unit: 'weighted findings per KLOC' },
          format: { value: 1, denominator: 1, unit: 'files failing the formatter' },
        },
      }),
    )
    expect(
      gradeRows(section(singular, '## Grades'))
        .map((line) => line.split(' | ')[1])
        .filter((basis) => basis !== 'not assessed'),
    ).toEqual([
      'C — 1 graded finding',
      'D — 1 weighted finding per 0.8 KLOC',
      'B — 1 of 1 file failing the formatter',
    ])
  })

  /**
   * A grade is read against what was measured, so what the scan did not look at
   * belongs beside the grades — and the sentences are the run's own, quoted
   * verbatim rather than composed a second time here.
   */
  it('notes the scan’s scope under the grades, above the language breakdown', () => {
    const scope =
      'scan scope: 1 file under a hidden directory was not analyzed by language tools; ' +
      'repo-scoped scanners (gitleaks, osv-scanner) scan the full tree'
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

  /**
   * How a category is graded and what fixing it means are the same sentences in
   * every report ever generated. Repeated under eight headings they are most of
   * the document; said once at the end they are a reference a reader consults.
   */
  it('states the bands and the remediation once each, in a reference section', async () => {
    const markdown = await render('sec-basic')
    expect(markdown.split('any critical → F')).toHaveLength(2)
    expect(markdown.split('Treat a leaked credential as compromised')).toHaveLength(2)
    expect(markdown.indexOf('## Reference')).toBeGreaterThan(markdown.indexOf('## test quality'))
    expect(section(markdown, '## security — D')).not.toContain('Graded on ')
    expect(section(markdown, '## lint — F')).not.toContain('**Remediation.**')
  })

  /** A `--only` run has no reference rows for the categories nobody asked about. */
  it('names only the categories it graded in the reference section', () => {
    const reference = section(
      renderReportMarkdown(
        makeReport({
          selected: ['lint'],
          categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'B' } },
        }),
      ),
      '## Reference',
    )
    expect(reference).toContain('| lint |')
    expect(reference).not.toContain('| security |')
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
      // A repo-spanning run — the duplication pass — renders as the per-project
      // rows it collapses into, and contributes no project of its own, because
      // `repo` is not one.
      const named = rows.flatMap((row) => /\(([^()]*)\)\s*\|$/.exec(row)?.[1]?.split(', ') ?? [])
      expect([category, named]).toEqual([category, expect.not.arrayContaining(['repo'])])
    }
  })

  /**
   * In a single-project repo, collapsing is removal and nothing else: no count
   * marker, no suffix, no list of the projects that were folded in. Every row is
   * that one project's, so naming it would be a tautology on every line.
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
   * In a monorepo it is removal *and* attribution: the one surviving row says
   * which packages it stands in for, because "opengrep is not on PATH" over two
   * packages of a workspace is not the same fact as over all of them — and a row
   * a reader *can* tell apart keeps its own, shorter list beside it.
   */
  it('names the projects a collapsed row stands in for, in a monorepo', () => {
    const scan = missingScan('packages/web')
    const gitleaks: ResolvedRun = {
      ...scan,
      record: {
        ...scan.record,
        tool: 'gitleaks',
        result: { ...scan.record.result, reason: 'gitleaks is not on PATH' },
      },
    }
    const markdown = renderReportMarkdown(
      makeReport({
        projects: [
          makeProjectScan({ project: projectAt('packages/api') }),
          makeProjectScan({ project: projectAt('packages/web') }),
        ],
        runs: [missingScan('packages/web'), gitleaks, missingScan('packages/api')],
      }),
    )
    expect(toolTable(markdown, 'security').split('\n')).toEqual([
      '| gitleaks | not available | [default-config] | — (pinned 1.26.0) | ' +
        'gitleaks is not on PATH (packages/web) |',
      '| opengrep | not available | [default-config] | — (pinned 1.26.0) | ' +
        'opengrep is not on PATH (packages/api, packages/web) |',
    ])
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

  /**
   * The repo-wide duplication pass and the per-project one are two runs over
   * one report file, and a reader offered the same link twice reads it as two
   * pieces of evidence.
   */
  it('names each piece of raw evidence once, however many runs produced it', () => {
    const markdown = renderReportMarkdown(
      makeReport({
        runs: [
          lintScan('packages/api', ['raw/repo/oxlint.sarif.json']),
          lintScan('packages/web', ['raw/repo/oxlint.sarif.json']),
        ],
      }),
    )
    expect(markdown).toContain(
      'Evidence: [raw/repo/oxlint.sarif.json](raw/repo/oxlint.sarif.json)\n',
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

  it('grades each project on its own findings, not the repo’s', () => {
    expect(projectBlock(markdown, '### packages/web')).toContain(
      '| lint | F | 2 graded findings (1 error, 1 warning), weighted total 6',
    )
    // The rollup's own basis counts all three, and is where it always was.
    expect(section(markdown, '## Grades')).toContain('| lint | D | 3 graded findings')
  })

  it('says a repo-scoped category was answered for the repo, not for the project', () => {
    expect(projectBlock(markdown, '### packages/api')).toContain(
      '| security | not assessed | repo-scoped |',
    )
    expect(markdown).toContain(
      'A category marked `repo-scoped` is one a repo-spanning scan answered',
    )
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

  /**
   * In a workspace every package inherits the root's toolchain, so a full table
   * per package is the same rows printed n times and the one row that differs
   * is invisible in the middle of them.
   */
  describe('toolchain tables against the root', () => {
    const workspace = renderReportMarkdown(
      makeReport({
        projects: [
          makeProjectScan({ project: makeProject(['package.json', 'src/a.ts']) }),
          makeProjectScan({ project: projectAt('packages/api') }),
          makeProjectScan({ project: projectAt('packages/web') }),
        ],
        runs: [
          ownedScan('.', 'oxlint', 'package.json'),
          ownedScan('packages/api', 'oxlint', 'package.json'),
          ownedScan('packages/web', 'oxlint', 'package.json'),
          ownedScan('packages/web', 'prettier', 'packages/web/package.json'),
        ],
      }),
    )

    it('renders the root’s own toolchain in full', () => {
      expect(projectBlock(workspace, '### repo root')).toContain(
        '| oxlint | lint | dependency | package.json | 1.0.0 |',
      )
    })

    it('renders only the rows a project does not share with the root', () => {
      const web = projectBlock(workspace, '### packages/web')
      expect(web).toContain('As `repo root`, except:')
      expect(web).toContain(
        '| prettier | format | dependency | packages/web/package.json | 1.0.0 |',
      )
      expect(web).not.toContain('| oxlint |')
    })

    it('says so in a sentence where a project shares the root’s toolchain exactly', () => {
      const api = projectBlock(workspace, '### packages/api')
      expect(api).toContain('The same toolchain as `repo root`.')
      expect(api).not.toContain('| Tool |')
    })
  })

  it('leaves a single-project report exactly as it was', async () => {
    const golden = await readGoldenReport('js-basic')
    const one: ReportProject = {
      path: '.',
      manifests: ['package.json'],
      languages: ['js-ts'],
      categories: golden.categories,
      gradeBasis: golden.gradeBasis,
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

/**
 * A `--only` run (spec §9): the seven categories nobody asked about are one
 * sentence, not seven table rows and seven "not assessed" sections. The
 * categories a run *did* ask about keep everything they had, degraded state and
 * reason included — that is the difference between "nobody looked" and "nothing
 * to measure".
 */
describe('renderReportMarkdown under --only', () => {
  const NOTE =
    'Not assessed: not selected by `--only` — security, types, dead code, complexity, ' +
    'duplication, format, test quality'

  const report = makeReport({
    selected: ['lint'],
    categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'B' } },
  })
  const markdown = renderReportMarkdown(report)

  it('grades only the categories the run was asked about', () => {
    expect(gradeRows(section(markdown, '## Grades'))).toEqual([
      '| lint | B | Nothing counted toward the grade. |',
    ])
  })

  it('gives the categories it left out no section of their own', () => {
    expect(categoryHeadings(markdown)).toEqual(['## lint — B'])
  })

  it('puts that line under the grades table and above the scan notes', () => {
    const noted = renderReportMarkdown(
      makeReport({
        selected: ['lint'],
        categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'B' } },
        warnings: ['oxlint: graded lint on its default config'],
      }),
    )
    expect(noted.indexOf(NOTE)).toBeGreaterThan(noted.indexOf('| lint | B |'))
    expect(noted.indexOf(NOTE)).toBeLessThan(noted.indexOf('**Scan notes.**'))
  })

  it('leaves the same categories out of every project’s table', () => {
    const mono = renderReportMarkdown(
      makeReport({
        selected: ['lint'],
        categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'B' } },
        projects: [
          makeProjectScan({
            project: projectAt('packages/web'),
            categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'F' } },
          }),
          makeProjectScan({
            project: projectAt('packages/api'),
            categories: { ...allNotAssessed(), lint: { status: 'graded', grade: 'A' } },
          }),
        ],
      }),
    )
    expect(gradeRows(projectBlock(mono, '### packages/web'))).toEqual([
      '| lint | F | Nothing counted toward the grade. |',
    ])
    expect(gradeRows(projectBlock(mono, '### packages/api'))).toEqual([
      '| lint | A | Nothing counted toward the grade. |',
    ])
  })

  it('says nothing about --only when every category was selected', () => {
    const all = renderReportMarkdown(makeReport({ categories: allGraded() }))
    expect(all).not.toContain('not selected by `--only`')
    expect(categoryHeadings(all)).toHaveLength(CATEGORIES.length)
  })

  /**
   * A category nothing could assess is not a category nobody asked about: it
   * keeps its row, its section and the reason it gives, verbatim.
   */
  it('keeps a selected category nothing assessed, reason and all', () => {
    const deferred = renderReportMarkdown(
      makeReport({
        categories: {
          ...allGraded(),
          'test-quality': { status: 'not-assessed', reason: 'not assessed — run `--deep`' },
        },
      }),
    )
    expect(deferred).toContain('## test quality — not assessed')
    expect(deferred).toContain('Not graded: not assessed — run `--deep`')
    expect(gradeRows(section(deferred, '## Grades'))).toContain(
      '| test quality | not assessed | not assessed — run `--deep` |',
    )

    // Structural, not textual: the selection says which categories were left
    // out, so a selected category whose reason merely *reads* like a skip keeps
    // its row and its section rather than being folded into the line above.
    const trap = renderReportMarkdown(
      makeReport({
        selected: ['lint', 'security'],
        categories: {
          ...allNotAssessed(),
          security: { status: 'not-assessed', reason: 'not selected by `--only`' },
        },
      }),
    )
    expect(gradeRows(section(trap, '## Grades'))).toContain(
      '| security | not assessed | not selected by `--only` |',
    )
    expect(categoryHeadings(trap)).toContain('## security — not assessed')
  })
})

/** The data rows of the grades table inside `block`, header and separator dropped. */
function gradeRows(block: string): string[] {
  const [, rest = ''] = block.split('| Category | Grade | Basis |\n')
  const [body = ''] = rest.split('\n\n')
  return body.split('\n').filter((line) => line !== '' && !line.startsWith('| --- |'))
}

/** Every `## <category> — <state>` heading, in the order the report prints them. */
function categoryHeadings(markdown: string): string[] {
  const headings = CATEGORIES.map((category) => `## ${CATEGORY_LABELS[category]} — `)
  return markdown.split('\n').filter((line) => headings.some((heading) => line.startsWith(heading)))
}
