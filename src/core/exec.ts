import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import type { PinnedTool } from '../manifest.ts'
import { pinnedSpec } from '../manifest.ts'

/**
 * The shared subprocess layer every adapter runs its tool through. It exists so
 * that the two things a runner must never get wrong — pinning (spec §6) and
 * zero footprint (spec §7) — are decided once, here, instead of per adapter.
 */

/** A resolved command line: the binary plus its arguments. */
export interface ToolCommand {
  readonly command: string
  readonly args: readonly string[]
  /** True when the tool is fetched by `npx` rather than run from the repo. */
  readonly ephemeral: boolean
}

/** Runs the repo's own installed binary (spec §1: repo-owned and installed). */
export function repoCommand(binPath: string, args: readonly string[]): ToolCommand {
  return { command: binPath, args, ephemeral: false }
}

/**
 * Runs the manifest-pinned version through `npx --yes`, which installs into
 * npm's own cache — never into the target repo.
 *
 * @param tool npm package name from the manifest
 * @param binary the command inside that package, when it differs from the
 * package name (`typescript` → `tsc`, `fta-cli` → `fta`). npx can only guess
 * the binary when the package ships exactly one, so naming it is the safe form.
 */
export function ephemeralCommand(
  tool: PinnedTool,
  args: readonly string[],
  binary?: string,
): ToolCommand {
  const spec = pinnedSpec(tool)
  return {
    command: 'npx',
    args:
      binary === undefined
        ? ['--yes', spec, ...args]
        : ['--yes', '--package', spec, '--', binary, ...args],
    ephemeral: true,
  }
}

/** How a tool run ended, in the vocabulary of `ToolResult.state`. */
export interface ToolFailure {
  readonly state: 'error' | 'timeout' | 'not-available'
  readonly reason: string
}

export interface ToolExecution {
  readonly stdout: string
  readonly stderr: string
  /** `undefined` when the process never started or was killed by a signal. */
  readonly exitCode: number | undefined
  /**
   * Set when the process could not produce a usable result at all. A non-zero
   * exit code is NOT a failure — most analyzers exit non-zero when they find
   * something — so this is only about the process itself.
   */
  readonly failure?: ToolFailure
}

export interface ExecOptions {
  /** Working directory. Always the repo root for analyzers. */
  readonly cwd: string
  readonly timeoutMs: number
  /** Extra environment on top of the neutralized base. */
  readonly env?: Readonly<Record<string, string>>
}

/** Tool output can be large on big repos; well past that we would rather fail. */
const MAX_BUFFER_BYTES = 128 * 1024 * 1024

/** How long an ephemeral tool may run before we explain the wait (see below). */
export const FIRST_RUN_NOTICE_MS = 4_000

/**
 * Runs one tool, converting every way a subprocess can go wrong into a
 * {@link ToolFailure} rather than a thrown error — the orchestrator's isolation
 * guarantee (spec §8) starts here.
 */
export async function execTool(tool: ToolCommand, options: ExecOptions): Promise<ToolExecution> {
  const notice = tool.ephemeral ? scheduleFirstRunNotice() : undefined
  try {
    const result = await execa(tool.command, [...tool.args], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      reject: false,
      all: false,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...NEUTRAL_ENV, ...options.env },
      extendEnv: true,
    })

    const stdout = String(result.stdout ?? '')
    const stderr = String(result.stderr ?? '')
    const failure = classify(tool, result, stderr)
    return failure === undefined
      ? { stdout, stderr, exitCode: result.exitCode }
      : { stdout, stderr, exitCode: result.exitCode, failure }
  } finally {
    notice?.()
  }
}

/**
 * Stages raw tool output under `<scratch>/raw/`. The pipeline adopts these
 * files into the run directory's `raw/`; runners never write into the target
 * repo and never learn where the output directory is.
 *
 * @returns the absolute path of the staged file, for `ToolResult.rawFiles`
 */
export async function writeScratchRaw(
  scratch: string,
  name: string,
  contents: string,
): Promise<string> {
  const directory = join(scratch, 'raw')
  await mkdir(directory, { recursive: true })
  const target = join(directory, name)
  await writeFile(target, contents, 'utf8')
  return target
}

/**
 * Environment neutralization. Colored or interactive output would corrupt the
 * parsers, and npm's notifiers make cold `npx` runs both slower and noisier.
 */
const NEUTRAL_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  CI: '1',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_PROGRESS: 'false',
}

/** Stderr markers that mean "npx could not fetch the tool", not "tool failed". */
const OFFLINE_MARKERS: readonly RegExp[] = [
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ERR_SOCKET_TIMEOUT/,
  /request to https?:\/\/\S+ failed/i,
  /offline mode/i,
  /npm error code E\d{3}/,
]

/** The parts of an execa result that decide whether the process itself failed. */
interface ExecaLike {
  readonly timedOut?: boolean
  readonly code?: string | undefined
}

function classify(tool: ToolCommand, result: ExecaLike, stderr: string): ToolFailure | undefined {
  if (result.timedOut === true) {
    return { state: 'timeout', reason: `${tool.command} exceeded its time budget` }
  }
  if (result.code === 'ENOENT') {
    return {
      state: 'not-available',
      reason: tool.ephemeral
        ? '`npx` is not on PATH — install Node.js 20+ so pinned tools can be fetched'
        : `${tool.command} is not executable`,
    }
  }
  if (tool.ephemeral && OFFLINE_MARKERS.some((marker) => marker.test(stderr))) {
    return {
      state: 'not-available',
      reason:
        `could not fetch ${pinnedArg(tool)}: no network and nothing in the npm ` +
        'cache — run crank-health once with network access to warm the cache',
    }
  }
  return undefined
}

/** The `name@version` argument inside an npx command line, for error messages. */
function pinnedArg(tool: ToolCommand): string {
  return tool.args.find((arg) => arg.lastIndexOf('@') > 0) ?? tool.command
}

let noticeShown = false

/**
 * Cold `npx` downloads take seconds with no output of their own, which reads as
 * a hang. If an ephemeral tool is still running after
 * {@link FIRST_RUN_NOTICE_MS}, say so once — on stderr, because `--json` owns
 * stdout.
 */
function scheduleFirstRunNotice(): () => void {
  if (noticeShown) return () => {}
  const timer = setTimeout(() => {
    noticeShown = true
    process.stderr.write('crank-health: downloading pinned tools (first run only)…\n')
  }, FIRST_RUN_NOTICE_MS)
  timer.unref?.()
  return () => {
    clearTimeout(timer)
  }
}
