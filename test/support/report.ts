import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
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
 * The determinism contract for a `--pr` report, which has two more varying
 * things in it: the commit shas of a scripted history. They are deterministic
 * for a given fixture, but recording them in a golden would mean regenerating
 * three files whenever a fixture's contents move by a byte, so they are
 * normalized away and the shas themselves are asserted directly instead.
 */
export function normalizePrReport(json: string): string {
  return withoutShas(normalizeReport(json))
}

/** {@link normalizeMarkdown} for a `--pr` artifact; see {@link normalizePrReport}. */
export function normalizePrMarkdown(markdown: string, repoPath: string): string {
  return withoutShas(normalizeMarkdown(markdown, repoPath))
}

/**
 * Commit shas, full and abbreviated, replaced by placeholders. Finding ids are
 * 16 hex characters and so match neither pattern.
 */
export function withoutShas(text: string): string {
  return text.replaceAll(/\b[0-9a-f]{40}\b/g, '<sha>').replaceAll(/\b[0-9a-f]{7,12}\b/g, '<short>')
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

/**
 * Re-capture mode: `scripts/capture-goldens.sh` sets this, and only that script
 * should — it is the one place that guarantees the sanitized `PATH` the goldens
 * are recorded against, and a golden captured on a machine with a release-binary
 * scanner installed would record a toolchain no other machine has.
 */
const CAPTURING = process.env['CRANK_CAPTURE_GOLDENS'] === '1'

/**
 * One golden artifact: the checked-in bytes are the assertion, except under
 * {@link CAPTURING}, where this run's bytes become the new golden.
 *
 * Every golden comparison goes through here so that re-capturing is exactly the
 * suite that checks them, run with one variable set — a separate capture path
 * could record something the tests never assert.
 *
 * @param name file name under `test/golden/`, e.g. `js-basic.report.json`
 */
export async function expectGolden(name: string, actual: string): Promise<void> {
  const path = fileURLToPath(new URL(`../golden/${name}`, import.meta.url))
  if (CAPTURING) {
    await writeFile(path, actual, 'utf8')
    return
  }
  expect(actual).toBe(await readFile(path, 'utf8'))
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
  // A report carrying no `gradeBasis` says no category has one — the empty map
  // rather than a missing key, so the renderers read a well-formed report.
  return { ...golden, gradeBasis: golden.gradeBasis ?? {}, timings: FIXED_TIMINGS }
}
