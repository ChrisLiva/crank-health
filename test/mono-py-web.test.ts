import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import { reportFindings } from '../src/render/json.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'

const SCAN_TIMEOUT_MS = 180_000

/**
 * The layout crank-factory has: a Python root, a JS app under `web/` that owns
 * Biome, and no `package.json` above it. Both knip and Biome take their cwd as
 * the project root — knip reads entry points from the `package.json` there,
 * Biome reads its config there and rejects one it meets below — so a runner
 * that runs every tool from the repo root gets a crash from each. The fix is
 * to run them from the directory that is their root, and this is the assertion
 * that the answer then reaches the report under the right paths.
 */
describe('quick scan of the mono-py-web fixture', () => {
  let fixture: FixtureRepo
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('mono-py-web')
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  const record = (tool: string, project: string) =>
    scan.report.tools.find((row) => row.tool === tool && row.project === project)

  /**
   * The enum member is the finding only knip makes — fallow names the unused
   * export in `orphan.js` too, and the anchor dedupe keeps one row — so it is
   * the one that proves knip's `src/mode.ts` came back as `web/src/mode.ts`.
   */
  it('runs knip from the package that names its entry points', () => {
    expect(record('knip', 'web')).toMatchObject({ state: 'ok', reason: null })
    expect(
      reportFindings(scan.report)
        .filter((finding) => finding.tool === 'knip')
        .map((finding) => [finding.rule, finding.file, finding.message]),
    ).toEqual([['knip/unused-enumMembers', 'web/src/mode.ts', 'Export `Slow` is never used']])
  })

  it('says knip cannot run where no package.json exists, rather than crashing', () => {
    expect(record('knip', '.')).toMatchObject({
      state: 'not-available',
      reason:
        'no package.json in the repo root or above it, so knip has no entry points to resolve',
    })
  })

  it('runs Biome from the directory of its config, honouring the repo’s ignore file', () => {
    expect(record('biome-lint', 'web')).toMatchObject({ state: 'ok', reason: null })
    expect(record('biome-format', 'web')).toMatchObject({ state: 'ok', reason: null })
    const biome = reportFindings(scan.report).filter((finding) => finding.tool.startsWith('biome-'))
    expect(biome.map((finding) => [finding.tool, finding.rule, finding.file])).toEqual([
      ['biome-lint', 'lint/suspicious/noDoubleEquals', 'web/src/both.js'],
      ['biome-format', 'biome/format', 'web/src/unformatted.js'],
    ])
    expect(biome.every((finding) => finding.provenance === 'repo-config')).toBe(true)
  })

  it('leaves the target repo untouched', async () => {
    expect(await fixture.status()).toBe('')
  })
})
