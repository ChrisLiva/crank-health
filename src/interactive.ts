import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { execa } from 'execa'
import pc from 'picocolors'
import { GITLEAKS } from './adapters/common/gitleaks.ts'
import { OPENGREP } from './adapters/common/opengrep.ts'
import { OSV_SCANNER } from './adapters/common/osv-scanner.ts'
import type { SystemToolSpec } from './adapters/common/system-tool.ts'
import { ADAPTERS } from './adapters/index.ts'
import type { CliOptions } from './args.ts'
import { discoverFiles } from './core/discover.ts'
import { headCommit, mergeBase, resolveCommit } from './core/git.ts'
import type { Grade, RepoContext } from './core/types.ts'
import { CATEGORIES, GRADES } from './core/types.ts'
import { DEFAULT_OUTPUT_DIRNAME } from './core/output.ts'
import { resolveRepoRoot } from './run.ts'

/**
 * `--interactive`: a guided walk through the CLI's options, tailored to the
 * target repo. Everything here is a front-end — the probe only *reads* (same
 * covenant as `ToolRunner.detect`: no tool ever executes), and the outcome is
 * an ordinary {@link CliOptions} handed back to `cli.ts`, so the scan that runs
 * afterwards is byte-identical to the one the printed equivalent command would
 * produce.
 */

/** Base branches worth offering for `--pr`, in preference order. */
const BASE_BRANCH_CANDIDATES: readonly string[] = ['main', 'master', 'develop', 'trunk']

/** What the probe learned about the target; every question keys off this. */
export interface RepoProbe {
  readonly repoRoot: string
  readonly jsTsFiles: number
  readonly pythonFiles: number
  /** Branch name, or `null` on a detached HEAD. */
  readonly currentBranch: string | null
  /**
   * Branches a `--pr` delta could be measured against: they exist, they are
   * not the branch we are on, and their merge-base with HEAD is a commit other
   * than HEAD itself — so there is actually a diff to report.
   */
  readonly baseCandidates: readonly string[]
  /** Tools the repo owns (`detect()` non-null), deduped, adapter order. */
  readonly ownedTools: readonly string[]
  /**
   * True when a repo-owned mutation tool exists (StrykerJS / cosmic-ray), i.e.
   * `--deep` could actually grade test quality rather than report the honest
   * "not available".
   */
  readonly mutationToolOwned: boolean
}

/** The two streams a prompt needs; tests inject a scripted one. */
export interface PromptIO {
  say(line: string): void
  ask(prompt: string): Promise<string>
}

/**
 * The security tools crank-health cannot fetch (release binaries; see
 * `adapters/common/system-tool.ts`), with what each one adds to the scan.
 */
const SYSTEM_TOOLS: readonly { spec: SystemToolSpec; purpose: string }[] = [
  { spec: GITLEAKS, purpose: 'secrets scanning' },
  { spec: OPENGREP, purpose: 'SAST rules for JS/TS and Python' },
  { spec: OSV_SCANNER, purpose: 'known-vulnerability scan of dependencies' },
]

/** One system tool's PATH status; `version` undefined means not installed. */
export interface SystemToolStatus {
  readonly spec: SystemToolSpec
  readonly purpose: string
  readonly version: string | undefined
}

/**
 * The session's touchpoints with the machine, injectable so tests can script
 * a toolchain (and never actually install anything).
 */
export interface SessionDeps {
  checkSystemTools(): Promise<readonly SystemToolStatus[]>
  hasBrew(): Promise<boolean>
  /** Runs the install, streaming its output; true on success. */
  install(spec: SystemToolSpec): Promise<boolean>
}

const REAL_DEPS: SessionDeps = {
  checkSystemTools: () =>
    Promise.all(
      SYSTEM_TOOLS.map(async ({ spec, purpose }) => ({
        spec,
        purpose,
        version: await installedVersion(spec),
      })),
    ),
  hasBrew: async () => (await execa('brew', ['--version'], { reject: false })).exitCode === 0,
  install: async (spec) => {
    const result = await execa('brew', ['install', spec.binary], {
      stdio: 'inherit',
      reject: false,
    })
    return result.exitCode === 0
  },
}

export interface InteractiveOutcome {
  /** The options as refined by the walk-through. */
  readonly options: CliOptions
  /** False when the user reviewed the summary and declined to run. */
  readonly run: boolean
}

/**
 * True when a prompt failed because stdin ended (Ctrl-D) — the user walking
 * away mid-session, which is a cancellation, not a crank-health error.
 */
export function isPromptCancelled(error: unknown): boolean {
  return error instanceof Error && (error as { code?: string }).code === 'ERR_USE_AFTER_CLOSE'
}

/** Readline-backed {@link PromptIO} for the real terminal. */
export function createTerminalIO(): PromptIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return {
    say: (line) => process.stdout.write(`${line}\n`),
    ask: (prompt) => rl.question(prompt),
    close: () => rl.close(),
  }
}

/**
 * Reads the facts the questions are tailored from. Never executes a tool and
 * never writes inside the repo — the scratch dir `detect()` is entitled to
 * lives under the OS tmpdir and is removed before returning.
 */
export async function probeRepo(path: string): Promise<RepoProbe> {
  const repoRoot = await resolveRepoRoot(path)
  const files = await discoverFiles(repoRoot)
  const scratch = await mkdtemp(join(tmpdir(), 'crank-health-probe-'))
  try {
    const repo: RepoContext = { repoRoot, files, scratch }

    const ownedTools: string[] = []
    let mutationToolOwned = false
    // Sequential on purpose: `ownedTools` must come out in adapter order.
    for (const adapter of ADAPTERS) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await adapter.detect(repo))) continue
      for (const runner of adapter.runners) {
        // eslint-disable-next-line no-await-in-loop
        if ((await runner.detect(repo)) === null) continue
        if (!ownedTools.includes(runner.tool)) ownedTools.push(runner.tool)
        // Mutation tools are exactly the deep runners crank-health never
        // imposes (StrykerJS, cosmic-ray); coverage.py is deep but not owned.
        if (runner.deepOnly === true && runner.repoOwnedOnly === true) mutationToolOwned = true
      }
    }

    return {
      repoRoot,
      jsTsFiles: files.byLanguage['js-ts'].length,
      pythonFiles: files.byLanguage.python.length,
      currentBranch: await currentBranch(repoRoot),
      baseCandidates: await viableBases(repoRoot),
      ownedTools,
      mutationToolOwned,
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The whole session: probe, walk the questions, print the summary. `base`
 * carries any flags that were passed alongside `--interactive`; they become
 * the prompts' defaults, so `crank-health -i --pr main` starts from PR mode
 * instead of contradicting the user.
 */
export async function runInteractiveSession(
  base: CliOptions,
  io: PromptIO,
  deps: SessionDeps = REAL_DEPS,
): Promise<InteractiveOutcome> {
  const probe = await probeRepo(base.path)
  sayHeader(probe, io)

  const pr = await askScope(base, probe, io)
  const deep = await askDepth(base, probe, io)
  const only = await askCategories(base, deep, io)
  if (only === undefined || only.includes('security')) await askSystemTools(io, deps)
  const failUnder = await askGate(base, io)
  const allowMissing = failUnder === undefined ? false : await askAllowMissing(base, deep, only, io)
  const out = await askOutputDir(base, probe, io)

  const options: CliOptions = {
    ...base,
    pr,
    deep,
    only,
    failUnder,
    allowMissing,
    out,
    interactive: false,
  }

  io.say('')
  io.say(`Equivalent command: ${pc.cyan(equivalentCommand(options))}`)
  const run = await confirm(io, 'Run this scan now?', true)
  return { options, run }
}

/** The one-shot command line that reproduces the chosen scan. */
export function equivalentCommand(options: CliOptions): string {
  const parts = ['npx', 'crank-health']
  if (options.pr !== undefined) parts.push('--pr', options.pr)
  if (options.deep) parts.push('--deep')
  if (options.only !== undefined) parts.push('--only', options.only.join(','))
  if (options.failUnder !== undefined) parts.push('--fail-under', options.failUnder)
  if (options.allowMissing) parts.push('--allow-missing')
  if (options.out !== undefined) parts.push('--out', options.out)
  if (options.timeoutSeconds !== undefined) parts.push('--timeout', String(options.timeoutSeconds))
  if (options.json) parts.push('--json')
  if (options.path !== '.') parts.push(options.path)
  return parts.join(' ')
}

function sayHeader(probe: RepoProbe, io: PromptIO): void {
  io.say(`${pc.bold('crank-health')} — interactive setup for ${probe.repoRoot}`)
  io.say('')
  io.say(`  files       ${probe.jsTsFiles} JS/TS · ${probe.pythonFiles} Python`)
  io.say(`  branch      ${probe.currentBranch ?? 'detached HEAD'}`)
  io.say(
    `  repo-owned  ${probe.ownedTools.length > 0 ? probe.ownedTools.join(', ') : 'no owned tools detected — pinned defaults will run'}`,
  )
}

/** Whole repo vs a `--pr` delta — only asked when a viable base exists. */
async function askScope(
  base: CliOptions,
  probe: RepoProbe,
  io: PromptIO,
): Promise<string | undefined> {
  // A base the user named on the command line is always offered, even when the
  // probe did not find it (it may be a sha or a remote-tracking ref).
  const bases =
    base.pr !== undefined && !probe.baseCandidates.includes(base.pr)
      ? [base.pr, ...probe.baseCandidates]
      : [...probe.baseCandidates]

  if (bases.length === 0) {
    io.say('')
    io.say('No other branch shares history with HEAD, so this will be a whole-repo scan.')
    return undefined
  }

  const choice = await select(
    io,
    'Scan scope?',
    [
      { label: 'Whole repo', note: 'grade everything as it stands' },
      ...bases.map((name) => ({
        label: `Changes vs ${name}`,
        note: `delta against \`git merge-base ${name} HEAD\``,
      })),
    ],
    base.pr === undefined ? 0 : bases.indexOf(base.pr) + 1,
  )
  return choice === 0 ? undefined : bases[choice - 1]
}

/** Quick vs `--deep`, with the honest prognosis for test quality. */
async function askDepth(base: CliOptions, probe: RepoProbe, io: PromptIO): Promise<boolean> {
  const deepNote = probe.mutationToolOwned
    ? 'a repo-owned mutation tool was detected, so test quality can be graded'
    : 'no repo-owned mutation tool — test quality would still read not-available'
  const choice = await select(
    io,
    'Depth?',
    [
      { label: 'Quick', note: 'static analysis only; never executes your code' },
      { label: 'Deep', note: `adds the mutation / test-suite tier (runs your tests); ${deepNote}` },
    ],
    base.deep ? 1 : 0,
  )
  return choice === 1
}

/** `--only`: empty answer means all eight categories. */
async function askCategories(
  base: CliOptions,
  deep: boolean,
  io: PromptIO,
): Promise<string[] | undefined> {
  io.say('')
  io.say('Categories?')
  for (const category of CATEGORIES) {
    const note = category === 'test-quality' && !deep ? '  (needs --deep to be graded)' : ''
    io.say(`  · ${category}${pc.dim(note)}`)
  }
  const fallback = base.only?.join(',') ?? 'all'
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const answer = (await io.ask(`  comma-separated subset [${fallback}]: `)).trim()
    const raw = answer.length === 0 ? fallback : answer
    if (raw === 'all') return undefined
    const picked = raw
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    const unknown = picked.filter((name) => !CATEGORIES.some((known) => known === name))
    if (picked.length > 0 && unknown.length === 0) return picked
    io.say(
      `  ${unknown.length > 0 ? `unknown: ${unknown.join(', ')}` : 'pick at least one'} — expected ${CATEGORIES.join(', ')} or "all"`,
    )
  }
}

/**
 * Security-tool status and, where Homebrew can do it, guided installs. Only
 * reached when the security category is selected: these three run as release
 * binaries crank-health cannot fetch ephemerally, so a missing one quietly
 * narrows what security can assess — this step is where that stops being
 * quiet. Declining (the default) changes nothing; the scan degrades exactly
 * as before.
 */
async function askSystemTools(io: PromptIO, deps: SessionDeps): Promise<void> {
  const status = await deps.checkSystemTools()
  io.say('')
  io.say('Security tools (release binaries crank-health cannot fetch itself):')
  for (const tool of status) {
    io.say(
      tool.version === undefined
        ? `  ✗ ${tool.spec.binary}  not on PATH — ${tool.purpose} will read not-available`
        : `  ✓ ${tool.spec.binary} ${tool.version}  — ${tool.purpose}`,
    )
  }

  const missing = status.filter((tool) => tool.version === undefined)
  if (missing.length === 0) return

  if (!(await deps.hasBrew())) {
    io.say('  Homebrew was not found, so crank-health cannot install these for you:')
    for (const tool of missing) io.say(`    ${tool.spec.install}`)
    return
  }

  for (const tool of missing) {
    const question = `Install ${tool.spec.binary} now (brew install ${tool.spec.binary})?`
    // eslint-disable-next-line no-await-in-loop
    if (!(await confirm(io, question, false))) {
      io.say(`  skipped — later: ${tool.spec.install}`)
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    const installed = await deps.install(tool.spec)
    io.say(
      installed
        ? `  ✓ ${tool.spec.binary} installed`
        : `  ✗ ${tool.spec.binary} install failed — ${tool.spec.install}`,
    )
  }
}

/** `--fail-under`: empty answer means the gate stays off. */
async function askGate(base: CliOptions, io: PromptIO): Promise<string | undefined> {
  io.say('')
  const fallback = base.failUnder ?? 'none'
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const answer = (await io.ask(`Fail (exit 1) below which grade? A–F or none [${fallback}]: `))
      .trim()
      .toUpperCase()
    const raw = answer.length === 0 ? fallback.toUpperCase() : answer
    if (raw === 'NONE') return undefined
    if (GRADES.includes(raw as Grade)) return raw
    io.say(`  expected one of ${GRADES.join(', ')} or none`)
  }
}

/**
 * `--allow-missing`, only reachable when a gate is set. In quick mode with
 * test-quality selected the honest default is yes: that category is *always*
 * not-assessed without `--deep`, and a gate that trips on it every run is a
 * gate nobody keeps.
 */
async function askAllowMissing(
  base: CliOptions,
  deep: boolean,
  only: readonly string[] | undefined,
  io: PromptIO,
): Promise<boolean> {
  const testQualitySelected = only === undefined || only.includes('test-quality')
  if (!deep && testQualitySelected) {
    io.say('  (quick mode always leaves test-quality not-assessed, so it would trip the gate)')
    return confirm(io, 'Ignore categories nothing could assess (--allow-missing)?', true)
  }
  return confirm(io, 'Ignore categories nothing could assess (--allow-missing)?', base.allowMissing)
}

/** `--out`: empty keeps the default (or whatever `--out` was already passed). */
async function askOutputDir(
  base: CliOptions,
  probe: RepoProbe,
  io: PromptIO,
): Promise<string | undefined> {
  io.say('')
  if (base.out === undefined) {
    io.say('The default keeps every run: each one lands in its own dated folder underneath.')
    io.say('Naming a directory instead writes this run exactly there.')
  }
  const fallback = base.out ?? join(probe.repoRoot, DEFAULT_OUTPUT_DIRNAME)
  const answer = (await io.ask(`Output directory [${fallback}]: `)).trim()
  return answer.length === 0 ? base.out : answer
}

/** Numbered single-choice prompt; returns the chosen index. */
async function select(
  io: PromptIO,
  question: string,
  choices: readonly { label: string; note?: string }[],
  defaultIndex: number,
): Promise<number> {
  io.say('')
  io.say(question)
  choices.forEach((choice, index) => {
    const note = choice.note === undefined ? '' : pc.dim(`  — ${choice.note}`)
    io.say(`  ${index + 1}. ${choice.label}${note}`)
  })
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const answer = (await io.ask(`  choice [${defaultIndex + 1}]: `)).trim()
    if (answer.length === 0) return defaultIndex
    const picked = Number(answer)
    if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length) return picked - 1
    io.say(`  enter a number between 1 and ${choices.length}`)
  }
}

/** Yes/no prompt with a default. */
async function confirm(io: PromptIO, question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const answer = (await io.ask(`${question} [${fallback ? 'Y/n' : 'y/N'}]: `))
      .trim()
      .toLowerCase()
    if (answer.length === 0) return fallback
    if (answer === 'y' || answer === 'yes') return true
    if (answer === 'n' || answer === 'no') return false
    io.say('  y or n')
  }
}

/**
 * The tool's installed version, or `undefined` when it is not on PATH. A tool
 * that runs but prints an unparseable version is still installed — the label
 * degrades, not the status.
 */
async function installedVersion(spec: SystemToolSpec): Promise<string | undefined> {
  const result = await execa(spec.binary, [...spec.versionArgs], {
    reject: false,
    timeout: 10_000,
  })
  if (result.exitCode !== 0) return undefined
  const line = (result.stdout || result.stderr).split('\n', 1)[0] ?? ''
  return /\d+\.\d+\.\d+\S*/.exec(line)?.[0] ?? 'installed'
}

/** The checked-out branch name, or `null` on a detached HEAD. */
async function currentBranch(repoRoot: string): Promise<string | null> {
  const result = await execa('git', ['symbolic-ref', '--short', '--quiet', 'HEAD'], {
    cwd: repoRoot,
    reject: false,
  })
  const name = result.stdout?.trim() ?? ''
  return result.exitCode === 0 && name.length > 0 ? name : null
}

/** See {@link RepoProbe.baseCandidates} for what "viable" means. */
async function viableBases(repoRoot: string): Promise<string[]> {
  const head = await headCommit(repoRoot)
  if (head === null) return []
  const branch = await currentBranch(repoRoot)
  const viable: string[] = []
  // Sequential on purpose: candidates keep their preference order.
  for (const name of BASE_BRANCH_CANDIDATES) {
    if (name === branch) continue
    // eslint-disable-next-line no-await-in-loop
    if ((await resolveCommit(repoRoot, name)) === null) continue
    // eslint-disable-next-line no-await-in-loop
    const fork = await mergeBase(repoRoot, name)
    if (fork !== null && fork !== head) viable.push(name)
  }
  return viable
}
