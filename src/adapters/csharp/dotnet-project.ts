import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ancestryOf, repoPath } from '../../core/discover.ts'
import { execTool, systemCommand } from '../../core/exec.ts'
import type { ExecOptions, ToolFailure } from '../../core/exec.ts'
import type { DetectContext, Detection, RunContext } from '../../core/types.ts'
import { explainMissing } from '../common/system-tool.ts'
import type { SystemToolSpec } from '../common/system-tool.ts'
import { asRecord, compare, firstLine, readJson } from '../support.ts'

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

/** The manifest `dotnet tool restore` reads, relative to a project directory. */
export const DOTNET_TOOLS_MANIFEST = '.config/dotnet-tools.json'

/** What makes a .NET local tool repo-owned; see {@link detectDotnetTool}. */
export interface DotnetToolSpec {
  /** The tool id as the tools manifest keys it, e.g. `dotnet-stryker`. */
  readonly toolId: string
  /** The NuGet package id a csproj `PackageReference` would name. */
  readonly packageName: string
}

/**
 * Spec §1's ownership test in the shape .NET local tools share: a
 * `.config/dotnet-tools.json` whose `tools` object lists the requested id —
 * file presence alone is not ownership, and a malformed manifest declares
 * nothing — or a `PackageReference` naming the package in one of the project's
 * own csprojs. The manifest chain walks {@link ancestryOf}, nearest first,
 * because `dotnet tool restore` and `dotnet <tool>` resolve the manifest the
 * same way: current directory upward.
 *
 * A listing manifest also answers "installed": it *is* the install declaration
 * (`dotnet tool restore` materializes it into the NuGet cache on demand), so
 * there is no virtualenv analogue to probe and no binary to find — and, like
 * `detectPythonTool`, no `version` field, because detection never spawns.
 *
 * @returns the {@link Detection} when the repo owns this tool, `null` otherwise
 */
export async function detectDotnetTool(
  ctx: DetectContext,
  spec: DotnetToolSpec,
): Promise<Detection | null> {
  const ancestry = ancestryOf(ctx.project.path)
  const manifests = await Promise.all(
    ancestry.map(async (directory) =>
      asRecord(await readJson(join(ctx.repoRoot, directory, DOTNET_TOOLS_MANIFEST))),
    ),
  )

  // Nearest-first, like the ancestry: the first entry is the manifest that wins.
  const configFiles = ancestry.flatMap((directory, depth) => {
    const tools = asRecord(manifests[depth]?.['tools'])
    return tools?.[spec.toolId] === undefined ? [] : [repoPath(directory, DOTNET_TOOLS_MANIFEST)]
  })

  const declaredIn = await declaringCsproj(ctx, spec.packageName)
  const declared = declaredIn !== undefined
  if (configFiles.length === 0 && !declared) return null

  const ownedVia = configFiles[0] ?? declaredIn
  return {
    reason:
      configFiles.length > 0 && declared
        ? 'config+dependency'
        : configFiles.length > 0
          ? 'config'
          : 'dependency',
    configFiles: configFiles.toSorted(compare),
    ...(ownedVia === undefined ? {} : { ownedVia }),
    installed: configFiles.length > 0,
  }
}

/** A `PackageReference` naming this exact package (NuGet ids compare caselessly). */
function packageReferencePattern(packageName: string): RegExp {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<PackageReference\\s[^>]*Include\\s*=\\s*"${escaped}"`, 'i')
}

/**
 * The nearest of the project's own csprojs that names the package as a
 * dependency, or `undefined`. Project-local on purpose: an ancestor's csproj is
 * another project's, and its `PackageReference`s do not flow downward the way a
 * tools manifest does.
 */
async function declaringCsproj(
  ctx: DetectContext,
  packageName: string,
): Promise<string | undefined> {
  const pattern = packageReferencePattern(packageName)
  const candidates = ctx.project.manifests.filter((manifest) =>
    manifest.toLowerCase().endsWith('.csproj'),
  )
  for (const manifest of candidates) {
    // A handful of small files; reading in order keeps "nearest" deterministic.
    // eslint-disable-next-line no-await-in-loop
    const text = await readTextFile(join(ctx.repoRoot, manifest))
    if (text !== undefined && pattern.test(text)) return manifest
  }
  return undefined
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
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
