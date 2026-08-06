import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Finding } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { REPO_SCOPED_REASON, runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { expectGolden, normalizeMarkdown, normalizeReport } from './support/report.ts'
import { GOLDEN_TOOLCHAIN } from './support/system-tools.ts'

/**
 * The spec-level promises on a monorepo, on the two layouts a repo can have:
 * `mono-js` declares its workspace and tools its packages differently,
 * `mono-mixed` declares nothing and puts a language in each service directory.
 *
 * Everything about a *planted* outcome is asserted unconditionally — which
 * project a finding belongs to, which config the tool that found it was under,
 * what each package's own grade is, byte-identity across runs, zero footprint.
 * Only the goldens are gated on the toolchain, because an installed
 * release-binary scanner is a different toolchain (see `support/system-tools.ts`).
 */

/** Roomy: the first run of a suite may be fetching tools from the npm cache. */
const SCAN_TIMEOUT_MS = 180_000

/** The one place this repo's own installed toolchain lives; see the hoisted case. */
const CRANK_NODE_MODULES = fileURLToPath(new URL('../node_modules', import.meta.url))

/**
 * The advisory complexity findings `packages/web/src/tokens.js` carries: fta's
 * file score, then one per function fallow flags on a ceiling that is not the
 * cognitive one. None of them is `gradeScope`, which is why the package still
 * grades A for complexity.
 */
const MONO_JS_TOKENS_ADVISORY = [
  {
    category: 'complexity',
    tool: 'fta',
    rule: 'fta/file-score',
    file: 'packages/web/src/tokens.js',
    project: 'packages/web',
    startLine: 1,
    severity: 'info',
    gradeScope: false,
  },
  ...[10, 58, 104, 135, 171].map((startLine) => ({
    category: 'complexity',
    tool: 'fallow-health',
    rule: 'fallow/complexity',
    file: 'packages/web/src/tokens.js',
    project: 'packages/web',
    startLine,
    severity: 'error',
    gradeScope: false,
  })),
] as const

/** Every finding planted in `test/fixtures/mono-js` — see that fixture's README. */
const MONO_JS_PLANTED = [
  ...MONO_JS_TOKENS_ADVISORY,
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'packages/api/src/shared.js',
    project: 'packages/api',
    startLine: 1,
    severity: 'warning',
    // Duplication grades on the percentage, so its findings are always evidence.
    gradeScope: false,
  },
  {
    category: 'duplication',
    tool: 'jscpd',
    rule: 'jscpd/duplicate-block',
    file: 'packages/web/src/shared.js',
    project: 'packages/web',
    startLine: 1,
    severity: 'warning',
    gradeScope: false,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-const-assign)',
    file: 'packages/api/src/const-assign.js',
    project: 'packages/api',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'eslint',
    rule: 'no-unused-vars',
    file: 'packages/web/src/lint.js',
    project: 'packages/web',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'format',
    tool: 'prettier',
    rule: 'prettier/format',
    file: 'packages/api/src/unformatted.js',
    project: 'packages/api',
    startLine: 1,
    severity: 'warning',
    gradeScope: true,
  },
] as const

describe('quick scan of the mono-js fixture', () => {
  let fixture: FixtureRepo
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('mono-js')
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /**
   * Acceptance criterion 1's first half. The root declares the workspace and
   * holds no source of its own, so it is a shell: eight empty categories under
   * `.` would say less than the note that the root is not a project.
   */
  it('discovers the two packages and records the root as a workspace shell', () => {
    expect(scan.report.projects.map((project) => project.path)).toEqual([
      'packages/api',
      'packages/web',
    ])
    expect(scan.report.rootShell).toEqual({ declaredBy: ['package.json'] })
    expect(scan.report.projects.map((project) => project.manifests)).toEqual([
      ['packages/api/package.json'],
      ['packages/web/package.json'],
    ])
  })

  it('finds every planted finding, and nothing else', () => {
    expect(scan.report.findings.map(shape)).toEqual(
      MONO_JS_PLANTED.map((planted) => ({
        ...planted,
      })),
    )
  })

  /**
   * Acceptance criteria 1 and 2: what each package owns, and what made it own
   * it. `web`'s ESLint is its own file; prettier is declared once at the root
   * and inherited by both packages, which is what `ownedVia` has to be able to
   * say — a package that is told it owns prettier and not where from cannot be
   * checked against its own repo.
   */
  it('attributes each package’s tools to the artifact that decided them', () => {
    expect(toolchain('packages/web')).toEqual([
      {
        tool: 'eslint',
        reason: 'config+dependency',
        ownedVia: 'packages/web/eslint.config.js',
      },
      { tool: 'prettier', reason: 'dependency', ownedVia: 'package.json' },
    ])
    expect(toolchain('packages/api')).toEqual([
      { tool: 'prettier', reason: 'dependency', ownedVia: 'package.json' },
    ])
  })

  /**
   * Acceptance criterion 3. The stand-down rule is per project: one package
   * owning a linter cannot silence the default in the package next door, or the
   * sibling's lint category would go ungraded because of a config it never had.
   */
  it('stands oxlint down in the package that owns ESLint, and runs it in the sibling', () => {
    expect(record('oxlint', 'packages/web')).toMatchObject({
      state: 'ok',
      reason: 'stood down: lint graded by eslint',
    })
    expect(record('oxlint', 'packages/api')).toMatchObject({ state: 'ok', reason: null })
    expect(record('eslint', 'packages/web')).toMatchObject({
      state: 'ok',
      provenance: 'repo-config',
    })
    // ESLint is `repoOwnedOnly`: the package that did not choose it never gets it.
    expect(record('eslint', 'packages/api')).toBeUndefined()
  })

  /**
   * Acceptance criterion 1's last half: two packages, two grades. Each fails
   * lint on its own linter's verdict and over its own denominator — the same
   * one error grades F in the smaller package and D in the larger — and only
   * `api` has a formatting failure. A blended repo grade could say none of that.
   */
  it('grades each package on its own findings', () => {
    expect(categories('packages/api')).toMatchObject({
      lint: { status: 'graded', grade: 'F' },
      format: { status: 'graded', grade: 'C' },
    })
    expect(categories('packages/web')).toMatchObject({
      lint: { status: 'graded', grade: 'D' },
      format: { status: 'graded', grade: 'A' },
    })
  })

  /**
   * The advisory half of the complexity category, and the reason `web` still
   * grades A: fta scores whole files and fallow gates on ceilings that are not
   * the cognitive one, so both can report a file the grade does not count.
   */
  it('keeps the file-level complexity findings out of the grade', () => {
    expect(categories('packages/web')?.complexity).toEqual({ status: 'graded', grade: 'A' })
    expect(
      scan.report.findings.filter((finding) => finding.category === 'complexity').map(shape),
    ).toEqual(MONO_JS_TOKENS_ADVISORY.map((planted) => ({ ...planted })))
  })

  /**
   * fta is handed a directory, so it reports inside it — `src/tokens.js` for a
   * run in `packages/web`. Nothing else would notice if that offset were lost:
   * fta reports no metrics, and a path no project claims is dropped, so the
   * finding would silently disappear rather than come back wrong.
   */
  it('brings fta’s paths back to the repo’s terms', () => {
    const fta = scan.report.findings.filter((finding) => finding.tool === 'fta')
    expect(fta.map((finding) => [finding.file, finding.project])).toEqual([
      ['packages/web/src/tokens.js', 'packages/web'],
    ])
    expect(record('fta', 'packages/web')?.raw).toEqual(['raw/packages/web/fta.json'])
  })

  /**
   * Reachability is not a question one package can answer. `cross.js` is
   * imported only by the *other* package, so a dead-code walk scoped to
   * `packages/api` reports it as an unused file — the walk is the repo's, and
   * this is the assertion that keeps it that way.
   */
  it('does not call a file dead because only the other package imports it', () => {
    expect(scan.report.findings.filter((finding) => finding.category === 'dead-code')).toEqual([])
    expect(categories('packages/api')?.['dead-code']).toEqual({ status: 'graded', grade: 'A' })
  })

  /**
   * A grade per project needs a denominator per project. The complexity tools
   * take a directory and walk it themselves, so the failure to guard against is
   * not a missing measurement but a repo-wide one wearing a package's name:
   * every package reporting the same number, and the rollup adding that number
   * up once per package for a repo that has it once.
   */
  it('counts each package’s own functions, and the rollup counts them once', () => {
    const totals = scan.report.projects.map(
      (project) => project.metrics.complexity?.functionsTotal ?? 0,
    )
    // The packages hold different code; one number for both would be the repo's.
    expect(totals).toEqual([7, 12])
    expect(scan.report.metrics.complexity?.functionsTotal).toBe(
      totals.reduce((sum, total) => sum + total, 0),
    )
  })

  /**
   * Acceptance criterion 8. The clone is between the packages, so neither
   * package's own measurement can see it — and the repo-wide pass that can is
   * the rollup's alone.
   */
  it('keeps the cross-package clone in the rollup’s duplication grade only', () => {
    expect(scan.report.categories.duplication).toEqual({ status: 'graded', grade: 'D' })
    expect(scan.report.metrics.duplication?.duplicationPercent).toBeGreaterThan(3)
    for (const project of scan.report.projects) {
      expect(project.categories.duplication).toEqual({ status: 'graded', grade: 'A' })
      expect(project.metrics.duplication?.duplicationPercent).toBe(0)
    }
    expect(record('jscpd', 'repo')?.repoWide).toBe(true)
  })

  /**
   * The same tool ran in both packages, so its evidence has to be told apart on
   * disk — otherwise the second run would overwrite the first, and every task
   * in `agent.md` would link one package's output.
   */
  it('nests each project’s raw evidence under its own path', async () => {
    expect((await readdir(join(scan.outputDir, 'raw'))).toSorted()).toEqual(
      expect.arrayContaining(['packages', 'repo']),
    )
    expect(record('oxlint', 'packages/api')?.raw).toEqual(['raw/packages/api/oxlint.sarif.json'])
    expect(record('eslint', 'packages/web')?.raw).toEqual(['raw/packages/web/eslint.json'])
    // …and the tasks link the evidence of the run that reported them.
    expect(scan.agentMarkdown).toContain('[raw/packages/api/oxlint.sarif.json]')
    expect(scan.agentMarkdown).toContain('[raw/packages/web/eslint.json]')
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    await expectGolden('mono-js.report.json', normalizeReport(scan.json))
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden report.md and agent.md', async () => {
    await expectGolden('mono-js.report.md', normalizeMarkdown(scan.markdown, scan.report.repo.path))
    await expectGolden(
      'mono-js.agent.md',
      normalizeMarkdown(scan.agentMarkdown, scan.report.repo.path),
    )
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root })
      expect(normalizeReport(second.json)).toBe(normalizeReport(scan.json))
      expect(second.report.findings.map((finding) => finding.id)).toEqual(
        scan.report.findings.map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })

  function categories(path: string) {
    return scan.report.projects.find((project) => project.path === path)?.categories
  }

  function toolchain(path: string) {
    return scan.report.projects
      .find((project) => project.path === path)
      ?.toolchain.map((tool) => ({ tool: tool.tool, reason: tool.reason, ownedVia: tool.ownedVia }))
  }

  function record(tool: string, project: string) {
    return scan.report.tools.find((entry) => entry.tool === tool && entry.project === project)
  }
})

/**
 * Acceptance criterion 2's second half. A workspace installs its toolchain once,
 * at the root, and every package runs it out of the hoisted `node_modules/.bin`
 * — so a package that owns a tool through the root manifest must run *that*
 * binary, not crank-health's pinned copy of a version the repo never chose.
 *
 * The install is planted as a link to this repo's own `node_modules`, because a
 * fixture cannot carry one: the real binary is the only thing that can prove the
 * real binary ran.
 */
describe('a workspace whose toolchain is installed only at the root', () => {
  let fixture: FixtureRepo
  let out: string
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('mono-js')
    out = await mkdtemp(join(tmpdir(), 'crank-hoisted-'))
    await symlink(CRANK_NODE_MODULES, join(fixture.root, 'node_modules'))
    scan = await runHealthScan({ path: fixture.root, out, only: ['format'] })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
    await rm(out, { recursive: true, force: true })
  })

  it('runs the root-installed binary in every package that inherited it', () => {
    for (const project of ['packages/api', 'packages/web']) {
      expect(
        scan.report.tools.find((tool) => tool.tool === 'prettier' && tool.project === project),
      ).toMatchObject({
        state: 'ok',
        execution: 'repo-installed',
        detection: { reason: 'dependency', ownedVia: 'package.json', installed: true },
      })
    }
  })

  it('leaves the target repo clean, hoisted install and all', async () => {
    expect(await fixture.status()).toBe('')
  })
})

/** Every finding planted in `test/fixtures/mono-mixed` — see that fixture's README. */
const MONO_MIXED_PLANTED = [
  {
    category: 'types',
    tool: 'ty',
    rule: 'unresolved-reference',
    file: 'services/api/greet.py',
    project: 'services/api',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'ruff-lint',
    rule: 'F821',
    file: 'services/api/greet.py',
    project: 'services/api',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
  {
    category: 'lint',
    tool: 'oxlint',
    rule: 'eslint(no-dupe-keys)',
    file: 'services/web/src/dupe-keys.js',
    project: 'services/web',
    startLine: 2,
    severity: 'error',
    gradeScope: true,
  },
] as const

describe('quick scan of the mono-mixed fixture', () => {
  let fixture: FixtureRepo
  let scan: HealthScanResult

  beforeAll(async () => {
    fixture = await createFixtureRepo('mono-mixed')
    scan = await runHealthScan({ path: fixture.root })
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  /**
   * Nothing in this repo declares a workspace, and it makes no difference: the
   * partition is the file inventory's, and a declaration only corroborates a
   * root that turned out to be a shell.
   */
  it('discovers an undeclared folder-per-service layout', () => {
    expect(
      scan.report.projects.map((project) => [project.path, project.languages, project.manifests]),
    ).toEqual([
      ['services/api', ['python'], ['services/api/pyproject.toml']],
      ['services/web', ['js-ts'], ['services/web/package.json']],
    ])
    expect(scan.report.rootShell).toEqual({ declaredBy: [] })
  })

  it('finds every planted finding, and nothing else', () => {
    expect(scan.report.findings.map(shape)).toEqual(
      MONO_MIXED_PLANTED.map((planted) => ({
        ...planted,
      })),
    )
  })

  /**
   * Each service is analyzed by the adapter its own files call for: the Python
   * service is never handed a JS linter and the JS service is never handed
   * ruff. That is the planner's per-project language rule, and without it every
   * tool would report "nothing to look at" in half the repo.
   */
  it('plans each language’s tools only in the project that has that language', () => {
    expect(toolsIn('services/api')).toEqual(
      expect.arrayContaining(['bandit', 'complexipy', 'ruff-format', 'ruff-lint', 'ty', 'vulture']),
    )
    expect(toolsIn('services/api')).not.toContain('oxlint')
    expect(toolsIn('services/web')).toEqual(
      expect.arrayContaining(['fallow-health', 'fta', 'oxlint', 'prettier']),
    )
    expect(toolsIn('services/web')).not.toContain('ruff-lint')
  })

  /**
   * The same denominator rule across two languages: each service is counted by
   * its own tool over its own files, and the rollup is those two counts added
   * together — not either tool's view of the whole repo.
   */
  it('counts each service’s own functions, and the rollup counts them once', () => {
    const totals = scan.report.projects.map(
      (project) => project.metrics.complexity?.functionsTotal ?? 0,
    )
    expect(totals).toEqual([2, 1])
    expect(scan.report.metrics.complexity?.functionsTotal).toBe(
      totals.reduce((sum, total) => sum + total, 0),
    )
  })

  it('grades each service on the categories its own tools reached', () => {
    expect(categories('services/api')).toMatchObject({
      types: { status: 'graded', grade: 'F' },
      lint: { status: 'graded', grade: 'F' },
      format: { status: 'graded', grade: 'A' },
    })
    expect(categories('services/web')).toMatchObject({
      lint: { status: 'graded', grade: 'F' },
      format: { status: 'graded', grade: 'A' },
      // No TypeScript and no tsconfig: nothing owns types here, and the repo has
      // no answer to lend it either.
      types: {
        status: 'not-assessed',
        reason: 'no tsconfig.json and no TypeScript sources — nothing owns the types category',
      },
    })
  })

  /**
   * The JS service has no security answer of its own — no Python means no bandit
   * — and it never gets a grade for one. Where the repo's own scanners did
   * answer, the reason says so, which is what keeps `--fail-under` from failing
   * a package for a scan that was never about it.
   *
   * Which branch holds is a fact about the machine, not about the repo: the
   * repo-spanning scanners are release binaries this one may not have, and a
   * substitution on the strength of a scan that did not run would be the one
   * direction this must never fail in.
   */
  it('gives a service no security grade its own runs did not earn', () => {
    const security = categories('services/web')?.security
    expect(security?.status).toBe('not-assessed')

    const spanningGraded = scan.report.tools.some(
      (tool) => tool.repoWide === true && tool.category === 'security' && tool.state === 'ok',
    )
    expect(security).toMatchObject(
      spanningGraded
        ? { reason: REPO_SCOPED_REASON }
        : { reason: expect.stringContaining('bandit assessed nothing') as unknown as string },
    )
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden normalized report', async () => {
    await expectGolden('mono-mixed.report.json', normalizeReport(scan.json))
  })

  it.runIf(GOLDEN_TOOLCHAIN)('matches the golden report.md and agent.md', async () => {
    await expectGolden(
      'mono-mixed.report.md',
      normalizeMarkdown(scan.markdown, scan.report.repo.path),
    )
    await expectGolden(
      'mono-mixed.agent.md',
      normalizeMarkdown(scan.agentMarkdown, scan.report.repo.path),
    )
  })

  it(
    'produces byte-identical output when run twice on the same commit',
    async () => {
      const second = await runHealthScan({ path: fixture.root })
      expect(normalizeReport(second.json)).toBe(normalizeReport(scan.json))
      expect(second.report.findings.map((finding) => finding.id)).toEqual(
        scan.report.findings.map((finding) => finding.id),
      )
    },
    SCAN_TIMEOUT_MS,
  )

  it('leaves the target repo clean', async () => {
    expect(await fixture.status()).toBe('')
  })

  function categories(path: string) {
    return scan.report.projects.find((project) => project.path === path)?.categories
  }

  function toolsIn(path: string): string[] {
    return scan.report.tools
      .filter((tool) => tool.project === path)
      .map((tool) => tool.tool)
      .toSorted()
  }
})

/** The parts of a finding a planted-finding table is about, project included. */
function shape(finding: Finding) {
  return {
    category: finding.category,
    tool: finding.tool,
    rule: finding.rule,
    file: finding.file,
    project: finding.project,
    startLine: finding.range.startLine,
    severity: finding.severity,
    gradeScope: finding.gradeScope,
  }
}
