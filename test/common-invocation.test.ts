import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { banditRunner } from '../src/adapters/common/bandit.ts'
import { gitleaksRunner, invocationArgs as gitleaksArgs } from '../src/adapters/common/gitleaks.ts'
import {
  JSCPD_TOOL,
  ignoreGlobs as jscpdIgnore,
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
import { buildInvocationArgs } from '../src/adapters/csharp/build.ts'
import { formatInvocationArgs } from '../src/adapters/csharp/dotnet-format.ts'
import { dotnetEnv, dotnetExecOptions } from '../src/adapters/csharp/dotnet-project.ts'
import { csharpAdapter } from '../src/adapters/csharp/index.ts'
import { roslynatorInvocationArgs } from '../src/adapters/csharp/roslynator.ts'
import {
  TOOL_RESTORE_ARGS,
  mutationReportPath,
  strykerNetInvocationArgs,
  strykerNetRunner,
} from '../src/adapters/csharp/stryker-net.ts'
import { EXCLUDED_SEGMENTS } from '../src/core/discover.ts'
import { dnxCommand } from '../src/core/exec.ts'
import { pinnedVersion } from '../src/manifest.ts'
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

/** jscpd names a clone's side as an object in some entries and a string in others. */
const clonedFile = (file: unknown) =>
  typeof file === 'object' && file !== null
    ? ((file as { name?: string }).name ?? '')
    : String(file)

/** A duplicated pair, repeated under two directories the ignore list has to exclude. */
const plantDuplicates = async (root: string) => {
  const fixture = join(import.meta.dirname, 'fixtures', 'sec-basic', 'src')
  const [handler, report] = await Promise.all([
    readFile(join(fixture, 'handler.js'), 'utf8'),
    readFile(join(fixture, 'report.js'), 'utf8'),
  ])
  await Promise.all(
    ['src', 'node_modules', '.secretdir'].map(async (directory) => {
      await mkdir(join(root, directory), { recursive: true })
      await Promise.all([
        writeFile(join(root, directory, 'a.js'), handler, 'utf8'),
        writeFile(join(root, directory, 'b.js'), report, 'utf8'),
      ])
    }),
  )
}

/** The pinned binary, run as the runner runs it: config in scratch, cwd outside the tree. */
const measureDuplication = async (root: string, scratch: string) => {
  const config = join(scratch, 'jscpd.json')
  await writeFile(config, JSON.stringify({ ignore: jscpdIgnore(root) }), 'utf8')
  const output = join(scratch, 'jscpd')
  await execa(
    'npx',
    ['-y', `jscpd@${pinnedVersion('jscpd')}`, ...jscpdArgs(root, output, config)],
    {
      cwd: scratch,
      reject: false,
    },
  )
  const report = JSON.parse(await readFile(join(output, 'jscpd-report.json'), 'utf8')) as {
    statistics: { total: { percentageTokens: number } }
    duplicates: { firstFile: unknown; secondFile: unknown }[]
  }
  return {
    percentage: report.statistics.total.percentageTokens,
    files: [
      ...new Set(
        report.duplicates.flatMap((d) => [clonedFile(d.firstFile), clonedFile(d.secondFile)]),
      ),
    ],
  }
}

/**
 * The ignore list is the only thing between the duplication grade and a repo's
 * dependencies, and jscpd matches it against the absolute paths it walks — so
 * whether it works at all depends on the repo's own address. The argument tests
 * further down pin the strings; these pin what the real matcher does with them,
 * because a list that matches nothing renders exactly like a list that matches
 * everything it should.
 */
describe('jscpd’s ignore list, against the real tool', () => {
  /**
   * Each of these directory names disables the list a different way, and every
   * one of them fails toward a *wrong grade* rather than an error: a hidden
   * ancestor matches `**\/.*\/**` on the repo's own address; `[` and `{` are
   * pattern syntax in the literal prefix; `,` splits the value jscpd is handed.
   */
  it.each([
    ['a plain path', 'plain'],
    ['a hidden ancestor', join('.cache', 'repo')],
    ['brackets in the path', 'br[ack]et'],
    ['braces in the path', 'br{ac}e'],
    ['parentheses in the path', 'pa(re)n'],
    ['a comma in the path', 'my,repo'],
  ])(
    'measures the repo and not its dependencies, with %s',
    async (_label, relative) => {
      const base = await mkdtemp(join(tmpdir(), 'crank-jscpd-'))
      try {
        const root = join(base, relative)
        const scratch = join(base, 'scratch')
        await mkdir(scratch, { recursive: true })
        await plantDuplicates(root)

        const { percentage, files } = await measureDuplication(root, scratch)

        // The `src/` pair is measured…
        expect(files.some((file) => file.includes(`${join(root, 'src')}/`))).toBe(true)
        expect(percentage).toBeGreaterThan(0)
        // …and neither excluded directory is, in the clones or in the ratio.
        expect(files.filter((file) => file.includes('node_modules'))).toEqual([])
        expect(files.filter((file) => file.includes('.secretdir'))).toEqual([])
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    120_000,
  )
})

describe('zero footprint, in the arguments', () => {
  /** The ignore list, read from the seam that builds it rather than from a flag. */
  const ignoreOf = (nested: readonly string[] = []) => jscpdIgnore(REPO, nested)

  /** jscpd's default reporter writes `report/` into the working directory. */
  it('redirects jscpd’s report into the scratch dir', () => {
    const args = jscpdArgs(REPO, join(SCRATCH, 'jscpd'), join(SCRATCH, 'jscpd.json'))
    expect(args[args.indexOf('--output') + 1]).toBe('/scratch/jscpd')
    expect(args).toContain('--reporters')
    expect(args.at(-1)).toBe(REPO)
  })

  /**
   * jscpd splits `--ignore` on `,`, so a single comma in the repo's own path
   * would truncate every rule after it. The config file's array does not split.
   */
  it('hands jscpd its ignore list in a scratch config file, not on --ignore', () => {
    const args = jscpdArgs(REPO, join(SCRATCH, 'jscpd'), join(SCRATCH, 'jscpd.json'))
    expect(args).not.toContain('--ignore')
    expect(args[args.indexOf('--config') + 1]).toBe('/scratch/jscpd.json')
  })

  it('keeps jscpd out of .git and dependency directories', () => {
    const ignore = ignoreOf().join(',')
    for (const excluded of ['.git', 'node_modules', '.venv', '__pycache__']) {
      expect(ignore).toContain(excluded)
    }
  })

  /**
   * The list is discovery's, not a hand-maintained twin of it: every segment
   * discovery never scans is a glob here, so the two file sets cannot drift
   * apart as one of them grows.
   */
  it('derives jscpd’s ignore list from discovery’s excluded segments', () => {
    const entries = ignoreOf()
    for (const segment of EXCLUDED_SEGMENTS) {
      expect(entries).toContain(`${REPO}/**/${segment}/**`)
    }
  })

  /**
   * Discovery drops every hidden directory but the root `.github/`, and jscpd
   * walks the tree itself, so this glob is the only thing applying that rule to
   * the duplication measurement. A glob list has no negation, so the exemption
   * cannot come back: `.github/scripts/` is excluded too, and that is the
   * approximation stated on the constant.
   */
  it('keeps jscpd out of hidden directories, with no way to carve .github back in', () => {
    const entries = ignoreOf()
    expect(entries).toContain(`${REPO}/**/.*/**`)
    expect(entries.filter((entry) => entry.startsWith('!'))).toEqual([])
    expect(entries.filter((entry) => entry.includes('.github'))).toEqual([])
  })

  /**
   * jscpd walks absolute paths, so an unanchored glob matches the *ancestors*
   * of the scanned directory as well as its contents: a repo checked out under
   * `~/.cache/` or `.claude/worktrees/` matches `**\/.*\/**` on a segment of
   * its own address, and jscpd ignores the entire tree — reporting 0% of tokens
   * duplicated and a flattering A for a repo it never measured. Anchoring every
   * glob to the scanned directory is what confines each rule to the tree it is
   * about.
   */
  it('anchors every ignore glob to the scanned directory, so no ancestor can match', () => {
    const entries = ignoreOf(['packages/api'])
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.filter((entry) => !entry.startsWith(`${REPO}/`))).toEqual([])
  })

  /**
   * The anchoring prefix is a literal path spliced into a pattern, so a repo
   * checked out to `~/src/br[ack]et/` would otherwise turn its own address into
   * a character class that matches nothing — taking every ignore rule with it
   * and putting `node_modules/` back inside the duplication measurement.
   */
  it('escapes glob metacharacters in the path it anchors to', () => {
    const entries = jscpdIgnore('/src/br[ack]et/re{p}o(1)', ['packages/api'])
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.startsWith(String.raw`/src/br\[ack\]et/re\{p\}o\(1\)/`)).toBe(true)
    }
  })

  /**
   * jscpd is handed a directory, so a project holding packages of its own would
   * measure their code — and the clones between them — as its duplication. That
   * measurement is the repo-wide pass's, and only the rollup grades on it.
   */
  it('leaves a parent project’s nested projects to the nested projects', () => {
    const ignore = ignoreOf(['packages/api', 'packages/web'])
    expect(ignore).toContain(`${REPO}/packages/api/**`)
    expect(ignore).toContain(`${REPO}/packages/web/**`)
    // …and the repo-wide pass, which passes none, still sees every package.
    const entries = ignoreOf()
    expect(entries).not.toContain(`${REPO}/packages/api/**`)
    expect(entries).not.toContain(`${REPO}/packages/web/**`)
  })

  it('asks jscpd for exactly the graded languages, C# included', () => {
    const args = jscpdArgs(REPO, join(SCRATCH, 'jscpd'), join(SCRATCH, 'jscpd.json'))
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
    const entries = ignoreOf()
    expect(entries).toContain(`${REPO}/**/bin/**`)
    expect(entries).toContain(`${REPO}/**/obj/**`)
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
   * The build command: SARIF 2.1 into scratch (the `%2C` escape is what keeps
   * the SDK from silently emitting SARIF 1.0), every MSBuild output property
   * redirected into scratch (zero footprint under full compilation), our
   * targets injected, and restore pinned to nuget.org — `dotnet build` has no
   * `--source` flag, so without `RestoreSources` the scanned repo's
   * `NuGet.config` would choose which analyzer binary crank-health executes.
   * No `--no-restore`: the injected analyzer PackageReference must resolve.
   */
  it('builds a scratch-confined, nuget.org-pinned dotnet build command', () => {
    const args = buildInvocationArgs({
      projectDir: join(REPO, 'svc'),
      scratch: join(SCRATCH, 'dotnet-build'),
      sarifPath: join(SCRATCH, 'dotnet-build', 'build.sarif'),
      targetsPath: join(SCRATCH, 'dotnet-build', 'crank-health.targets'),
    })

    expect(args.slice(0, 2)).toEqual(['build', '/repo/svc'])
    expect(args).toContain('-p:ErrorLog=/scratch/dotnet-build/build.sarif%2Cversion=2.1')
    expect(args).toContain('-p:BaseIntermediateOutputPath=/scratch/dotnet-build/obj/')
    expect(args).toContain('-p:BaseOutputPath=/scratch/dotnet-build/bin/')
    expect(args).toContain('-p:MSBuildProjectExtensionsPath=/scratch/dotnet-build/obj/')
    expect(args).toContain(
      '-p:CustomAfterMicrosoftCommonTargets=/scratch/dotnet-build/crank-health.targets',
    )
    expect(args).toContain('-p:RestoreSources=https://api.nuget.org/v3/index.json')
    expect(args).not.toContain('--no-restore')
    // Beyond the project dir itself, every path points into scratch.
    for (const value of args.slice(2).map((arg) => arg.replace(/^-p:[A-Za-z]+=/, ''))) {
      if (value.startsWith('/')) expect(value.startsWith('/scratch/')).toBe(true)
    }
  })

  /**
   * The roslynator tail handed to `dnxCommand`: read-only `find-symbol` (the
   * mutating `--remove` mode is unreachable), and every MSBuild output the
   * design-time build produces redirected into scratch through `--properties`
   * (flag spelling surveyed against the 0.12.0 CLI's `find-symbol --help`).
   */
  it('builds a read-only roslynator find-symbol command confined to scratch', () => {
    const args = roslynatorInvocationArgs(join(REPO, 'App.csproj'), join(SCRATCH, 'roslynator'))

    expect(args).toEqual([
      'find-symbol',
      '/repo/App.csproj',
      '--unused',
      '--properties',
      'BaseIntermediateOutputPath=/scratch/roslynator/obj/',
      'BaseOutputPath=/scratch/roslynator/bin/',
      'MSBuildProjectExtensionsPath=/scratch/roslynator/obj/',
    ])
    expect(args).not.toContain('--remove')
  })

  /**
   * The exact pin and the exact feed are `dnxCommand`'s (spec §6): `-y`, the
   * `id@version` form, `--source` nuget.org, and the `--` that keeps every
   * tool argument out of dnx's own parser.
   */
  it('wraps the roslynator tail in the pinned, nuget.org-locked dnx form', () => {
    const tail = roslynatorInvocationArgs(join(REPO, 'App.csproj'), join(SCRATCH, 'roslynator'))
    const command = dnxCommand('roslynator.dotnet.cli', tail)

    expect(command.command).toBe('dnx')
    expect(command.ephemeral).toBe('dnx')
    expect(command.args.slice(0, 5)).toEqual([
      '-y',
      'roslynator.dotnet.cli@0.12.0',
      '--source',
      'https://api.nuget.org/v3/index.json',
      '--',
    ])
    expect(command.args.slice(5)).toEqual([...tail])
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
      runScratch: SCRATCH,
      detection: null,
      timeoutMs: 12_345,
      deep: false,
    }

    expect(dotnetExecOptions(ctx, '/repo/src')).toEqual({
      cwd: '/repo/src',
      timeoutMs: 12_345,
      env: dotnetEnv(),
    })

    // The dnx-fetched runners work from scratch, with the pinned environment:
    // NUGET_PACKAGES pinned to the machine cache (zero footprint under a
    // hostile NuGet.config), diagnostics forced to English (determinism).
    expect(dotnetExecOptions(ctx, join(SCRATCH, 'roslynator'))).toEqual({
      cwd: '/scratch/roslynator',
      timeoutMs: 12_345,
      env: dotnetEnv(),
    })
    expect(dotnetEnv()['NUGET_PACKAGES']).toBe(join(homedir(), '.nuget', 'packages'))
    expect(dotnetEnv()['DOTNET_CLI_UI_LANGUAGE']).toBe('en')
  })

  /**
   * The two commands the Stryker.NET runner spawns, both through the repo's
   * own restored tool: `tool restore` resolves the manifest's pins into the
   * NuGet machine cache without evaluating a repo target, and the run itself
   * sends Stryker's whole output tree (`reports/`, `logs/`) into scratch —
   * `--output` is what keeps a `StrykerOutput/` from landing beside the code.
   */
  it('builds a restore-then-run dotnet stryker pair reporting into scratch', () => {
    expect(TOOL_RESTORE_ARGS).toEqual(['tool', 'restore'])
    expect(strykerNetInvocationArgs(join(SCRATCH, 'job'))).toEqual([
      'stryker',
      '--output',
      '/scratch/job/stryker-net',
      '--reporter',
      'json',
    ])
    // The runner reads the report exactly where `--output` makes Stryker write it.
    expect(mutationReportPath(join(SCRATCH, 'job'))).toBe(
      '/scratch/job/stryker-net/reports/mutation-report.json',
    )
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
    // `dead-code` precedes `complexity` in `CATEGORIES`, so roslynator sits at
    // index 1 — between the build-backed `types` runner and the rest.
    expect(categories[1]).toBe('dead-code')
  })

  /** Task 9 completes the list: `test-quality` is `CATEGORIES`' last member. */
  it('answers every C# category, stryker-net last', () => {
    expect(csharpAdapter.runners.map((runner) => runner.category)).toEqual([
      'types',
      'dead-code',
      'complexity',
      'lint',
      'format',
      'test-quality',
    ])
    expect(csharpAdapter.runners.at(-1)).toBe(strykerNetRunner)
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
