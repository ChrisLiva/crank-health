import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execa } from 'execa'
import { mapLimit } from './pool.ts'
import type { FileInventory, Language } from './types.ts'

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
  const all = candidates.filter((_, index) => existing[index] === true)

  return {
    all,
    byLanguage: {
      'js-ts': all.filter((file) => languageOf(file) === 'js-ts'),
      python: all.filter((file) => languageOf(file) === 'python'),
    },
  }
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
