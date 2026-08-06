import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { banditRunner } from '../src/adapters/common/bandit.ts'
import { gitleaksRunner, invocationArgs as gitleaksArgs } from '../src/adapters/common/gitleaks.ts'
import {
  JSCPD_TOOL,
  invocationArgs as jscpdArgs,
  jscpdRunner,
} from '../src/adapters/common/jscpd.ts'
import { commonAdapter } from '../src/adapters/common/index.ts'
import {
  invocationArgs as opengrepArgs,
  materializeRules,
  opengrepRunner,
} from '../src/adapters/common/opengrep.ts'
import { OPENGREP_RULES } from '../src/adapters/common/opengrep-rules.ts'
import {
  isDatabaseUnreachable,
  invocationArgs as osvArgs,
  osvScannerRunner,
} from '../src/adapters/common/osv-scanner.ts'
import { zizmorRunner } from '../src/adapters/common/zizmor.ts'
import { formatInvocationArgs } from '../src/adapters/csharp/dotnet-format.ts'
import { dotnetEnv, dotnetExecOptions } from '../src/adapters/csharp/dotnet-project.ts'
import { csharpAdapter } from '../src/adapters/csharp/index.ts'
import { ADAPTERS } from '../src/adapters/index.ts'
import type { RunContext } from '../src/core/types.ts'
import { categoryRank } from '../src/core/types.ts'
import { makeProject } from './factories.ts'
import type { ReportTool } from '../src/render/json.ts'
import { runHealthScan } from '../src/run.ts'

/**
 * The command lines, asserted without running anything.
 *
 * Two spec promises are decided entirely by how these arguments are built, and
 * neither shows up in a parse test: the license rule (plan's retiring check —
 * "no default invocation fetches registry packs") and zero footprint (spec §7 —
 * every tool writes into the scratch dir, and no repo-mutating subcommand is
 * reachable).
 */

const SCRATCH = '/scratch'
const REPO = '/repo'

describe('the license rule', () => {
  /**
   * Plan risk table: "Semgrep rules license → offline LGPL snapshot by default;
   * M6 test asserts no default registry fetch."
   */
  it('never puts a registry pack, `auto` or a URL into opengrep’s --config', () => {
    const args = opengrepArgs(join(SCRATCH, 'opengrep', 'crank-health-rules.yaml'), ['/repo/a.js'])
    const config = args[args.indexOf('--config') + 1]
    expect(config).toBe('/scratch/opengrep/crank-health-rules.yaml')
    expect(args).not.toContain('auto')
    expect(args.some((arg) => arg.startsWith('p/'))).toBe(false)
    expect(args.some((arg) => /^https?:\/\//.test(arg))).toBe(false)
    expect(args.some((arg) => arg.includes('semgrep.dev'))).toBe(false)
  })

  it('disables opengrep’s version phone-home', () => {
    expect(opengrepArgs('/scratch/rules.yaml', [])).toContain('--disable-version-check')
  })

  /** The rules that make the grade have to be ours, and local. */
  it('materializes the bundled ruleset into scratch, byte for byte', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-rules-'))
    try {
      const path = await materializeRules(scratch)
      expect(path.startsWith(scratch)).toBe(true)
      expect(await readFile(path, 'utf8')).toBe(OPENGREP_RULES)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe('zero footprint, in the arguments', () => {
  /** jscpd's default reporter writes `report/` into the working directory. */
  it('redirects jscpd’s report into the scratch dir', () => {
    const args = jscpdArgs(REPO, join(SCRATCH, 'jscpd'))
    expect(args[args.indexOf('--output') + 1]).toBe('/scratch/jscpd')
    expect(args).toContain('--reporters')
    expect(args.at(-1)).toBe(REPO)
  })

  it('keeps jscpd out of .git and dependency directories', () => {
    const args = jscpdArgs(REPO, SCRATCH)
    const ignore = args[args.indexOf('--ignore') + 1] ?? ''
    for (const excluded of ['.git', 'node_modules', '.venv', '__pycache__']) {
      expect(ignore).toContain(excluded)
    }
  })

  /**
   * jscpd is handed a directory, so a project holding packages of its own would
   * measure their code — and the clones between them — as its duplication. That
   * measurement is the repo-wide pass's, and only the rollup grades on it.
   */
  it('leaves a parent project’s nested projects to the nested projects', () => {
    const ignoreOf = (nested: readonly string[]) => {
      const args = jscpdArgs(REPO, SCRATCH, nested)
      return args[args.indexOf('--ignore') + 1] ?? ''
    }

    const ignore = ignoreOf(['packages/api', 'packages/web'])
    expect(ignore).toContain('**/packages/api/**')
    expect(ignore).toContain('**/packages/web/**')
    // …and the repo-wide pass, which passes none, still sees every package.
    expect(ignoreOf([])).not.toContain('packages')
  })

  it('asks jscpd for exactly the graded languages, C# included', () => {
    const args = jscpdArgs(REPO, join(SCRATCH, 'jscpd'))
    expect(args[args.indexOf('--format') + 1]).toBe('javascript,jsx,typescript,tsx,python,csharp')
  })

  /**
   * `bin/` and `obj/` are MSBuild output. jscpd walks the tree itself rather
   * than taking our inventory, so it cannot apply discovery's C#-only rule —
   * these globs are language-blind by design, the documented trade: a JS
   * package's `bin/cli.js` stays in the inventory and out of the duplication
   * measurement.
   */
  it('keeps jscpd out of C# build output directories', () => {
    const args = jscpdArgs(REPO, SCRATCH)
    const ignore = args[args.indexOf('--ignore') + 1] ?? ''
    expect(ignore).toContain('**/bin/**')
    expect(ignore).toContain('**/obj/**')
  })

  it('writes gitleaks’ report into the scratch dir, redacted', () => {
    const args = gitleaksArgs(REPO, join(SCRATCH, 'gitleaks.json'))
    expect(args[0]).toBe('dir')
    expect(args).toContain('--redact=100')
    expect(args[args.indexOf('--report-path') + 1]).toBe('/scratch/gitleaks.json')
    // "Found a secret" must not read as "gitleaks failed".
    expect(args[args.indexOf('--exit-code') + 1]).toBe('0')
  })

  /**
   * `--verify-no-changes` is the flag dotnet format cannot be correct without:
   * without it the run rewrites the target's files in place. `--folder` is what
   * keeps the run source-text only (no project load, no restore — SDK 10
   * rejects an explicit `--no-restore` beside it as redundant), and the report
   * goes to scratch. Excludes: MSBuild output, and each nested project — whose
   * whitespace is its own run's to measure.
   */
  it('builds a read-only, folder-mode dotnet format command reporting into scratch', () => {
    const args = formatInvocationArgs(
      join(REPO, 'src'),
      ['bin', 'obj', 'src/nested'],
      join(SCRATCH, 'dotnet-format'),
    )

    expect(args).toEqual([
      'format',
      'whitespace',
      '/repo/src',
      '--folder',
      '--verify-no-changes',
      '--exclude',
      'bin',
      'obj',
      'src/nested',
      '--report',
      '/scratch/dotnet-format',
    ])
  })

  /**
   * The one builder every C# runner passes to `execTool`: `cwd`, `timeoutMs`
   * and `env` are decided once here, not in five runner bodies.
   */
  it('builds every dotnet spawn’s options from the context, with the pinned env', () => {
    const ctx: RunContext = {
      repoRoot: REPO,
      project: makeProject(['src/A.cs']),
      files: ['src/A.cs'],
      scratch: SCRATCH,
      detection: null,
      timeoutMs: 12_345,
      deep: false,
    }

    expect(dotnetExecOptions(ctx, '/repo/src')).toEqual({
      cwd: '/repo/src',
      timeoutMs: 12_345,
      env: dotnetEnv(),
    })
  })

  /** Spec §7's block-list names `osv-scanner fix` explicitly. */
  it('never builds a mutating osv-scanner subcommand', () => {
    const args = osvArgs(REPO, join(SCRATCH, 'osv-scanner.json'))
    expect(args.slice(0, 2)).toEqual(['scan', 'source'])
    expect(args).not.toContain('fix')
    expect(args[args.indexOf('--output-file') + 1]).toBe('/scratch/osv-scanner.json')
  })
})

/** A throwaway git repo (hermetic identity), scanned with `--out` kept outside. */
async function scanTemp(files: Readonly<Record<string, string>>): Promise<ReportTool[]> {
  const repo = await mkdtemp(join(tmpdir(), 'crank-jscpd-cs-'))
  const out = await mkdtemp(join(tmpdir(), 'crank-jscpd-cs-out-'))
  try {
    await execa('git', ['init', '--quiet'], {
      cwd: repo,
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      extendEnv: true,
    })
    for (const [file, contents] of Object.entries(files)) {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(join(repo, file), contents, 'utf8')
    }
    const scan = await runHealthScan({ path: repo, out })
    return scan.report.tools.filter((tool) => tool.tool === JSCPD_TOOL)
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
}

describe('jscpd on a C#-only tree', () => {
  /** Roomy: a cold npx cache fetches the pinned jscpd first. */
  const SCAN_TIMEOUT_MS = 180_000

  it(
    'measures a tree of only .cs files instead of standing down',
    async () => {
      const runs = await scanTemp({ 'Program.cs': 'class Program { static void Main() {} }\n' })

      expect(runs.length).toBeGreaterThan(0)
      expect(runs.map((run) => run.state)).not.toContain('not-available')
    },
    SCAN_TIMEOUT_MS,
  )

  it(
    'names all four languages when there is nothing to measure',
    async () => {
      const runs = await scanTemp({ 'README.md': '# nothing to measure\n' })

      expect(runs.length).toBeGreaterThan(0)
      for (const run of runs) {
        expect(run.state).toBe('not-available')
        expect(run.reason).toBe(
          'no JavaScript, TypeScript, Python or C# files, so jscpd measured nothing',
        )
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('osv-scanner degradation', () => {
  /**
   * Spec §8: a scan that could not reach the advisory database must say so, not
   * report a clean dependency tree it never checked.
   */
  it.each([
    'failed to get vulnerabilities: dial tcp: lookup api.osv.dev: no such host',
    'Get "https://api.deps.dev/v3alpha": context deadline exceeded',
    'error: net/http: TLS handshake timeout',
    'connection refused',
  ])('recognizes an unreachable database in %s', (stderr) => {
    expect(isDatabaseUnreachable(stderr)).toBe(true)
  })

  it('does not mistake an ordinary failure for a network problem', () => {
    expect(isDatabaseUnreachable('No package sources found, --help for usage information.')).toBe(
      false,
    )
    expect(isDatabaseUnreachable('')).toBe(false)
  })
})

describe('the C# adapter', () => {
  /** `LANGUAGES` pins "canonical language order, matching the adapter order". */
  it('joins the adapter order after python, before common', () => {
    expect(ADAPTERS.map((adapter) => adapter.language)).toEqual([
      'js-ts',
      'python',
      'csharp',
      'common',
    ])
    expect(csharpAdapter.language).toBe('csharp')
  })

  /**
   * A standing check that survives every later insertion: runners are listed in
   * category order (spec §10's remediation priority), so a later task inserts
   * by `CATEGORIES` index rather than appending.
   */
  it('lists its runners in category order', () => {
    const categories = csharpAdapter.runners.map((runner) => runner.category)
    expect(categories).toEqual(categories.toSorted((a, b) => categoryRank(a) - categoryRank(b)))
    expect(categories).toContain('format')
  })
})

describe('the common adapter', () => {
  it('is registered, after the three language adapters', () => {
    expect(ADAPTERS.at(-1)).toBe(commonAdapter)
    expect(commonAdapter.language).toBe('common')
  })

  /**
   * Spec "Categories and tools" lists security as a union of complementary
   * scanners, so none of them may stand another down (see
   * `ToolRunner.complementary` and the orchestrator test).
   */
  it('marks every security runner complementary', () => {
    const security = commonAdapter.runners.filter((runner) => runner.category === 'security')
    expect(security.map((runner) => runner.tool).toSorted()).toEqual([
      'bandit',
      'gitleaks',
      'opengrep',
      'osv-scanner',
      'zizmor',
    ])
    expect(security.every((runner) => runner.complementary === true)).toBe(true)
  })

  /** Duplication has exactly one tool, so it needs no such exemption. */
  it('leaves jscpd as an ordinary default', () => {
    expect(jscpdRunner.category).toBe('duplication')
    expect(jscpdRunner.complementary).toBeUndefined()
  })

  it('records a version for every runner', () => {
    for (const runner of [
      gitleaksRunner,
      opengrepRunner,
      zizmorRunner,
      banditRunner,
      osvScannerRunner,
      jscpdRunner,
    ]) {
      expect(runner.pinnedVersion).toMatch(/^\d+\.\d+/)
    }
  })
})
