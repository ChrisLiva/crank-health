import { homedir } from 'node:os'
import { join } from 'node:path'
import { ancestryOf, repoPath } from '../../core/discover.ts'
import { execTool, systemCommand } from '../../core/exec.ts'
import type { ExecOptions, ToolFailure } from '../../core/exec.ts'
import type { DetectContext, Detection, RunContext, ToolResult } from '../../core/types.ts'
import { compare, exists, firstLine } from '../support.ts'

/**
 * The shared floor of the Go adapter: the environment every `go` spawn carries,
 * the gate that proves the toolchain this run would use can grade Go at all,
 * and the ancestor walk the config-owned Go tools share.
 *
 * The Go toolchain is not in `SYSTEM_TOOL_MANIFEST`: nothing pins it, because
 * it is the *fetcher* for every pinned Go analyzer (`go run <path>@<version>`)
 * the way `npx` and `uvx` are. So a machine without it gets an honest
 * `not-available` with an install hint rather than a version comparison.
 */

/**
 * The Go minor this release's pinned analyzers need. It is a *minor* floor, not
 * a major one (unlike `sdkGate`'s): Go's compatibility line moves with the
 * minor, and the pinned analyzers' own `go` directives are what set this.
 */
export const MINIMUM_GO_MINOR = 25

/** `go version`'s own binary and probe arguments. */
const GO_BINARY = 'go'
const GO_VERSION_ARGS: readonly string[] = ['version']

/** Where a user gets a Go toolchain, quoted in the gate's install hint. */
const GO_INSTALL = 'https://go.dev/dl'

/**
 * The environment every `go` spawn carries, on top of the neutralized base —
 * the zero-footprint contract (spec §7) for a toolchain that is perfectly
 * willing to write into the module it is pointed at.
 *
 * `GOFLAGS=-mod=readonly` is Go's own default, set explicitly so an ambient
 * `GOFLAGS=-mod=mod` cannot turn a scan into a `go.mod`/`go.sum` rewrite. It is
 * safe for a vendored module too: verified against a `go mod vendor`ed tree,
 * where it produces byte-identical findings.
 *
 * `GOMODCACHE` is pinned to the machine's warm cache — `$HOME/go/pkg/mod`,
 * Go's own default — for the same reason `dotnet-project.ts` pins
 * `NUGET_PACKAGES`: it is the one setting that could otherwise be pointed
 * inside the repo being scanned. The build cache (`GOCACHE`) is derived from
 * the OS cache directory and is never inside a repo.
 */
export function goExecEnv(): Record<string, string> {
  return {
    GOFLAGS: '-mod=readonly',
    GOMODCACHE: join(homedir(), 'go', 'pkg', 'mod'),
  }
}

/**
 * The major and minor `go version` reported, or `undefined` when the line
 * carries no version at all.
 *
 * Exported because two callers need it — this file's gate and the suite's
 * golden-toolchain predicate — and a second regex somewhere else is exactly how
 * the two drift apart. It reads one line and nothing else: `go version` prints
 * `go version go1.26.6 darwin/arm64` on a release toolchain and
 * `go version devel go1.27-<sha> …` on a development one, and both carry the
 * same `goX.Y` token.
 */
export function parseGoVersion(line: string): { major: number; minor: number } | undefined {
  const matched = /\bgo(\d+)\.(\d+)/.exec(line)
  if (matched === null) return undefined
  return { major: Number(matched[1]), minor: Number(matched[2]) }
}

/** Whether a parsed toolchain version clears {@link MINIMUM_GO_MINOR}. */
export function meetsGoFloor(version: { major: number; minor: number }): boolean {
  return version.major > 1 || version.minor >= MINIMUM_GO_MINOR
}

/**
 * Proves the Go toolchain a runner is about to use is usable, or says why not.
 * Called once per runner at `run()` time — detection never spawns.
 *
 * It takes the **same `ExecOptions` value the caller is about to hand its real
 * command**, so the gate cannot answer for a different `cwd` or environment
 * than the run uses: a repo `go.work` or a `toolchain` directive in `go.mod`
 * changes which toolchain `go` resolves *in that directory*.
 *
 * The branches are ordered — spawn failure, then a non-zero exit, then an
 * unreadable version, then the floor — and each mints one sentence a user can
 * act on. There is no silent pass: a toolchain this cannot vouch for is
 * `not-available`, never an unremarked run.
 *
 * @returns `undefined` when Go is present, working and new enough
 */
export async function goGate(options: ExecOptions): Promise<ToolFailure | undefined> {
  const execution = await execTool(systemCommand(GO_BINARY, GO_VERSION_ARGS), options)
  if (execution.failure !== undefined) {
    return {
      state: 'not-available',
      reason:
        `Go toolchain not found — install Go ≥ 1.${MINIMUM_GO_MINOR} ` +
        `(${GO_INSTALL}) to grade Go code`,
    }
  }
  if (execution.exitCode !== 0) {
    return {
      state: 'not-available',
      reason:
        `go version failed (exit ${execution.exitCode ?? 'signal'}): ` +
        firstLine(execution.stderr),
    }
  }

  const line = firstLine(execution.stdout)
  const version = parseGoVersion(line)
  if (version === undefined) {
    return { state: 'not-available', reason: `could not parse \`go version\` output: ${line}` }
  }
  if (!meetsGoFloor(version)) {
    return {
      state: 'not-available',
      reason:
        `Go ${version.major}.${version.minor} is below the 1.${MINIMUM_GO_MINOR} floor ` +
        `the pinned Go analyzers need — upgrade Go to grade Go code`,
    }
  }
  return undefined
}

/**
 * The single place the Go gate is spelled. Every Go-adapter runner is declared
 * `run: withGoGate(runX)` and none calls {@link goGate} itself.
 *
 * Why one home: the contract is that *every* Go runner degrades with the gate's
 * own reason, and eight independently written gate preambles is exactly how one
 * of them ends up with a different sentence or a missing branch. The wrapper
 * also builds the `ExecOptions` the wrapped run will use, so the gate is asked
 * about the directory and environment the real command gets.
 */
export function withGoGate(
  run: (ctx: RunContext) => Promise<ToolResult>,
): (ctx: RunContext) => Promise<ToolResult> {
  return async (ctx: RunContext): Promise<ToolResult> => {
    const gate = await goGate(goExecOptions(ctx))
    if (gate !== undefined)
      return { state: gate.state, findings: [], rawFiles: [], reason: gate.reason }
    return run(ctx)
  }
}

/**
 * The `ExecOptions` a Go runner hands `execTool` — decided once here rather
 * than in each runner body, so {@link withGoGate}'s probe and the run it guards
 * cannot disagree about where they ran.
 */
export function goExecOptions(ctx: RunContext): ExecOptions {
  return { cwd: projectDirectory(ctx), timeoutMs: ctx.timeoutMs, env: goExecEnv() }
}

/** The absolute directory a project's Go commands run in. */
export function projectDirectory(ctx: RunContext): string {
  return ctx.project.path === '.' ? ctx.repoRoot : join(ctx.repoRoot, ctx.project.path)
}

/**
 * Spec §1's ownership test for the Go tools whose ownership is a *config file
 * and nothing else* — staticcheck, golangci-lint and gremlins each read one of
 * a small set of names, and none of them has a dependency declaration to look
 * for: `go run` fetches them, so nothing in a repo ever installs one.
 *
 * The walk is {@link ancestryOf}, nearest first, because that is how the tools
 * themselves resolve a config: the project's directory upward. Every existing
 * name at every level lands in `configFiles` — a reader wants the inherited
 * ones too — while `ownedVia` names the nearest, which is the one that decides.
 *
 * `installed` is always `false` for the same reason there is no dependency
 * branch: there is no repo-local binary to find.
 *
 * @param names the config file names this tool answers to, in no order
 * @returns the {@link Detection} when the repo owns this tool, `null` otherwise
 */
export async function detectGoConfig(
  ctx: DetectContext,
  names: readonly string[],
): Promise<Detection | null> {
  const ancestry = ancestryOf(ctx.project.path)
  const candidates = ancestry.flatMap((directory) =>
    names.map((name) => ({ directory, path: repoPath(directory, name) })),
  )
  const present = await Promise.all(
    candidates.map(async (candidate) =>
      (await exists(join(ctx.repoRoot, candidate.path))) ? candidate.path : undefined,
    ),
  )
  // Nearest-first, like the ancestry: the first survivor is the config that wins.
  const found = present.filter((path) => path !== undefined)
  const nearest = found[0]
  if (nearest === undefined) return null

  return {
    reason: 'config',
    configFiles: found.toSorted(compare),
    ownedVia: nearest,
    installed: false,
  }
}
