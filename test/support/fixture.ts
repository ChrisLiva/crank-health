import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

/**
 * Fixture repos are checked in as plain trees (a nested `.git` cannot live
 * inside this repo) and turned into real git repos here, because discovery is
 * `git ls-files`-based.
 *
 * The commit is byte-for-byte reproducible: fixed identity, fixed dates, no
 * signing, and no global git config in scope. That is what lets the golden
 * `report.json` snapshot contain a real commit sha.
 */

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** Frozen so the fixture commit sha never moves. */
const COMMIT_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'crank-health fixtures',
  GIT_AUTHOR_EMAIL: 'fixtures@crank-health.invalid',
  GIT_AUTHOR_DATE: '1704067200 +0000',
  GIT_COMMITTER_NAME: 'crank-health fixtures',
  GIT_COMMITTER_EMAIL: 'fixtures@crank-health.invalid',
  GIT_COMMITTER_DATE: '1704067200 +0000',
  // The developer's own git config must not leak into a fixture's identity.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

export interface FixtureRepo {
  /** Absolute path to the temporary repo. */
  readonly root: string
  /** The (deterministic) sha of the single commit. */
  readonly commit: string
  /** `git status --porcelain` output — empty means zero footprint. */
  status(): Promise<string>
  remove(): Promise<void>
}

/**
 * Copies `test/fixtures/<name>` into a temp dir and commits it.
 *
 * @param name fixture directory name, e.g. `js-basic`
 */
export async function createFixtureRepo(name: string): Promise<FixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), `crank-fixture-${name}-`))
  await cp(join(FIXTURES, name), root, { recursive: true })

  const git = (args: string[]) => execa('git', args, { cwd: root, env: COMMIT_IDENTITY })
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['add', '--all'])
  await git(['commit', '--quiet', '--no-gpg-sign', '--message', 'fixture'])
  const { stdout: commit } = await git(['rev-parse', 'HEAD'])

  return {
    root,
    commit: commit.trim(),
    status: async () => (await git(['status', '--porcelain'])).stdout,
    remove: () => rm(root, { recursive: true, force: true }),
  }
}
