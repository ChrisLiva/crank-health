import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import type { PinnedDotnetTool, PinnedPythonTool, PinnedTool } from '../manifest.ts'
import { pinnedDotnetSpec, pinnedPythonSpec, pinnedPythonVersion, pinnedSpec } from '../manifest.ts'

/**
 * The shared subprocess layer every adapter runs its tool through. It exists so
 * that the two things a runner must never get wrong — pinning (spec §6) and
 * zero footprint (spec §7) — are decided once, here, instead of per adapter.
 */

/**
 * Who fetches a pinned tool: npm's runner for the JS/TS side, uv's for the
 * Python side, the .NET SDK's `dnx` for the C# side. All three install into
 * their own caches, never into the target repo.
 */
export type EphemeralFetcher = 'npx' | 'uvx' | 'dnx'

/** A resolved command line: the binary plus its arguments. */
export interface ToolCommand {
  readonly command: string
  readonly args: readonly string[]
  /** The fetcher that resolves the tool, or `null` for the repo's own binary. */
  readonly ephemeral: EphemeralFetcher | null
}

/** Runs the repo's own installed binary (spec §1: repo-owned and installed). */
export function repoCommand(binPath: string, args: readonly string[]): ToolCommand {
  return { command: binPath, args, ephemeral: null }
}

/**
 * Runs a tool already installed on the machine, resolved through `PATH`.
 *
 * This is not a third fetcher: nothing is fetched, which is the whole point.
 * gitleaks, opengrep and osv-scanner ship as release binaries with no npm or
 * PyPI distribution to pin (see `SYSTEM_TOOL_MANIFEST`), so a runner either
 * finds one on the machine or degrades — and `ephemeral: null` is exactly the
 * "we did not install this" that {@link execTool}'s classification already
 * understands. The install hint that makes the degradation actionable is the
 * runner's, because only it knows which tool to name.
 */
export function systemCommand(binary: string, args: readonly string[]): ToolCommand {
  return { command: binary, args, ephemeral: null }
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
    ephemeral: 'npx',
  }
}

/**
 * The Python half of {@link ephemeralCommand}: runs the manifest-pinned version
 * through `uvx`, which resolves the distribution into uv's own tool cache and
 * an ephemeral virtualenv — never into the target repo, and never into a venv
 * the repo owns.
 *
 * `uvx <dist>@<version>` is uv's exact-pin form and is what we use whenever the
 * command and the distribution share a name (all five Python tools do today).
 * `uvx --from <dist>==<version> <command>` is the form for the other case, and
 * is what `binary` selects.
 *
 * @param tool PyPI distribution name from the manifest
 * @param binary the command inside that distribution, when it differs
 */
export function uvxCommand(
  tool: PinnedPythonTool,
  args: readonly string[],
  binary?: string,
): ToolCommand {
  return {
    command: 'uvx',
    args:
      binary === undefined
        ? [pinnedPythonSpec(tool), ...args]
        : ['--from', `${tool}==${pinnedPythonVersion(tool)}`, binary, ...args],
    ephemeral: 'uvx',
  }
}

/**
 * The .NET third of {@link ephemeralCommand}: runs the manifest-pinned version
 * through `dnx`, which resolves the NuGet tool package into the NuGet cache and
 * executes it from there — never into the target repo.
 *
 * `-y` skips the interactive "download and run?" prompt, `<id>@<version>` is
 * dnx's exact-pin form, and `--source` names the feed explicitly so a machine's
 * NuGet.config cannot redirect the pin. The trailing `--` is load-bearing:
 * everything after it goes to the tool, so a tool flag that collides with one
 * of dnx's own (`--source`, `--version`, `--prerelease`, …) never reaches dnx's
 * parser.
 *
 * @param tool NuGet tool-package id from the manifest
 */
export function dnxCommand(tool: PinnedDotnetTool, args: readonly string[]): ToolCommand {
  return {
    command: 'dnx',
    args: [
      '-y',
      pinnedDotnetSpec(tool),
      '--source',
      'https://api.nuget.org/v3/index.json',
      '--',
      ...args,
    ],
    ephemeral: 'dnx',
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

/**
 * How long a terminated tool has to exit before it is killed outright.
 *
 * SIGTERM first, so a tool that wants to remove its own temp files gets the
 * chance; SIGKILL soon after, because a budget that a process can decline to
 * honor is not a budget.
 */
const FORCE_KILL_AFTER_MS = 2_000

/** How long an ephemeral tool may run before we explain the wait (see below). */
export const FIRST_RUN_NOTICE_MS = 4_000

/**
 * Runs one tool, converting every way a subprocess can go wrong into a
 * {@link ToolFailure} rather than a thrown error — the orchestrator's isolation
 * guarantee (spec §8) starts here.
 */
export async function execTool(tool: ToolCommand, options: ExecOptions): Promise<ToolExecution> {
  const notice = tool.ephemeral === null ? undefined : scheduleFirstRunNotice()
  try {
    const result = await execa(tool.command, [...tool.args], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      reject: false,
      all: false,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...NEUTRAL_ENV, ...options.env },
      extendEnv: true,
      // Almost every tool here is a *tree*: `npx` spawns the analyzer, `uvx`
      // spawns it inside an ephemeral venv, a repo's `node_modules/.bin` entry
      // is often a shell wrapper. Terminating only the direct child leaves the
      // grandchild alive holding the stdout pipe we are still reading, so the
      // budget expires, the scan moves on with a `timeout` result — and the CLI
      // cannot exit until the abandoned process finishes on its own. A one-tool
      // hang would become a scan that never returns.
      //
      // `killDescendants` makes every termination path take the whole tree: on
      // Unix the subprocess leads its own process group and the signal goes to
      // `-pid`, on Windows execa uses `taskkill /T /F`. It deliberately does
      // *not* set the user-facing `detached` option, which is what keeps
      // `cleanup` (on by default) killing the same tree when crank-health
      // itself exits or is interrupted — so Ctrl-C still leaves nothing behind.
      killDescendants: true,
      forceKillAfterDelay: FORCE_KILL_AFTER_MS,
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

/**
 * Stderr markers that mean "the fetcher could not get the tool", not "the tool
 * failed". Each fetcher words it its own way, and both wordings matter: this is
 * the difference between `not-available` with an actionable reason and a
 * mystery `error` (spec §8).
 */
const OFFLINE_MARKERS: Readonly<Record<EphemeralFetcher, readonly RegExp[]>> = {
  npx: [
    /ENOTFOUND/,
    /EAI_AGAIN/,
    /ECONNREFUSED/,
    /ETIMEDOUT/,
    /ERR_SOCKET_TIMEOUT/,
    /request to https?:\/\/\S+ failed/i,
    /offline mode/i,
    /npm error code E\d{3}/,
  ],
  uvx: [
    // uv reports an unfetchable pin as an unsolvable requirement, and says why.
    /No solution found when resolving tool dependencies/i,
    /network was disabled/i,
    /failed to fetch/i,
    /failed to download/i,
    /error sending request/i,
    /Request failed after \d+ retries/i,
    /Could not connect/i,
  ],
  // NuGet's "is not found in NuGet feeds" (an unresolvable pin) is deliberately
  // absent: a pin the feed does not have is a tool error quoting the pin, never
  // "offline, warm your cache".
  dnx: [
    /Unable to load the service index/i,
    /NU1301/,
    /No such host is known/i,
    /Temporary failure in name resolution/i,
    /Connection refused/i,
    /error sending request/i,
  ],
}

/** What to tell the user when a fetcher itself is missing (spec §8). */
const MISSING_FETCHER: Readonly<Record<EphemeralFetcher, string>> = {
  npx: '`npx` is not on PATH — install Node.js 20+ so pinned tools can be fetched',
  uvx:
    '`uvx` is not on PATH — install uv (https://docs.astral.sh/uv/getting-started/installation/) ' +
    'so pinned Python tools can be fetched',
  dnx:
    '`dnx` is not on PATH — install the .NET SDK 10+ (https://dotnet.microsoft.com/download) ' +
    'so pinned C# tools can be fetched',
}

/** What each fetcher's local cache is called, for the offline hint below. */
const FETCHER_CACHE: Readonly<Record<EphemeralFetcher, string>> = {
  npx: 'npm',
  uvx: 'uv',
  dnx: 'NuGet',
}

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
      reason:
        tool.ephemeral === null
          ? `${tool.command} is not executable`
          : MISSING_FETCHER[tool.ephemeral],
    }
  }
  if (tool.ephemeral !== null && OFFLINE_MARKERS[tool.ephemeral].some((m) => m.test(stderr))) {
    return {
      state: 'not-available',
      reason:
        `could not fetch ${pinnedArg(tool)}: no network and nothing in the ` +
        `${FETCHER_CACHE[tool.ephemeral]} cache — run crank-health once with ` +
        'network access to warm the cache',
    }
  }
  return undefined
}

/** The pinned `name@version`/`name==version` argument, for error messages. */
function pinnedArg(tool: ToolCommand): string {
  return tool.args.find((arg) => arg.lastIndexOf('@') > 0 || arg.includes('==')) ?? tool.command
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
