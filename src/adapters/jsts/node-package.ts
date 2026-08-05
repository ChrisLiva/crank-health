import { join } from 'node:path'
import type { Detection, RepoContext } from '../../core/types.ts'
import { asRecord, asString, exists, readJson } from '../support.ts'

/**
 * Spec §1's ownership test, in the one form every Node tool shares: a config
 * artifact at the repo root, or a declared dependency in `package.json`.
 * `package.json` scripts corroborate but never decide, so they are not read
 * here at all — and detection never spawns a process, so the installed version
 * comes off disk.
 */

/** Manifest fields a tool can be declared in. `scripts` is deliberately absent. */
const DEPENDENCY_FIELDS: readonly string[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

export interface NodeToolSpec {
  /** Repo-root-relative config artifacts that make the tool repo-owned. */
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
}

/**
 * @returns the {@link Detection} when the repo owns this tool, `null` otherwise
 */
export async function detectNodeTool(
  repo: RepoContext,
  spec: NodeToolSpec,
): Promise<Detection | null> {
  const manifest = asRecord(await readJson(join(repo.repoRoot, 'package.json')))

  const configFiles = spec.configFiles.filter((file) => repo.files.all.includes(file))
  const manifestKey = (spec.manifestKeys ?? []).some((key) => manifest?.[key] !== undefined)
  if (manifestKey && !configFiles.includes('package.json')) configFiles.push('package.json')

  const declared = DEPENDENCY_FIELDS.some(
    (field) => asRecord(manifest?.[field])?.[spec.packageName] !== undefined,
  )
  if (configFiles.length === 0 && !declared) return null

  const binPath = join(repo.repoRoot, 'node_modules', '.bin', spec.binName)
  const installed = await exists(binPath)
  const version = installed ? await installedVersion(repo.repoRoot, spec.packageName) : undefined

  return {
    reason:
      configFiles.length > 0 && declared
        ? 'config+dependency'
        : configFiles.length > 0
          ? 'config'
          : 'dependency',
    configFiles,
    installed,
    ...(installed ? { binPath } : {}),
    ...(version === undefined ? {} : { version }),
  }
}

/** Manifest fields that only a package with a published surface declares. */
const PUBLISHED_ENTRY_FIELDS: readonly string[] = ['exports', 'module', 'types']

/**
 * Whether the repo publishes a package rather than being an application.
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
export async function isLibraryPackage(repoRoot: string): Promise<boolean> {
  const manifest = asRecord(await readJson(join(repoRoot, 'package.json')))
  if (manifest === undefined) return false

  if (PUBLISHED_ENTRY_FIELDS.some((field) => manifest[field] !== undefined)) return true
  return manifest['main'] !== undefined && manifest['private'] !== true
}

/** The installed version, read from disk — detection never spawns a process. */
async function installedVersion(
  repoRoot: string,
  packageName: string,
): Promise<string | undefined> {
  const manifest = asRecord(
    await readJson(join(repoRoot, 'node_modules', ...packageName.split('/'), 'package.json')),
  )
  return asString(manifest?.['version'])
}
