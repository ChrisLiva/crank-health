import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { expect } from 'vitest'

/**
 * The whole run directory, `raw/` included: the artifacts are not the only
 * thing a user hands to somebody else. Security scanners quote the line they
 * matched, so this is the assertion that keeps their raw output sanitized (see
 * `sanitizeRawResults`).
 *
 * Every language with a source-quoting scanner needs this sweep — bandit and
 * opengrep for Python and JS/TS, gosec for Go — so it lives here rather than
 * inside one suite, and the strings it hunts for come from the caller: a
 * fixture's planted credential *and* the bare vendor prefix it starts with,
 * because a scrub that left `AKIA…` truncated would still be a leak.
 *
 * @param secrets every string that must not appear anywhere under the run dir
 */
export async function expectNoSecretUnder(
  runDirectory: string,
  secrets: readonly string[],
): Promise<void> {
  const names = await readdir(runDirectory, { recursive: true })
  const files: string[] = []
  for (const name of names) {
    const path = join(runDirectory, name)
    // eslint-disable-next-line no-await-in-loop
    if ((await stat(path)).isFile()) files.push(path)
  }
  // A run that wrote nothing would pass this vacuously.
  expect(files.length).toBeGreaterThan(3)

  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const contents = await readFile(file, 'utf8')
    const where = relative(runDirectory, file)
    for (const secret of secrets) {
      expect(contents, `${where} carries the planted secret`).not.toContain(secret)
    }
  }
}
