import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { mapLimit } from './pool.ts'
import type { DetectContext, FileInventory, Language, Project } from './types.ts'
import { LANGUAGES } from './types.ts'

/**
 * Path segments that are never scanned, even when the repo forgot to gitignore
 * them (spec §7: dependencies are never scanned). `git ls-files
 * --exclude-standard` already drops the gitignored ones; this is the defensive
 * second line, matched per path segment so `packages/a/node_modules/x` goes too.
 */
export const EXCLUDED_SEGMENTS: readonly string[] = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'virtualenv',
  '.tox',
  '.nox',
  '.eggs',
  'site-packages',
  '__pycache__',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
]

/** Extension → language. Lowercase, leading dot. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  '.js': 'js-ts',
  '.jsx': 'js-ts',
  '.mjs': 'js-ts',
  '.cjs': 'js-ts',
  '.ts': 'js-ts',
  '.tsx': 'js-ts',
  '.mts': 'js-ts',
  '.cts': 'js-ts',
  '.py': 'python',
  '.pyi': 'python',
}

/** How many files we stat/read at once. */
const FS_CONCURRENCY = 32

/**
 * The one file discovery per scan. Uses `git ls-files --cached --others
 * --exclude-standard`, so it is gitignore-true and includes untracked files
 * that are not ignored. Works in a repo with zero commits (nothing is cached
 * yet, `--others` still lists the working tree).
 *
 * Paths come back repo-relative, posix, de-duplicated and stable-sorted.
 * Entries `git` lists but the disk no longer has (deleted, not yet staged) are
 * dropped, as are directories (submodule gitlinks) and symlinks.
 *
 * @param repoRoot absolute path to the repo root
 * @throws {Error} when `git` is unavailable or `repoRoot` is not a work tree
 */
export async function discoverFiles(repoRoot: string): Promise<FileInventory> {
  const listed = await gitListFiles(repoRoot)

  const candidates = [...new Set(listed)]
    .filter((file) => file.length > 0 && !isExcluded(file))
    .toSorted(compareFiles)

  const existing = await mapLimit(candidates, FS_CONCURRENCY, (file) =>
    isRegularFile(repoRoot, file),
  )
  return inventoryOf(candidates.filter((_, index) => existing[index] === true))
}

/** Repo-relative posix path of the root project — its own identity, not a prefix. */
export const ROOT_PROJECT = '.'

const PACKAGE_JSON = 'package.json'
const PYPROJECT_TOML = 'pyproject.toml'
const PNPM_WORKSPACE = 'pnpm-workspace.yaml'

/** A manifest makes its directory a project candidate, and declares a language. */
const MANIFEST_LANGUAGE: Readonly<Record<string, Language>> = {
  [PACKAGE_JSON]: 'js-ts',
  [PYPROJECT_TOML]: 'python',
}

/** `[tool.uv.workspace]`, or any table under it. */
const UV_WORKSPACE_SECTION = /^\s*\[tool\.uv\.workspace[\].]/m

/** The repo root as a workspace shell: it holds no source files of its own. */
export interface RootShell {
  /**
   * Workspace declarations found at the root, repo-relative posix and
   * stable-sorted; empty when the layout is undeclared. They corroborate the
   * classification and nothing else — which projects exist is decided by the
   * file partition alone, so an unlisted or unbuilt package is never dropped.
   */
  readonly declaredBy: readonly string[]
}

export interface ProjectDiscovery {
  /** Stable-sorted by path, never empty. */
  readonly projects: readonly Project[]
  /** Present only when the root is a shell rather than a project. */
  readonly rootShell?: RootShell
}

/**
 * Partitions the inventory into projects, then reads the root's workspace
 * declarations when the root turned out to be a shell.
 *
 * @param repoRoot absolute path to the repo root
 * @param files the one inventory from {@link discoverFiles}
 */
export async function discoverProjects(
  repoRoot: string,
  files: FileInventory,
): Promise<ProjectDiscovery> {
  const projects = partitionProjects(files)
  if (projects.some((project) => project.path === ROOT_PROJECT)) return { projects }
  return { projects, rootShell: { declaredBy: await workspaceDeclarations(repoRoot, files) } }
}

/**
 * The project partition, from the inventory alone: every directory holding a
 * `package.json` or a `pyproject.toml` is a candidate (the root always is), and
 * each file goes to its nearest ancestor candidate — so every source file
 * belongs to exactly one candidate, and a nested package's files are the
 * nested package's, not its parent's.
 *
 * A candidate that keeps no source file of its own is a *shell*, not a project:
 * a workspace root whose packages claimed everything has nothing to grade, and
 * eight `not-assessed` categories would say less than its absence. Both
 * manifests in one directory make one project that owns both languages.
 *
 * The one exception keeps the contract that a scan always has a project: a repo
 * with no source files anywhere is the root project, holding the root's slice.
 */
export function partitionProjects(files: FileInventory): readonly Project[] {
  const manifests = manifestsByDirectory(files.all)
  const claimed = new Map<string, string[]>([...manifests.keys()].map((dir) => [dir, []]))
  for (const file of files.all) claimed.get(nearestCandidate(manifests, file))?.push(file)

  const projects = [...manifests.keys()]
    .toSorted(compareFiles)
    .map((dir) => projectOf(dir, manifests.get(dir) ?? [], claimed.get(dir) ?? []))
    .filter((project) => project.files.all.some((file) => languageOf(file) !== undefined))

  return projects.length > 0
    ? projects
    : [projectOf(ROOT_PROJECT, manifests.get(ROOT_PROJECT) ?? [], claimed.get(ROOT_PROJECT) ?? [])]
}

/**
 * The whole inventory taken as one project at the repo root — the unit a
 * repo-wide scan detects against.
 */
export function repoDetectContext(repoRoot: string, files: FileInventory): DetectContext {
  const manifests = files.all.filter(
    (file) => MANIFEST_LANGUAGE[baseName(file)] !== undefined && directoryOf(file) === ROOT_PROJECT,
  )
  return { repoRoot, project: projectOf(ROOT_PROJECT, manifests, files.all), files }
}

/**
 * A project's own directory followed by every ancestor of it up to the repo
 * root, nearest first — the chain detection walks for an inherited config, an
 * inherited dependency declaration, a hoisted install or an ancestor's
 * virtualenv. The root project's chain is itself alone.
 */
export function ancestryOf(projectPath: string): readonly string[] {
  const chain = [projectPath]
  let directory = projectPath
  while (directory !== ROOT_PROJECT) {
    directory = directoryOf(directory)
    chain.push(directory)
  }
  return chain
}

/** A repo-relative path inside a project directory; the root adds no segment. */
export function repoPath(directory: string, name: string): string {
  return directory === ROOT_PROJECT ? name : `${directory}/${name}`
}

/** Candidate directories → their manifests, repo-relative and stable-sorted. */
function manifestsByDirectory(files: readonly string[]): Map<string, readonly string[]> {
  const byDirectory = new Map<string, string[]>([[ROOT_PROJECT, []]])
  for (const file of files) {
    if (MANIFEST_LANGUAGE[baseName(file)] === undefined) continue
    const directory = directoryOf(file)
    const found = byDirectory.get(directory)
    if (found === undefined) byDirectory.set(directory, [file])
    else found.push(file)
  }
  return byDirectory
}

/** The candidate a file belongs to: the nearest one up its path, else the root. */
function nearestCandidate(candidates: ReadonlyMap<string, unknown>, file: string): string {
  let directory = directoryOf(file)
  while (directory !== ROOT_PROJECT && !candidates.has(directory)) {
    directory = directoryOf(directory)
  }
  return directory
}

function projectOf(path: string, manifests: readonly string[], files: readonly string[]): Project {
  const inventory = inventoryOf(files)
  const declared = new Set(manifests.map((manifest) => MANIFEST_LANGUAGE[baseName(manifest)]))
  return {
    path,
    manifests: manifests.toSorted(compareFiles),
    languages: LANGUAGES.filter(
      (language) => declared.has(language) || inventory.byLanguage[language].length > 0,
    ),
    files: inventory,
  }
}

/** The language subsets of a file list, computed the one way. */
function inventoryOf(files: readonly string[]): FileInventory {
  return {
    all: files,
    byLanguage: {
      'js-ts': files.filter((file) => languageOf(file) === 'js-ts'),
      python: files.filter((file) => languageOf(file) === 'python'),
    },
  }
}

/**
 * Workspace declarations at the root: npm/yarn/bun's `workspaces` field, a
 * `pnpm-workspace.yaml`, or `[tool.uv.workspace]`. Their globs are deliberately
 * not read — corroboration is all they are for, so the cheapest reliable check
 * for each is the right one.
 */
async function workspaceDeclarations(
  repoRoot: string,
  files: FileInventory,
): Promise<readonly string[]> {
  const found: string[] = []

  const manifest = await readText(repoRoot, PACKAGE_JSON)
  if (manifest !== undefined && hasField(manifest, 'workspaces')) found.push(PACKAGE_JSON)

  if (files.all.includes(PNPM_WORKSPACE)) found.push(PNPM_WORKSPACE)

  const pyproject = await readText(repoRoot, PYPROJECT_TOML)
  if (pyproject !== undefined && UV_WORKSPACE_SECTION.test(pyproject)) found.push(PYPROJECT_TOML)

  return found.toSorted(compareFiles)
}

/** Top-level key presence in a JSON document; unparseable input declares nothing. */
function hasField(json: string, field: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && field in parsed
  } catch {
    return false
  }
}

/** The directory a repo-relative path sits in — the parent, for a directory. */
function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? ROOT_PROJECT : path.slice(0, slash)
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The language a path belongs to, or `undefined` when we do not analyze it. */
export function languageOf(file: string): Language | undefined {
  const dot = file.lastIndexOf('.')
  if (dot <= 0) return undefined
  return LANGUAGE_BY_EXTENSION[file.slice(dot).toLowerCase()]
}

/** True when any path segment is on the hard exclusion list. */
export function isExcluded(file: string): boolean {
  return file.split('/').some((segment) => EXCLUDED_SEGMENTS.includes(segment))
}

/**
 * Total physical lines across `files` — the KLOC denominator for density
 * grades. "Physical" means every line as written, blanks and comments
 * included; the last line counts even without a trailing newline. Unreadable
 * or binary-ish files contribute 0 rather than failing the scan.
 */
export async function countPhysicalLines(
  repoRoot: string,
  files: readonly string[],
): Promise<number> {
  const counts = await mapLimit(files, FS_CONCURRENCY, async (file) => {
    const text = await readText(repoRoot, file)
    return text === undefined ? 0 : countLines(text)
  })
  return counts.reduce((total, count) => total + count, 0)
}

/** Physical line count of one blob of text. */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') lines++
  }
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * Reads the given files for anchor computation. Missing/unreadable files are
 * simply absent from the map — `computeAnchors` falls back to an empty anchor.
 */
export async function readSources(
  repoRoot: string,
  files: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(files)]
  const texts = await mapLimit(unique, FS_CONCURRENCY, (file) => readText(repoRoot, file))
  const sources = new Map<string, string>()
  unique.forEach((file, index) => {
    const text = texts[index]
    if (text !== undefined) sources.set(file, text)
  })
  return sources
}

/** Byte-wise ordering, not locale-aware: the sort must not vary by machine. */
function compareFiles(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

async function gitListFiles(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execa(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: repoRoot, stripFinalNewline: false },
    )
    return stdout.split('\0')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`git ls-files failed in ${repoRoot}: ${detail}`, { cause: error })
  }
}

async function isRegularFile(repoRoot: string, file: string): Promise<boolean> {
  try {
    return (await lstat(join(repoRoot, file))).isFile()
  } catch {
    return false
  }
}

async function readText(repoRoot: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(repoRoot, file), 'utf8')
  } catch {
    return undefined
  }
}
