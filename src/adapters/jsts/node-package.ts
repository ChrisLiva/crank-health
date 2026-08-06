import { join } from 'node:path'
import { ROOT_PROJECT, ancestryOf, repoPath } from '../../core/discover.ts'
import type { DetectContext, Detection } from '../../core/types.ts'
import { asRecord, asString, exists, readJson } from '../support.ts'

/**
 * Spec §1's ownership test, in the one form every Node tool shares: a config
 * artifact, or a declared dependency in a `package.json`. `package.json`
 * scripts corroborate but never decide, so they are not read here at all — and
 * detection never spawns a process, so the installed version comes off disk.
 *
 * **Ancestors count.** Node itself resolves upward: a package inside a
 * workspace runs the tool its root declared, out of the `node_modules/.bin` npm
 * hoisted it to, under the config file sitting above it. So every check here
 * walks the project's directory and then its ancestors, nearest first, and the
 * nearest answer wins. The exception is a config the tool does *not* resolve
 * upward — {@link NodeToolSpec.configInherits}.
 */

/** The manifest that declares a Node project's dependencies and its config blocks. */
const PACKAGE_JSON = 'package.json'

/** Manifest fields a tool can be declared in. `scripts` is deliberately absent. */
const DEPENDENCY_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

export interface NodeToolSpec {
  /** Config artifacts that make the tool repo-owned, relative to a project dir. */
  readonly configFiles: readonly string[]
  /** npm package name, e.g. `@biomejs/biome`. */
  readonly packageName: string
  /** The `node_modules/.bin` entry, e.g. `biome`. */
  readonly binName: string
  /**
   * `package.json` keys that are themselves a config artifact — prettier's
   * `"prettier"` block being the canonical case.
   */
  readonly manifestKeys?: readonly string[]
  /**
   * Whether a config artifact in an ancestor directory configures this project
   * too. Default `true`: ESLint, prettier, Biome and the rest all resolve their
   * config upward from the file they are checking.
   *
   * `false` is for the config that does not — `tsconfig.json` is TypeScript's
   * project definition, not an inherited setting, so a package without one is
   * not covered by the root's and gets crank-health's bundled default scoped to
   * its own files. Dependency inheritance is unaffected either way: the
   * hoisted TypeScript is still the compiler that runs.
   */
  readonly configInherits?: boolean
}

/**
 * @returns the {@link Detection} when the repo owns this tool, `null` otherwise
 */
export async function detectNodeTool(
  ctx: DetectContext,
  spec: NodeToolSpec,
): Promise<Detection | null> {
  const ancestry = ancestryOf(ctx.project.path)
  const manifests = await Promise.all(
    ancestry.map(async (directory) =>
      asRecord(await readJson(join(ctx.repoRoot, directory, PACKAGE_JSON))),
    ),
  )
  const present = new Set(ctx.files.all)

  const configFiles = ancestry
    .slice(0, spec.configInherits === false ? 1 : ancestry.length)
    .flatMap((directory, depth) => configArtifacts(directory, manifests[depth], spec, present))

  const declared = manifests.some((manifest) =>
    DEPENDENCY_FIELDS.some(
      (field) => asRecord(manifest?.[field])?.[spec.packageName] !== undefined,
    ),
  )
  if (configFiles.length === 0 && !declared) return null

  const depth = await nearestInstall(ctx.repoRoot, ancestry, spec.binName)
  const installedIn = depth === undefined ? undefined : (ancestry[depth] ?? undefined)
  const binPath =
    installedIn === undefined ? undefined : binaryPath(ctx.repoRoot, installedIn, spec.binName)
  const version =
    depth === undefined
      ? undefined
      : await installedVersion(ctx.repoRoot, ancestry.slice(depth), spec)

  return {
    reason:
      configFiles.length > 0 && declared
        ? 'config+dependency'
        : configFiles.length > 0
          ? 'config'
          : 'dependency',
    configFiles,
    installed: binPath !== undefined,
    ...(binPath === undefined ? {} : { binPath }),
    ...(version === undefined ? {} : { version }),
  }
}

/** This directory's config artifacts, including a config block in its manifest. */
function configArtifacts(
  directory: string,
  manifest: Record<string, unknown> | undefined,
  spec: NodeToolSpec,
  present: ReadonlySet<string>,
): string[] {
  const found = spec.configFiles
    .map((file) => repoPath(directory, file))
    .filter((file) => present.has(file))

  const manifestPath = repoPath(directory, PACKAGE_JSON)
  const configBlock = (spec.manifestKeys ?? []).some((key) => manifest?.[key] !== undefined)
  if (configBlock && !found.includes(manifestPath)) found.push(manifestPath)
  return found
}

/** How far up the chain the nearest `node_modules/.bin` entry is, if any. */
async function nearestInstall(
  repoRoot: string,
  ancestry: readonly string[],
  binName: string,
): Promise<number | undefined> {
  const installed = await Promise.all(
    ancestry.map((directory) => exists(binaryPath(repoRoot, directory, binName))),
  )
  const depth = installed.indexOf(true)
  return depth === -1 ? undefined : depth
}

function binaryPath(repoRoot: string, directory: string, binName: string): string {
  return join(repoRoot, directory, 'node_modules', '.bin', binName)
}

/**
 * The installed version, read from disk — detection never spawns a process.
 * The binary can be a hoisted install's shim, so the package it came from is
 * looked for from the directory that has the binary upward.
 */
async function installedVersion(
  repoRoot: string,
  ancestry: readonly string[],
  spec: NodeToolSpec,
): Promise<string | undefined> {
  const manifests = await Promise.all(
    ancestry.map((directory) =>
      readJson(
        join(repoRoot, directory, 'node_modules', ...spec.packageName.split('/'), PACKAGE_JSON),
      ),
    ),
  )
  return manifests
    .map((manifest) => asString(asRecord(manifest)?.['version']))
    .find((version) => version !== undefined)
}

/** Manifest fields that only a package with a published surface declares. */
const PUBLISHED_ENTRY_FIELDS: readonly string[] = ['exports', 'module', 'types']

/**
 * Whether this project publishes a package rather than being an application.
 * The question is its own manifest's, never an ancestor's: a workspace root
 * publishing a package says nothing about the app in `apps/web`.
 *
 * Tools that call dead code "dead" are wrong about a library: its exports are
 * the product, consumed from outside the repo. The test is field *presence*,
 * never truthiness (`"exports": {}` still declares a surface), and never the
 * `"type"` field — `"type": "module"` says how files are parsed, not that
 * anything is published.
 *
 * `private: true` vetoes a bare `main` (an app's entry point) but cannot veto
 * `exports`/`module`/`types`: packages published from a private manifest by a
 * release pipeline are common, zustand being the canonical case.
 */
export async function isLibraryPackage(
  repoRoot: string,
  projectPath = ROOT_PROJECT,
): Promise<boolean> {
  const manifest = asRecord(await readJson(join(repoRoot, projectPath, PACKAGE_JSON)))
  if (manifest === undefined) return false

  if (PUBLISHED_ENTRY_FIELDS.some((field) => manifest[field] !== undefined)) return true
  return manifest['main'] !== undefined && manifest['private'] !== true
}
