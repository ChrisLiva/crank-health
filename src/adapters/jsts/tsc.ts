import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  RepoContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
import { byLocation, firstLine, identify, repoRelative } from '../support.ts'
import { detectNodeTool } from './node-package.ts'

/**
 * tsc — the JS/TS type checker (spec "Categories and tools").
 *
 * **What owns the types category** (spec §1, verbatim: "`tsconfig.json` alone
 * owns the types category"). Three cases, and the third is a decision worth
 * spelling out:
 *
 * 1. `tsconfig.json` present → their config decides what is checked, run with
 *    their installed TypeScript when there is one. Every diagnostic is graded:
 *    they wrote the strictness settings they are failing.
 * 2. No `tsconfig.json`, but the repo has TypeScript sources → checking them is
 *    still meaningful, so the pinned TypeScript runs against a minimal
 *    {@link DEFAULT_TSCONFIG} materialized in the scratch dir. Unresolved-import
 *    diagnostics stay advisory there ({@link DEFAULT_ADVISORY_CODES}): a repo
 *    with no `tsconfig.json` usually has no installed type declarations either,
 *    and "cannot find module 'react'" says nothing about the code's health.
 * 3. No `tsconfig.json` and no TypeScript sources → the category is not
 *    assessed. Type-checking plain JavaScript against inferred types produces
 *    noise, not signal, and nothing in the repo asked for it.
 */

export const TSC_TOOL = 'tsc'

/** npm package name; the command it ships is `tsc`. */
const TSC_PACKAGE = 'typescript'

/** The artifact that owns the types category, per spec §1. */
export const TSCONFIG = 'tsconfig.json'

/** Extensions that make a repo worth type-checking without a `tsconfig.json`. */
const TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts']

/**
 * Our bundled default config for case 3 above, written into the scratch dir —
 * never into the target repo. Deliberately permissive: without the repo's own
 * settings we report what is broken under *any* configuration, not what a
 * strict project would flag. `noEmit` plus an explicit `files` list keeps the
 * run read-only and scoped to the paths discovery already vetted.
 */
export const DEFAULT_TSCONFIG = {
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
 * missing modules and missing declaration files. On the repo's own config these
 * are graded like anything else; on ours they are advisory, because we chose a
 * module-resolution setup the repo never did.
 */
export const DEFAULT_ADVISORY_CODES: ReadonlySet<string> = new Set([
  'TS2307', // Cannot find module '…' or its corresponding type declarations.
  'TS2503', // Cannot find namespace '…'.
  'TS2688', // Cannot find type definition file for '…'.
  'TS2792', // Cannot find module … Did you mean to set 'moduleResolution' to 'node'?
  'TS7016', // Could not find a declaration file for module '…'.
])

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
  detect: (repo: RepoContext): Promise<Detection | null> =>
    detectNodeTool(repo, {
      configFiles: [TSCONFIG],
      packageName: TSC_PACKAGE,
      binName: TSC_TOOL,
    }),
  run: runTsc,
}

async function runTsc(ctx: RunContext): Promise<ToolResult> {
  const detection = ctx.detection
  const ownsConfig = detection?.configFiles.includes(TSCONFIG) === true
  const typeScriptFiles = ctx.files.filter((file) =>
    TS_EXTENSIONS.some((extension) => file.endsWith(extension)),
  )

  if (!ownsConfig && typeScriptFiles.length === 0) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'no tsconfig.json and no TypeScript sources — nothing owns the types category',
    }
  }

  const projectArgs = ownsConfig
    ? []
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
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }

  const diagnostics = parseDiagnostics(execution.stdout)

  // tsc exits non-zero when it emitted diagnostics — but also when the project
  // itself could not be loaded, and those messages carry no file, so they parse
  // to nothing. Reporting "zero type errors" there would be a lie.
  if (diagnostics.length === 0 && execution.exitCode !== 0) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `tsc failed without reporting a diagnostic (exit ${execution.exitCode ?? 'signal'}): ${
        firstLine(execution.stdout) || firstLine(execution.stderr)
      }`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(diagnostics, ownsConfig, ctx.repoRoot).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(detection?.version === undefined
      ? { toolVersion: pinnedVersion(TSC_PACKAGE) }
      : { toolVersion: detection.version }),
    rawFiles,
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

/**
 * Diagnostics → the core's vocabulary. On the repo's own `tsconfig.json`
 * everything is graded; on ours the environment-only codes stay advisory (see
 * {@link DEFAULT_ADVISORY_CODES}).
 */
export function toPendingFindings(
  diagnostics: readonly TscDiagnostic[],
  repoConfig: boolean,
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
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: repoConfig || !DEFAULT_ADVISORY_CODES.has(diagnostic.code),
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
