import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Finding } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { normalizeReport } from './support/report.ts'

/**
 * The four spec-level executable promises, on the fixtures that exercise the
 * whole JS/TS adapter: every planted finding and nothing else · a golden
 * normalized report · byte-identity across runs · zero footprint on the target.
 *
 * These drive `runHealthScan` — the same entry point `cli.ts` uses — so what is
 * proven here is what the binary does. Each fixture is scanned once and the
 * assertions share the result; these runs fetch real pinned tools.
 */

const GOLDEN = fileURLToPath(new URL('./golden/js-basic.report.json', import.meta.url))

/** Roomy: the first run of a suite may be fetching tools from the npm cache. */
const SCAN_TIMEOUT_MS = 180_000

/** Every finding planted in `test/fixtures/js-basic` — see that fixture's README. */
const PLANTED = [
  {
    category: 'dead-code',
    tool: 'fallow-dead-code',
    rule: 'fallow/unused-export',
    file: 'src/clean.js',
    startLine: 5,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'dead-code',
    tool: 'knip',
    rule: 'knip/unused-exports',
    file: 'src/clean.js',
    startLine: 5,
    severity: 'warning',
    gradeScope: true,
  },
  {
    category: 'complexity',
    tool: 'fallow-health',
    rule: 'fallow/complexity',
    file: 'src/complex.js',
    startLine: 1,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'oxc(no-accumulating-spread)',
    file: 'src/accumulate.js',
    startLine: 2,
    severity: 'warning',
    // A `perf`-class rule: reported, not graded, on our default config (spec §1).
    gradeScope: false,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-const-assign)',
    file: 'src/const-assign.js',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-dupe-keys)',
    file: 'src/dupe-keys.js',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-unreachable)',
    file: 'src/unreachable.js',
    startLine: 6,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'prettier',
    rule: 'prettier/format',
    file: 'src/unformatted.js',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

/** Files planted deliberately clean; a finding in one of these is a false positive. */
const CLEAN_FILES = new Set(['src/index.js', 'src/util/format.js'])

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
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(outside, { recursive: true, force: true })
  })

  it('finds every planted finding, and nothing else', () => {
    expect(findings.map(shape)).toEqual(PLANTED.map((planted) => ({ ...planted })))
  })

  it('reports no findings in the deliberately clean files', () => {
    expect(findings.filter((finding) => CLEAN_FILES.has(finding.file))).toEqual([])
  })

  it('tags an untooled repo as default-config, run from the pinned versions', () => {
    const report = parse(json)
    expect(report.tools.map((tool) => tool.tool)).toEqual([
      'tsc',
      'fallow-dead-code',
      'knip',
      'fallow-health',
      'fta',
      'oxlint',
      'prettier',
    ])
    expect(report.tools.every((tool) => tool.provenance === 'default-config')).toBe(true)
    expect(report.tools.every((tool) => tool.execution === 'ephemeral-pinned')).toBe(true)
    expect(report.tools.every((tool) => tool.detection === null)).toBe(true)
    // Every tool that produced a version reports the one this release pins.
    for (const tool of report.tools) {
      if (tool.version !== null) expect(tool.version).toBe(tool.pinned)
    }
    expect(findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
  })

  it('grades every category a JS/TS-only repo can reach, and pins the commit', () => {
    const report = parse(json)
    expect(report.repo.commit).toBe(fixture.commit)
    expect(report.categories).toEqual({
      security: { status: 'not-assessed', reason: 'no tool available for this category' },
      // No tsconfig.json and no TypeScript sources: nothing owns types here.
      types: {
        status: 'not-assessed',
        reason: 'no tsconfig.json and no TypeScript sources — nothing owns the types category',
      },
      'dead-code': { status: 'graded', grade: 'F' },
      complexity: { status: 'graded', grade: 'D' },
      duplication: { status: 'not-assessed', reason: 'no tool available for this category' },
      lint: { status: 'graded', grade: 'F' },
      format: { status: 'graded', grade: 'C' },
      'test-quality': { status: 'not-assessed', reason: 'not assessed — run `--deep`' },
    })
  })

  /** The ratio grades are only readable next to the numbers they came from. */
  it('reports the measurements the ratio grades were computed from', () => {
    const report = parse(json)
    expect(report.metrics).toEqual({
      // 1 of 9 functions over cognitive 15 = 11.1% → D (C ≤10, D ≤20).
      complexity: { functionsTotal: 9, functionsOverCeiling: 1 },
      // 1 of 9 files failing = 11.1% → C (B ≤10, C ≤30).
      format: { formattableFiles: 9 },
    })
  })

  it('matches the golden normalized report', async () => {
    expect(normalizeReport(json)).toBe(await readFile(GOLDEN, 'utf8'))
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root })
      expect(normalizeReport(second.json)).toBe(normalizeReport(json))
      expect(second.report.findings.map((finding) => finding.id)).toEqual(
        findings.map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )

  it('leaves the target repo clean: the run directory ignores itself', async () => {
    expect(await fixture.status()).toBe('')
    expect(await readdir(join(fixture.root, '.codebase-health'))).toContain('report.json')
  })

  it(
    'writes nothing at all into the repo when --out points elsewhere',
    async () => {
      await rm(join(fixture.root, '.codebase-health'), { recursive: true, force: true })
      const result = await runHealthScan({ path: fixture.root, out: outside })

      expect(result.outputDir).toBe(outside)
      expect(await fixture.status()).toBe('')
      expect(await readdir(fixture.root)).toEqual(['.git', 'README.md', 'package.json', 'src'])
      // Every tool's evidence is kept next to the report (spec §9).
      expect((await readdir(join(outside, 'raw'))).toSorted()).toEqual([
        'fallow-dead-code.json',
        'fallow-dead-code.stderr.txt',
        'fallow-health.json',
        'fallow-health.stderr.txt',
        'fta.json',
        'knip.json',
        'oxlint.sarif.json',
        'prettier.txt',
      ])
    },
    SCAN_TIMEOUT_MS,
  )

  it('keeps raw tool evidence next to the report', async () => {
    const raw = await readFile(join(outside, 'raw', 'oxlint.sarif.json'), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: '2.1.0' })
  })
})

describe('quick scan of the ts-owned fixture', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('ts-owned')
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it('finds every planted finding, and nothing else', () => {
    expect(result.report.findings.map(shape)).toEqual([
      {
        category: 'types',
        tool: 'tsc',
        rule: 'TS2322',
        file: 'src/types.ts',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'fallow-dead-code',
        rule: 'fallow/unused-file',
        file: 'src/lint.js',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'knip',
        rule: 'knip/unused-file',
        file: 'src/lint.js',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'fallow-dead-code',
        rule: 'fallow/unused-export',
        file: 'src/util.ts',
        startLine: 5,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'dead-code',
        tool: 'knip',
        rule: 'knip/unused-exports',
        file: 'src/util.ts',
        startLine: 5,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'complexity',
        tool: 'fallow-health',
        rule: 'fallow/complexity',
        file: 'src/complex.ts',
        startLine: 1,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'lint',
        tool: 'eslint',
        rule: 'no-unused-vars',
        file: 'src/lint.js',
        startLine: 2,
        severity: 'error',
        gradeScope: true,
      },
      {
        category: 'lint',
        tool: 'eslint',
        rule: 'eqeqeq',
        file: 'src/lint.js',
        startLine: 3,
        severity: 'warning',
        gradeScope: true,
      },
      {
        category: 'format',
        tool: 'prettier',
        rule: 'prettier/format',
        file: 'src/unformatted.ts',
        startLine: 1,
        severity: 'warning',
        gradeScope: true,
      },
    ])
  })

  it('honours the repo’s own configs, ephemerally, and tags them repo-config', () => {
    const byTool = new Map(parse(result.json).tools.map((tool) => [tool.tool, tool]))

    expect(byTool.get('tsc')).toMatchObject({
      execution: 'ephemeral-pinned',
      provenance: 'repo-config',
      state: 'ok',
      version: '7.0.2',
      detection: { reason: 'config+dependency', configFiles: ['tsconfig.json'], installed: false },
    })
    expect(byTool.get('eslint')).toMatchObject({
      provenance: 'repo-config',
      state: 'ok',
      detection: { reason: 'config+dependency', configFiles: ['eslint.config.js'] },
    })
    expect(byTool.get('prettier')).toMatchObject({
      provenance: 'repo-config',
      state: 'ok',
      detection: { reason: 'config+dependency', configFiles: ['.prettierrc.json'] },
    })
  })

  /** Spec §1: owned → their tool; not owned → ours. The branches are exclusive. */
  it('stands oxlint down, because this repo already owns a linter', () => {
    const tools = parse(result.json).tools.map((tool) => tool.tool)
    expect(tools).toContain('eslint')
    expect(tools).not.toContain('oxlint')
  })

  it('grades types and dead code, which the untooled fixture could not reach', () => {
    expect(result.report.categories.types).toEqual({ status: 'graded', grade: 'F' })
    expect(result.report.categories['dead-code']).toEqual({ status: 'graded', grade: 'F' })
  })

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe('quick scan of a repo that owns two linters and a formatter', () => {
  let fixture: FixtureRepo
  let result: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-multi-tool')
    result = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /** Spec §1: "run all, merge findings … grade on the union". */
  it('merges both linters’ findings, each tagged with the tool that made it', () => {
    const lint = result.report.findings.filter((finding) => finding.category === 'lint')
    expect(lint.map((finding) => [finding.tool, finding.rule, finding.file])).toEqual([
      ['eslint', 'eqeqeq', 'src/both.js'],
      ['biome-lint', 'lint/suspicious/noDoubleEquals', 'src/both.js'],
    ])
    // Two tools, one line, two distinct identities — the tool is in the hash.
    expect(new Set(lint.map((finding) => finding.id)).size).toBe(2)
    expect(lint.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(lint.every((finding) => finding.gradeScope)).toBe(true)
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
  })

  it('stands both of our defaults down: this repo owns lint and format', () => {
    const tools = parse(result.json).tools.map((tool) => tool.tool)
    expect(tools).toContain('eslint')
    expect(tools).toContain('biome-lint')
    expect(tools).toContain('biome-format')
    expect(tools).not.toContain('oxlint')
    expect(tools).not.toContain('prettier')
  })

  it('grades format from Biome’s verdict alone', () => {
    expect(result.report.findings.filter((finding) => finding.category === 'format')).toMatchObject(
      [{ tool: 'biome-format', rule: 'biome/format', file: 'src/unformatted.js' }],
    )
    expect(result.report.metrics.format).toEqual({ formattableFiles: 4 })
    expect(result.report.categories.format).toEqual({ status: 'graded', grade: 'C' })
  })

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })
})

describe('the same rule class under two provenances', () => {
  it(
    'tags a formatting failure repo-config where the repo owns prettier, default-config where it does not',
    async () => {
      const owned = await createFixtureRepo('ts-owned')
      const untooled = await createFixtureRepo('js-basic')
      try {
        const [byRepo, byDefault] = await Promise.all([
          runHealthScan({ path: owned.root }),
          runHealthScan({ path: untooled.root }),
        ])

        expect(pick(byRepo)).toMatchObject({ provenance: 'repo-config', gradeScope: true })
        expect(pick(byDefault)).toMatchObject({ provenance: 'default-config', gradeScope: true })
        // Same rule, same tool, different repos — and therefore different ids.
        expect(pick(byRepo)?.id).not.toBe(pick(byDefault)?.id)
      } finally {
        await owned.remove()
        await untooled.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('zero footprint', () => {
  it.each(['js-basic', 'js-owned', 'ts-owned', 'js-multi-tool'])(
    'leaves %s untouched after a full scan',
    async (name) => {
      const fixture = await createFixtureRepo(name)
      const outside = await mkdtemp(join(tmpdir(), 'crank-zero-'))
      const before = (await readdir(fixture.root)).toSorted()
      try {
        await runHealthScan({ path: fixture.root, out: outside })
        expect(await fixture.status()).toBe('')
        expect((await readdir(fixture.root)).toSorted()).toEqual(before)
      } finally {
        await fixture.remove()
        await rm(outside, { recursive: true, force: true })
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('quick scan of a repo that owns oxlint but has not installed it', () => {
  it(
    'honours the repo config, ephemerally, and grades what that config flags',
    async () => {
      const fixture = await createFixtureRepo('js-owned')
      try {
        const result = await runHealthScan({ path: fixture.root, only: ['lint'] })

        expect(result.report.tools[0]).toMatchObject({
          tool: 'oxlint',
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
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('quick scan of crank-health itself', () => {
  it(
    'runs the repo-installed binaries with the repo config',
    async () => {
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
        expect(result.report.categories.format).toEqual({
          status: 'not-assessed',
          reason: 'not selected by --only',
        })
      } finally {
        await rm(out, { recursive: true, force: true })
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('a repo whose own linter is broken', () => {
  it(
    'reports the category as error and still writes a complete report',
    async () => {
      const fixture = await repoWithBrokenOxlint('echo "boom" 1>&2; exit 1')
      try {
        const result = await runHealthScan({ path: fixture.root, only: ['lint'] })

        expect(result.report.categories.lint).toEqual({
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
    },
    SCAN_TIMEOUT_MS,
  )

  it(
    'treats unparseable output as an error rather than as zero findings',
    async () => {
      const fixture = await repoWithBrokenOxlint('echo "definitely not sarif"')
      try {
        const result = await runHealthScan({ path: fixture.root, only: ['lint'] })
        expect(result.report.categories.lint).toMatchObject({ status: 'error' })
        expect(result.report.tools[0]?.reason).toContain('could not parse oxlint output')
        // The evidence is kept even though nothing could be made of it (spec §8).
        expect(result.report.tools[0]?.raw).toEqual(['raw/oxlint.sarif.json'])
      } finally {
        await fixture.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )
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

/** The one formatting finding a scan produced. */
function pick(result: HealthScanResult): Finding | undefined {
  return result.report.findings.find((finding) => finding.rule === 'prettier/format')
}

/** The parts of a finding a planted-finding table is about. */
function shape(finding: Finding) {
  return {
    category: finding.category,
    tool: finding.tool,
    rule: finding.rule,
    file: finding.file,
    startLine: finding.range.startLine,
    severity: finding.severity,
    gradeScope: finding.gradeScope,
  }
}

interface ReportShape {
  readonly repo: { readonly commit: string }
  readonly categories: Record<string, { status: string; grade?: string; reason?: string }>
  readonly metrics: Record<string, Record<string, number>>
  readonly tools: {
    readonly tool: string
    readonly execution: string
    readonly provenance: string
    readonly version: string | null
    readonly pinned: string | null
    readonly detection: unknown
  }[]
}

function parse(json: string): ReportShape {
  return JSON.parse(json) as ReportShape
}
