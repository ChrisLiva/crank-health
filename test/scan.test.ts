import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Finding } from '../src/core/types.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { normalizeReport } from './support/report.ts'

/**
 * The four spec-level executable promises, all on the same fixture:
 * every planted finding and nothing else · a golden normalized report ·
 * byte-identity across runs · zero footprint on the target.
 *
 * These drive `runHealthScan` — the same entry point `cli.ts` uses — so what is
 * proven here is what the binary does.
 */

const GOLDEN = fileURLToPath(new URL('./golden/js-basic.report.json', import.meta.url))

/**
 * Every finding planted in `test/fixtures/js-basic`, with the rule oxlint must
 * report for it. `no-accumulating-spread` is a `perf`-class rule, so on our
 * default config it is advisory: reported, not graded (spec §1).
 */
const PLANTED = [
  {
    rule: 'oxc(no-accumulating-spread)',
    file: 'src/accumulate.js',
    startLine: 2,
    severity: 'warning',
    gradeScope: false,
  },
  {
    rule: 'eslint(no-const-assign)',
    file: 'src/const-assign.js',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    rule: 'eslint(no-dupe-keys)',
    file: 'src/dupe-keys.js',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    rule: 'eslint(no-unreachable)',
    file: 'src/unreachable.js',
    startLine: 6,
    severity: 'error',
    gradeScope: true,
  },
] as const

/** Files planted deliberately clean; a finding in one of these is a false positive. */
const CLEAN_FILES = new Set(['src/clean.js', 'src/util/format.js'])

describe('quick scan of the js-basic fixture', () => {
  let fixture: FixtureRepo
  let outside: string
  let json: string
  let findings: readonly Finding[]

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
    outside = await mkdtemp(join(tmpdir(), 'crank-out-'))
    const result = await runHealthScan({ path: fixture.root })
    json = result.json
    findings = result.report.findings
  })

  afterAll(async () => {
    await fixture.remove()
    await rm(outside, { recursive: true, force: true })
  })

  it('finds every planted finding, and nothing else', () => {
    expect(
      findings.map((finding) => ({
        rule: finding.rule,
        file: finding.file,
        startLine: finding.range.startLine,
        severity: finding.severity,
        gradeScope: finding.gradeScope,
      })),
    ).toEqual(PLANTED.map((planted) => ({ ...planted })))
  })

  it('reports no findings in the deliberately clean files', () => {
    expect(findings.filter((finding) => CLEAN_FILES.has(finding.file))).toEqual([])
  })

  it('tags an untooled repo as default-config, run from the pinned version', async () => {
    const report = JSON.parse(json) as {
      tools: { execution: string; provenance: string; version: string; pinned: string }[]
    }
    expect(report.tools).toHaveLength(1)
    expect(report.tools[0]).toMatchObject({
      execution: 'ephemeral-pinned',
      provenance: 'default-config',
      version: '1.77.0',
      pinned: '1.77.0',
    })
    expect(findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
  })

  it('grades lint from the graded findings only, and pins the commit', () => {
    const report = JSON.parse(json) as {
      repo: { commit: string }
      categories: Record<string, { status: string; grade?: string; reason?: string }>
    }
    expect(report.repo.commit).toBe(fixture.commit)
    // Three weighted-5 errors in ~35 lines: far past the D band of 40/KLOC.
    expect(report.categories['lint']).toEqual({ status: 'graded', grade: 'F' })
    expect(report.categories['test-quality']).toEqual({
      status: 'not-assessed',
      reason: 'not assessed — run `--deep`',
    })
  })

  it('matches the golden normalized report', async () => {
    expect(normalizeReport(json)).toBe(await readFile(GOLDEN, 'utf8'))
  })

  it('produces byte-identical output when run twice on the same commit', async () => {
    const second = await runHealthScan({ path: fixture.root })
    expect(normalizeReport(second.json)).toBe(normalizeReport(json))
    expect(second.report.findings.map((finding) => finding.id)).toEqual(
      findings.map((finding) => finding.id),
    )
  })

  it('leaves the target repo clean: the run directory ignores itself', async () => {
    expect(await fixture.status()).toBe('')
    expect(await readdir(join(fixture.root, '.codebase-health'))).toContain('report.json')
  })

  it('writes nothing at all into the repo when --out points elsewhere', async () => {
    await rm(join(fixture.root, '.codebase-health'), { recursive: true, force: true })
    const result = await runHealthScan({ path: fixture.root, out: outside })

    expect(result.outputDir).toBe(outside)
    expect(await fixture.status()).toBe('')
    expect(await readdir(fixture.root)).toEqual(['.git', 'README.md', 'package.json', 'src'])
    expect(await readdir(join(outside, 'raw'))).toEqual(['oxlint.sarif.json'])
  })

  it('keeps raw tool evidence next to the report', async () => {
    const raw = await readFile(join(outside, 'raw', 'oxlint.sarif.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: '2.1.0' })
  })
})

describe('quick scan of a repo that owns oxlint but has not installed it', () => {
  it('honours the repo config, ephemerally, and grades what that config flags', async () => {
    const fixture = await createFixtureRepo('js-owned')
    try {
      const result = await runHealthScan({ path: fixture.root })

      expect(result.report.tools[0]).toMatchObject({
        execution: 'ephemeral-pinned',
        provenance: 'repo-config',
        version: '1.77.0',
        state: 'ok',
        detection: {
          reason: 'config+dependency',
          configFiles: ['.oxlintrc.json'],
          installed: false,
          version: null,
        },
      })
      // Their config turns correctness off and one style rule on; a repo is
      // graded on the standard it chose for itself, style rules included.
      expect(
        result.report.findings.map((finding) => ({
          rule: finding.rule,
          severity: finding.severity,
          provenance: finding.provenance,
          gradeScope: finding.gradeScope,
        })),
      ).toEqual([
        {
          rule: 'unicorn(prefer-ternary)',
          severity: 'warning',
          provenance: 'repo-config',
          gradeScope: true,
        },
      ])
      expect(await fixture.status()).toBe('')
    } finally {
      await fixture.remove()
    }
  })
})

describe('quick scan of a repo that owns oxlint', () => {
  it('runs the repo-installed binary with the repo config', async () => {
    const out = await mkdtemp(join(tmpdir(), 'crank-self-'))
    try {
      const result = await runHealthScan({
        path: fileURLToPath(new URL('..', import.meta.url)),
        out,
        only: ['lint'],
      })
      expect(result.report.tools[0]).toMatchObject({
        tool: 'oxlint',
        execution: 'repo-installed',
        provenance: 'repo-config',
        state: 'ok',
        detection: {
          reason: 'config+dependency',
          configFiles: ['.oxlintrc.json'],
          installed: true,
        },
      })
      expect(result.report.categories['format']).toEqual({
        status: 'not-assessed',
        reason: 'not selected by --only',
      })
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('a repo whose own linter is broken', () => {
  it('reports the category as error and still writes a complete report', async () => {
    const fixture = await repoWithBrokenOxlint('echo "boom" 1>&2; exit 1')
    try {
      const result = await runHealthScan({ path: fixture.root })

      expect(result.report.categories['lint']).toEqual({
        status: 'error',
        reason: expect.stringContaining('boom') as unknown as string,
      })
      expect(result.report.tools[0]?.state).toBe('error')
      // The other seven categories are still reported, and the artifact exists.
      expect(Object.keys(result.report.categories)).toHaveLength(8)
      expect(await readFile(result.reportPath, 'utf8')).toBe(result.json)
    } finally {
      await fixture.remove()
    }
  })

  it('treats unparseable output as an error rather than as zero findings', async () => {
    const fixture = await repoWithBrokenOxlint('echo "definitely not sarif"')
    try {
      const result = await runHealthScan({ path: fixture.root })
      expect(result.report.categories['lint']).toMatchObject({ status: 'error' })
      expect(result.report.tools[0]?.reason).toContain('could not parse oxlint output')
      // The evidence is kept even though nothing could be made of it (spec §8).
      expect(result.report.tools[0]?.raw).toEqual(['raw/oxlint.sarif.json'])
    } finally {
      await fixture.remove()
    }
  })
})

/** Plants a repo-owned oxlint whose binary does `sabotage` instead of linting. */
async function repoWithBrokenOxlint(sabotage: string): Promise<FixtureRepo> {
  const fixture = await createFixtureRepo('js-basic')
  await writeFile(join(fixture.root, '.oxlintrc.json'), '{}\n')
  await mkdir(join(fixture.root, 'node_modules', '.bin'), { recursive: true })
  await writeFile(
    join(fixture.root, 'node_modules', '.bin', 'oxlint'),
    `#!/bin/sh\n${sabotage}\n`,
    {
      mode: 0o755,
    },
  )
  return fixture
}
