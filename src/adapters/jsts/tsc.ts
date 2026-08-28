import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repoPath } from '../../core/discover.ts'
import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
import { byLocation, failed, firstLine, identify, repoRelative } from '../support.ts'
import { detectNodeTool, hasInstalledDependencies } from './node-package.ts'

/**
 * tsc — the JS/TS type checker (spec "Categories and tools").
 *
 * **What owns the types category** (spec §1, verbatim: "`tsconfig.json` alone
 * owns the types category"). Three cases, and the third is a decision worth
 * spelling out:
 *
 * 1. `tsconfig.json` present → their config decides what is checked, run with
 *    their installed TypeScript when there is one. Every diagnostic is graded:
 *    they wrote the strictness settings they are failing. The one exception is
 *    a project with no install, where the "cannot find `@types/…`" diagnostics
 *    stay advisory ({@link DEFAULT_ADVISORY_CODES}): nothing was there to
 *    resolve them from.
 * 2. No `tsconfig.json`, but the repo has TypeScript sources → checking them is
 *    still meaningful, so the pinned TypeScript runs against a minimal
 *    {@link DEFAULT_TSCONFIG} materialized in the scratch dir. Missing-types
 *    diagnostics stay advisory there ({@link DEFAULT_ADVISORY_CODES}): a repo
 *    with no `tsconfig.json` usually has no installed type declarations either,
 *    and "cannot find module 'react'" — or "install @types/node" for a file
 *    that imports `node:fs` — says nothing about the code's health.
 * 3. No `tsconfig.json` and no TypeScript sources → the category is not
 *    assessed. Type-checking plain JavaScript against inferred types produces
 *    noise, not signal, and nothing in the repo asked for it.
 */

const TSC_TOOL = 'tsc'

/** npm package name; the command it ships is `tsc`. */
const TSC_PACKAGE = 'typescript'

/** The artifact that owns the types category, per spec §1. */
const TSCONFIG = 'tsconfig.json'

/** Extensions that make a repo worth type-checking without a `tsconfig.json`. */
const TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts']

/**
 * Our bundled default config for case 3 above, written into the scratch dir —
 * never into the target repo. Deliberately permissive: without the repo's own
 * settings we report what is broken under *any* configuration, not what a
 * strict project would flag. `noEmit` plus an explicit `files` list keeps the
 * run read-only and scoped to the paths discovery already vetted.
 */
const DEFAULT_TSCONFIG = {
  compilerOptions: {
    target: 'es2022',
    lib: ['es2023', 'dom'],
    module: 'preserve',
    moduleResolution: 'bundler',
    jsx: 'preserve',
    strict: false,
    allowJs: false,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    allowImportingTsExtensions: true,
  },
} as const

/**
 * Diagnostics that are about the repo's *environment* rather than its code:
 * missing modules, missing declaration files, and globals with no ambient
 * types. Every one of them says "install a `@types/*` package", which is a
 * fact about `node_modules`, not about the code.
 *
 * Two things have to hold before one counts toward the grade. The repo's own
 * `tsconfig.json` has to have produced it, because under our bundled config we
 * chose the module resolution and the `lib`/`types` set the repo never did.
 * And the project has to have an install ({@link hasInstalledDependencies}),
 * because a project whose dependencies are absent cannot resolve a declaration
 * whatever its config says, so grading these would grade whether `npm install`
 * ran. crank-health installs nothing into the target (spec §7), so it meets
 * uninstalled projects routinely: a fresh clone, a CI job that scans before it
 * installs, a fixture tree checked in as test input.
 */
const DEFAULT_ADVISORY_CODES: ReadonlySet<string> = new Set([
  'TS2307', // Cannot find module '…' or its corresponding type declarations.
  'TS2503', // Cannot find namespace '…'.
  'TS2580', // Cannot find name 'require'/'module'/'__dirname'. Try `npm i --save-dev @types/node`.
  'TS2591', // Cannot find name '…'. Do you need to install type definitions for node?
  'TS2593', // Cannot find name 'describe'/'it'. Do you need to install @types/jest or @types/mocha?
  'TS2688', // Cannot find type definition file for '…'.
  'TS2792', // Cannot find module … Did you mean to set 'moduleResolution' to 'node'?
  'TS7016', // Could not find a declaration file for module '…'.
])

/**
 * The same fact stated in the message rather than in the code. TypeScript has
 * a "do you need to install type definitions" diagnostic per ambient library
 * and {@link DEFAULT_ADVISORY_CODES} cannot name them all: TS2592 (jQuery) is
 * the one it misses today, and only that diagnostic's wording says the missing
 * name is a library we never installed types for rather than a typo.
 *
 * This sits *under* {@link DEFAULT_ADVISORY_CODES}, not instead of it: the
 * codes are TypeScript's stable contract and the wording is not, so a compiler
 * rewording loses only the diagnostics the codes never named — today's grade —
 * where a message-only net would let the whole rule lapse. Both are read, and
 * either one alone is enough to make a diagnostic advisory.
 *
 * Both alternatives are *instructions to install*, not the substring `@types/`:
 * tsc prints fully-qualified `node_modules/@types/…` paths inside ordinary
 * assignability errors, and a bare-substring net would demote those out of the
 * grade on nothing but where a declaration file happens to live. The narrower
 * `npm i --save-dev @types/` is kept rather than dropped, because a lone
 * `install type definitions` would *be* the wording this rule exists to
 * outlive — one alternative that is the phrase it guards against is no net at
 * all. No path can contain either phrase.
 *
 * No `g` flag: `.test` would otherwise carry `lastIndex` between diagnostics
 * and classify the same message differently depending on emission order, which
 * is a determinism bug (spec §7).
 */
const ADVISORY_MESSAGE = /npm i --save-dev @types\/|install type definitions/

const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  error: 'error',
  warning: 'warning',
  message: 'info',
}

/**
 * Flags shared by every invocation.
 *
 * Zero footprint (spec §7): `--noEmit` stops tsc writing compiled output and
 * `--incremental false` stops it writing a `.tsbuildinfo` next to the config —
 * which a repo whose `tsconfig.json` enables `incremental` would otherwise get.
 * `--pretty false` is what makes the diagnostics parseable.
 */
const BASE_ARGS: readonly string[] = ['--noEmit', '--pretty', 'false', '--incremental', 'false']

export const tscRunner: ToolRunner = {
  tool: TSC_TOOL,
  category: 'types',
  pinnedVersion: pinnedVersion(TSC_PACKAGE),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      configFiles: [TSCONFIG],
      packageName: TSC_PACKAGE,
      binName: TSC_TOOL,
      // A `tsconfig.json` is a project definition, not a setting TypeScript
      // resolves upward: a package without one is not covered by the config
      // above it, and gets {@link DEFAULT_TSCONFIG} scoped to its own files.
      // The declared TypeScript is still inherited — that is the compiler that
      // runs either way.
      configInherits: false,
    }),
  run: runTsc,
}

async function runTsc(ctx: RunContext): Promise<ToolResult> {
  const detection = ctx.detection
  // The project's own `tsconfig.json`, not an ancestor's: TypeScript does not
  // resolve one upward, so detection never inherits it (`configInherits: false`)
  // and the path to look for is this project's.
  const ownsConfig = detection?.configFiles.includes(repoPath(ctx.project.path, TSCONFIG)) === true
  const typeScriptFiles = ctx.files.filter((file) =>
    TS_EXTENSIONS.some((extension) => file.endsWith(extension)),
  )

  if (!ownsConfig && typeScriptFiles.length === 0) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'no tsconfig.json and no TypeScript sources — nothing owns the types category',
      configOwned: ownsConfig,
    }
  }

  // Either way the project being checked is named explicitly. Left implicit,
  // tsc resolves a `tsconfig.json` from its working directory — which is the
  // repo root, and in a monorepo that is another project's config.
  const projectArgs = ownsConfig
    ? ['--project', join(ctx.repoRoot, ctx.project.path)]
    : ['--project', await materializeDefaultConfig(ctx.scratch, ctx.repoRoot, typeScriptFiles)]

  const command =
    detection?.installed === true && detection.binPath !== undefined
      ? repoCommand(detection.binPath, [])
      : ephemeralCommand(TSC_PACKAGE, [], TSC_TOOL)

  const execution = await execTool(
    { ...command, args: [...command.args, ...BASE_ARGS, ...projectArgs] },
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'tsc.txt', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'tsc.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return { ...failed(execution.failure, rawFiles), configOwned: ownsConfig }
  }

  // The findings this run actually produced: parsed, then narrowed to the files
  // discovery gave us. Both steps drop diagnostics — the parser drops the ones
  // with no `file(line,col)` prefix, the filter drops the ones about a file
  // nobody asked us to analyze (`tsconfig.json` itself, a `.d.ts` outside the
  // inventory) — and the guard below has to see what survived *both*, not what
  // survived the first. A config that type-checks nothing (`"files": []`,
  // TS18002) reports only diagnostics of exactly that kind, and calling that
  // "zero type errors" is the lie this guard exists to prevent.
  // Not a question detection already answered: detection reports whether
  // TypeScript itself is installed, and what decides an environment-only
  // diagnostic is whether any install exists to have supplied the declarations.
  const dependenciesInstalled = await hasInstalledDependencies(ctx.repoRoot, ctx.project.path)

  const analyzed = new Set(ctx.files)
  const pending = toPendingFindings(
    parseDiagnostics(execution.stdout),
    { repoConfig: ownsConfig, dependenciesInstalled },
    ctx.repoRoot,
  ).filter((finding) => analyzed.has(finding.file))

  // tsc exits non-zero when it emitted diagnostics — but also when the project
  // itself could not be loaded or resolved to no input at all.
  if (pending.length === 0 && execution.exitCode !== 0) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `tsc failed without reporting a diagnostic in any analyzed file (exit ${
        execution.exitCode ?? 'signal'
      }): ${firstLine(execution.stdout) || firstLine(execution.stderr)}`,
      configOwned: ownsConfig,
    }
  }

  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending),
    ...(detection?.version === undefined
      ? { toolVersion: pinnedVersion(TSC_PACKAGE) }
      : { toolVersion: detection.version }),
    rawFiles,
    // Spec §1: `tsconfig.json` owns the types category, and a *declared*
    // TypeScript dependency does not. Detection sees both, so the runner is the
    // only place that knows which config actually decided these findings.
    configOwned: ownsConfig,
  }
}

/** One `file(line,col): error TSxxxx: message` line. */
export interface TscDiagnostic {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly level: string
  readonly code: string
  readonly message: string
}

/**
 * tsc has no machine-readable output, so its text form is the contract:
 * `path/to/file.ts(12,7): error TS2322: Type 'a' is not assignable to 'b'.`
 *
 * Continuation lines (related information, multi-part messages) are indented
 * and therefore never match, which is exactly right — they belong to the
 * diagnostic above them, not to a finding of their own.
 */
const DIAGNOSTIC_PATTERN =
  /^(?<file>\S[^(]*)\((?<line>\d+),(?<column>\d+)\): (?<level>error|warning|message) (?<code>TS\d+): (?<message>.*)$/

/** Exported so a tsc output-format shift fails a test (plan M4 checks). */
export function parseDiagnostics(stdout: string): TscDiagnostic[] {
  return stdout.split('\n').flatMap((line) => {
    const match = DIAGNOSTIC_PATTERN.exec(line.trimEnd())
    const groups = match?.groups
    if (groups === undefined) return []
    return [
      {
        file: groups['file'] ?? '',
        line: Number(groups['line']),
        column: Number(groups['column']),
        level: groups['level'] ?? 'error',
        code: groups['code'] ?? '',
        message: groups['message'] ?? '',
      } satisfies TscDiagnostic,
    ]
  })
}

/** What decides whether an environment-only diagnostic counts toward the grade. */
export interface TypeCheckScope {
  /** The diagnostics came from the repo's own `tsconfig.json`, not our bundled one. */
  readonly repoConfig: boolean
  /** The project has a `node_modules`, so `@types/*` declarations could resolve. */
  readonly dependenciesInstalled: boolean
}

/**
 * Diagnostics → the core's vocabulary. An environment-only diagnostic,
 * recognized by code ({@link DEFAULT_ADVISORY_CODES}) or by wording
 * ({@link ADVISORY_MESSAGE}), is graded only when the repo's own config
 * produced it and the project has an install it could have resolved from.
 * Every other diagnostic is graded under either config.
 */
export function toPendingFindings(
  diagnostics: readonly TscDiagnostic[],
  scope: TypeCheckScope,
  repoRoot: string,
): PendingFinding[] {
  return diagnostics
    .map((diagnostic) => ({
      category: 'types' as const,
      tool: TSC_TOOL,
      rule: diagnostic.code,
      severity: SEVERITY_BY_LEVEL[diagnostic.level] ?? 'error',
      file: repoRelative(diagnostic.file, repoRoot),
      range: {
        startLine: diagnostic.line,
        startCol: diagnostic.column,
        endLine: diagnostic.line,
        endCol: diagnostic.column,
      },
      message: diagnostic.message,
      provenance: scope.repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope:
        (scope.repoConfig && scope.dependenciesInstalled) ||
        (!DEFAULT_ADVISORY_CODES.has(diagnostic.code) &&
          !ADVISORY_MESSAGE.test(diagnostic.message)),
    }))
    .toSorted(byLocation)
}

/**
 * Writes {@link DEFAULT_TSCONFIG} into scratch, listing the discovered
 * TypeScript files by absolute path (relative entries would resolve against the
 * scratch dir), and returns the config path.
 */
async function materializeDefaultConfig(
  scratch: string,
  repoRoot: string,
  files: readonly string[],
): Promise<string> {
  const directory = join(scratch, TSC_TOOL)
  await mkdir(directory, { recursive: true })
  const target = join(directory, 'tsconfig.json')
  const config = { ...DEFAULT_TSCONFIG, files: files.map((file) => join(repoRoot, file)) }
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return target
}
