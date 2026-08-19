import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import { COMPLEXITY_CEILING } from '../../core/grade.ts'
import type {
  PendingFinding,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedDotnetVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  firstLine,
  identify,
  repoRelative,
  scanMemo,
} from '../support.ts'
import { DOTNET, dotnetExecOptions, sdkGate } from './dotnet-project.ts'

/**
 * The `dotnet build` host: the injected MSBuild assets, the command line, the
 * SARIF parsing that turns one build into `types` and `lint` findings plus the
 * complexity metrics — and the runtime that spawns the build once for the
 * three runners consuming it ({@link buildFor} and the mappers below).
 *
 * One empiric shapes everything here (probed on SDK 10.0.203): a
 * multi-targeting project (`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>`)
 * compiles once per TFM, and every compilation writes the *same* `ErrorLog`
 * path — in parallel that interleaves two writers into corrupt JSON, and
 * serialized (`-m:1`) the last TFM silently overwrites the first. So
 * {@link INJECTED_TARGETS} redirects each compilation to
 * `<sarif base>.<TargetFramework>.sarif`, and {@link mergeSarifLogs} folds the
 * per-TFM documents back into the one SARIF 2.1 log that
 * {@link parseBuildSarif} consumes.
 */

/** The NuGet id of the analyzer package the build injects. */
export const NETANALYZERS_PACKAGE = 'microsoft.codeanalysis.netanalyzers'

/** The tool name all three build-backed runners report under. */
export const DOTNET_BUILD_TOOL = 'dotnet-build'

/**
 * The `CustomAfterMicrosoftCommonTargets` file injected into every compilation
 * (materialized into scratch by the runtime; `dotnet build` receives its path).
 * Three probed-on-SDK-10 subtleties, each load-bearing:
 *
 * - The analyzer version is bracketed (`[x.y.z]`): a bare `Version="x.y.z"` is
 *   a `>=` constraint to NuGet, and a vanished pin would silently float upward
 *   to a different analyzer binary. Brackets make a missing pin a loud
 *   `NU1102` instead (see {@link isUnresolvedPin}).
 * - The `.globalconfig` is added to `EditorConfigFiles` inside a
 *   `BeforeTargets="CoreCompile"` target — the documented evaluation-time
 *   `GlobalAnalyzerConfigFiles` item never reaches the compiler from here,
 *   because Roslyn's `Microsoft.Managed.Core.targets` copies that item into
 *   `EditorConfigFiles` before `CustomAfterMicrosoftCommonTargets` is
 *   imported. Target-time is the SDK's own mechanism (its
 *   `AddGlobalAnalyzerConfigForPackage_*` targets do exactly this).
 * - `TreatAsLocalProperty` lets this file rewrite the CLI-supplied `ErrorLog`
 *   per compilation, giving every TFM its own SARIF file (see the module
 *   comment). Single-TFM projects take the same path — `$(TargetFramework)`
 *   is set during their one compilation too — so the runtime always collects
 *   `<sarif base>.*.sarif` and merges.
 */
export const INJECTED_TARGETS = `<Project TreatAsLocalProperty="ErrorLog">
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.NetAnalyzers" Version="[${pinnedDotnetVersion(NETANALYZERS_PACKAGE)}]" PrivateAssets="all" />
    <AdditionalFiles Include="$(MSBuildThisFileDirectory)CodeMetricsConfig.txt" />
  </ItemGroup>
  <PropertyGroup Condition="'$(TargetFramework)' != '' and '$(ErrorLog)' != ''">
    <ErrorLog>$(ErrorLog.Replace('.sarif,version=2.1', '.$(TargetFramework).sarif,version=2.1'))</ErrorLog>
  </PropertyGroup>
  <Target Name="CrankHealthAnalyzerConfig" BeforeTargets="CoreCompile">
    <ItemGroup>
      <EditorConfigFiles Include="$(MSBuildThisFileDirectory)crank-health.globalconfig" />
    </ItemGroup>
  </Target>
</Project>
`

/**
 * The analyzer config injected beside the targets file. `global_level = 0`
 * sits above the analyzer package's shipped configs (−100, whose disabling of
 * CA1502 would tie and win at −100) and below a repo's own `.globalconfig`
 * (default 100) — so the rules turn on here, and the repo's explicit analyzer
 * choices still override ours (which is what lets criterion 17 read a missing
 * CA1502 as "suppressed by the repo").
 *
 * Two rules: CA1502 is the complexity census (see {@link CODE_METRICS_CONFIG}),
 * and CA1823 (unused private fields) is the one lint rule netanalyzers leaves
 * off by default that the default lint tier turns on — probed on SDK 10.0.203:
 * without it, an untooled C# repo's build yields no CA lint diagnostics at all
 * (`cs-basic`'s planted unused field fires only the CS0414 compiler warning),
 * and the lint category would grade on the analyzer set's near-empty default.
 */
export const INJECTED_GLOBALCONFIG = `is_global = true
global_level = 0
dotnet_diagnostic.CA1502.severity = warning
dotnet_diagnostic.CA1823.severity = warning
`

/**
 * `AdditionalFiles` payload the CA1502 analyzer reads its threshold from.
 * Zero reports *every* method with its cyclomatic complexity, which is what
 * turns CA1502 into a complexity census — the ceiling is applied in our code
 * against `COMPLEXITY_CEILING`, never a repo threshold.
 */
export const CODE_METRICS_CONFIG = 'CA1502: 0\n'

/**
 * The raw text of one merged SARIF 2.1 log — what `CsBuild` carries. Kept as
 * bytes rather than a parsed tree so the runtime can restage the identical
 * document as raw evidence and each consumer parses through the one strict
 * gate ({@link parseBuildSarif}).
 */
export type SarifLog = string

/**
 * One `dotnet build`'s outcome, as {@link buildFor} classifies it. A
 * discriminated union rather than optional fields: there is no SARIF when the
 * build never ran. `loud` carries criterion 16's one distinction — an
 * unresolvable analyzer pin is a tool `error` (never a silent fallback to the
 * SDK's bundled analyzers); everything else that stopped the build is
 * `not-available`. `rawFile` is where the runtime staged the merged log
 * (written once per build); every consuming record references it, so the run
 * directory holds one SARIF however many runners graded from it.
 */
export type CsBuild =
  | { readonly state: 'ok'; readonly sarif: SarifLog; readonly rawFile: string }
  | { readonly state: 'compile-failed'; readonly sarif: SarifLog; readonly rawFile: string }
  | { readonly state: 'unavailable'; readonly reason: string; readonly loud?: true }

/**
 * The strict gate every SARIF document passes: JSON, `version` exactly 2.1.0
 * (a 1.0 log is a silently different format, never zero findings), a `runs`
 * array. Returns the runs; throws — naming what it saw — on anything else.
 */
function sarifRuns(json: string): unknown[] {
  const document = asRecord(JSON.parse(json))
  if (document === undefined) throw new Error('SARIF log is not a JSON object')
  const version = asString(document['version'])
  if (version !== '2.1.0') {
    throw new Error(`SARIF version is '${version ?? '(missing)'}', crank-health requires 2.1.0`)
  }
  const runs = asArray(document['runs'])
  if (runs === undefined) throw new Error('SARIF log has no runs array')
  return runs
}

/**
 * Folds the per-TFM SARIF files one build produced (see
 * {@link INJECTED_TARGETS}) into a single 2.1 log holding every run — a
 * multi-targeting build reports each diagnostic once per TFM, and
 * {@link parseBuildSarif}'s dedupe collapses those copies. Every input is
 * validated through the same strict gate as parsing; an empty input list is a
 * throw, because a build that produced no SARIF must never read as a clean
 * empty one.
 */
export function mergeSarifLogs(documents: readonly string[]): SarifLog {
  if (documents.length === 0) throw new Error('no SARIF documents to merge')
  return JSON.stringify({ version: '2.1.0', runs: documents.flatMap(sarifRuns) })
}

/** Everything {@link buildInvocationArgs} needs; all paths absolute. */
export interface BuildInputs {
  readonly projectDir: string
  readonly scratch: string
  readonly sarifPath: string
  readonly targetsPath: string
}

/**
 * The `dotnet` argument list for one project's build. The `%2C` escape in
 * `ErrorLog` is mandatory — a literal comma makes the SDK silently emit SARIF
 * 1.0. `RestoreSources` pins restore to nuget.org because `dotnet build` has
 * no `--source` flag, and without it the scanned repo's `NuGet.config` would
 * decide which analyzer binary crank-health executes. No `--no-restore`: the
 * injected analyzer PackageReference must resolve (`NUGET_PACKAGES` keeps the
 * restore warm and out of the tree).
 */
export function buildInvocationArgs(input: BuildInputs): readonly string[] {
  return [
    'build',
    input.projectDir,
    `-p:ErrorLog=${input.sarifPath}%2Cversion=2.1`,
    `-p:BaseIntermediateOutputPath=${join(input.scratch, 'obj')}/`,
    `-p:BaseOutputPath=${join(input.scratch, 'bin')}/`,
    `-p:MSBuildProjectExtensionsPath=${join(input.scratch, 'obj')}/`,
    `-p:CustomAfterMicrosoftCommonTargets=${input.targetsPath}`,
    '-p:RestoreSources=https://api.nuget.org/v3/index.json',
  ]
}

/**
 * Whether a `dotnet build` transcript says the injected analyzer pin did not
 * resolve — NuGet's `NU1102` ("unable to find package … with version"), which
 * the bracketed pin in {@link INJECTED_TARGETS} guarantees for a missing
 * version. Matched on the combined stdout+stderr because MSBuild writes its
 * diagnostics to stdout. Deliberately the `dotnet build` surface only: `dnx`'s
 * pin failure carries no NuGet error code (Task 2's capture), a different
 * tool with a different consumer, and one regex spanning both would let a
 * roslynator failure be reported as an analyzer-pin failure quoting the wrong
 * package. An offline feed (`NU1301`) is not a pin failure either — that
 * degrades quietly, this one is loud (criterion 16).
 */
export function isUnresolvedPin(output: string): boolean {
  return /NU1102/.test(output)
}

/**
 * How the CA1502 records carry what the parser needs (decided by the
 * 10.0.400 capture): the SARIF has no `logicalLocations`, so the method
 * identity and the cyclomatic number both come from the message text —
 * `'Classify' has a cyclomatic complexity of '17'. …`. A record whose message
 * does not match is a parse throw, never a zero: a silently unparsed metric
 * would be a flattering complexity grade.
 */
export const CA1502_MESSAGE = /^'(?<symbol>.+)' has a cyclomatic complexity of '(?<number>\d+)'/

/** Rule ids the C# compiler itself owns; everything else is an analyzer's. */
const COMPILER_RULE = /^CS\d/

/** SARIF `level` → the finding schema's severity; unknown levels read as info. */
const SEVERITY_BY_LEVEL: Readonly<Record<string, Severity>> = {
  error: 'error',
  warning: 'warning',
}

/** What one build's SARIF partitions into (spec criterion 14). */
export interface ParsedBuild {
  readonly types: PendingFinding[]
  readonly lint: PendingFinding[]
  readonly complexity: {
    readonly functionsTotal: number
    readonly functionsOverCeiling: number
    readonly ca1502Count: number
  }
}

/** One SARIF result, flattened to the fields the partition consumes. */
interface BuildResult {
  readonly ruleId: string
  readonly level: string
  readonly message: string
  readonly file: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
}

/** SARIF artifact URIs are `file://` absolute; older tools emit plain paths. */
function resultFile(uri: string, repoRoot: string): string {
  return repoRelative(uri.startsWith('file:') ? fileURLToPath(uri) : uri, repoRoot)
}

/** Flattens one raw SARIF result entry; malformed entries yield nothing. */
function flattenResult(entry: unknown, repoRoot: string): BuildResult[] {
  const result = asRecord(entry)
  if (result === undefined) return []
  const ruleId = asString(result['ruleId'])
  const physical = asRecord(asRecord(asArray(result['locations'])?.[0])?.['physicalLocation'])
  const uri = asString(asRecord(physical?.['artifactLocation'])?.['uri'])
  if (ruleId === undefined || uri === undefined) return []

  const region = asRecord(physical?.['region'])
  const startLine = asNumber(region?.['startLine']) ?? 1
  const startCol = asNumber(region?.['startColumn']) ?? 1
  return [
    {
      ruleId,
      level: asString(result['level']) ?? 'warning',
      message: asString(asRecord(result['message'])?.['text']) ?? '',
      file: resultFile(uri, repoRoot),
      startLine,
      startCol,
      endLine: asNumber(region?.['endLine']) ?? startLine,
      endCol: asNumber(region?.['endColumn']) ?? startCol,
    },
  ]
}

/** A result → the finding shape shared by both graded partitions. */
function toFinding(result: BuildResult, category: 'types' | 'lint'): PendingFinding {
  return {
    category,
    tool: DOTNET_BUILD_TOOL,
    rule: result.ruleId,
    severity: SEVERITY_BY_LEVEL[result.level] ?? 'info',
    file: result.file,
    range: {
      startLine: result.startLine,
      startCol: result.startCol,
      endLine: result.endLine,
      endCol: result.endCol,
    },
    message: result.message,
    // The compiler enforces the repo's own project settings; the CA rules run
    // under our injected analyzer and config.
    provenance: category === 'types' ? 'repo-config' : 'default-config',
    gradeScope: true,
  }
}

/**
 * Partitions one build's SARIF (criterion 14): compiler diagnostics (`CS…`)
 * become `types` findings, `CA1502` feeds the complexity metrics alone — at
 * threshold zero it reports every method, a census rather than a lint rule —
 * and every other rule becomes a `lint` finding.
 *
 * `functionsTotal` counts distinct (file, symbol) pairs among the CA1502
 * records; `functionsOverCeiling` counts those whose reported cyclomatic
 * number exceeds `COMPLEXITY_CEILING` — strictly ours, never a repo
 * threshold.
 *
 * @throws {Error} when the payload is not a SARIF 2.1 document with runs and
 *   results, or a CA1502 record's message does not carry the method identity
 *   and cyclomatic number ({@link CA1502_MESSAGE})
 */
export function parseBuildSarif(json: string, repoRoot: string): ParsedBuild {
  const flattened = sarifRuns(json).flatMap((entry) => {
    const run = asRecord(entry)
    const entries = asArray(run?.['results'])
    if (entries === undefined) throw new Error('SARIF run has no results array')
    return entries.flatMap((result) => flattenResult(result, repoRoot))
  })

  // Criterion 15: a multi-targeting build reports each diagnostic once per
  // TFM — one copy per (rule, file, region, message) survives, before any
  // finding or metric is built.
  const seen = new Set<string>()
  const results = flattened.filter((result) => {
    const key = [
      result.ruleId,
      result.file,
      result.startLine,
      result.startCol,
      result.endLine,
      result.endCol,
      result.message,
    ].join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const types: PendingFinding[] = []
  const lint: PendingFinding[] = []
  const complexityBySymbol = new Map<string, number>()
  let ca1502Count = 0

  for (const result of results) {
    if (result.ruleId === 'CA1502') {
      ca1502Count += 1
      const match = CA1502_MESSAGE.exec(result.message)
      const symbol = match?.groups?.['symbol']
      const number = match?.groups?.['number']
      if (symbol === undefined || number === undefined) {
        throw new Error(`CA1502 record with an unrecognized message: '${result.message}'`)
      }
      const key = `${result.file}\u0000${symbol}`
      complexityBySymbol.set(key, Math.max(complexityBySymbol.get(key) ?? 0, Number(number)))
    } else if (COMPILER_RULE.test(result.ruleId)) {
      types.push(toFinding(result, 'types'))
    } else {
      lint.push(toFinding(result, 'lint'))
    }
  }

  return {
    types: types.toSorted(byLocation),
    lint: lint.toSorted(byLocation),
    complexity: {
      functionsTotal: complexityBySymbol.size,
      functionsOverCeiling: [...complexityBySymbol.values()].filter(
        (complexity) => complexity > COMPLEXITY_CEILING,
      ).length,
      ca1502Count,
    },
  }
}

/**
 * Criterion 16's loud reason: the injected analyzer pin did not resolve, and
 * grading on the SDK's bundled analyzers instead would be a silently different
 * toolchain — so the three build-backed runners surface this as tool `error`,
 * quoting the pin.
 */
export const UNRESOLVED_PIN_REASON =
  `the pinned analyzer ${NETANALYZERS_PACKAGE}@${pinnedDotnetVersion(NETANALYZERS_PACKAGE)} ` +
  'did not resolve (NU1102) — refusing to grade on the SDK’s bundled analyzers instead'

/**
 * Why `lint` and `complexity` decline a `compile-failed` build: a partial
 * multi-csproj build is one failure, and CA results from the sub-projects that
 * did compile would be a lint grade over an unknown fraction of the code — a
 * flattering number, not a measurement.
 */
export const BUILD_FAILED_REASON = 'build failed'

/**
 * Criterion 17: the build succeeded, the project holds C# source, and the
 * census came back empty — at threshold 0 CA1502 reports *every* method, so
 * zero records means the repo's own analyzer config outranked the injected one
 * (its `.globalconfig` defaults to `global_level` 100, ours is 0). The honest
 * state is not-assessed with this reason, never a "no complex functions" A.
 */
export const CA1502_SUPPRESSED_REASON = 'CA1502 suppressed by the repo’s analyzer config'

/**
 * One scan's builds: the **promise** is cached, not the result, so the three
 * runners `mapLimit` starts concurrently share one `dotnet build` instead of
 * racing three. Keyed on {@link RunContext.runScratch} — the scan-root scratch
 * every job shares — plus the project path; the per-job `ctx.scratch` would
 * never collide across the trio of one project and would never share.
 */
const builds = scanMemo<CsBuild>()

/** The per-TFM logs one build writes (see {@link INJECTED_TARGETS}). */
const PER_TFM_SARIF = /^build\..+\.sarif$/

/**
 * The one `dotnet build` of this scan × this project, memoized so the three
 * consuming runners trigger exactly one compilation — and every one of them
 * reads the same resolved value, which is what makes "the identical reason
 * from all three" hold by construction when the build is unavailable.
 */
export function buildFor(ctx: RunContext): Promise<CsBuild> {
  return builds.for(ctx, runBuild)
}

/**
 * Releases every build memoized under a scan's scratch dir — called from the
 * scan teardowns beside the `rm` of that dir, so a long-lived process (the
 * test suite) does not retain a parsed SARIF per scan. Matches by path prefix
 * because PR mode nests its two sides (`<scratch>/base-scratch`,
 * `<scratch>/head-scratch`) under the one dir its finally holds.
 */
export function forgetBuilds(runScratch: string): void {
  builds.forget(runScratch)
}

/**
 * The build itself: gate the SDK, materialize the injected assets into
 * scratch, compile with every output redirected there, then classify — first
 * match wins. See {@link CsBuild} for the states.
 */
async function runBuild(ctx: RunContext): Promise<CsBuild> {
  // The assets live under the *scan* scratch, keyed by project, because the
  // build they configure is the scan × project's — not any one runner's.
  const assetDir = join(ctx.runScratch, 'dotnet-build', ...ctx.project.path.split('/'))
  await mkdir(assetDir, { recursive: true })

  // Built once and passed to both the gate and the real command, so the gate
  // provably answered for the identical directory (a repo `global.json` changes
  // what `dotnet --version` resolves per directory).
  const options = dotnetExecOptions(ctx, assetDir)
  const gate = await sdkGate(options)
  if (gate !== undefined) return { state: 'unavailable', reason: gate.reason }

  const targetsPath = join(assetDir, 'crank-health.targets')
  // Must end in `.sarif`: the injected targets' per-TFM rewrite string-matches
  // `.sarif,version=2.1`, and a different suffix would silently resurrect the
  // shared-file corruption the rewrite exists to prevent.
  const sarifPath = join(assetDir, 'build.sarif')
  await writeFile(targetsPath, INJECTED_TARGETS, 'utf8')
  await writeFile(join(assetDir, 'crank-health.globalconfig'), INJECTED_GLOBALCONFIG, 'utf8')
  await writeFile(join(assetDir, 'CodeMetricsConfig.txt'), CODE_METRICS_CONFIG, 'utf8')

  const projectDir = ctx.project.path === '.' ? ctx.repoRoot : join(ctx.repoRoot, ctx.project.path)
  const execution = await execTool(
    systemCommand(
      DOTNET.binary,
      buildInvocationArgs({ projectDir, scratch: assetDir, sarifPath, targetsPath }),
    ),
    options,
  )

  if (execution.failure !== undefined) {
    return { state: 'unavailable', reason: execution.failure.reason }
  }
  // MSBuild writes its diagnostics to stdout, so the pin check reads both.
  if (isUnresolvedPin(execution.stdout + execution.stderr)) {
    return { state: 'unavailable', reason: UNRESOLVED_PIN_REASON, loud: true }
  }

  const names = (await readdir(assetDir)).filter((name) => PER_TFM_SARIF.test(name)).toSorted()
  if (names.length === 0) {
    return {
      state: 'unavailable',
      reason:
        `dotnet build exited ${execution.exitCode ?? 'signal'} without a SARIF log: ` +
        firstLine(execution.stderr),
    }
  }

  const sarif = mergeSarifLogs(
    await Promise.all(names.map((name) => readFile(join(assetDir, name), 'utf8'))),
  )
  // Staged once, here, inside the memoized promise — the job scratch is shared
  // by the trio's runners (same project, same raw prefix), so every record can
  // reference this one file.
  const rawFile = await writeScratchRaw(ctx.scratch, 'dotnet-build.sarif.json', sarif)
  return execution.exitCode === 0
    ? { state: 'ok', sarif, rawFile }
    : { state: 'compile-failed', sarif, rawFile }
}

/** The narrowed `unavailable` variant, as one mapper-shared result. */
function unavailableResult(build: Extract<CsBuild, { state: 'unavailable' }>): ToolResult {
  return {
    state: build.loud === true ? 'error' : 'not-available',
    findings: [],
    rawFiles: [],
    reason: build.reason,
  }
}

/** A SARIF the strict gate refused: an `error`, never zero findings. */
function parseFailure(rawFiles: readonly string[], error: unknown): ToolResult {
  return {
    state: 'error',
    findings: [],
    rawFiles,
    reason: `could not parse the build SARIF: ${error instanceof Error ? error.message : String(error)}`,
  }
}

/**
 * The `types` view of one build. On `ok` it grades from the compiler
 * diagnostics; on `compile-failed` it *still* grades — the compile errors are
 * the types findings — and when the failed build's diagnostics all lacked
 * locations (csc's CS5001 does), the state is `error` naming the failure,
 * never an `ok` that reads as a clean A.
 */
export async function typesResultFor(build: CsBuild, repoRoot: string): Promise<ToolResult> {
  if (build.state === 'unavailable') return unavailableResult(build)
  const rawFiles = [build.rawFile]
  let parsed: ParsedBuild
  try {
    parsed = parseBuildSarif(build.sarif, repoRoot)
  } catch (error) {
    return parseFailure(rawFiles, error)
  }
  const findings = await identify(repoRoot, parsed.types)
  if (build.state === 'compile-failed') {
    return findings.length === 0
      ? {
          state: 'error',
          findings: [],
          rawFiles,
          reason:
            'dotnet build failed, and its diagnostics carry no source locations — ' +
            'types cannot be graded',
        }
      : {
          state: 'ok',
          findings,
          rawFiles,
          reason: 'dotnet build failed; types graded from the compiler diagnostics',
        }
  }
  return { state: 'ok', findings, rawFiles }
}

/**
 * The `lint` view of one build: the analyzer diagnostics on `ok`, and
 * {@link BUILD_FAILED_REASON} on a partial build — see that constant for why a
 * failed compilation grades nothing here.
 */
export async function lintResultFor(build: CsBuild, repoRoot: string): Promise<ToolResult> {
  if (build.state === 'unavailable') return unavailableResult(build)
  const rawFiles = [build.rawFile]
  if (build.state === 'compile-failed') {
    return { state: 'not-available', findings: [], rawFiles, reason: BUILD_FAILED_REASON }
  }
  try {
    const parsed = parseBuildSarif(build.sarif, repoRoot)
    return { state: 'ok', findings: await identify(repoRoot, parsed.lint), rawFiles }
  } catch (error) {
    return parseFailure(rawFiles, error)
  }
}

/**
 * The `complexity` view of one build: the CA1502 census as metrics, never as
 * findings. `hasCsFiles` is the suppression witness — a successful build over
 * real C# source with zero census records means the repo's config turned the
 * rule off ({@link CA1502_SUPPRESSED_REASON}); with no C# files there is
 * nothing to census and nothing to accuse the repo of suppressing.
 */
export function complexityResultFor(build: CsBuild, hasCsFiles: boolean): ToolResult {
  if (build.state === 'unavailable') return unavailableResult(build)
  const rawFiles = [build.rawFile]
  if (build.state === 'compile-failed') {
    return { state: 'not-available', findings: [], rawFiles, reason: BUILD_FAILED_REASON }
  }
  let parsed: ParsedBuild
  try {
    // The census never leaves this function as findings, so file paths are
    // internal dedupe keys only — a fixed root keeps them deterministic.
    parsed = parseBuildSarif(build.sarif, '/')
  } catch (error) {
    return parseFailure(rawFiles, error)
  }
  const { functionsTotal, functionsOverCeiling, ca1502Count } = parsed.complexity
  if (hasCsFiles && ca1502Count === 0) {
    return { state: 'not-available', findings: [], rawFiles, reason: CA1502_SUPPRESSED_REASON }
  }
  return { state: 'ok', findings: [], rawFiles, metrics: { functionsTotal, functionsOverCeiling } }
}

/** The shape the three build-backed runners share; only category and run differ. */
function buildBackedRunner(
  category: 'types' | 'complexity' | 'lint',
  run: (ctx: RunContext) => Promise<ToolResult>,
): ToolRunner {
  return {
    tool: DOTNET_BUILD_TOOL,
    category,
    // The executed binary is the machine's SDK; what this release pins exactly
    // is the analyzer package the build injects (spec §6).
    pinnedVersion: pinnedDotnetVersion(NETANALYZERS_PACKAGE),
    // Only `--deep` may evaluate MSBuild: a build executes the repo's own
    // project files (criterion 5's booby trap is exactly that proof).
    deepOnly: true,
    // The build is never repo-owned — it is our injected toolchain over the
    // repo's sources — and detection never spawns.
    detect: () => Promise.resolve(null),
    run,
  }
}

/** `types` from the one memoized build: compiler diagnostics, repo-config. */
export const dotnetBuildTypesRunner: ToolRunner = buildBackedRunner('types', async (ctx) =>
  typesResultFor(await buildFor(ctx), ctx.repoRoot),
)

/** `complexity` from the one memoized build: the CA1502 census as metrics. */
export const dotnetBuildComplexityRunner: ToolRunner = buildBackedRunner(
  'complexity',
  async (ctx) => complexityResultFor(await buildFor(ctx), ctx.files.length > 0),
)

/** `lint` from the one memoized build: the injected analyzers' diagnostics. */
export const dotnetBuildLintRunner: ToolRunner = buildBackedRunner('lint', async (ctx) =>
  lintResultFor(await buildFor(ctx), ctx.repoRoot),
)
