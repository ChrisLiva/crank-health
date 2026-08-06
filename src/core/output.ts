import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { ROOT_PROJECT } from './discover.ts'

/** Output dir when `--out` is not given (spec §9). */
export const DEFAULT_OUTPUT_DIRNAME = '.codebase-health'

/** Where a repo-scoped run's evidence lands under `raw/`. */
export const REPO_RAW_DIRNAME = 'repo'

/** …and the root project's, whose path `.` is not a directory name. */
export const ROOT_RAW_DIRNAME = 'root'

/**
 * A first path segment the reserved names would collide with: `root` and `repo`
 * themselves, and the escapes of them ({@link rawPrefix}).
 */
const RESERVED_SEGMENT = /^(?:root|repo)_*$/

/**
 * The `raw/` subdirectory one run's evidence belongs in: the project's own
 * repo-relative posix path, with two reserved names — `repo/` for a run that
 * answered about the repo and `root/` for the root project. The nesting is what
 * keeps the same tool's output in two projects apart, since every runner names
 * its raw files after itself.
 *
 * A repo may of course contain a package directory called `root/` or `repo/`,
 * and it must not land in the reserved one — two runs writing the same file is
 * evidence one of them silently loses, and a tool that reads its report back out
 * of the run directory would read the other's (jscpd runs both per project and
 * once over the repo, under one file name). Such a first segment therefore gains
 * a trailing `_`, and so does one that already ends in `_`s: `root` → `root_`,
 * `root_` → `root__`. Doubling is what keeps the escape injective, so no two
 * projects can ever be handed the same directory.
 *
 * @param project a project path, or {@link import('./types.ts').REPO_SCOPE}
 * @param repoWide whether this run spanned the repo. Not derivable from
 * `project`: `REPO_SCOPE` is `repo`, which is also a directory name a
 * package may have, and only the caller knows which of the two it holds.
 */
export function rawPrefix(project: string, repoWide: boolean): string {
  if (repoWide) return REPO_RAW_DIRNAME
  if (project === ROOT_PROJECT) return ROOT_RAW_DIRNAME
  const segments = project.split('/')
  const first = segments[0] ?? project
  return RESERVED_SEGMENT.test(first) ? [`${first}_`, ...segments.slice(1)].join('/') : project
}

/** What a default run directory is named: local date plus a 4-hex run id. */
export const RUN_DIRNAME_PATTERN = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/

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
   * @param prefix subdirectory of `raw/` to land in. PR mode puts the base
   * scan's evidence under `base/`, because the two scans run the same tools and
   * `raw/oxlint.sarif.json` would otherwise mean whichever wrote it last.
   * @returns run-directory-relative posix paths, for `report.json`
   */
  adoptRaw(staged: readonly string[], prefix?: string): Promise<string[]>
}

/**
 * Creates (or reuses) the run directory and its `raw/` subdirectory, and drops
 * in the `.gitignore` containing `*` that hides the directory — including the
 * `.gitignore` itself — from the target repo.
 *
 * **The marker never overwrites an existing `.gitignore`** ({@link writeMarker}).
 * `--out` can name a directory the user already keeps files in, and replacing
 * their ignore rules with `*` is data loss — silent, and exactly the kind a
 * tool that promises zero footprint must not commit. The cost is that a
 * pre-existing `.gitignore` which does not ignore its own directory leaves the
 * run's artifacts visible to `git status`; that is the user's file and their
 * choice of `--out`, and preserving it is the correct priority. The default run
 * directory is unaffected: it is crank-health's own, and the marker lands the
 * first time it is created.
 *
 * **Default runs keep their history.** Without `--out`, each run gets its own
 * directory under `.codebase-health/`, named `YYYY-MM-DD-xxxx` (local date
 * plus a 4-hex-char run id), so consecutive runs coexist instead of the new
 * report overwriting the last one. The self-ignoring marker lives once at
 * `.codebase-health/.gitignore` and covers every run under it. `--out` keeps
 * its exact meaning: the named directory IS the run directory, because a user
 * who names a destination gets that destination.
 *
 * @param repoRoot absolute path to the target repo
 * @param out `--out` override; relative paths resolve against the cwd
 */
export async function createOutputDir(repoRoot: string, out?: string): Promise<OutputDir> {
  const root =
    out === undefined
      ? await createRunRoot(join(repoRoot, DEFAULT_OUTPUT_DIRNAME))
      : isAbsolute(out)
        ? out
        : resolve(out)
  const raw = join(root, 'raw')

  await mkdir(raw, { recursive: true })
  if (out !== undefined) await writeMarker(join(root, '.gitignore'))

  return {
    root,
    raw,
    path: (name) => join(root, safeName(name)),
    write: async (name, contents) => writeAtomic(join(root, safeName(name)), contents),
    writeRaw: async (name, contents) => writeAtomic(join(raw, safeName(name)), contents),
    adoptRaw: async (staged, prefix) => {
      if (staged.length === 0) return []
      const directory = prefix === undefined ? raw : join(raw, safeName(prefix))
      const relative = prefix === undefined ? 'raw' : `raw/${safeName(prefix)}`
      await mkdir(directory, { recursive: true })

      const adopted: string[] = []
      for (const source of staged) {
        const name = safeName(basename(source))
        // Sequential: a handful of small files, and unbounded fan-out here
        // would buy nothing but EMFILE risk.
        // eslint-disable-next-line no-await-in-loop
        await copyFile(source, join(directory, name))
        adopted.push(`${relative}/${name}`)
      }
      return adopted
    },
  }
}

/**
 * Creates this run's directory under the default parent: marker at the parent,
 * then an exclusive `mkdir` of `<date>-<id>` — `EEXIST` means another run won
 * the name this instant, so try another id rather than share a directory.
 */
async function createRunRoot(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true })
  await writeMarker(join(parent, '.gitignore'))
  for (;;) {
    const root = join(parent, `${localDate()}-${randomUUID().slice(0, 4)}`)
    try {
      // eslint-disable-next-line no-await-in-loop
      await mkdir(root)
      return root
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** The run's calendar date as the user's wall clock shows it. */
function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function pad(part: number): string {
  return String(part).padStart(2, '0')
}

/**
 * Writes the self-ignoring marker, and only when there is no `.gitignore` there
 * already — `wx` is the check and the write in one, so two concurrent runs
 * cannot both decide the file is missing. See {@link createOutputDir}.
 */
async function writeMarker(target: string): Promise<void> {
  try {
    await writeFile(target, '*\n', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
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
