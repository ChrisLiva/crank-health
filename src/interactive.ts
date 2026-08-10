import { join } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { execa } from 'execa'
import pc from 'picocolors'
import { GITLEAKS } from './adapters/common/gitleaks.ts'
import { OPENGREP } from './adapters/common/opengrep.ts'
import { OSV_SCANNER } from './adapters/common/osv-scanner.ts'
import type { SystemToolSpec } from './adapters/common/system-tool.ts'
import { ADAPTERS } from './adapters/index.ts'
import type { CliOptions } from './args.ts'
import { discoverFiles, partitionProjects, repoDetectContext } from './core/discover.ts'
import { headCommit, mergeBase, resolveCommit } from './core/git.ts'
import type { Grade, Language } from './core/types.ts'
import { CATEGORIES, GRADES, LANGUAGES } from './core/types.ts'
import { DEFAULT_OUTPUT_DIRNAME } from './core/output.ts'
import { LANGUAGE_LABELS } from './render/display.ts'
import { resolveRepoRoot } from './run.ts'

/**
 * `--interactive`: a guided walk through the CLI's options, tailored to the
 * target repo and driven entirely by the keyboard — arrow keys move, enter
 * chooses, space toggles, escape steps back to the previous question; nothing
 * has to be typed unless the user asks for a custom output path. Everything
 * here is a front-end — the probe only *reads* (same covenant as
 * `ToolRunner.detect`: no tool ever executes), and the outcome is an ordinary
 * {@link CliOptions} handed back to `cli.ts`, so the scan that runs afterwards
 * is byte-identical to the one the printed equivalent command would produce.
 */

/** Base branches worth offering for `--pr`, in preference order. */
const BASE_BRANCH_CANDIDATES: readonly string[] = ['main', 'master', 'develop', 'trunk']

/** What the probe learned about the target; every question keys off this. */
export interface RepoProbe {
  readonly repoRoot: string
  /** One entry per member of {@link LANGUAGES}, in that order — zero included. */
  readonly fileCounts: readonly { language: Language; count: number }[]
  /**
   * The discovered projects' repo-relative paths, stable-sorted — what each
   * grade in the report will be about, and what `--project` selects from.
   */
  readonly projects: readonly string[]
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

/**
 * One keypress, in the shape `node:readline`'s keypress parser emits: special
 * keys carry a `name` ('up', 'return', 'escape', 'space', …), printable
 * characters carry themselves in `sequence`.
 */
export interface PromptKey {
  readonly name?: string | undefined
  readonly sequence?: string | undefined
  readonly ctrl?: boolean | undefined
  readonly meta?: boolean | undefined
  readonly shift?: boolean | undefined
}

/** What a prompt needs from the terminal; tests inject a scripted one. */
export interface PromptIO {
  /** A finished line of output. */
  say(line: string): void
  /** A raw fragment — the repaint traffic menus redraw themselves with. */
  write(text: string): void
  /** The next keypress. */
  nextKey(): Promise<PromptKey>
}

/**
 * The security tools crank-health cannot fetch (release binaries; see
 * `adapters/common/system-tool.ts`), with what each one adds to the scan.
 */
export const SYSTEM_TOOLS: readonly { spec: SystemToolSpec; purpose: string }[] = [
  { spec: GITLEAKS, purpose: 'secrets scanning' },
  { spec: OPENGREP, purpose: 'SAST rules for JS/TS, Python and C#' },
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
    // brew inherits our stdio; hand it a cooked terminal, not the raw mode the
    // menus run in, so its output and Ctrl-C behave normally.
    const stdin = process.stdin
    const wasRaw = stdin.isTTY === true && stdin.isRaw === true
    if (wasRaw) stdin.setRawMode(false)
    try {
      const result = await execa('brew', ['install', spec.binary], {
        stdio: 'inherit',
        reject: false,
      })
      return result.exitCode === 0
    } finally {
      if (wasRaw) stdin.setRawMode(true)
    }
  },
}

export interface InteractiveOutcome {
  /** The options as refined by the walk-through. */
  readonly options: CliOptions
  /** False when the user reviewed the summary and declined to run. */
  readonly run: boolean
}

/** Ctrl-C / Ctrl-D mid-session: a cancellation, not a crank-health error. */
export class PromptCancelledError extends Error {
  constructor() {
    super('interactive session cancelled')
    this.name = 'PromptCancelledError'
  }
}

/** True when a prompt failed because the user cancelled the session. */
export function isPromptCancelled(error: unknown): boolean {
  return error instanceof PromptCancelledError
}

/**
 * Raw-mode keypress {@link PromptIO} for the real terminal. Raw mode is what
 * lets a single arrow key arrive as one event; it also means Ctrl-C arrives as
 * a keypress instead of a signal, which {@link readKey} turns into
 * {@link PromptCancelledError}.
 */
export function createTerminalIO(): PromptIO & { close(): void } {
  const stdin = process.stdin
  emitKeypressEvents(stdin)
  if (stdin.isTTY === true) stdin.setRawMode(true)
  stdin.resume()

  const pending: PromptKey[] = []
  const waiting: ((key: PromptKey) => void)[] = []
  const onKeypress = (input: string | undefined, key: PromptKey | undefined): void => {
    const resolved: PromptKey = key ?? { sequence: input }
    const next = waiting.shift()
    if (next === undefined) pending.push(resolved)
    else next(resolved)
  }
  stdin.on('keypress', onKeypress)

  return {
    say: (line) => void process.stdout.write(`${line}\n`),
    write: (text) => void process.stdout.write(text),
    nextKey: () =>
      pending.length === 0
        ? new Promise((resolve) => waiting.push(resolve))
        : Promise.resolve(pending.shift() as PromptKey),
    close: () => {
      stdin.off('keypress', onKeypress)
      if (stdin.isTTY === true) stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write(SHOW_CURSOR)
    },
  }
}

/**
 * Reads the facts the questions are tailored from. Never executes a tool and
 * never writes anything: detection reads the working tree and the manifests in
 * it, and nothing else.
 */
export async function probeRepo(path: string): Promise<RepoProbe> {
  const repoRoot = await resolveRepoRoot(path)
  // The interview is about what the repo holds, so the scan-scope warnings are
  // the scan's to report, not a question's to ask.
  const { files } = await discoverFiles(repoRoot)
  const detectContext = repoDetectContext(repoRoot, files)

  const ownedTools: string[] = []
  let mutationToolOwned = false
  // Sequential on purpose: `ownedTools` must come out in adapter order.
  for (const adapter of ADAPTERS) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await adapter.detect(detectContext))) continue
    for (const runner of adapter.runners) {
      // eslint-disable-next-line no-await-in-loop
      if ((await runner.detect(detectContext)) === null) continue
      if (!ownedTools.includes(runner.tool)) ownedTools.push(runner.tool)
      // Mutation tools are exactly the deep runners crank-health never
      // imposes (StrykerJS, cosmic-ray); coverage.py is deep but not owned.
      if (runner.deepOnly === true && runner.repoOwnedOnly === true) mutationToolOwned = true
    }
  }

  return {
    repoRoot,
    fileCounts: LANGUAGES.map((language) => ({
      language,
      count: files.byLanguage[language].length,
    })),
    projects: partitionProjects(files).map((project) => project.path),
    currentBranch: await currentBranch(repoRoot),
    baseCandidates: await viableBases(repoRoot),
    ownedTools,
    mutationToolOwned,
  }
}

/** A question's request to return to the one before it (escape / left arrow). */
const BACK: unique symbol = Symbol('back')
type Back = typeof BACK

/** The "type a path yourself" entry in the output-directory menu. */
const CUSTOM: unique symbol = Symbol('custom')

/** One question in the walk-through; `applies` is re-read on every pass. */
interface SessionStep {
  applies(): boolean
  run(): Promise<Back | undefined>
}

/**
 * The whole session: probe, walk the questions, print the summary. `base`
 * carries any flags that were passed alongside `--interactive`; they become
 * the menus' defaults, so `crank-health -i --pr main` starts from PR mode
 * instead of contradicting the user. Escape (or ←) on any question returns to
 * the previous one with the draft answers intact.
 */
export async function runInteractiveSession(
  base: CliOptions,
  io: PromptIO,
  deps: SessionDeps = REAL_DEPS,
): Promise<InteractiveOutcome> {
  const probe = await probeRepo(base.path)
  sayHeader(probe, io)

  // A base the user named on the command line is always offered, even when the
  // probe did not find it (it may be a sha or a remote-tracking ref).
  const bases =
    base.pr !== undefined && !probe.baseCandidates.includes(base.pr)
      ? [base.pr, ...probe.baseCandidates]
      : [...probe.baseCandidates]
  if (bases.length === 0) {
    io.say('')
    io.say('No other branch shares history with HEAD, so this will be a whole-repo scan.')
  }

  /** The answers so far; going back edits this in place. */
  const draft = {
    pr: base.pr,
    deep: base.deep,
    only: base.only === undefined ? undefined : [...base.only],
    failUnder: base.failUnder,
    allowMissing: base.allowMissing,
    out: base.out,
    securityReviewed: false,
    run: true,
  }

  const assemble = (): CliOptions => ({
    ...base,
    pr: draft.pr,
    deep: draft.deep,
    only: draft.only,
    failUnder: draft.failUnder,
    // The gate question is the only path to --allow-missing; no gate, no flag.
    allowMissing: draft.failUnder === undefined ? false : draft.allowMissing,
    out: draft.out,
    interactive: false,
  })

  const steps: readonly SessionStep[] = [
    {
      // Whole repo vs a `--pr` delta — only asked when a viable base exists.
      applies: () => bases.length > 0,
      run: async () => {
        const picked = await select(
          io,
          'Scan scope?',
          [
            { label: 'Whole repo', note: 'grade everything as it stands' },
            ...bases.map((name) => ({
              label: `Changes vs ${name}`,
              note: `delta against \`git merge-base ${name} HEAD\``,
            })),
          ],
          draft.pr === undefined ? 0 : bases.indexOf(draft.pr) + 1,
        )
        if (picked === BACK) return BACK
        draft.pr = picked === 0 ? undefined : bases[picked - 1]
        return undefined
      },
    },
    {
      // Quick vs `--deep`, with the honest prognosis for test quality.
      applies: () => true,
      run: async () => {
        const deepNote = probe.mutationToolOwned
          ? 'a repo-owned mutation tool was detected, so test quality can be graded'
          : 'no repo-owned mutation tool — test quality would still read not-available'
        const picked = await select(
          io,
          'Depth?',
          [
            { label: 'Quick', note: 'static analysis only; never executes your code' },
            {
              label: 'Deep',
              note: `adds the mutation / test-suite tier (runs your tests); ${deepNote}`,
            },
          ],
          draft.deep ? 1 : 0,
        )
        if (picked === BACK) return BACK
        draft.deep = picked === 1
        return undefined
      },
    },
    {
      // `--only`: all eight checked is the default and means no subset.
      applies: () => true,
      run: async () => {
        const picked = await multiSelect(
          io,
          'Categories?',
          CATEGORIES.map((category) => ({
            label: category,
            note:
              category === 'test-quality' && !draft.deep ? 'needs --deep to be graded' : undefined,
          })),
          CATEGORIES.map((category) => draft.only === undefined || draft.only.includes(category)),
        )
        if (picked === BACK) return BACK
        draft.only = picked.every(Boolean)
          ? undefined
          : CATEGORIES.filter((_, index) => picked[index])
        return undefined
      },
    },
    {
      // Security-tool status and, where Homebrew can do it, guided installs.
      // Only reached when the security category is selected, and only once:
      // an install cannot be un-run by going back.
      applies: () =>
        !draft.securityReviewed && (draft.only === undefined || draft.only.includes('security')),
      run: async () => {
        const outcome = await askSystemTools(io, deps)
        if (outcome === BACK) return BACK
        draft.securityReviewed = true
        return undefined
      },
    },
    {
      // `--fail-under`: a grade off the shelf, or no gate at all.
      applies: () => true,
      run: async () => {
        const picked = await select(
          io,
          'Fail (exit 1) below which grade?',
          [
            { label: 'No gate', note: 'the scan always exits 0' },
            ...GRADES.map((grade) => ({ label: grade })),
          ],
          draft.failUnder === undefined ? 0 : GRADES.indexOf(draft.failUnder as Grade) + 1,
        )
        if (picked === BACK) return BACK
        draft.failUnder = picked === 0 ? undefined : GRADES[picked - 1]
        return undefined
      },
    },
    {
      // `--allow-missing`, only reachable when a gate is set. In quick mode
      // with test-quality selected the honest default is yes: that category is
      // *always* not-assessed without `--deep`, and a gate that trips on it
      // every run is a gate nobody keeps.
      applies: () => draft.failUnder !== undefined,
      run: async () => {
        const testQualitySelected = draft.only === undefined || draft.only.includes('test-quality')
        const tailored = !draft.deep && testQualitySelected
        io.say('')
        if (tailored) {
          io.say(
            pc.dim(
              '  quick mode always leaves test-quality not-assessed, so it would trip the gate',
            ),
          )
        }
        const picked = await confirm(
          io,
          'Ignore categories nothing could assess (--allow-missing)?',
          tailored ? true : draft.allowMissing,
        )
        if (picked === BACK) return BACK
        draft.allowMissing = picked
        return undefined
      },
    },
    {
      // `--out`: the keyboard picks between keeping the default and a custom
      // path; only "somewhere else" ever needs typing.
      applies: () => true,
      run: () => askOutputDir(io, probe, draft),
    },
    {
      // The review: the one-shot command this session reproduces, then go.
      applies: () => true,
      run: async () => {
        io.say('')
        io.say(`Equivalent command: ${pc.cyan(equivalentCommand(assemble()))}`)
        const picked = await confirm(io, 'Run this scan now?', true)
        if (picked === BACK) return BACK
        draft.run = picked
        return undefined
      },
    },
  ]

  // Forward through the applicable questions; BACK pops to the last one that
  // actually ran (skipped questions never enter the history). At the first
  // question BACK has nowhere to go and the question is simply asked again.
  const history: number[] = []
  let index = 0
  while (index < steps.length) {
    const step = steps[index] as SessionStep
    if (!step.applies()) {
      index += 1
      continue
    }
    // eslint-disable-next-line no-await-in-loop
    const outcome = await step.run()
    if (outcome === BACK) {
      index = history.pop() ?? index
    } else {
      history.push(index)
      index += 1
    }
  }

  return { options: assemble(), run: draft.run }
}

/** The one-shot command line that reproduces the chosen scan. */
export function equivalentCommand(options: CliOptions): string {
  const parts = ['npx', 'crank-health']
  if (options.pr !== undefined) parts.push('--pr', options.pr)
  for (const project of options.projects ?? []) parts.push('--project', project)
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
  io.say(
    `  files       ${probe.fileCounts
      .map(({ language, count }) => `${count} ${LANGUAGE_LABELS[language]}`)
      .join(' · ')}`,
  )
  io.say(`  projects    ${probe.projects.join(', ')}`)
  // Only worth saying where there is something to choose between.
  if (probe.projects.length > 1) {
    io.say(
      pc.dim('              each is graded on its own files and toolchain; scope with --project'),
    )
  }
  io.say(`  branch      ${probe.currentBranch ?? 'detached HEAD'}`)
  io.say(
    `  repo-owned  ${probe.ownedTools.length > 0 ? probe.ownedTools.join(', ') : 'no owned tools detected — pinned defaults will run'}`,
  )
}

/**
 * Security-tool status and guided installs. These three run as release
 * binaries crank-health cannot fetch ephemerally, so a missing one quietly
 * narrows what security can assess — this step is where that stops being
 * quiet. Declining (the default) changes nothing; the scan degrades exactly
 * as before.
 */
async function askSystemTools(io: PromptIO, deps: SessionDeps): Promise<Back | undefined> {
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
  if (missing.length === 0) return undefined

  if (!(await deps.hasBrew())) {
    io.say('  Homebrew was not found, so crank-health cannot install these for you:')
    for (const tool of missing) io.say(`    ${tool.spec.install}`)
    return undefined
  }

  for (const tool of missing) {
    const question = `Install ${tool.spec.binary} now (brew install ${tool.spec.binary})?`
    // eslint-disable-next-line no-await-in-loop
    const picked = await confirm(io, question, false)
    if (picked === BACK) return BACK
    if (!picked) {
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
  return undefined
}

/** The `--out` question, looping between the menu and the optional path edit. */
async function askOutputDir(
  io: PromptIO,
  probe: RepoProbe,
  draft: { out: string | undefined },
): Promise<Back | undefined> {
  const standard = join(probe.repoRoot, DEFAULT_OUTPUT_DIRNAME)
  for (;;) {
    const choices: { label: string; note?: string; out: string | undefined | typeof CUSTOM }[] = [
      ...(draft.out === undefined
        ? []
        : [{ label: draft.out, note: 'this run writes exactly here', out: draft.out }]),
      {
        label: standard,
        note: 'the default — every run kept in its own dated folder underneath',
        out: undefined,
      },
      { label: 'Somewhere else…', note: 'type a path', out: CUSTOM },
    ]
    // eslint-disable-next-line no-await-in-loop
    const picked = await select(io, 'Output directory?', choices, 0)
    if (picked === BACK) return BACK
    const chosen = (choices[picked] as (typeof choices)[number]).out
    if (chosen !== CUSTOM) {
      draft.out = chosen
      return undefined
    }
    // eslint-disable-next-line no-await-in-loop
    const typed = await textInput(io, 'Output directory', draft.out ?? '')
    if (typed !== null && typed.length > 0) {
      draft.out = typed
      return undefined
    }
    // Escaped or emptied the edit: back to the menu, not to the previous step.
  }
}

// ── The widgets ──────────────────────────────────────────────────────────────
// Each renders a block, repaints it in place on every keypress, and collapses
// to a single `question answer` line once settled, so the transcript that
// scrolls away reads like a filled-in form.

const HIDE_CURSOR = '\u001B[?25l'
const SHOW_CURSOR = '\u001B[?25h'
const CLEAR_BELOW = '\u001B[0J'
const moveUp = (lines: number): string => (lines > 0 ? `\u001B[${lines}A` : '')

const SELECT_HINT = '↑↓ move · enter choose · esc back'
const MULTI_HINT = '↑↓ move · space toggle · a all/none · enter confirm · esc back'
const CONFIRM_HINT = '←→ toggle · y/n · enter · esc back'
const TEXT_HINT = 'enter confirm · esc back'

/** Tracks how many lines the current block occupies on screen. */
interface Painted {
  lines: number
}

function paint(io: PromptIO, state: Painted, lines: readonly string[]): void {
  io.write(`${moveUp(state.lines)}\r${CLEAR_BELOW}${lines.join('\n')}\n`)
  state.lines = lines.length
}

/** Erases the block and leaves one settled line in its place. */
function settle(io: PromptIO, state: Painted, line: string): void {
  io.write(`${moveUp(state.lines)}\r${CLEAR_BELOW}`)
  state.lines = 0
  io.say(line)
}

/** Next keypress; Ctrl-C / Ctrl-D cancel the whole session from any prompt. */
async function readKey(io: PromptIO): Promise<PromptKey> {
  const key = await io.nextKey()
  if (key.ctrl === true && (key.name === 'c' || key.name === 'd')) {
    throw new PromptCancelledError()
  }
  return key
}

/** '1'–'9' as a shortcut straight to that entry, where the list has one. */
function digitIndex(key: PromptKey, count: number): number | undefined {
  const digit = key.sequence
  if (digit === undefined || digit.length !== 1 || digit < '1' || digit > '9') return undefined
  const index = Number(digit) - 1
  return index < count ? index : undefined
}

/** Arrow-key single choice; returns the chosen index, or {@link BACK}. */
async function select(
  io: PromptIO,
  question: string,
  choices: readonly { label: string; note?: string | undefined }[],
  defaultIndex: number,
): Promise<number | Back> {
  const count = choices.length
  let cursor = Math.min(Math.max(defaultIndex, 0), count - 1)
  const state: Painted = { lines: 0 }
  const render = (): string[] => [
    `${question} ${pc.dim(`(${SELECT_HINT})`)}`,
    ...choices.map((choice, index) => {
      const active = index === cursor
      const marker = active ? pc.cyan('❯') : ' '
      const note = choice.note === undefined ? '' : pc.dim(` — ${choice.note}`)
      return `  ${marker} ${active ? pc.bold(choice.label) : choice.label}${note}`
    }),
  ]

  io.say('')
  io.write(HIDE_CURSOR)
  try {
    for (;;) {
      paint(io, state, render())
      // eslint-disable-next-line no-await-in-loop
      const key = await readKey(io)
      if (key.name === 'up' || key.name === 'k') cursor = (cursor + count - 1) % count
      else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % count
      else if (key.name === 'return' || key.name === 'enter') break
      else if (key.name === 'escape' || key.name === 'left') {
        settle(io, state, `${question} ${pc.dim('(back)')}`)
        return BACK
      } else {
        const jump = digitIndex(key, count)
        if (jump !== undefined) {
          cursor = jump
          break
        }
      }
    }
  } finally {
    io.write(SHOW_CURSOR)
  }
  settle(io, state, `${question} ${pc.cyan((choices[cursor] as { label: string }).label)}`)
  return cursor
}

/**
 * Arrow-key multi choice: space toggles the entry under the cursor, `a` flips
 * everything at once, enter confirms (at least one must stay selected).
 * Returns one flag per choice, or {@link BACK}.
 */
async function multiSelect(
  io: PromptIO,
  question: string,
  choices: readonly { label: string; note?: string | undefined }[],
  initial: readonly boolean[],
): Promise<boolean[] | Back> {
  const count = choices.length
  let cursor = 0
  let warn = false
  const selected = [...initial]
  const state: Painted = { lines: 0 }
  const render = (): string[] => [
    `${question} ${pc.dim(`(${MULTI_HINT})`)}`,
    ...choices.map((choice, index) => {
      const active = index === cursor
      const marker = active ? pc.cyan('❯') : ' '
      const box = selected[index] === true ? pc.cyan('◉') : '◯'
      const note = choice.note === undefined ? '' : pc.dim(` — ${choice.note}`)
      return `  ${marker} ${box} ${active ? pc.bold(choice.label) : choice.label}${note}`
    }),
    ...(warn ? [`  ${pc.yellow('keep at least one selected')}`] : []),
  ]

  io.say('')
  io.write(HIDE_CURSOR)
  try {
    for (;;) {
      paint(io, state, render())
      // eslint-disable-next-line no-await-in-loop
      const key = await readKey(io)
      if (key.name === 'up' || key.name === 'k') cursor = (cursor + count - 1) % count
      else if (key.name === 'down' || key.name === 'j') cursor = (cursor + 1) % count
      else if (key.name === 'space') {
        selected[cursor] = selected[cursor] !== true
        warn = false
      } else if (key.name === 'a') {
        const all = selected.every(Boolean)
        selected.fill(!all)
        warn = false
      } else if (key.name === 'return' || key.name === 'enter') {
        if (selected.some(Boolean)) break
        warn = true
      } else if (key.name === 'escape' || key.name === 'left') {
        settle(io, state, `${question} ${pc.dim('(back)')}`)
        return BACK
      }
    }
  } finally {
    io.write(SHOW_CURSOR)
  }
  const chosen = selected.every(Boolean)
    ? 'all'
    : choices
        .filter((_, index) => selected[index])
        .map((choice) => choice.label)
        .join(', ')
  settle(io, state, `${question} ${pc.cyan(chosen)}`)
  return selected
}

/** A Yes/No toggle: arrows flip it, y/n answer directly, enter confirms. */
async function confirm(io: PromptIO, question: string, fallback: boolean): Promise<boolean | Back> {
  let value = fallback
  const state: Painted = { lines: 0 }
  const render = (): string[] => {
    const yes = value ? pc.bold(pc.cyan('❯ Yes')) : pc.dim('  Yes')
    const no = value ? pc.dim('  No') : pc.bold(pc.cyan('❯ No'))
    return [`${question}  ${yes}  ${no}  ${pc.dim(`(${CONFIRM_HINT})`)}`]
  }

  io.write(HIDE_CURSOR)
  try {
    for (;;) {
      paint(io, state, render())
      // eslint-disable-next-line no-await-in-loop
      const key = await readKey(io)
      if (key.name === 'y') {
        value = true
        break
      }
      if (key.name === 'n') {
        value = false
        break
      }
      if (key.name === 'return' || key.name === 'enter') break
      if (key.name === 'escape') {
        settle(io, state, `${question} ${pc.dim('(back)')}`)
        return BACK
      }
      if (
        key.name === 'left' ||
        key.name === 'right' ||
        key.name === 'up' ||
        key.name === 'down' ||
        key.name === 'tab' ||
        key.name === 'space'
      ) {
        value = !value
      }
    }
  } finally {
    io.write(SHOW_CURSOR)
  }
  settle(io, state, `${question} ${pc.cyan(value ? 'Yes' : 'No')}`)
  return value
}

/**
 * The one place typing happens: a minimal line edit for a custom path.
 * Returns the trimmed text, or `null` when escaped.
 */
async function textInput(io: PromptIO, label: string, initial: string): Promise<string | null> {
  let value = initial
  const state: Painted = { lines: 0 }
  for (;;) {
    paint(io, state, [`${label}: ${value}${pc.dim('▏')}  ${pc.dim(`(${TEXT_HINT})`)}`])
    // eslint-disable-next-line no-await-in-loop
    const key = await readKey(io)
    if (key.name === 'return' || key.name === 'enter') {
      const trimmed = value.trim()
      settle(io, state, `${label} ${pc.cyan(trimmed.length === 0 ? '(unchanged)' : trimmed)}`)
      return trimmed
    }
    if (key.name === 'escape') {
      settle(io, state, `${label} ${pc.dim('(back)')}`)
      return null
    }
    if (key.name === 'backspace') value = value.slice(0, -1)
    else if (key.ctrl === true && key.name === 'u') value = ''
    else if (printable(key)) value += key.sequence
  }
}

/** A single character the path edit should accept as itself. */
function printable(key: PromptKey): boolean {
  if (key.ctrl === true || key.meta === true) return false
  const ch = key.sequence
  return ch !== undefined && ch.length === 1 && ch >= ' ' && ch !== '\u007F'
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
