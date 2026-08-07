import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'

/**
 * A controlled `PATH` for tests that drive real subprocesses: a temp directory
 * holding symlinks to the development binaries the suite needs by name — the
 * same set `scripts/capture-goldens.sh` farms for the golden toolchain — plus
 * any fake tools the test plants, and nothing else. `dotnet` (or anything not
 * passed in `extras`) does not resolve on the returned `PATH`, which is what
 * lets one machine act out "SDK missing", "SDK too old" and "SDK broken".
 */
const REQUIRED_BINARIES: readonly string[] = ['node', 'npm', 'npx', 'git']

/**
 * Builds the farm and returns the `PATH` value to run a subprocess under:
 * `<farm>:/usr/bin:/bin` — the farm first, then the base system where the
 * utilities a tool's own wrapper script calls live (`sh`, `cat`, `which`).
 *
 * @param extras fake executables to plant, name → script contents (a shebang
 * line and a body); each is written into the farm and marked executable
 */
export async function pathFarm(
  extras?: Readonly<Record<string, string>>,
): Promise<{ path: string; remove(): Promise<void> }> {
  const farm = await mkdtemp(join(tmpdir(), 'crank-path-farm-'))
  await Promise.all(
    REQUIRED_BINARIES.map(async (binary) => {
      const { stdout } = await execa('/bin/sh', ['-c', `command -v ${binary}`])
      await symlink(stdout.trim(), join(farm, binary))
    }),
  )
  await Promise.all(
    Object.entries(extras ?? {}).map(async ([name, script]) => {
      const file = join(farm, name)
      await writeFile(file, script.endsWith('\n') ? script : `${script}\n`, 'utf8')
      await chmod(file, 0o755)
    }),
  )
  return {
    path: `${farm}:/usr/bin:/bin`,
    remove: () => rm(farm, { recursive: true, force: true }),
  }
}
