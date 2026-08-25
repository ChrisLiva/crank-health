import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { COMMIT_IDENTITY } from './fixture.ts'

/**
 * Scripted two-commit histories for the PR-delta tests.
 *
 * A delta fixture is a *history*, not a tree: what `--pr` reports depends on
 * what changed between two commits and on how git describes that change, so
 * these are built commit by commit rather than copied from `test/fixtures/`.
 * Base lands on `main`, head on a branch off it — exactly the shape a PR has,
 * and the shape `git merge-base main HEAD` was designed for.
 */

/** One edit in the head commit. */
type HistoryOp =
  | { readonly write: string; readonly content: string }
  /** `git mv`, so git's rename detection has a rename to detect. */
  | { readonly rename: string; readonly to: string }
  | { readonly remove: string }

export interface HistorySpec {
  /** The base commit's tree: repo-relative posix path → file contents. */
  readonly base: Readonly<Record<string, string>>
  /** Applied on the head branch, in order, then committed as one commit. */
  readonly head: readonly HistoryOp[]
}

export interface HistoryRepo {
  /** Absolute path to the temporary repo, with `main` branched and `pr` checked out. */
  readonly root: string
  readonly baseCommit: string
  readonly headCommit: string
  /** `git status --porcelain` — empty means zero footprint. */
  status(): Promise<string>
  /** Absolute paths of every registered worktree, main worktree first. */
  worktrees(): Promise<string[]>
  remove(): Promise<void>
}

/** Builds the two-commit history described by `spec`. */
export async function createHistoryRepo(spec: HistorySpec): Promise<HistoryRepo> {
  const root = await mkdtemp(join(tmpdir(), 'crank-history-'))
  const git = (args: string[]) => execa('git', args, { cwd: root, env: COMMIT_IDENTITY })

  await git(['init', '--quiet', '--initial-branch=main'])
  for (const [path, content] of Object.entries(spec.base)) {
    // Sequential: fixture trees are a handful of files and the order the base
    // commit is built in is the order it reads in.
    // eslint-disable-next-line no-await-in-loop
    await write(root, path, content)
  }
  await git(['add', '--all'])
  await git(['commit', '--quiet', '--no-gpg-sign', '--message', 'base'])
  const { stdout: baseCommit } = await git(['rev-parse', 'HEAD'])

  await git(['checkout', '--quiet', '-b', 'pr'])
  for (const op of spec.head) {
    // eslint-disable-next-line no-await-in-loop
    await apply(root, git, op)
  }
  await git(['add', '--all'])
  // `--allow-empty`: "a PR that changed nothing" is a case worth being able to
  // script, and git refuses an empty commit by default.
  await git(['commit', '--quiet', '--no-gpg-sign', '--allow-empty', '--message', 'head'])
  const { stdout: headCommit } = await git(['rev-parse', 'HEAD'])

  return {
    root,
    baseCommit: baseCommit.trim(),
    headCommit: headCommit.trim(),
    status: async () => (await git(['status', '--porcelain'])).stdout,
    worktrees: async () => {
      const { stdout } = await git(['worktree', 'list', '--porcelain'])
      return stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
    },
    remove: () => rm(root, { recursive: true, force: true }),
  }
}

type Git = (args: string[]) => Promise<unknown>

async function apply(root: string, git: Git, op: HistoryOp): Promise<void> {
  if ('write' in op) return write(root, op.write, op.content)
  if ('rename' in op) {
    await mkdir(dirname(join(root, op.to)), { recursive: true })
    await git(['mv', op.rename, op.to])
    return
  }
  await git(['rm', '--quiet', op.remove])
}

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

/**
 * A file of `count` lines, with `lines` overriding the ones it names (1-based).
 * Delta fixtures need findings a long way from the lines a diff touched, and
 * spelling out forty lines of padding in every one of them would hide the point.
 */
export function paddedFile(count: number, lines: Readonly<Record<number, string>>): string {
  return `${Array.from(
    { length: count },
    (_, index) => lines[index + 1] ?? `// padding line ${index + 1}`,
  ).join('\n')}\n`
}
