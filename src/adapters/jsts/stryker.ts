import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execTool, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  DetectContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { verifiedRepoVersion } from '../../manifest.ts'
import {
  SURVIVED_FINDING_LIMIT,
  mutationCounts,
  parseMutationReport,
  toPendingFindings,
} from '../mutation-report.ts'
import type { Mutant } from '../mutation-report.ts'
import { asRecord, firstLine, identify, readJson } from '../support.ts'
import { detectNodeTool } from './node-package.ts'

/**
 * StrykerJS — mutation testing for JavaScript and TypeScript, and the only
 * thing in crank-health that runs the target's own test suite (spec §5: "deep
 * is the only tier that executes repo code").
 *
 * **Why this runner only ever uses the repo's own installation.** Stryker does
 * not analyze code, it *runs* it: it mutates a copy of the sources and executes
 * the repo's tests against each mutant. That needs the repo's test runner, the
 * matching Stryker runner plugin (`@stryker-mutator/vitest-runner`,
 * `…/jest-runner`, …) and every dependency the tests import — all of which live
 * in the repo's `node_modules` and none of which an ephemeral `npx
 * @stryker-mutator/core` would have. So the posture is:
 *
 * - repo-owned (a `stryker.config.*` or a declared `@stryker-mutator/core`)
 *   **and installed** → run their binary, inheriting their config;
 * - repo-owned but not installed → `not-available` with "run `npm install`";
 * - not owned at all → the runner never runs (`repoOwnedOnly`), and test
 *   quality stays not-assessed with a hint for enabling it.
 *
 * A default ephemeral Stryker on a repo that never configured one would have to
 * guess the test runner, and would report a mutation score of "everything
 * survived" whenever it guessed wrong — a confident wrong grade in place of an
 * honest gap (spec §8). That is the v1 default posture.
 *
 * **Zero footprint (spec §7) is entirely a matter of where Stryker writes.**
 * Left alone it writes `reports/` and `.stryker-tmp/` into the current
 * directory, and the current directory has to be the repo for the tests to run.
 * Both are redirected into the scratch dir through the generated config below,
 * and the zero-footprint test covers the result.
 *
 * **PR scoping is `mutate`, not `--since`.** The plan called for `--since
 * --incremental`; `--since` is a Stryker.NET flag and does not exist in
 * StrykerJS 9 (verified against `stryker run --help`), and `--incremental` only
 * pays off when its incremental file survives between runs — which, for a tool
 * that writes nothing into the target, it cannot. Restricting `mutate` to the
 * files the diff touched is simpler, deterministic, and scopes the run for the
 * same reason spec §4 asks for scoping.
 */

export const STRYKER_TOOL = 'stryker'

/** npm package name; the command it installs is `stryker`. */
const STRYKER_PACKAGE = '@stryker-mutator/core'

/** Config artifacts that make Stryker repo-owned (spec §1, first check). */
export const STRYKER_CONFIG_FILES: readonly string[] = [
  'stryker.config.json',
  'stryker.config.jsonc',
  'stryker.config.js',
  'stryker.config.mjs',
  'stryker.config.cjs',
  'stryker.conf.json',
  'stryker.conf.js',
  'stryker.conf.mjs',
  'stryker.conf.cjs',
]

/** What to tell a repo that has no mutation testing set up. */
export const STRYKER_SETUP_HINT =
  'add a `@stryker-mutator/core` devDependency and a stryker config (plus the runner ' +
  'plugin for your test framework) to enable mutation testing'

/** Extensions Stryker can mutate; anything else in a diff is not its business. */
const MUTABLE_EXTENSIONS: readonly string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts']

/** Test files are inputs to a mutation run, never targets of one. */
const TEST_FILE_PATTERN = /(^|\/)(__tests__|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$/

export const strykerRunner: ToolRunner = {
  tool: STRYKER_TOOL,
  category: 'test-quality',
  pinnedVersion: verifiedRepoVersion(STRYKER_PACKAGE),
  repoOwnedOnly: true,
  deepOnly: true,
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      configFiles: STRYKER_CONFIG_FILES,
      packageName: STRYKER_PACKAGE,
      binName: STRYKER_TOOL,
    }),
  run: runStryker,
}

async function runStryker(ctx: RunContext): Promise<ToolResult> {
  if (!ctx.deep) {
    return unavailable('mutation testing runs in the deep profile only — pass `--deep`')
  }
  const detection = ctx.detection
  if (detection === null) return unavailable(STRYKER_SETUP_HINT)
  if (!detection.installed || detection.binPath === undefined) {
    return unavailable(
      'this repo declares StrykerJS but has not installed it — run `npm install` so ' +
        'Stryker and the test-runner plugins its config names are present',
    )
  }

  const mutate = mutateScope(ctx)
  if (mutate !== undefined && mutate.length === 0) {
    return unavailable('this change touched no JavaScript or TypeScript file Stryker could mutate')
  }

  const workingDir = join(ctx.scratch, STRYKER_TOOL)
  await mkdir(workingDir, { recursive: true })
  const reportPath = join(workingDir, 'mutation-report.json')
  const configPath = join(workingDir, 'crank-health.stryker.config.mjs')

  await writeFile(
    configPath,
    renderStrykerConfig(
      buildStrykerOverrides({
        workingDir,
        reportPath,
        ...(mutate === undefined ? {} : { mutate }),
      }),
      await baseConfig(ctx.repoRoot, detection),
    ),
    'utf8',
  )

  const execution = await execTool(repoCommand(detection.binPath, ['run', configPath]), {
    cwd: ctx.repoRoot,
    timeoutMs: ctx.timeoutMs,
  })

  const rawFiles: string[] = []
  const report = await readFileOrUndefined(reportPath)
  if (report !== undefined) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'stryker-mutation-report.json', report))
  }
  if (execution.stdout.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'stryker.txt', execution.stdout))
  }
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'stryker.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }
  if (report === undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `Stryker wrote no mutation report (exit ${execution.exitCode ?? 'signal'}): ` +
        `${firstLine(execution.stderr) || firstLine(execution.stdout) || 'no output'}`,
    }
  }

  let mutants: Mutant[]
  try {
    mutants = parseMutationReport(report, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse Stryker's mutation report: ${describe(error)}`,
    }
  }

  const counts = mutationCounts(mutants)
  const analyzed = new Set(ctx.files)
  const survived = mutants.filter((mutant) => mutant.status === 'Survived')
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(mutants, STRYKER_TOOL).filter((finding) => analyzed.has(finding.file)),
    ),
    ...(detection.version === undefined ? {} : { toolVersion: detection.version }),
    rawFiles,
    ...(survived.length > SURVIVED_FINDING_LIMIT
      ? {
          reason: `listing the first ${SURVIVED_FINDING_LIMIT} of ${survived.length} survived mutants; the rest are in the raw report`,
        }
      : {}),
    metrics: {
      ...(counts.detected + counts.undetected > 0
        ? { mutationScore: (counts.detected / (counts.detected + counts.undetected)) * 100 }
        : {}),
      mutantsDetected: counts.detected,
      mutantsUndetected: counts.undetected,
    },
  }
}

/**
 * The files Stryker may mutate, or `undefined` to leave its own config alone.
 *
 * Whole-repo runs defer to the repo's `mutate` setting (or Stryker's default of
 * "the production code under `src`/`lib`"), because that is the repo's own
 * statement of what its tests are supposed to cover. A PR run narrows it to the
 * changed files (spec §4), minus the test files — mutating a test asks whether
 * the tests test the tests.
 */
export function mutateScope(ctx: RunContext): string[] | undefined {
  if (ctx.changedFiles === undefined) return undefined
  const analyzed = new Set(ctx.files)
  return ctx.changedFiles.filter(
    (file) =>
      analyzed.has(file) &&
      MUTABLE_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
      !TEST_FILE_PATTERN.test(file),
  )
}

/** The settings crank-health imposes on any Stryker run, whoever configured it. */
export interface StrykerOverrides {
  readonly reporters: readonly string[]
  readonly jsonReporter: { readonly fileName: string }
  readonly tempDirName: string
  readonly cleanTempDir: string
  readonly incremental: boolean
  readonly allowConsoleColors: boolean
  readonly allowEmpty: boolean
  readonly fileLogLevel: string
  readonly mutate?: readonly string[]
}

export interface StrykerOverrideOptions {
  /** Absolute path of this run's scratch working directory. */
  readonly workingDir: string
  /** Absolute path the JSON report must be written to. */
  readonly reportPath: string
  /** PR mode: the only files to mutate. Absent means "whatever they configured". */
  readonly mutate?: readonly string[]
}

/**
 * The overrides, as data — every one of them is either zero footprint or
 * determinism, and nothing here is a preference:
 *
 * - `reporters`/`jsonReporter.fileName` — the default reporter set writes an
 *   HTML report into `reports/` in the *target*; the JSON report is the one we
 *   parse, and it goes to scratch.
 * - `tempDirName`/`cleanTempDir` — Stryker's sandbox is `.stryker-tmp` next to
 *   the code by default. Absolute, in scratch, and deleted either way.
 * - `incremental: false` — an incremental file only helps if it survives
 *   between runs, and one that survived would be a file in the target.
 * - `allowConsoleColors: false`, `fileLogLevel: 'off'` — no escape codes in the
 *   captured output, and no `stryker.log` written next to the code.
 * - `allowEmpty: true` — a PR that touched no mutable file is a normal result,
 *   not a failed scan.
 */
export function buildStrykerOverrides(options: StrykerOverrideOptions): StrykerOverrides {
  return {
    reporters: ['json'],
    jsonReporter: { fileName: options.reportPath },
    tempDirName: join(options.workingDir, 'stryker-tmp'),
    cleanTempDir: 'always',
    incremental: false,
    allowConsoleColors: false,
    allowEmpty: true,
    fileLogLevel: 'off',
    ...(options.mutate === undefined ? {} : { mutate: options.mutate }),
  }
}

/**
 * The generated config module: the repo's own configuration, with the overrides
 * on top.
 *
 * It is an ES module rather than JSON because that is the only way to keep the
 * repo's config *and* control where Stryker writes. Stryker resolves exactly one
 * config file, so a JSON file of ours would silently replace theirs — losing the
 * `testRunner` setting the run depends on. A module can load theirs first: a
 * JSON config is inlined here (parsed before we ever get to this function), and
 * a `.js`/`.mjs`/`.cjs` one is imported by Stryker's own Node process, where a
 * config that throws is Stryker's error to report rather than a crash inside
 * crank-health.
 */
export function renderStrykerConfig(
  overrides: StrykerOverrides,
  base: StrykerBaseConfig | undefined,
): string {
  const lines = ['// Generated by crank-health for one deep scan. Not written into the repo.']
  if (base?.kind === 'module') {
    lines.push(
      `const loaded = await import(${JSON.stringify(base.url)})`,
      'const exported = loaded.default ?? loaded',
      "const base = typeof exported === 'object' && exported !== null ? exported : {}",
    )
  } else {
    lines.push(
      `const base = ${JSON.stringify(base?.kind === 'inline' ? base.config : {}, null, 2)}`,
    )
  }
  lines.push(`export default { ...base, ...${JSON.stringify(overrides, null, 2)} }`, '')
  return lines.join('\n')
}

/** How the repo's own Stryker config reaches the generated one. */
export type StrykerBaseConfig =
  /** A JSON config, already parsed. */
  | { readonly kind: 'inline'; readonly config: Record<string, unknown> }
  /** A JS config, to be imported by Stryker's process. */
  | { readonly kind: 'module'; readonly url: string }

/**
 * Locates and, for JSON, reads the repo's Stryker config. A repo that owns
 * Stryker only through a declared dependency has none, and Stryker's own
 * defaults apply.
 */
async function baseConfig(
  repoRoot: string,
  detection: Detection,
): Promise<StrykerBaseConfig | undefined> {
  const file = detection.configFiles.find((candidate) =>
    STRYKER_CONFIG_FILES.includes(candidate.split('/').at(-1) ?? candidate),
  )
  if (file === undefined) return undefined

  const path = join(repoRoot, file)
  if (file.endsWith('.json') || file.endsWith('.jsonc')) {
    const parsed = asRecord(await readJson(path))
    return parsed === undefined ? undefined : { kind: 'inline', config: parsed }
  }
  return { kind: 'module', url: pathToFileURL(path).href }
}

function unavailable(reason: string): ToolResult {
  return { state: 'not-available', findings: [], rawFiles: [], reason }
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
