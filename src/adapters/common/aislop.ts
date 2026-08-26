import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import { ancestryOf, languageOf, repoPath } from '../../core/discover.ts'
import { ephemeralCommand, execTool, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type { ToolFailure } from '../../core/exec.ts'
import type {
  DetectContext,
  Detection,
  Language,
  PendingFinding,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import type { PinnedTool } from '../../manifest.ts'
import { pinnedVersion } from '../../manifest.ts'
import { detectNodeTool } from '../jsts/node-package.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  errorMessage,
  exists,
  failed,
  firstLine,
  identify,
  readFileOrUndefined,
  repoRelative,
  unavailable,
} from '../support.ts'

/**
 * aislop — the `ai-slop` engine of the `aislop` CLI, read as lint findings.
 *
 * aislop ships six engines; five of them re-run what crank-health already runs
 * (format, lint, code-quality, security, architecture), so the generated config
 * turns those off and this runner reads `ai-slop` alone. That engine flags the
 * shapes LLM-written code arrives in — a duplicate import, a swallowed
 * exception, a package that was never declared — which no other analyzer here
 * measures.
 *
 * The parser is exported so a format shift fails a test instead of corrupting a
 * report, the way `react-doctor.ts` and `zizmor.ts` are.
 */

export const AISLOP_TOOL = 'aislop' satisfies PinnedTool

/** The only engine this runner reads; the other five are off in the config. */
const AISLOP_ENGINE = 'ai-slop'

/** What aislop's own file policy can read, in `Language` terms. */
export const AISLOP_LANGUAGES: readonly Language[] = ['js-ts', 'python', 'go', 'csharp']

/** The one path aislop reads its config from; `.aislop/config.yaml` is not it. */
export const AISLOP_CONFIG_FILE = '.aislop/config.yml'

/** One entry of aislop's top-level `diagnostics[]`, narrowed to what we map. */
export interface AislopDiagnostic {
  readonly filePath: string
  readonly engine: string
  readonly rule: string
  /** aislop's enum is `error`, `warning`, `info`; anything else maps to `info`. */
  readonly severity: string
  readonly message: string
  readonly help?: string
  readonly line: number
  readonly column: number
}

/** The fields of `aislop scan --json` this runner reads. */
export interface AislopPayload {
  /** `''` when the payload carries no `schemaVersion`; see {@link payloadFailure}. */
  readonly schemaVersion: string
  readonly version?: string
  readonly engines: Readonly<Record<string, { readonly skipped: boolean }>>
  /** `summary.files`, 0 when the payload carries no count. */
  readonly filesScanned: number
  readonly diagnostics: readonly AislopDiagnostic[]
}

/**
 * Parses `aislop scan --json` output.
 *
 * Empty stdout throws here, where zizmor's and opengrep's parsers read it as a
 * clean run: aislop prints its envelope whatever it found, so nothing on stdout
 * means the process died before it printed one, and reporting that as zero
 * findings would grade a repo on a scan that never happened.
 *
 * A diagnostic missing any field a finding needs is dropped rather than
 * defaulted (the `react-doctor.ts` rule): a partial payload loses those rows and
 * nothing else.
 *
 * @throws {Error} when stdout is not an aislop payload, or aislop reported an error
 */
export function parseAislopJson(stdout: string): AislopPayload {
  const record = stdout.trim().length === 0 ? undefined : asRecord(parseJson(stdout))
  if (record === undefined) throw new Error('aislop printed no JSON object')

  const error = asString(record['error'])
  if (error !== undefined) throw new Error(`aislop reported an error: ${error}`)

  const entries = asArray(record['diagnostics'])
  if (entries === undefined) throw new Error('aislop output has no diagnostics array')

  const diagnostics = entries.flatMap((entry) => {
    const row = asRecord(entry)
    const filePath = asString(row?.['filePath'])
    const engine = asString(row?.['engine'])
    const rule = asString(row?.['rule'])
    const severity = asString(row?.['severity'])
    const message = asString(row?.['message'])
    const line = asNumber(row?.['line'])
    const column = asNumber(row?.['column'])
    if (
      filePath === undefined ||
      engine === undefined ||
      rule === undefined ||
      severity === undefined ||
      message === undefined ||
      line === undefined ||
      column === undefined
    ) {
      return []
    }
    const help = asString(row?.['help'])
    return [
      {
        filePath,
        engine,
        rule,
        severity,
        message,
        ...(help === undefined ? {} : { help }),
        line,
        column,
      } satisfies AislopDiagnostic,
    ]
  })

  const engines = Object.fromEntries(
    Object.entries(asRecord(record['engines']) ?? {}).map(([name, value]) => [
      name,
      { skipped: asRecord(value)?.['skipped'] === true },
    ]),
  )
  const version = asString(record['version'])
  return {
    schemaVersion: asString(record['schemaVersion']) ?? '',
    ...(version === undefined ? {} : { version }),
    engines,
    filesScanned: asNumber(asRecord(record['summary'])?.['files']) ?? 0,
    diagnostics,
  }
}

/**
 * The payload guards, in order, returning the first that applies.
 *
 * Each one names a way the run can look successful and be worthless: a moved
 * JSON contract, a config aislop did not honor, an engine that stood itself
 * down, and a scan whose directory policy skipped every file. A category is
 * graded the moment a runner returns `ok`, so each of these has to be a failure
 * rather than zero findings.
 *
 * @param scannableCount how many files of this project the inventory offered
 */
export function payloadFailure(
  payload: AislopPayload,
  scannableCount: number,
): ToolFailure | undefined {
  if (payload.schemaVersion !== '1') {
    return {
      state: 'error',
      reason: `aislop printed schemaVersion "${payload.schemaVersion}", not "1"; its JSON contract moved`,
    }
  }
  const engines = Object.keys(payload.engines)
  if (engines.length !== 1 || engines[0] !== AISLOP_ENGINE) {
    return {
      state: 'error',
      reason: 'aislop ran engines beyond ai-slop; its config was not honored',
    }
  }
  if (payload.engines[AISLOP_ENGINE]?.skipped === true) {
    return {
      state: 'error',
      reason: 'aislop skipped its ai-slop engine and its JSON gives no reason',
    }
  }
  if (payload.filesScanned === 0 && scannableCount > 0) {
    return {
      state: 'not-available',
      reason: "aislop's directory policy excluded every file of this project",
    }
  }
  return undefined
}

/**
 * aislop's own severity enum (`src/engines/types.ts`), mapped to ours. The
 * fallback covers a release that adds a fourth level: an unknown level is
 * advisory-weight, not silently graded as an error.
 */
const SEVERITIES: Readonly<Record<string, Severity>> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
}

/**
 * Rules whose message interpolates an import specifier, which can carry
 * `user:password@` userinfo. `duplicate-import` quotes the raw specifier;
 * `hallucinated-import` quotes only the package name today, and is listed so a
 * change upstream cannot leak a credential into the run dir.
 */
const REDACTED_RULES: ReadonlySet<string> = new Set([
  'ai-slop/duplicate-import',
  'ai-slop/hallucinated-import',
])

/**
 * Diagnostics → the core's vocabulary, graded as lint findings.
 *
 * The inventory, not aislop, decides what is in the report: aislop walks the
 * mirror directory, so only a diagnostic about a file crank-health handed it
 * survives. Rule ids keep their `ai-slop/` prefix, which is what tells a reader
 * of the report which engine spoke. No explicit anchor: identity is the trimmed
 * source line, like every other line-attached diagnostic.
 *
 * @param scannable repo-relative posix paths of this project's inventory
 */
export function toPendingFindings(
  payload: AislopPayload,
  repoConfig: boolean,
  scannable: ReadonlySet<string>,
): PendingFinding[] {
  return payload.diagnostics
    .flatMap((diagnostic) => {
      const file = repoRelative(diagnostic.filePath)
      if (diagnostic.engine !== AISLOP_ENGINE || !scannable.has(file)) return []
      // aislop reports column 0 for a whole-line diagnostic; a `Range` is
      // one-based on both axes.
      const column = Math.max(1, diagnostic.column)
      return [
        {
          category: 'lint' as const,
          tool: AISLOP_TOOL,
          rule: diagnostic.rule,
          severity: SEVERITIES[diagnostic.severity] ?? ('info' as const),
          file,
          range: {
            startLine: diagnostic.line,
            startCol: column,
            endLine: diagnostic.line,
            endCol: column,
          },
          message: REDACTED_RULES.has(diagnostic.rule)
            ? redactUserinfo(diagnostic.message)
            : diagnostic.message,
          provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
          gradeScope: true,
          ...(diagnostic.help === undefined ? {} : { fixHint: diagnostic.help }),
        } satisfies PendingFinding,
      ]
    })
    .toSorted(byLocation)
}

/**
 * `https://user:pass@host/m.js` → `https://<redacted>@host/m.js`. The class
 * stops at a quote, a slash or whitespace, so an address later in the sentence
 * is left alone.
 */
/**
 * `JSON.parse`, with a syntax error read as "not a payload". The thrown
 * `SyntaxError` quotes the first bytes of stdout, and this runner's reason
 * reaches `report.json`, where nothing may quote what a tool printed.
 */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

function redactUserinfo(message: string): string {
  return message.replaceAll(/:\/\/[^@\s"'/]+@/g, '://<redacted>@')
}

/**
 * `aislop scan --json <root>`, and nothing else.
 *
 * The root is always the scratch mirror, never a path inside the repo: aislop
 * walks the directory it is given and writes its cache beside its cwd, so
 * pointing it at the repo would put both the walk and the write in the target.
 * `--config` is absent because aislop finds `.aislop/config.yml` from the cwd,
 * which the runner sets to the mirror's parent, and the fixing subcommands
 * (`fix`, `agent`) are unreachable from here by construction.
 */
export function invocationArgs(mirrorRoot: string): string[] {
  return ['scan', '--json', mirrorRoot]
}

/** aislop's `RuleSeverityOverride` enum, the only rule values its schema takes. */
export type RuleSeverity = 'error' | 'warning' | 'off'

/** The three keys of a repo's aislop config this runner honors. */
export interface LiftedConfig {
  readonly rules?: Readonly<Record<string, RuleSeverity>>
  readonly exclude?: readonly string[]
  readonly include?: readonly string[]
}

/**
 * The config crank-health writes beside the mirror.
 *
 * Engine selection is never the repo's: five of aislop's six engines re-run
 * what other runners here already graded, so they are off whatever the repo
 * says. `version` is a number because aislop's schema is `z.number()` and a
 * string fails the whole parse, whose catch falls back to aislop's defaults:
 * all six engines, which would double-count four categories. `failBelow: 0`
 * keeps the score out of the exit code, and `telemetry.enabled` is the file
 * half of the `AISLOP_NO_TELEMETRY` the run sets.
 *
 * {@link liftRepoConfig} yields `rules`, `exclude` and `include` alone, so the
 * spread can never reach `engines`, `ci`, `telemetry` or `version`.
 */
export function generatedConfig(lifted?: LiftedConfig): Record<string, unknown> {
  return {
    version: 1,
    engines: {
      format: false,
      lint: false,
      'code-quality': false,
      security: false,
      architecture: false,
      [AISLOP_ENGINE]: true,
    },
    ci: { failBelow: 0 },
    telemetry: { enabled: false },
    ...lifted,
  }
}

/** A repo's own aislop config, read for the two things it may decide. */
export interface RepoConfig {
  readonly lifted: LiftedConfig
  /** `engines: {ai-slop: false}`: the repo asked for no ai-slop assessment. */
  readonly aiSlopDisabled: boolean
}

/**
 * A repo's `.aislop/config.yml` narrowed to the keys a crank-health run honors.
 *
 * The lift is a validation, not a merge: a key present with a shape aislop's
 * own schema would reject makes the whole call `undefined`, and the run then
 * measures with crank-health's defaults and says so in its reason. Reading
 * half of a config aislop would have thrown out would grade the repo under
 * settings nothing ever applied.
 *
 * @returns `undefined` when the text is not a YAML mapping, or a lifted key
 * fails its check
 */
export function liftRepoConfig(text: string): RepoConfig | undefined {
  let document: unknown
  try {
    document = parseYaml(text)
  } catch {
    return undefined
  }
  const record = asRecord(document)
  if (record === undefined) return undefined

  const rules = liftRules(record['rules'])
  const exclude = liftGlobs(record['exclude'])
  const include = liftGlobs(record['include'])
  if (rules === null || exclude === null || include === null) return undefined

  return {
    lifted: {
      ...(rules === undefined ? {} : { rules }),
      ...(exclude === undefined ? {} : { exclude }),
      ...(include === undefined ? {} : { include }),
    },
    aiSlopDisabled: asRecord(record['engines'])?.[AISLOP_ENGINE] === false,
  }
}

/** `undefined` = the key is absent, `null` = present and invalid. */
function liftRules(value: unknown): Readonly<Record<string, RuleSeverity>> | null | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value)
  if (record === undefined) return null
  const rules: Record<string, RuleSeverity> = {}
  for (const [rule, severity] of Object.entries(record)) {
    if (severity !== 'error' && severity !== 'warning' && severity !== 'off') return null
    rules[rule] = severity
  }
  return rules
}

/** The same three-way answer for `exclude` and `include`, both glob lists. */
function liftGlobs(value: unknown): readonly string[] | null | undefined {
  if (value === undefined) return undefined
  const entries = asArray(value)
  if (entries === undefined) return null
  const globs: string[] = []
  for (const entry of entries) {
    const glob = asString(entry)
    if (glob === undefined) return null
    globs.push(glob)
  }
  return globs
}

export const aislopRunner: ToolRunner = {
  tool: AISLOP_TOOL,
  category: 'lint',
  pinnedVersion: pinnedVersion(AISLOP_TOOL),
  // ai-slop measures what no lint alternative here measures, so a repo that
  // owns ESLint or Biome keeps it, and owning aislop stands no linter down.
  complementary: true,
  languages: AISLOP_LANGUAGES,
  detect: detectAislop,
  run: runAislop,
}

/**
 * Two halves, either of which makes aislop the repo's: a declared dependency
 * (`detectNodeTool`'s four manifest blocks, inherited from ancestors the way
 * npm resolves) and a `.aislop/config.yml` in the project or above it.
 *
 * The config half reads the disk rather than the inventory: `.aislop/` is a dot
 * directory, and discovery keeps those out of `ctx.files.all`. Ancestry order
 * is kept as it comes, nearest first, so `configFiles[0]` is the config that
 * actually governs this project.
 *
 * Nothing here spawns: the installed version is read out of the package's own
 * `package.json`, never from `aislop --version`.
 */
async function detectAislop(ctx: DetectContext): Promise<Detection | null> {
  const dependency = await detectNodeTool(ctx, {
    // No `configFiles`: aislop's config is not a project-relative artifact the
    // inventory can confirm, so this runner finds it itself below.
    configFiles: [],
    packageName: AISLOP_TOOL,
    binName: AISLOP_TOOL,
  })

  const ancestry = ancestryOf(ctx.project.path)
  const present = await Promise.all(
    ancestry.map((directory) => exists(join(ctx.repoRoot, directory, AISLOP_CONFIG_FILE))),
  )
  const configFiles = ancestry.flatMap((directory, depth) =>
    present[depth] === true ? [repoPath(directory, AISLOP_CONFIG_FILE)] : [],
  )
  if (dependency === null && configFiles.length === 0) return null

  const ownedVia = configFiles[0] ?? dependency?.ownedVia
  return {
    reason:
      configFiles.length > 0 && dependency !== null
        ? 'config+dependency'
        : configFiles.length > 0
          ? 'config'
          : 'dependency',
    configFiles,
    ...(ownedVia === undefined ? {} : { ownedVia }),
    installed: dependency?.installed ?? false,
    ...(dependency?.binPath === undefined ? {} : { binPath: dependency.binPath }),
    ...(dependency?.version === undefined ? {} : { version: dependency.version }),
  }
}

/**
 * The manifests aislop reads to decide whether an import names a declared
 * package. They are copied from every ancestor directory, so a workspace
 * package's mirror carries the root's dependency list and
 * `hallucinated-import` does not fire on every hoisted dependency.
 */
const MIRRORED_MANIFESTS: readonly string[] = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
]

/** aislop's own ignore file, which the repo may own; repo root only. */
const AISLOP_IGNORE_FILE = '.aislopignore'

async function runAislop(ctx: RunContext): Promise<ToolResult> {
  const scannable = scannableOf(ctx.files)
  if (scannable.size === 0) {
    // See `opengrep.ts`: nothing scanned is a category with no evidence, never
    // a clean bill. Only the repo-spanning unit reaches this branch: discovery
    // (`discover.ts`, `partitionProjects`) keeps a project only when it holds a
    // `languageOf` file, and `Language` is exactly `AISLOP_LANGUAGES`.
    return unavailable(
      'no JavaScript, TypeScript, Python, C# or Go files, so aislop assessed nothing',
    )
  }

  const configPath = ctx.detection?.configFiles[0]
  const text =
    configPath === undefined ? undefined : await readFileOrUndefined(join(ctx.repoRoot, configPath))
  const repo = text === undefined ? undefined : liftRepoConfig(text)
  if (repo?.aiSlopDisabled === true) {
    return unavailable(`repo's ${configPath} disables aislop's ai-slop engine`)
  }

  // The generated config sits beside the mirror, not inside it: aislop reads
  // `.aislop/config.yml` from its cwd, and a config inside the scanned tree
  // would become one more file it walks.
  const base = join(ctx.scratch, AISLOP_TOOL)
  const mirror = join(base, 'repo')
  await mkdir(join(base, '.aislop'), { recursive: true })
  await writeFile(join(base, '.aislop', 'config.yml'), stringify(generatedConfig(repo?.lifted)))

  const mirrored = await buildMirror(ctx, mirror)
  if (mirrored !== undefined) return mirrored

  const args = invocationArgs(mirror)
  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, args)
      : ephemeralCommand(AISLOP_TOOL, args)
  const execution = await execTool(command, {
    cwd: base,
    timeoutMs: ctx.timeoutMs,
    // The file half is `telemetry.enabled: false`; this is the half that holds
    // when aislop reads its config from somewhere we did not write.
    env: { AISLOP_NO_TELEMETRY: '1' },
  })

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'aislop.json', execution.stdout)]
  if (execution.stderr.length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'aislop.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) return failed(execution.failure, rawFiles)
  // aislop exits 1 when it found something, which is a completed run.
  if (execution.exitCode !== 0 && execution.exitCode !== 1) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `aislop exited ${execution.exitCode}: ${firstLine(execution.stderr) || 'no output'}`,
    }
  }

  let payload: AislopPayload
  try {
    payload = parseAislopJson(execution.stdout)
  } catch (error) {
    return { state: 'error', findings: [], rawFiles, reason: errorMessage(error) }
  }
  const failure = payloadFailure(payload, scannable.size)
  if (failure !== undefined) return { ...failure, findings: [], rawFiles }

  const configOwned = repo !== undefined
  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, toPendingFindings(payload, configOwned, scannable)),
    rawFiles,
    ...(payload.version === undefined ? {} : { toolVersion: payload.version }),
    // Detection cannot answer this one: a repo can own a config this run then
    // could not validate, and the findings must not claim it as their source.
    configOwned,
    ...(configPath === undefined
      ? {}
      : {
          reason: configOwned
            ? `engine selection is crank-health's; rules, exclude and include come from ${configPath}`
            : `${configPath} could not be read as aislop config; measured with crank-health's defaults`,
        }),
  }
}

/** The inventory paths aislop's file policy can read, as the report filter. */
function scannableOf(files: readonly string[]): ReadonlySet<string> {
  return new Set(
    files.filter((file) => {
      const language = languageOf(file)
      return language !== undefined && AISLOP_LANGUAGES.includes(language)
    }),
  )
}

/**
 * Copies this project's inventory, its ancestors' manifests and the repo's
 * `.aislopignore` into `mirror`, at their repo-relative paths.
 *
 * A mirror rather than the repo itself is what makes the scan honest twice
 * over: aislop walks a directory and would otherwise read files discovery
 * excluded (a gitignored build output, a vendored tree), and it writes its
 * cache beside its cwd, which under the repo would be a footprint.
 *
 * @returns the error result when a file could not be copied, `undefined` on
 * success
 */
async function buildMirror(ctx: RunContext, mirror: string): Promise<ToolResult | undefined> {
  const ancestry = ancestryOf(ctx.project.path)
  const manifests = await Promise.all(
    ancestry.flatMap((directory) =>
      MIRRORED_MANIFESTS.map(async (name) => {
        const file = repoPath(directory, name)
        return (await exists(join(ctx.repoRoot, file))) ? file : undefined
      }),
    ),
  )
  const ignore = (await exists(join(ctx.repoRoot, AISLOP_IGNORE_FILE))) ? [AISLOP_IGNORE_FILE] : []
  // A manifest that is also in the inventory is copied once.
  const files = [
    ...new Set([
      ...ctx.project.files.all,
      ...manifests.filter((file) => file !== undefined),
      ...ignore,
    ]),
  ]

  const failures = await Promise.all(
    files.map(async (file) => {
      try {
        const target = join(mirror, file)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(join(ctx.repoRoot, file), target)
        return undefined
      } catch (error) {
        return `could not mirror ${file} for aislop: ${failureCode(error)}`
      }
    }),
  )
  const reason = failures.find((failure) => failure !== undefined)
  return reason === undefined ? undefined : { state: 'error', findings: [], rawFiles: [], reason }
}

/**
 * The errno code, not the message: Node quotes both absolute paths in a
 * `copyFile` failure, and no reason in `report.json` may name one. Every code
 * in the family reads the same way here: ENOENT, EACCES, EPERM and ENOTDIR
 * all mean this file did not reach the mirror.
 */
function failureCode(error: unknown): string {
  return asString(asRecord(error)?.['code']) ?? errorMessage(error)
}
