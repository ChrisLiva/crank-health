import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execTool, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type { ToolExecution } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { verifiedRepoVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  errorMessage,
  failed,
  firstLine,
  identify,
  repoRelative,
  unavailable,
} from '../support.ts'
import { detectPythonTool, findVenv } from './py-project.ts'

/**
 * cosmic-ray — mutation testing for Python, and the deep tier's Python half
 * (spec "Categories and tools": "cosmic-ray (state outside repo)").
 *
 * **It only runs where the project already owns it, and that is a safety
 * decision, not a detection one.** Unlike StrykerJS — which mutates a copy of
 * the sources in a sandbox — cosmic-ray applies each mutation *to the file on
 * disk*, runs the suite, and puts the original back. A run that is killed
 * between those two steps leaves the target holding mutated source, which is
 * exactly the footprint spec §7 promises never to leave. crank-health will not
 * do that to a repo that never asked for it, so this runner is `repoOwnedOnly`
 * and additionally requires cosmic-ray to be installed in the project's own
 * virtualenv: it runs where a maintainer has already adopted the tool and its
 * model, with their config's blessing, and nowhere else.
 *
 * Everything crank-health controls does stay outside the repo: the generated
 * config, the session database (plan M9: "session SQLite in scratch") and every
 * report live in the scratch directory.
 *
 * **The test command names the virtualenv's interpreter absolutely.** cosmic-ray
 * runs it through `subprocess` with its own environment, where a bare `python`
 * is not resolvable — verified by probe: every mutant came back `incompetent`
 * with `FileNotFoundError: 'python'` until the interpreter was spelled out.
 *
 * **Scoping (spec §4).** A PR run mutates only the Python files the diff
 * touched, expressed the way cosmic-ray's config can express it: the module
 * path is the directory that contains them, and everything else under it is in
 * `excluded-modules`.
 *
 * **The config is generated, not inherited** — the one place this runner departs
 * from spec §1's "run their config". A cosmic-ray config *is* the run: it names
 * the module path, the test command and the timeout, which are exactly the three
 * things crank-health has to control (the diff's scope, the absolute
 * interpreter, a bounded run). The repo's own config is what makes cosmic-ray
 * repo-owned; it is not what parameterizes this run, and `raw/cosmic-ray.toml`
 * shows a reader precisely what did.
 */

const COSMIC_RAY_TOOL = 'cosmic-ray'

/** PyPI distribution; its command and distribution names coincide. */
const COSMIC_RAY_DISTRIBUTION = 'cosmic-ray'

/**
 * Config artifacts that make cosmic-ray repo-owned. It has no conventional file
 * name — the config is a TOML file passed on the command line — so these are the
 * two names the documentation's examples use.
 */
const COSMIC_RAY_CONFIG_FILES: readonly string[] = ['cosmic-ray.toml', '.cosmic-ray.toml']

/** `pyproject.toml` sections that make cosmic-ray repo-owned. */
const COSMIC_RAY_SECTIONS: readonly string[] = ['tool.cosmic-ray']

/** The rule surviving mutants are reported under. */
const COSMIC_RAY_SURVIVED_RULE = 'cosmic-ray/survived-mutant'

/** Survived mutants listed as findings; see StrykerJS for why there is a cap. */
const SURVIVED_FINDING_LIMIT = 50

/** Seconds one mutant's test run may take before cosmic-ray abandons it. */
export const MUTANT_TIMEOUT_SECONDS = 30

/** Files that are tests rather than code under test. */
const TEST_FILE_PATTERN = /(^|\/)(tests?|testing)\/|(^|\/)(test_[^/]+|[^/]+_test)\.py$/

/** What to tell a project that has not adopted cosmic-ray. */
const COSMIC_RAY_SETUP_HINT =
  'cosmic-ray mutates files in place while it runs, so crank-health only runs it where the ' +
  'project has adopted it: add cosmic-ray to the project virtualenv and a `[tool.cosmic-ray]` ' +
  'section (or a cosmic-ray.toml) to enable Python mutation testing'

export const cosmicRayRunner: ToolRunner = {
  tool: COSMIC_RAY_TOOL,
  category: 'test-quality',
  pinnedVersion: verifiedRepoVersion(COSMIC_RAY_DISTRIBUTION),
  repoOwnedOnly: true,
  deepOnly: true,
  // Mutation testing and the coverage run measure different things; neither
  // stands the other down (see `ToolRunner.complementary`).
  complementary: true,
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: COSMIC_RAY_CONFIG_FILES,
      distribution: COSMIC_RAY_DISTRIBUTION,
      sections: COSMIC_RAY_SECTIONS,
    }),
  run: runCosmicRay,
}

/**
 * Kept out of the mutated tree along with everything else this run writes: a
 * `__pycache__` beside the code would be a footprint (spec §7).
 */
const MUTATION_ENV: Readonly<Record<string, string>> = { PYTHONDONTWRITEBYTECODE: '1' }

/** What a cosmic-ray run needs before it may mutate anything. */
interface CosmicRayPlan {
  /** The project's own cosmic-ray, the only one this runner ever spawns. */
  readonly binPath: string
  /** Absolute path of the virtualenv interpreter that runs the tests. */
  readonly interpreter: string
  /** The Python files this run may mutate. */
  readonly targets: readonly string[]
}

/**
 * The plan, or the `not-available` result that stands in for it: the deep
 * profile, a project that both declares and installed cosmic-ray, a virtualenv
 * to run the suite in, and at least one source file worth mutating.
 */
async function cosmicRayPlan(ctx: RunContext): Promise<CosmicRayPlan | ToolResult> {
  if (!ctx.deep) {
    return unavailable('mutation testing runs in the deep profile only — pass `--deep`')
  }
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }
  const detection = ctx.detection
  if (detection === null) return unavailable(COSMIC_RAY_SETUP_HINT)
  if (!detection.installed || detection.binPath === undefined) {
    return unavailable(
      `this project declares cosmic-ray but has not installed it in its virtualenv — ${COSMIC_RAY_SETUP_HINT}`,
    )
  }
  const venv = await findVenv(ctx.repoRoot, ctx.project.path)
  if (venv === undefined) {
    return unavailable('this project has no virtualenv to run its tests in')
  }

  const targets = mutationTargets(ctx)
  if (targets.length === 0) {
    return unavailable(
      ctx.changedFiles === undefined
        ? 'no Python source files to mutate (every discovered file looks like a test)'
        : 'this change touched no Python source file cosmic-ray could mutate',
    )
  }
  return { binPath: detection.binPath, interpreter: venv.interpreter, targets }
}

/** Where one run's generated config and session live, all under scratch. */
interface SessionPaths {
  readonly workingDir: string
  readonly configPath: string
  readonly sessionPath: string
}

/**
 * The three invocations, in the only order they are valid in: nothing is
 * mutated until the suite has passed unmutated, and `exec` runs the work `init`
 * wrote into the session.
 *
 * The baseline is not optional: cosmic-ray reads "the test command failed" as
 * "the mutant was killed", so a test command that cannot run at all scores 100%
 * instead of failing. A probe produced exactly that — 27 of 27 mutants "killed"
 * because the interpreter could not import pytest. One extra suite run buys the
 * difference between a perfect score and a meaningless one.
 */
function stageInvocations(paths: SessionPaths): readonly (readonly [string, readonly string[]])[] {
  return [
    [
      'baseline',
      ['baseline', '--session-file', join(paths.workingDir, 'baseline.sqlite'), paths.configPath],
    ],
    ['init', ['init', paths.configPath, paths.sessionPath]],
    ['exec', ['exec', paths.configPath, paths.sessionPath]],
  ]
}

/**
 * Runs the stages in order, staging each one's stderr. Answers the result that
 * ends the run, or `undefined` when all three succeeded.
 */
async function runStages(
  ctx: RunContext,
  binPath: string,
  paths: SessionPaths,
  rawFiles: string[],
): Promise<ToolResult | undefined> {
  for (const [stage, args] of stageInvocations(paths)) {
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(repoCommand(binPath, args), {
      cwd: ctx.repoRoot,
      timeoutMs: ctx.timeoutMs,
      env: MUTATION_ENV,
    })
    if (execution.stderr.trim().length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const staged = await writeScratchRaw(
        ctx.scratch,
        `cosmic-ray-${stage}.stderr.txt`,
        execution.stderr,
      )
      rawFiles.push(staged)
    }
    if (execution.failure !== undefined) {
      return failed(execution.failure, rawFiles)
    }
    if (execution.exitCode !== 0) {
      return stageFailure(stage, execution, rawFiles)
    }
  }
  return undefined
}

/**
 * A stage that exited non-zero. A failing baseline is `not-available` — the
 * suite, not crank-health, is what could not answer — and any later stage is an
 * error.
 */
function stageFailure(
  stage: string,
  execution: ToolExecution,
  rawFiles: readonly string[],
): ToolResult {
  if (stage === 'baseline') {
    return {
      state: 'not-available',
      findings: [],
      rawFiles,
      reason:
        'the test suite does not pass on unmutated code, so a mutation score would be ' +
        `meaningless: ${firstLine(execution.stdout) || firstLine(execution.stderr) || 'see raw output'}`,
    }
  }
  return {
    state: 'error',
    findings: [],
    rawFiles,
    reason: `cosmic-ray ${stage} failed (exit ${execution.exitCode ?? 'signal'}): ${
      firstLine(execution.stderr) || firstLine(execution.stdout) || 'no output'
    }`,
  }
}

async function runCosmicRay(ctx: RunContext): Promise<ToolResult> {
  const plan = await cosmicRayPlan(ctx)
  if ('state' in plan) return plan

  const workingDir = join(ctx.scratch, COSMIC_RAY_TOOL)
  await mkdir(workingDir, { recursive: true })
  const paths: SessionPaths = {
    workingDir,
    configPath: join(workingDir, 'cosmic-ray.toml'),
    sessionPath: join(workingDir, 'session.sqlite'),
  }
  const scope = mutationScope(plan.targets, ctx.files)

  const config = buildCosmicRayConfig({
    modulePath: join(ctx.repoRoot, scope.modulePath),
    excludedModules: scope.excluded,
    interpreter: plan.interpreter,
  })
  await writeFile(paths.configPath, config, 'utf8')

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'cosmic-ray.toml', config)]

  const ended = await runStages(ctx, plan.binPath, paths, rawFiles)
  if (ended !== undefined) return ended

  const dump = await execTool(repoCommand(plan.binPath, ['dump', paths.sessionPath]), {
    cwd: ctx.repoRoot,
    timeoutMs: ctx.timeoutMs,
    env: MUTATION_ENV,
  })
  rawFiles.unshift(await writeScratchRaw(ctx.scratch, 'cosmic-ray-dump.jsonl', dump.stdout))
  if (dump.failure !== undefined) {
    return failed(dump.failure, rawFiles)
  }

  let mutants: CosmicRayMutant[]
  try {
    mutants = parseCosmicRayDump(dump.stdout, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse the cosmic-ray session dump: ${errorMessage(error)}`,
    }
  }

  const counts = cosmicRayCounts(mutants)
  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(mutants).filter((finding) => analyzed.has(finding.file)),
    ),
    rawFiles,
    metrics: {
      ...(counts.detected + counts.undetected > 0
        ? { mutationScore: (counts.detected / (counts.detected + counts.undetected)) * 100 }
        : {}),
      mutantsDetected: counts.detected,
      mutantsUndetected: counts.undetected,
    },
  }
}

/** The Python files this run may mutate: source only, and the diff's in a PR. */
export function mutationTargets(ctx: RunContext): string[] {
  const changed = ctx.changedFiles === undefined ? undefined : new Set(ctx.changedFiles)
  return ctx.files.filter(
    (file) =>
      file.endsWith('.py') &&
      !TEST_FILE_PATTERN.test(file) &&
      (changed === undefined || changed.has(file)),
  )
}

/** A cosmic-ray config's two scoping settings. */
export interface MutationScope {
  /** Repo-relative posix path of the file or directory to mutate. */
  readonly modulePath: string
  /** Modules under it that must not be mutated, as cosmic-ray glob patterns. */
  readonly excluded: readonly string[]
}

/**
 * Expresses "mutate exactly these files" in the two settings cosmic-ray has:
 * one module path, plus exclusions.
 *
 * A single target is its own module path — the precise case, and the common one
 * for a small PR. Otherwise the module path is the directory that contains them
 * all, and every other Python file under it is excluded by name, which is what
 * keeps a PR's mutation run scoped to the PR (spec §4) and keeps a whole-repo run
 * from mutating the test suite.
 */
export function mutationScope(
  targets: readonly string[],
  discovered: readonly string[],
): MutationScope {
  const only = targets.length === 1 ? targets[0] : undefined
  if (only !== undefined) return { modulePath: only, excluded: [] }

  const modulePath = commonDirectory(targets)
  const prefix = modulePath === '.' ? '' : `${modulePath}/`
  const wanted = new Set(targets)
  const excluded = discovered.filter(
    (file) => file.endsWith('.py') && file.startsWith(prefix) && !wanted.has(file),
  )
  return { modulePath, excluded: excluded.toSorted(compare) }
}

/** The deepest directory every path is under, or `.` for the repo root. */
function commonDirectory(paths: readonly string[]): string {
  const segments = paths.map((path) => path.split('/').slice(0, -1))
  const first = segments[0] ?? []
  let shared = first.length
  for (const other of segments) {
    let index = 0
    while (index < shared && index < other.length && other[index] === first[index]) index++
    shared = index
  }
  return shared === 0 ? '.' : first.slice(0, shared).join('/')
}

export interface CosmicRayConfigOptions {
  /** Absolute path of the file or directory to mutate. */
  readonly modulePath: string
  /** Repo-relative posix paths cosmic-ray must skip. */
  readonly excludedModules: readonly string[]
  /** Absolute path of the virtualenv interpreter that runs the tests. */
  readonly interpreter: string
}

/**
 * The generated cosmic-ray config (TOML). Exported so its shape is a test's
 * subject rather than a string built inside a process spawn.
 */
export function buildCosmicRayConfig(options: CosmicRayConfigOptions): string {
  return [
    '# Generated by crank-health for one deep scan. Not written into the repo.',
    '[cosmic-ray]',
    `module-path = ${tomlString(options.modulePath)}`,
    `timeout = ${MUTANT_TIMEOUT_SECONDS.toFixed(1)}`,
    `excluded-modules = [${options.excludedModules.map((module) => tomlString(module)).join(', ')}]`,
    // The interpreter is absolute because cosmic-ray runs this command with its
    // own environment, where `python` alone does not resolve (see module note).
    `test-command = ${tomlString(`${options.interpreter} -m pytest -x -q -p no:cacheprovider`)}`,
    '',
    '[cosmic-ray.distributor]',
    'name = "local"',
    '',
  ].join('\n')
}

/** One mutant from a `cosmic-ray dump`, reduced to what a report needs. */
export interface CosmicRayMutant {
  /** Repo-relative posix path of the mutated module. */
  readonly file: string
  /** cosmic-ray's operator, e.g. `core/ReplaceBinaryOperator_Add_Sub`. */
  readonly operator: string
  /** The function or class the mutation landed in, when the dump names one. */
  readonly definition: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
  /** `killed`, `survived`, `incompetent`, or absent for work with no result. */
  readonly testOutcome: string | undefined
  /** `normal`, `timeout`, `exception`, `no-test`, `skipped`. */
  readonly workerOutcome: string | undefined
}

/**
 * Parses `cosmic-ray dump` output: one JSON array per line, holding a work item
 * and its result (the result is `null` for work with no verdict yet).
 *
 * Positions are `[line, column]` with a 1-based line and a 0-based column —
 * verified against a real session — and are converted to the `Finding` schema's
 * 1-based pair here.
 *
 * Exported so a format shift fails a test instead of emptying a score (plan M9).
 *
 * @throws {Error} when no line of the dump is a work item at all
 */
export function parseCosmicRayDump(text: string, repoRoot = ''): CosmicRayMutant[] {
  const mutants: CosmicRayMutant[] = []
  let recognized = false

  for (const line of text.split('\n')) {
    const work = workItem(line)
    if (work === undefined) continue
    recognized = true
    mutants.push(...mutantsIn(work, repoRoot))
  }

  if (!recognized && text.trim().length > 0) {
    throw new Error('no cosmic-ray work items in the session dump')
  }
  return mutants.toSorted(
    (a, b) => compare(a.file, b.file) || a.startLine - b.startLine || a.startCol - b.startCol,
  )
}

/** One dump line: the work item and its verdict. */
interface WorkItem {
  readonly mutations: readonly unknown[]
  /** `undefined` for work with no result yet — the dump writes `null` there. */
  readonly result: Record<string, unknown> | undefined
}

/**
 * One line of the dump, or `undefined` where it is blank, not JSON, or not a
 * work item at all — which is what {@link parseCosmicRayDump} recognizes a
 * format shift by.
 */
function workItem(line: string): WorkItem | undefined {
  if (line.trim().length === 0) return undefined
  const pair = asArray(parseLine(line))
  const item = asRecord(pair?.[0])
  const mutations = asArray(item?.['mutations'])
  if (item === undefined || mutations === undefined) return undefined
  return { mutations, result: asRecord(pair?.[1]) }
}

/** One dump line as JSON, or `undefined` where it was not JSON at all. */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** The mutations of one work item, each carrying that item's verdict. */
function mutantsIn(work: WorkItem, repoRoot: string): CosmicRayMutant[] {
  const mutants: CosmicRayMutant[] = []
  for (const raw of work.mutations) {
    const mutation = asRecord(raw)
    const file = asString(mutation?.['module_path'])
    if (mutation === undefined || file === undefined) continue
    const start = position(mutation['start_pos'])
    const end = endPosition(position(mutation['end_pos']), start)
    mutants.push({
      file: repoRelative(file, repoRoot),
      operator: asString(mutation['operator_name']) ?? 'unknown',
      definition: asString(mutation['definition_name']) ?? '',
      startLine: start.line,
      startCol: start.column,
      endLine: end.line,
      endCol: end.column,
      testOutcome: asString(work.result?.['test_outcome']),
      workerOutcome: asString(work.result?.['worker_outcome']),
    })
  }
  return mutants
}

/** Where a mutation ends. A missing `end_pos` reads as `[1, 0]`; the start stands in. */
function endPosition(end: Position, start: Position): Position {
  return end.line === 1 && end.column === 1 ? start : end
}

/** A position in the schema's 1-based pair. */
interface Position {
  readonly line: number
  readonly column: number
}

/** `[line, column]`, converted to the schema's 1-based pair. */
function position(value: unknown): Position {
  const pair = asArray(value)
  return { line: asNumber(pair?.[0]) ?? 1, column: (asNumber(pair?.[1]) ?? 0) + 1 }
}

/**
 * Counts mutants the way the mutation score is defined, in cosmic-ray's
 * vocabulary: `killed` and a worker `timeout` are detected, `survived` is not,
 * and `incompetent` — a mutation the code could not even run with — is in
 * neither, because it says nothing about the tests.
 */
export function cosmicRayCounts(mutants: readonly CosmicRayMutant[]): {
  readonly detected: number
  readonly undetected: number
} {
  return {
    detected: mutants.filter(
      (mutant) => mutant.testOutcome === 'killed' || mutant.workerOutcome === 'timeout',
    ).length,
    undetected: mutants.filter((mutant) => mutant.testOutcome === 'survived').length,
  }
}

/**
 * Surviving mutants → the core's vocabulary, in the same shape StrykerJS's are:
 * the grade is the score, and these are the evidence behind it. Provenance is
 * always `repo-config` — cosmic-ray only ever runs on a project that owns it.
 */
export function toPendingFindings(mutants: readonly CosmicRayMutant[]): PendingFinding[] {
  return mutants
    .filter((mutant) => mutant.testOutcome === 'survived')
    .map((mutant) => ({
      category: 'test-quality' as const,
      tool: COSMIC_RAY_TOOL,
      rule: COSMIC_RAY_SURVIVED_RULE,
      severity: 'warning' as const,
      file: mutant.file,
      range: {
        startLine: mutant.startLine,
        startCol: mutant.startCol,
        endLine: mutant.endLine,
        endCol: mutant.endCol,
      },
      message: `Mutant survived: ${mutant.operator}${mutant.definition === '' ? '' : ` in \`${mutant.definition}\``} — every test still passed`,
      provenance: 'repo-config' as const,
      gradeScope: true,
    }))
    .toSorted(byLocation)
    .slice(0, SURVIVED_FINDING_LIMIT)
}

/** A TOML basic string. Paths and commands are the only values we ever write. */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
