import { join } from 'node:path'
import { ROOT_PROJECT, ancestryOf, directoryOf } from '../../core/discover.ts'
import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
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
  readJson,
  repoRelative,
  unavailable,
  underProject,
} from '../support.ts'
import { PACKAGE_JSON, detectNodeTool, isLibraryPackage } from './node-package.ts'

/**
 * knip — the dead-code cross-check (spec "Categories and tools": "fallow
 * dead-code + knip cross-check"). Two independent implementations of the same
 * question is the point: fallow is young and single-vendor, and a finding both
 * tools report is one a reader can act on without re-deriving it.
 *
 * **The "bundled default config" for knip is knip's own default.** Every other
 * default runner writes a config into the scratch dir, but knip resolves entry
 * points from `package.json` (`main`, `bin`, `exports`), from workspace
 * layouts, and from ~100 framework plugins keyed off the repo's dependencies. A
 * hand-written entry list would be strictly worse than that on every repo it
 * did not happen to match. Nothing leaks in from the target either: a repo that
 * *has* a knip config is repo-owned by definition, so the no-config path only
 * ever runs where there is no config to inherit.
 */

const KNIP_TOOL = 'knip'

/** npm package name; knip's command and package names coincide. */
const KNIP_PACKAGE = 'knip'

const KNIP_CONFIG_FILES: readonly string[] = [
  'knip.json',
  'knip.jsonc',
  'knip.ts',
  'knip.js',
  'knip.config.ts',
  'knip.config.js',
  'knip.config.mjs',
]

/**
 * Flags shared by every invocation.
 *
 * Zero footprint (spec §7): knip caches only under `--cache` and writes only
 * under `--fix`, so neither may ever appear. `--no-exit-code` keeps a repo full
 * of dead code from looking like a crashed tool, and `--no-config-hints` /
 * `--no-progress` keep advice and spinners out of the JSON.
 */
const BASE_ARGS: readonly string[] = [
  '--reporter',
  'json',
  '--no-config-hints',
  '--no-progress',
  '--no-exit-code',
]

export const knipRunner: ToolRunner = {
  tool: KNIP_TOOL,
  category: 'dead-code',
  pinnedVersion: pinnedVersion(KNIP_PACKAGE),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      configFiles: KNIP_CONFIG_FILES,
      packageName: KNIP_PACKAGE,
      binName: KNIP_TOOL,
      manifestKeys: ['knip'],
    }),
  run: runKnip,
}

async function runKnip(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no JavaScript or TypeScript files' }
  }

  const detection = ctx.detection
  const root = await knipRoot(ctx)
  if (root === undefined) {
    return unavailable(
      `no package.json in ${ctx.project.path === ROOT_PROJECT ? 'the repo root' : ctx.project.path} ` +
        'or above it, so knip has no entry points to resolve',
    )
  }

  const command =
    detection?.installed === true && detection.binPath !== undefined
      ? repoCommand(detection.binPath, [])
      : ephemeralCommand(KNIP_PACKAGE, [])

  const execution = await execTool(
    { ...command, args: [...command.args, ...BASE_ARGS] },
    { cwd: join(ctx.repoRoot, root), timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'knip.json', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'knip.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return failed(execution.failure, rawFiles)
  }
  if (execution.stdout.trim().length === 0) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `knip produced no output (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
    }
  }

  let issues: KnipIssues
  try {
    issues = relocate(parseKnipJson(execution.stdout), root)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse knip output: ${errorMessage(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  const isLibrary = await isLibraryPackage(ctx.repoRoot, ctx.project.path)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(issues, detection !== null, ctx.files.length, isLibrary).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(detection?.version === undefined
      ? { toolVersion: pinnedVersion(KNIP_PACKAGE) }
      : { toolVersion: detection.version }),
    rawFiles,
  }
}

/** A root `package.json` field, or a file beside one, that says "run knip here". */
const WORKSPACE_DECLARATIONS = { field: 'workspaces', file: 'pnpm-workspace.yaml' } as const

/**
 * Where knip runs for this project, repo-relative — its cwd is the one thing
 * that decides what knip analyzes, because knip resolves entry points from the
 * `package.json` *there* and never looks upward for one.
 *
 * A workspace is knip's own unit: run from the workspace root it resolves an
 * import across packages, run from a member it calls the imported file dead
 * (`mono-js`'s `cross.js` is the assertion). So the highest ancestor that
 * declares workspaces, or holds a knip config, wins over anything nearer. With
 * no such root the project's nearest `package.json` is the one that names its
 * entry points — a JS package under a Python root has no other. `undefined`
 * when no ancestor has a manifest at all: JS files without a `package.json`
 * are knip's `not-available`, not a crash to parse.
 */
async function knipRoot(ctx: RunContext): Promise<string | undefined> {
  const ancestry = ancestryOf(ctx.project.path)
  const manifests = await Promise.all(
    ancestry.map(async (directory) =>
      asRecord(await readJson(join(ctx.repoRoot, directory, PACKAGE_JSON))),
    ),
  )
  const workspaceFiles = await Promise.all(
    ancestry.map((directory) => exists(join(ctx.repoRoot, directory, WORKSPACE_DECLARATIONS.file))),
  )
  // Nearest-first chains: the last index is the highest ancestor.
  const configDirectories = new Set(
    (ctx.detection?.configFiles ?? []).map((file) => directoryOf(file)),
  )
  for (let depth = ancestry.length - 1; depth >= 0; depth -= 1) {
    const directory = ancestry[depth] ?? ROOT_PROJECT
    const declaresWorkspaces =
      manifests[depth]?.[WORKSPACE_DECLARATIONS.field] !== undefined ||
      workspaceFiles[depth] === true
    if (declaresWorkspaces || configDirectories.has(directory)) return directory
  }
  const nearest = manifests.findIndex((manifest) => manifest !== undefined)
  return nearest === -1 ? undefined : ancestry[nearest]
}

/** knip reports paths relative to where it ran; everything downstream is repo-relative. */
function relocate(issues: KnipIssues, root: string): KnipIssues {
  if (root === ROOT_PROJECT) return issues
  return {
    unusedFiles: issues.unusedFiles.map((file) => underProject(root, file)),
    unusedExports: issues.unusedExports.map((symbol) => ({
      ...symbol,
      file: underProject(root, symbol.file),
    })),
    unusedDependencies: issues.unusedDependencies.map((dependency) => ({
      ...dependency,
      file: underProject(root, dependency.file),
    })),
  }
}

/** The three issue kinds we report, flattened out of knip's per-file records. */
export interface KnipIssues {
  readonly unusedFiles: readonly string[]
  readonly unusedExports: readonly KnipSymbol[]
  readonly unusedDependencies: readonly KnipDependency[]
}

interface KnipSymbol {
  readonly file: string
  readonly name: string
  readonly line: number
  readonly column: number
  /** `exports`, `types`, `enumMembers`, … — knip's own issue-type name. */
  readonly kind: string
}

interface KnipDependency {
  readonly file: string
  readonly name: string
  /** `dependencies`, `devDependencies`, `optionalPeerDependencies`. */
  readonly kind: string
}

/** Issue types that name an unused export-like symbol. */
const EXPORT_KINDS: readonly string[] = ['exports', 'types', 'enumMembers', 'namespaceMembers']

/** Issue types that name a declared-but-unused package. */
const DEPENDENCY_KINDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
]

/**
 * Parses knip's `--reporter json` output. Exported so a format shift fails a
 * test instead of corrupting a report (plan M4 checks).
 *
 * @throws {Error} when the payload is not knip's `issues` envelope
 */
export function parseKnipJson(stdout: string): KnipIssues {
  const issues = asArray(asRecord(JSON.parse(stdout))?.['issues'])
  if (issues === undefined) throw new Error('no issues array in knip output')

  const unusedFiles: string[] = []
  const unusedExports: KnipSymbol[] = []
  const unusedDependencies: KnipDependency[] = []

  for (const entry of issues) {
    const record = asRecord(entry)
    const file = asString(record?.['file'])
    if (record === undefined || file === undefined) continue
    const path = repoRelative(file)

    for (const raw of asArray(record['files']) ?? []) {
      const name = asString(asRecord(raw)?.['name']) ?? asString(raw)
      if (name !== undefined) unusedFiles.push(repoRelative(name))
    }
    for (const kind of EXPORT_KINDS) {
      for (const raw of asArray(record[kind]) ?? []) {
        const symbol = asRecord(raw)
        const name = asString(symbol?.['name'])
        if (name === undefined) continue
        unusedExports.push({
          file: path,
          name,
          line: asNumber(symbol?.['line']) ?? 1,
          column: asNumber(symbol?.['col']) ?? 1,
          kind,
        })
      }
    }
    for (const kind of DEPENDENCY_KINDS) {
      for (const raw of asArray(record[kind]) ?? []) {
        const name = asString(asRecord(raw)?.['name']) ?? asString(raw)
        if (name !== undefined) unusedDependencies.push({ file: path, name, kind })
      }
    }
  }

  return {
    unusedFiles: unusedFiles.toSorted(),
    unusedExports,
    unusedDependencies,
  }
}

/**
 * knip issues → the core's vocabulary, with spec §3's "high-confidence only"
 * rule applied through `gradeScope`.
 *
 * knip has no confidence score of its own, so confidence is read off the issue
 * type and the shape of the result:
 *
 * - **unused exports** (and types, enum and namespace members) are high
 *   confidence — the module graph resolved and nothing imports them — and are
 *   graded as `warning`. On a library they are reported but not graded: the
 *   consumers that use a published API are outside the repo, so "nothing here
 *   imports it" is not evidence the export is dead. A library that owns a knip
 *   config has already told knip which exports count, so it is graded again.
 * - **unused files** are graded as `warning` *unless* knip found every analyzed
 *   file unused, which means it never resolved an entry point at all. A library
 *   with no `main` would otherwise grade F for having no `main`.
 * - **unused dependencies** are `info` and never graded: they are dependency
 *   hygiene rather than dead code, and without the framework plugins that need
 *   a real `node_modules` their false-positive rate is high.
 */
export function toPendingFindings(
  issues: KnipIssues,
  repoConfig: boolean,
  analyzedFileCount: number,
  isLibrary: boolean,
): PendingFinding[] {
  const provenance = repoConfig ? ('repo-config' as const) : ('default-config' as const)
  const foundEntryPoint = analyzedFileCount > 0 && issues.unusedFiles.length < analyzedFileCount

  const files = issues.unusedFiles.map((file) => ({
    category: 'dead-code' as const,
    tool: KNIP_TOOL,
    rule: 'knip/unused-file',
    severity: 'warning' as const,
    file,
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    message: foundEntryPoint
      ? 'File is never imported from any entry point'
      : 'File is never imported (advisory: knip resolved no entry point in this repo)',
    provenance,
    gradeScope: foundEntryPoint,
    anchor: '',
  }))

  const exports = issues.unusedExports.map((symbol) => ({
    category: 'dead-code' as const,
    tool: KNIP_TOOL,
    rule: `knip/unused-${symbol.kind}`,
    severity: 'warning' as const,
    file: symbol.file,
    range: {
      startLine: symbol.line,
      startCol: symbol.column,
      endLine: symbol.line,
      endCol: symbol.column,
    },
    message: `Export \`${symbol.name}\` is never used`,
    provenance,
    gradeScope: repoConfig || !isLibrary,
    anchor: symbol.name,
  }))

  const dependencies = issues.unusedDependencies.map((dependency) => ({
    category: 'dead-code' as const,
    tool: KNIP_TOOL,
    rule: `knip/unused-${dependency.kind}`,
    severity: 'info' as const,
    file: dependency.file,
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    message: `Dependency \`${dependency.name}\` is declared but never imported`,
    provenance,
    gradeScope: false,
    anchor: dependency.name,
  }))

  return [...files, ...exports, ...dependencies].toSorted(byLocation)
}
