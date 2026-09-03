import { execTool, systemCommand } from '../../core/exec.ts'
import type { ToolExecution, ToolFailure } from '../../core/exec.ts'
import type { ToolResult } from '../../core/types.ts'
import type { SystemTool } from '../../manifest.ts'
import { failed, firstLine } from '../support.ts'

/**
 * The tools crank-health cannot fetch — gitleaks, opengrep, osv-scanner and the
 * `dotnet` SDK — share one degradation story, and it lives here.
 *
 * Spec §8: a missing prerequisite is `not-available` *with an install hint*, the
 * run continues, and the exit code stays 0. What makes that honest rather than
 * silent is the hint: "brew install gitleaks" is a thing a reader can act on,
 * "gitleaks is not executable" is not.
 */

export interface SystemToolSpec {
  /** The command as it appears on `PATH`. */
  readonly binary: SystemTool
  /** Arguments that print the version, e.g. `['version']`, `['--version']`. */
  readonly versionArgs: readonly string[]
  /** How to install it, phrased as something to run. */
  readonly install: string
}

/**
 * Replaces the generic "not executable" reason with an install hint, and leaves
 * every other outcome alone.
 *
 * The probe *is* the run: asking `PATH` first and then running would be two
 * process spawns to learn one thing, and would race with a tool being installed
 * in between. Instead the real invocation goes out, and an `ENOENT` coming back
 * is what "not installed" means.
 */
export function explainMissing(spec: SystemToolSpec, failure: ToolFailure): ToolFailure {
  if (failure.state !== 'not-available') return failure
  return {
    state: 'not-available',
    reason:
      `${spec.binary} is not on PATH — install it (${spec.install}) to assess this, ` +
      `or leave it out and the rest of the scan is unaffected`,
  }
}

/**
 * The installed version, for `report.json`'s record of what actually ran (spec
 * §6). A tool crank-health does not pin is precisely the one whose version a
 * reader needs to see, so it is asked — once, after the scan itself proved the
 * binary exists.
 *
 * `undefined` when the version cannot be read: the scan already succeeded, and
 * losing the version label is not worth failing over.
 */
export async function systemToolVersion(
  spec: SystemToolSpec,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const execution = await execTool(systemCommand(spec.binary, spec.versionArgs), { cwd, timeoutMs })
  if (execution.failure !== undefined) return undefined
  const line = firstLine(execution.stdout) || firstLine(execution.stderr)
  // gitleaks prints `8.30.1`, opengrep `1.29.0`, osv-scanner
  // `osv-scanner version: 2.4.0` — take the first dotted number either way.
  return /\d+\.\d+\.\d+\S*/.exec(line)?.[0]
}

/** A `ToolResult` for a failed system-tool execution, with the hint applied. */
export function systemToolFailure(
  spec: SystemToolSpec,
  execution: ToolExecution & { readonly failure: ToolFailure },
  rawFiles: readonly string[],
): ToolResult {
  return failed(explainMissing(spec, execution.failure), rawFiles)
}
