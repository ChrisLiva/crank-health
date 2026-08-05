import { execa } from 'execa'

/**
 * The commit a report is pinned to (spec §6: same version + same commit ⇒
 * byte-identical report).
 *
 * @returns the full HEAD sha, or `null` in a repo that has no commits yet
 * @throws {Error} when `repoRoot` is not a git work tree
 */
export async function headCommit(repoRoot: string): Promise<string | null> {
  const result = await execa('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, reject: false })
  if (result.exitCode === 0) return result.stdout.trim()

  // An unborn HEAD is a normal state (fresh `git init`), not an error; anything
  // else means this is not a work tree at all and the caller should hear it.
  const inWorkTree = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot,
    reject: false,
  })
  if (inWorkTree.exitCode === 0) return null
  throw new Error(`not a git repository: ${repoRoot}`)
}
