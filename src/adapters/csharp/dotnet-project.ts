import { homedir } from 'node:os'
import { join } from 'node:path'
import { execTool, systemCommand } from '../../core/exec.ts'
import type { ExecOptions, ToolFailure } from '../../core/exec.ts'
import type { RunContext } from '../../core/types.ts'
import { explainMissing } from '../common/system-tool.ts'
import type { SystemToolSpec } from '../common/system-tool.ts'
import { firstLine } from '../support.ts'

/**
 * The shared floor of the C# adapter: the one `dotnet` SDK spec, the
 * environment every `dotnet` spawn carries, and the gate that proves the SDK
 * this run would use is one this release was verified against.
 *
 * The SDK is a system tool (`SYSTEM_TOOL_MANIFEST`): crank-health cannot fetch
 * it, runs whatever the machine has, and degrades to `not-available` with an
 * install hint when there is none.
 */

/** The `dotnet` SDK as a system tool: probed on `PATH`, never fetched. */
export const DOTNET: SystemToolSpec = {
  binary: 'dotnet',
  versionArgs: ['--version'],
  install: 'https://dotnet.microsoft.com/download',
}

/**
 * The environment every `dotnet` spawn carries, on top of the neutralized base.
 *
 * `NUGET_PACKAGES` is set explicitly to the machine's default cache: that is
 * what defeats a hostile `NuGet.config` `globalPackagesFolder` pointing into
 * the target repo (zero footprint), while keeping the cache warm across runs —
 * a per-run scratch folder would re-download every restore graph every time.
 * `DOTNET_CLI_UI_LANGUAGE=en` is the determinism half: diagnostics are parsed
 * and quoted in reasons, so they must not vary with the machine's locale.
 */
export function dotnetEnv(): Readonly<Record<string, string>> {
  return {
    NUGET_PACKAGES: join(homedir(), '.nuget', 'packages'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_UI_LANGUAGE: 'en',
  }
}

/**
 * The `ExecOptions` every C# runner hands `execTool` — `cwd`, `timeoutMs` and
 * `env` decided once here rather than in each runner body. Build it once per
 * run and pass the same value to {@link sdkGate} and to the real command, so
 * the gate answers for the directory the run actually uses (a repo
 * `global.json` changes what `dotnet --version` answers per directory).
 *
 * @param cwd the runner's own working directory — never a fixed scratch path
 */
export function dotnetExecOptions(ctx: RunContext, cwd: string): ExecOptions {
  return { cwd, timeoutMs: ctx.timeoutMs, env: dotnetEnv() }
}

/** The SDK major this release's C# toolchain was verified against. */
const MINIMUM_SDK_MAJOR = 10

/**
 * Proves the SDK a C# runner is about to use is usable, or says why not.
 * Called once per runner at `run()` time — detection never spawns.
 *
 * It takes the **same `ExecOptions` value the caller is about to hand its real
 * command**, so the gate cannot answer for a different `cwd` than the run uses.
 * That matters because a repo `global.json` changes what `dotnet --version`
 * answers *in that directory*: a gate asked from a scratch path could pass
 * while the real run resolved a different — older — SDK.
 *
 * The branches are ordered, and the order is what probing forced. With a
 * `global.json` naming an uninstalled SDK, `dotnet --version` exits 155 and
 * prints the *installed-SDK list* on stdout (first line `6.0.405 [...]`) —
 * parsing a version out of that would produce a confidently wrong reason for an
 * unrelated failure, so a non-zero exit quotes stderr and never stdout.
 *
 * @returns `undefined` when the SDK is present, working and new enough
 */
export async function sdkGate(options: ExecOptions): Promise<ToolFailure | undefined> {
  const execution = await execTool(systemCommand(DOTNET.binary, DOTNET.versionArgs), options)
  if (execution.failure !== undefined) return explainMissing(DOTNET, execution.failure)
  if (execution.exitCode !== 0) {
    return {
      state: 'not-available',
      reason:
        `dotnet --version failed (exit ${execution.exitCode ?? 'signal'}): ` +
        firstLine(execution.stderr),
    }
  }
  const version = firstLine(execution.stdout)
  const major = /^(\d+)/.exec(version)?.[1]
  if (major === undefined) {
    return {
      state: 'not-available',
      reason: `dotnet --version printed '${version}' instead of a version`,
    }
  }
  if (Number(major) < MINIMUM_SDK_MAJOR) {
    return {
      state: 'not-available',
      reason:
        `.NET SDK ${version} is installed, but crank-health's C# tools need ` +
        `≥ ${MINIMUM_SDK_MAJOR} — install one (${DOTNET.install})`,
    }
  }
  return undefined
}
