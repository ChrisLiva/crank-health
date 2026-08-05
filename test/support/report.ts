import { readFile } from 'node:fs/promises'
import type { Report } from '../../src/render/json.ts'
import { TIMINGS_MARKER } from '../../src/render/report-md.ts'

/**
 * The determinism contract in executable form (spec §6): two runs of the same
 * crank-health on the same commit differ only in how long they took and where
 * the repo happened to be checked out. Everything else must be byte-identical,
 * so those two things — and only those two — are normalized away here.
 */
export function normalizeReport(json: string): string {
  const report: Record<string, unknown> = JSON.parse(json)
  delete report['timings']
  const repo = report['repo'] as { path: string } | undefined
  if (repo !== undefined) repo.path = '<repo>'
  return `${JSON.stringify(report, null, 2)}\n`
}

/**
 * The same normalization for the markdown artifacts. `report.md` quarantines
 * everything a clock produced behind {@link TIMINGS_MARKER}, so cutting there
 * leaves exactly the part two runs must agree on; `agent.md` has no trailer and
 * is only path-normalized.
 */
export function normalizeMarkdown(markdown: string, repoPath: string): string {
  const [body = ''] = markdown.split(TIMINGS_MARKER)
  return `${body.replaceAll(repoPath, '<repo>').trimEnd()}\n`
}

/** Timings a real run would vary; see {@link normalizeReport}. */
const FIXED_TIMINGS = {
  generatedAt: '2024-01-01T00:00:00.000Z',
  durationMs: 1234,
  tools: [],
} as const

/**
 * A checked-in golden `report.json`, back in {@link Report} form.
 *
 * The renderers are pure functions of a report, so their goldens are recorded
 * against these — no tool has to run, and the result is the same on every
 * machine. That the pipeline really writes what they render is asserted by the
 * fixture scans.
 */
export async function readGoldenReport(name: string): Promise<Report> {
  const url = new URL(`../golden/${name}.report.json`, import.meta.url)
  const golden = JSON.parse(await readFile(url, 'utf8')) as Report
  return { ...golden, timings: FIXED_TIMINGS }
}
