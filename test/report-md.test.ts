import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { renderReportMarkdown } from '../src/render/report-md.ts'
import { TIMINGS_MARKER } from '../src/render/report-md.ts'
import { allGraded, makeFinding, makeReport } from './factories.ts'
import { normalizeMarkdown, readGoldenReport } from './support/report.ts'

/**
 * `report.md` (spec §9). The renderer is a pure function of a `Report`, so the
 * goldens are recorded against the checked-in golden `report.json` files rather
 * than against a scan: same bytes on every machine, no tool has to run, and a
 * change in the report *is* a change in the golden. That the pipeline writes
 * exactly what this renders is asserted in the fixture scans.
 */

const FIXTURES = ['js-basic', 'py-basic', 'sec-basic'] as const

async function goldenMarkdown(name: string): Promise<string> {
  return readFile(new URL(`./golden/${name}.report.md`, import.meta.url), 'utf8')
}

/** The golden form: the timings trailer cut, the repo path already `<repo>`. */
async function render(name: string): Promise<string> {
  return normalizeMarkdown(renderReportMarkdown(await readGoldenReport(name)), '<repo>')
}

/** One `##` section, from its heading to the next one. */
function section(markdown: string, heading: string): string {
  const [, rest = ''] = markdown.split(heading)
  return rest.split('\n## ')[0] ?? ''
}

describe('renderReportMarkdown', () => {
  it.each(FIXTURES)('matches the golden report.md for %s', async (name) => {
    expect(await render(name)).toBe(await goldenMarkdown(name))
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
    expect(await render('js-basic')).toContain('[raw/oxlint.sarif.json](raw/oxlint.sarif.json)')
  })

  it('keeps a tool’s free-text reason from breaking the tool table', () => {
    const report = makeReport({
      runs: [
        {
          record: {
            tool: 'oxlint',
            category: 'lint',
            scope: 'js-ts',
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
