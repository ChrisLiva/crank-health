import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'

/** Output dir when `--out` is not given (spec §9). */
export const DEFAULT_OUTPUT_DIRNAME = '.codebase-health'

/**
 * The run directory: `.codebase-health/` by default, always self-ignoring so a
 * scan leaves `git status --porcelain` clean (spec §7 and §9). The repo's own
 * `.gitignore` is never touched.
 */
export interface OutputDir {
  /** Absolute path to the run directory. */
  readonly root: string
  /** Absolute path to `raw/`, where per-tool output goes. */
  readonly raw: string
  /** Absolute path of a name inside the run directory. */
  path(name: string): string
  /** Writes a file in the run directory; returns its absolute path. */
  write(name: string, contents: string): Promise<string>
  /** Writes a file in `raw/`; returns its absolute path. */
  writeRaw(name: string, contents: string): Promise<string>
  /**
   * Moves raw tool output that a runner staged in the scratch dir into `raw/`.
   * Runners never learn where the run directory is — they hand back absolute
   * scratch paths and the pipeline adopts them before scratch is destroyed.
   *
   * @returns run-directory-relative posix paths, for `report.json`
   */
  adoptRaw(staged: readonly string[]): Promise<string[]>
}

/**
 * Creates (or reuses) the run directory and its `raw/` subdirectory, and drops
 * in the `.gitignore` containing `*` that hides the directory — including the
 * `.gitignore` itself — from the target repo.
 *
 * @param repoRoot absolute path to the target repo
 * @param out `--out` override; relative paths resolve against the cwd
 */
export async function createOutputDir(repoRoot: string, out?: string): Promise<OutputDir> {
  const root =
    out === undefined
      ? join(repoRoot, DEFAULT_OUTPUT_DIRNAME)
      : isAbsolute(out)
        ? out
        : resolve(out)
  const raw = join(root, 'raw')

  await mkdir(raw, { recursive: true })
  await writeAtomic(join(root, '.gitignore'), '*\n')

  return {
    root,
    raw,
    path: (name) => join(root, safeName(name)),
    write: async (name, contents) => writeAtomic(join(root, safeName(name)), contents),
    writeRaw: async (name, contents) => writeAtomic(join(raw, safeName(name)), contents),
    adoptRaw: async (staged) => {
      const adopted: string[] = []
      for (const source of staged) {
        const name = safeName(basename(source))
        // Sequential: a handful of small files, and unbounded fan-out here
        // would buy nothing but EMFILE risk.
        // eslint-disable-next-line no-await-in-loop
        await copyFile(source, join(raw, name))
        adopted.push(`raw/${name}`)
      }
      return adopted
    },
  }
}

/**
 * Write-then-rename, so a crash mid-write cannot leave a half-written artifact
 * that a later run or a reader would treat as complete.
 */
async function writeAtomic(target: string, contents: string): Promise<string> {
  const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return target
}

/**
 * Artifact names come from tool ids, so keep them inside the run directory:
 * no absolute paths, no `..`, no nesting beyond a plain name.
 *
 * @throws {Error} on a name that would escape the run directory
 */
function safeName(name: string): string {
  const invalid =
    name.length === 0 ||
    isAbsolute(name) ||
    name.includes('\\') ||
    name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  if (invalid) throw new Error(`unsafe output file name: "${name}"`)
  return name
}
