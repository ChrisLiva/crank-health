import { execa } from 'execa'

/**
 * The git seam. Every git invocation crank-health makes lives here, so the
 * commands, their flags and the parsing of their output are reviewable in one
 * place — and the parsers ({@link parseNameStatus}, {@link parseTouchedLines})
 * are pure functions the tests can drive without a repo.
 */

/**
 * The commit a report is pinned to (spec §6: same version + same commit ⇒
 * byte-identical report).
 *
 * @returns the full HEAD sha, or `null` in a repo that has no commits yet
 * @throws {Error} when `repoRoot` is not a git work tree
 */
export async function headCommit(repoRoot: string): Promise<string | null> {
  const result = await git(repoRoot, ['rev-parse', 'HEAD'])
  if (result.exitCode === 0) return result.stdout.trim()

  // An unborn HEAD is a normal state (fresh `git init`), not an error; anything
  // else means this is not a work tree at all and the caller should hear it.
  const inWorkTree = await git(repoRoot, ['rev-parse', '--is-inside-work-tree'])
  if (inWorkTree.exitCode === 0) return null
  throw new Error(`not a git repository: ${repoRoot}`)
}

/**
 * Resolves a user-supplied ref (`main`, `origin/main`, a sha, a tag) to the
 * commit it names.
 *
 * `^{commit}` peels annotated tags, so `--pr v1.2.0` resolves to the commit the
 * tag points at rather than to the tag object.
 *
 * @returns the full sha, or `null` when the ref does not exist here
 */
export async function resolveCommit(repoRoot: string, ref: string): Promise<string | null> {
  const result = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null
}

/**
 * The merge-base of `base` and HEAD — the commit a PR branched from, and the
 * only honest "before" for a delta. Comparing against the tip of `base` would
 * report every change that landed on the base branch since as if this PR had
 * made it.
 *
 * @returns the full sha, or `null` when the two histories are unrelated
 */
export async function mergeBase(repoRoot: string, base: string): Promise<string | null> {
  const result = await git(repoRoot, ['merge-base', base, 'HEAD'])
  return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null
}

/** What the PR diff says about where the changes are (spec §4). */
export interface DiffFacts {
  /**
   * Renamed files, base path → head path. Applied to base findings before
   * fingerprints are compared, so a moved file does not read as "everything in
   * it was resolved, and everything in it is new".
   */
  readonly renames: ReadonlyMap<string, string>
  /**
   * Head-side line numbers this diff added or modified, per head path. A new
   * finding sitting on one of these is *directly actionable*: this change put
   * it there. Findings elsewhere are still new — a non-local regression is a
   * regression — but they are not what the author was typing.
   */
  readonly touchedLines: ReadonlyMap<string, ReadonlySet<number>>
  /** Every path the diff mentions, head-side where there is one. Stable-sorted. */
  readonly changedFiles: readonly string[]
}

/**
 * Reads {@link DiffFacts} for `from..to` in two git invocations.
 *
 * `to` is a commit, not the working tree: a PR is what has been committed, and
 * `git diff <mergeBase> HEAD` is the diff a reviewer sees. Uncommitted changes
 * are still *scanned* — the head scan reads the working tree as-is — they just
 * do not count as touched lines or contribute rename mappings.
 */
export async function readDiffFacts(
  repoRoot: string,
  from: string,
  to = 'HEAD',
): Promise<DiffFacts> {
  const status = await git(repoRoot, [
    'diff',
    '--find-renames',
    '--name-status',
    '-z',
    '--no-ext-diff',
    from,
    to,
  ])
  if (status.exitCode !== 0) {
    throw new Error(`git diff --name-status ${from} ${to} failed: ${firstLine(status.stderr)}`)
  }

  const patch = await git(repoRoot, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--find-renames',
    '--unified=0',
    '--no-prefix',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    from,
    to,
  ])
  if (patch.exitCode !== 0) {
    throw new Error(`git diff --unified=0 ${from} ${to} failed: ${firstLine(patch.stderr)}`)
  }

  const { renames, changedFiles } = parseNameStatus(status.stdout)
  return { renames, changedFiles, touchedLines: parseTouchedLines(patch.stdout) }
}

/** Rename map and changed-file list from `git diff --name-status -z` output. */
export function parseNameStatus(stdout: string): {
  readonly renames: ReadonlyMap<string, string>
  readonly changedFiles: readonly string[]
} {
  const fields = stdout.split('\0').filter((field) => field.length > 0)
  const renames = new Map<string, string>()
  const changed = new Set<string>()

  for (let index = 0; index < fields.length; index++) {
    const status = fields[index] ?? ''
    // R### and C### carry two paths (source, destination); everything else one.
    if (/^[RC]\d*$/.test(status)) {
      const from = fields[index + 1]
      const to = fields[index + 2]
      index += 2
      if (from === undefined || to === undefined) continue
      if (status.startsWith('R')) renames.set(from, to)
      changed.add(to)
      continue
    }
    const path = fields[index + 1]
    index += 1
    if (path !== undefined) changed.add(path)
  }

  return { renames, changedFiles: [...changed].toSorted(compare) }
}

/**
 * Head-side added/modified line numbers per file, from a `--unified=0
 * --no-prefix` patch.
 *
 * Only the `+++` header and the hunk headers are read: `@@ -a,b +c,d @@` means
 * `d` head lines starting at `c` (`d` defaults to 1, and `d === 0` is a pure
 * deletion, which touches no head line). `--no-prefix` is what makes the `+++`
 * path the path, with no `b/` to strip off a file that might itself be called
 * `b/…`; `core.quotePath=false` keeps non-ASCII paths unescaped.
 */
export function parseTouchedLines(patch: string): ReadonlyMap<string, ReadonlySet<number>> {
  const touched = new Map<string, Set<number>>()
  let file: string | undefined

  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim()
      // A deletion has no head side, so nothing after it can be touched.
      file = path === '/dev/null' ? undefined : unquotePath(path)
      continue
    }
    if (file === undefined || !line.startsWith('@@')) continue

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk === null) continue
    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue

    const lines = touched.get(file) ?? new Set<number>()
    for (let offset = 0; offset < count; offset++) lines.add(start + offset)
    touched.set(file, lines)
  }

  return touched
}

/**
 * Git quotes a path with unusual characters in C style. `core.quotePath=false`
 * covers the common case (non-ASCII), and this covers the rest well enough that
 * a path with a quote or a tab in it maps to the right file rather than to a
 * literal backslash sequence.
 */
function unquotePath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path
  try {
    return JSON.parse(path) as string
  } catch {
    return path.slice(1, -1)
  }
}

/**
 * Checks `commit` out into its own detached worktree under `path`, so the base
 * scan reads a real tree with a real `.git` and discovery works there unchanged.
 *
 * The worktree lives in crank-health's scratch directory, never in the target
 * repo; the only trace inside the repo is bookkeeping under `.git/worktrees/`,
 * which `git status` does not report and {@link removeWorktree} deletes.
 *
 * @throws {Error} when git refuses to create it
 */
export async function addWorktree(repoRoot: string, path: string, commit: string): Promise<void> {
  const result = await git(repoRoot, ['worktree', 'add', '--detach', '--quiet', path, commit])
  if (result.exitCode !== 0) {
    throw new Error(`could not create a worktree for ${commit}: ${firstLine(result.stderr)}`)
  }
}

/**
 * Removes a worktree and its bookkeeping. Never throws: this runs in a
 * `finally`, and an error here would replace whatever really went wrong.
 *
 * `--force` because a tool may have left a file behind, and `prune` because a
 * worktree whose directory is already gone (a killed run, a cleaned tmpdir)
 * leaves a stale entry that would otherwise accumulate in the target repo.
 */
export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', path])
  await git(repoRoot, ['worktree', 'prune'])
}

function git(repoRoot: string, args: readonly string[]) {
  return execa('git', [...args], { cwd: repoRoot, reject: false })
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? 'no output'
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
