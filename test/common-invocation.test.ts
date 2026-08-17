import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { banditRunner } from '../src/adapters/common/bandit.ts'
import { gitleaksRunner, invocationArgs as gitleaksArgs } from '../src/adapters/common/gitleaks.ts'
import { govulncheckRunner } from '../src/adapters/common/govulncheck.ts'
import {
  JSCPD_TOOL,
  ignoreGlobs as jscpdIgnore,
  inheritanceNote,
  inheritedIgnoreGlobs,
  invocationArgs as jscpdArgs,
  jscpdRunner,
} from '../src/adapters/common/jscpd.ts'
import { readRepoExcludes } from '../src/adapters/jsts/repo-excludes.ts'
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
import { isAuditable, zizmorRunner } from '../src/adapters/common/zizmor.ts'
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
import type { Report, ReportTool } from '../src/render/json.ts'
import { reportFindings } from '../src/render/json.ts'
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

/** A clone side's path, read the way `parseJscpdReport` reads it. */
const clonedFile = (side: { name: string }) => side.name

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
    duplicates: { firstFile: { name: string }; secondFile: { name: string } }[]
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
   * `id@version` form, `--source` nuget.org, `-v quiet` so a cold NuGet cache
   * cannot narrate itself into this runner's stdout, and the `--` that keeps
   * every tool argument out of dnx's own parser.
   */
  it('wraps the roslynator tail in the pinned, nuget.org-locked dnx form', () => {
    const tail = roslynatorInvocationArgs(join(REPO, 'App.csproj'), join(SCRATCH, 'roslynator'))
    const command = dnxCommand('roslynator.dotnet.cli', tail)

    expect(command.command).toBe('dnx')
    expect(command.ephemeral).toBe('dnx')
    expect(command.args.slice(0, 7)).toEqual([
      '-y',
      'roslynator.dotnet.cli@0.12.0',
      '--source',
      'https://api.nuget.org/v3/index.json',
      '-v',
      'quiet',
      '--',
    ])
    expect(command.args.slice(7)).toEqual([...tail])
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
async function scanTemp(files: Readonly<Record<string, string>>): Promise<Report> {
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
    return scan.report
  } finally {
    await rm(repo, { recursive: true, force: true })
    await rm(out, { recursive: true, force: true })
  }
}

/**
 * Every jscpd record in a report: one per project, plus the repo-wide pass in a
 * repo with more than one project for a clone to be *between*. The single-
 * project trees below therefore yield exactly one.
 */
const jscpdRuns = (report: Report): readonly ReportTool[] =>
  report.tools.filter((tool) => tool.tool === JSCPD_TOOL)

describe('jscpd on a C#-only tree', () => {
  /** Roomy: a cold npx cache fetches the pinned jscpd first. */
  const SCAN_TIMEOUT_MS = 180_000

  it(
    'measures a tree of only .cs files instead of standing down',
    async () => {
      const runs = jscpdRuns(
        await scanTemp({ 'Program.cs': 'class Program { static void Main() {} }\n' }),
      )

      expect(runs.length).toBeGreaterThan(0)
      expect(runs.map((run) => run.state)).not.toContain('not-available')
    },
    SCAN_TIMEOUT_MS,
  )

  it(
    'names all four languages when there is nothing to measure',
    async () => {
      const runs = jscpdRuns(await scanTemp({ 'README.md': '# nothing to measure\n' }))

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

/**
 * jscpd resolves its config from its working directory, which is the scratch
 * dir, and is handed our `--config` besides — so a repo's own `.jscpd.json` is
 * definitively unread. Detection still finds that file, and must not be what
 * decides provenance: a repo that tuned `minTokens` is graded as though it had
 * not, so every run says `default-config` and the report says so too.
 */
describe('whose config decided a duplication grade', () => {
  const SCAN_TIMEOUT_MS = 180_000

  /** The `.jscpd.json` a repo would tune its duplication grade with. */
  const TUNED = `${JSON.stringify({ minTokens: 5000 }, null, 2)}\n`

  /**
   * The path that returns before jscpd is ever spawned, and the one a full
   * scan cannot reach with detection non-null. `configOwned` has to be answered
   * on every return: left off, `provenanceOf` (`src/render/json.ts:439-440`)
   * falls back to detection and the record claims `repo-config`.
   */
  it('says default-config even where it stood down without running', async () => {
    const result = await jscpdRunner.run({
      repoRoot: REPO,
      project: makeProject(['README.md']),
      files: ['README.md'],
      scratch: SCRATCH,
      runScratch: SCRATCH,
      detection: {
        reason: 'config',
        configFiles: ['.jscpd.json'],
        ownedVia: '.jscpd.json',
        installed: false,
      },
      timeoutMs: 1000,
      deep: false,
    })

    expect(result.state).toBe('not-available')
    expect(result.configOwned).toBe(false)
  })

  it(
    'reports default-config on the tool record and every clone, on a repo owning .jscpd.json',
    async () => {
      const fixture = join(import.meta.dirname, 'fixtures', 'sec-basic', 'src')
      const [handler, report] = await Promise.all([
        readFile(join(fixture, 'handler.js'), 'utf8'),
        readFile(join(fixture, 'report.js'), 'utf8'),
      ])

      const scanned = await scanTemp({ 'a.js': handler, 'b.js': report, '.jscpd.json': TUNED })

      const runs = jscpdRuns(scanned)
      expect(runs.length).toBeGreaterThan(0)
      // Detection still saw the file — this is not a test of detection going blind.
      expect(runs.some((run) => run.detection !== null)).toBe(true)
      expect(runs.map((run) => run.provenance)).toEqual(runs.map(() => 'default-config'))

      const clones = reportFindings(scanned).filter((finding) => finding.tool === JSCPD_TOOL)
      // Without this the clause below is vacuously true of an empty list.
      expect(clones.length).toBeGreaterThan(0)
      expect(clones.map((clone) => clone.provenance)).toEqual(clones.map(() => 'default-config'))
    },
    SCAN_TIMEOUT_MS,
  )

  /**
   * The honest end-to-end statement of the same fact, against the real binary:
   * `minTokens: 5000` would suppress every clone in this tree if jscpd read it.
   * The percentages are identical because it never does — a characterization
   * test, not a discriminator, and the reason `default-config` is the truth
   * rather than a simplification.
   */
  it(
    'measures the same percentage whether or not the tree carries a .jscpd.json',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'crank-jscpd-config-'))
      try {
        const tuned = join(base, 'tuned')
        const plain = join(base, 'plain')
        // A scratch dir each: the two runs share a config file name and a
        // report path, so one working directory would have them overwrite
        // each other's answer.
        const tunedScratch = join(base, 'scratch-tuned')
        const plainScratch = join(base, 'scratch-plain')
        await Promise.all([
          mkdir(tunedScratch, { recursive: true }),
          mkdir(plainScratch, { recursive: true }),
          plantDuplicates(tuned),
          plantDuplicates(plain),
        ])
        await writeFile(join(tuned, '.jscpd.json'), TUNED, 'utf8')

        const [withConfig, without] = await Promise.all([
          measureDuplication(tuned, tunedScratch),
          measureDuplication(plain, plainScratch),
        ])

        expect(withConfig.percentage).toBeGreaterThan(0)
        expect(withConfig.percentage).toBe(without.percentage)
      } finally {
        await rm(base, { recursive: true, force: true })
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

/**
 * The thresholds that turn a percentage into a letter stay crank-health's own
 * (see "whose config decided a duplication grade" above); what a repo's own
 * configs are allowed to narrow is the *file set*. A generated tree the repo
 * already told Biome or fallow to skip is not duplication anybody wrote, and
 * grading it marks a repo down for owning a code generator.
 *
 * So the excludes are read from the configs the project owns — nearest
 * ancestor first, the ownership rule detection already uses — translated only
 * where the translation is faithful, and named on the tool row so a reader can
 * see which file narrowed the measurement.
 */
/** A throwaway tree of literal files; directories are created as needed. */
const withRepo = async (
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), 'crank-excludes-'))
  try {
    for (const [file, contents] of Object.entries(files)) {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(dirname(join(root, file)), { recursive: true })
      // eslint-disable-next-line no-await-in-loop
      await writeFile(join(root, file), contents, 'utf8')
    }
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const biomeConfig = (includes: readonly string[]) =>
  JSON.stringify({ files: { includes } }, null, 2)

describe('duplication excludes inherited from the repo’s own configs', () => {
  it('reads biome’s negated includes, and nothing else in the list', async () => {
    await withRepo(
      { 'biome.json': biomeConfig(['**', 'src/**', '!gen/**', '!src/legacy/**']) },
      async (root) => {
        const excludes = await readRepoExcludes(root)
        expect(excludes.patterns).toEqual(['gen/**', 'src/legacy/**'])
        expect(excludes.sources).toEqual([
          { config: 'biome.json', patterns: ['gen/**', 'src/legacy/**'] },
        ])
        expect(excludes.unreadable).toEqual([])
      },
    )
  })

  it('reads .fallowrc.json’s ignorePatterns', async () => {
    await withRepo(
      { '.fallowrc.json': JSON.stringify({ ignorePatterns: ['generated/**'] }) },
      async (root) => {
        const excludes = await readRepoExcludes(root)
        expect(excludes.patterns).toEqual(['generated/**'])
        expect(excludes.sources).toEqual([{ config: '.fallowrc.json', patterns: ['generated/**'] }])
      },
    )
  })

  /** Both contributing is one note, and the order is the read order, not disk order. */
  it('names both configs in one note, in a stable order', async () => {
    await withRepo(
      {
        '.fallowrc.json': JSON.stringify({ ignorePatterns: ['generated/**'] }),
        'biome.json': biomeConfig(['**', '!gen/**']),
      },
      async (root) => {
        const excludes = await readRepoExcludes(root)
        expect(excludes.sources.map((source) => source.config)).toEqual([
          'biome.json',
          '.fallowrc.json',
        ])
        expect(inheritanceNote(excludes)).toBe(
          'duplication excludes inherited from biome.json, .fallowrc.json',
        )
      },
    )
  })

  /**
   * A config crank-health cannot read is a config it cannot honor, and guessing
   * at half of it would narrow the measurement by an amount nobody wrote. It
   * inherits nothing from that file and says so, rather than throwing or
   * silently measuring more than the repo asked for.
   */
  it('skips inheritance from a config it cannot parse, and says so', async () => {
    await withRepo({ 'biome.json': '{ "files": { "includes": ["**", // nope\n' }, async (root) => {
      const excludes = await readRepoExcludes(root)
      expect(excludes.patterns).toEqual([])
      expect(excludes.sources).toEqual([])
      expect(excludes.unreadable).toEqual(['biome.json'])
      expect(inheritanceNote(excludes)).toBe(
        'no duplication excludes inherited from biome.json: not readable as JSON',
      )
    })
  })

  it('still inherits from the config it can read when the other is malformed', async () => {
    await withRepo(
      {
        '.fallowrc.json': JSON.stringify({ ignorePatterns: ['generated/**'] }),
        'biome.json': 'not json at all',
      },
      async (root) => {
        const excludes = await readRepoExcludes(root)
        expect(excludes.patterns).toEqual(['generated/**'])
        expect(inheritanceNote(excludes)).toBe(
          'duplication excludes inherited from .fallowrc.json; ' +
            'no duplication excludes inherited from biome.json: not readable as JSON',
        )
      },
    )
  })

  it('inherits nothing, and says nothing, when the repo owns neither config', async () => {
    await withRepo({ 'package.json': '{}\n' }, async (root) => {
      const excludes = await readRepoExcludes(root)
      expect(excludes).toEqual({ patterns: [], sources: [], unreadable: [] })
      expect(inheritanceNote(excludes)).toBeUndefined()
      expect(inheritedIgnoreGlobs(root, excludes.patterns)).toEqual([])
    })
  })

  /** A config that excludes nothing has narrowed nothing; a note would be noise. */
  it('says nothing when a config it read declares no excludes', async () => {
    await withRepo(
      {
        'biome.json': biomeConfig(['src/**']),
        '.fallowrc.json': JSON.stringify({ entryPoints: ['src/index.ts'] }),
      },
      async (root) => {
        const excludes = await readRepoExcludes(root)
        expect(excludes.sources).toEqual([])
        expect(excludes.unreadable).toEqual([])
        expect(inheritanceNote(excludes)).toBeUndefined()
      },
    )
  })

  /**
   * Ownership inherits from ancestors, so a package with no config of its own is
   * configured by the one above it — and the patterns are read relative to the
   * directory that declared them, never to the project that inherited them.
   */
  it('takes the nearest config, and an ancestor’s where the project has none', async () => {
    await withRepo(
      {
        'biome.json': biomeConfig(['**', '!gen/**']),
        'packages/web/biome.json': biomeConfig(['**', '!build/**']),
      },
      async (root) => {
        expect((await readRepoExcludes(root, 'packages/api')).patterns).toEqual(['gen/**'])
        expect((await readRepoExcludes(root, 'packages/web')).patterns).toEqual([
          'packages/web/build/**',
        ])
      },
    )
  })

  /**
   * `!**\/dist` names a directory, and jscpd matches files — so the pattern as
   * written would exclude nothing at all. Both forms go in: what the repo wrote,
   * and the files under it, which is what it meant.
   */
  it('excludes the files under a directory the config named', async () => {
    await withRepo({ 'biome.json': biomeConfig(['**', '!**/dist']) }, async (root) => {
      expect((await readRepoExcludes(root)).patterns).toEqual(['**/dist', '**/dist/**'])
    })
  })

  /**
   * A pattern that cannot be translated faithfully is dropped rather than
   * approximated: an exclude that reaches further than the repo's own config
   * meant would hide real duplication behind a grade nobody can audit.
   */
  it('skips a pattern it cannot translate without widening it', async () => {
    await withRepo(
      {
        'biome.json': biomeConfig(['**', '!../outside/**', '!/abs/**', '!', '!!odd/**', '!ok/**']),
      },
      async (root) => {
        expect((await readRepoExcludes(root)).patterns).toEqual(['ok/**'])
      },
    )
  })

  /** Determinism: the config jscpd is handed must not depend on config order. */
  it('sorts and dedupes the inherited patterns', async () => {
    await withRepo(
      {
        'biome.json': biomeConfig(['**', '!z/**', '!a/**', '!z/**']),
        '.fallowrc.json': JSON.stringify({ ignorePatterns: ['a/**'] }),
      },
      async (root) => {
        const excludes = await readRepoExcludes(root)
        expect(excludes.patterns).toEqual(['a/**', 'z/**'])
        expect(excludes.sources.map((source) => source.patterns)).toEqual([
          ['a/**', 'z/**'],
          ['a/**'],
        ])
      },
    )
  })

  /**
   * Anchored to the repo root, not to the scanned directory: the pattern is
   * relative to the config that declared it, and the config can sit above the
   * project being measured. The prefix is escaped for the same reason every
   * other glob's is — see "escapes glob metacharacters in the path it anchors to".
   */
  it('anchors an inherited pattern to the repo root, escaping the literal prefix', () => {
    expect(inheritedIgnoreGlobs('/src/br[ack]et', ['gen/**'])).toEqual([
      String.raw`/src/br\[ack\]et/gen/**`,
    ])
  })

  /**
   * The end of the wire, against the real binary: a clone planted inside the
   * `gen/` tree biome.json excludes is neither reported nor counted, the same
   * clone in `src/` still is, and the row says which config narrowed the run.
   * The second scan is the discriminator — without the config, `gen/` is
   * measured like anything else.
   */
  it('leaves a clone inside a biome-excluded gen/ unmeasured, and says which config did it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'crank-jscpd-excludes-'))
    try {
      const fixture = join(import.meta.dirname, 'fixtures', 'sec-basic', 'src')
      const [handler, report] = await Promise.all([
        readFile(join(fixture, 'handler.js'), 'utf8'),
        readFile(join(fixture, 'report.js'), 'utf8'),
      ])
      const files = ['src/a.js', 'src/b.js', 'gen/a.js', 'gen/b.js']

      const scanOf = async (name: string, config: Record<string, string>) => {
        const root = join(base, name)
        const scratch = join(base, `${name}-scratch`)
        await mkdir(scratch, { recursive: true })
        await Promise.all(
          ['src', 'gen'].map(async (directory) => {
            await mkdir(join(root, directory), { recursive: true })
            await Promise.all([
              writeFile(join(root, directory, 'a.js'), handler, 'utf8'),
              writeFile(join(root, directory, 'b.js'), report, 'utf8'),
            ])
          }),
        )
        for (const [file, contents] of Object.entries(config)) {
          // eslint-disable-next-line no-await-in-loop
          await writeFile(join(root, file), contents, 'utf8')
        }
        return jscpdRunner.run({
          repoRoot: root,
          project: makeProject(files),
          files,
          scratch,
          runScratch: scratch,
          detection: null,
          timeoutMs: 120_000,
          deep: false,
        })
      }

      const excluded = await scanOf('excluded', {
        'biome.json': biomeConfig(['**', '!gen/**']),
      })
      expect(excluded.state).toBe('ok')
      expect(excluded.findings.filter((finding) => finding.file.startsWith('gen/'))).toEqual([])
      expect(excluded.findings.some((finding) => finding.file.startsWith('src/'))).toBe(true)
      expect(excluded.reason).toBe('duplication excludes inherited from biome.json')

      const measured = await scanOf('measured', {})
      expect(measured.findings.some((finding) => finding.file.startsWith('gen/'))).toBe(true)
      expect(measured.reason).toBeUndefined()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }, 240_000)
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

/**
 * zizmor is handed discovery's paths, then filters them itself — so this
 * predicate, not the inventory, is what decides whether a workflow file is
 * audited. Discovery keeps a `.github` at any depth (see `isHiddenScope`); a
 * filter anchored at the repo root would take a nested package's workflows
 * straight back out again, and zizmor would report `not-available` on a repo
 * whose workflows it was holding.
 */
describe('the inputs zizmor audits', () => {
  it.each([
    '.github/workflows/ci.yml',
    '.github/workflows/release.yaml',
    // A package's own workflows are workflow files at any depth.
    'packages/web/.github/workflows/x.yml',
    'a/b/c/.github/workflows/x.yaml',
    // Composite actions, which live wherever their action does.
    'action.yml',
    '.github/actions/setup/action.yml',
    'packages/web/.github/actions/setup/action.yaml',
  ])('audits %s', (file) => {
    expect(isAuditable(file)).toBe(true)
  })

  it.each([
    // `workflows/` is the directory that makes a YAML file a workflow.
    '.github/dependabot.yml',
    '.github/zizmor.yml',
    'workflows/ci.yml',
    '.github/workflows/nested/ci.yml',
    // Neither a workflow nor an action, whatever it is named.
    'src/app.js',
    'action.json',
    'my-action.yml',
    'README.md',
    '',
  ])('leaves %s alone', (file) => {
    expect(isAuditable(file)).toBe(false)
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
      'govulncheck',
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
      govulncheckRunner,
      jscpdRunner,
    ]) {
      // Go versions carry the `v`; every other ecosystem's does not.
      expect(runner.pinnedVersion).toMatch(/^v?\d+\.\d+/)
    }
  })
})
