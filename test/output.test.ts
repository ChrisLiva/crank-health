import {
  readFile,
  readdir,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliUsageError } from '../src/args.ts'
import { writeScratchRaw } from '../src/core/exec.ts'
import {
  BASE_RAW_DIRNAME,
  DEFAULT_OUTPUT_DIRNAME,
  REPO_RAW_DIRNAME,
  ROOT_RAW_DIRNAME,
  RUN_DIRNAME_PATTERN,
  createOutputDir,
  rawPrefix,
} from '../src/core/output.ts'
import { REPO_SCOPE } from '../src/core/types.ts'
import { createRunDirectory, resolveRepoRoot } from '../src/run.ts'

/** A project path, as every per-project run is filed. */
function projectPrefix(path: string): string {
  return rawPrefix(path, false)
}

/**
 * The `raw/` nesting is what keeps two runs of the same tool apart, so it has
 * one job: never hand two different things the same directory. The reserved
 * names are the interesting case — a repo is perfectly entitled to a package
 * called `root/`.
 */
describe('rawPrefix', () => {
  it('gives the reserved meanings their reserved directories', () => {
    expect(rawPrefix(REPO_SCOPE, true)).toBe(REPO_RAW_DIRNAME)
    expect(projectPrefix('.')).toBe(ROOT_RAW_DIRNAME)
  })

  it('keeps an ordinary project at its own path', () => {
    expect(projectPrefix('packages/api')).toBe('packages/api')
    expect(projectPrefix('rooted')).toBe('rooted')
    expect(projectPrefix('packages/root')).toBe('packages/root')
  })

  it('never collides a real project with a reserved directory', () => {
    const paths = ['.', 'root', 'repo', 'base', 'root_', 'repo_', 'root/nested', 'repo/nested']
    const prefixes = [rawPrefix(REPO_SCOPE, true), ...paths.map((path) => projectPrefix(path))]

    expect(new Set(prefixes).size).toBe(prefixes.length)
    // …and the escape is the documented one, not merely some unique string.
    expect(paths.map((path) => projectPrefix(path))).toEqual([
      ROOT_RAW_DIRNAME,
      'root_',
      'repo_',
      'base_',
      'root__',
      'repo__',
      'root_/nested',
      'repo_/nested',
    ])
  })

  /**
   * A `--pr` run nests the base scan's whole prefix tree under `raw/base/`, so
   * `base` is reserved like the others: a project at `base/root/` must not write
   * over the base scan's copy of the root project's evidence.
   */
  it('never collides a project with the --pr base scan’s tree', () => {
    const headSide = ['base', 'base/root', 'base/repo'].map((path) => projectPrefix(path))
    const baseSide = ['.', 'root', 'repo'].map(
      (path) => `${BASE_RAW_DIRNAME}/${projectPrefix(path)}`,
    )

    expect(new Set([...headSide, ...baseSide]).size).toBe(headSide.length + baseSide.length)
    expect(headSide).toEqual(['base_', 'base_/root', 'base_/repo'])
    expect(baseSide).toEqual(['base/root', 'base/root_', 'base/repo_'])
  })
})

describe('createOutputDir', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-output-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('defaults to a dated run dir under .codebase-health/, with a raw/ subdir', async () => {
    const out = await createOutputDir(repo)
    expect(dirname(out.root)).toBe(join(repo, DEFAULT_OUTPUT_DIRNAME))
    expect(basename(out.root)).toMatch(RUN_DIRNAME_PATTERN)
    expect(out.raw).toBe(join(out.root, 'raw'))
    expect((await stat(out.raw)).isDirectory()).toBe(true)
  })

  it('gives consecutive default runs their own directories', async () => {
    const first = await createOutputDir(repo)
    const second = await createOutputDir(repo)
    expect(second.root).not.toBe(first.root)
    expect(dirname(second.root)).toBe(dirname(first.root))
  })

  it('writes a .gitignore that hides every run directory', async () => {
    await createOutputDir(repo)
    expect(await readFile(join(repo, DEFAULT_OUTPUT_DIRNAME, '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('writes that marker into a fresh --out directory too', async () => {
    const out = await createOutputDir(repo, join(repo, 'fresh-out'))
    expect(await readFile(join(out.root, '.gitignore'), 'utf8')).toBe('*\n')
  })

  /**
   * `--out` can name a directory the user already keeps things in, and their
   * ignore rules are theirs. Replacing them with `*` is silent data loss — and
   * it is the run directory's own convenience, not a correctness requirement.
   */
  it('never overwrites a .gitignore that is already there', async () => {
    const target = join(repo, 'existing')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, '.gitignore'), 'node_modules\n*.log\n', 'utf8')

    await createOutputDir(repo, target)

    expect(await readFile(join(target, '.gitignore'), 'utf8')).toBe('node_modules\n*.log\n')
  })

  it('leaves git status clean in the target repo', async () => {
    const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    await execa('git', ['init', '--quiet'], { cwd: repo, env, extendEnv: true })

    const out = await createOutputDir(repo)
    await out.write('report.json', '{}\n')
    await out.writeRaw('oxlint.json', '[]\n')

    const { stdout } = await execa('git', ['status', '--porcelain'], {
      cwd: repo,
      env,
      extendEnv: true,
    })
    expect(stdout).toBe('')
  })

  it('respects an --out override, absolute or relative to the cwd', async () => {
    const absolute = join(repo, 'elsewhere', 'health')
    expect((await createOutputDir(repo, absolute)).root).toBe(absolute)

    // relative paths resolve against the cwd, not against the target repo
    const target = join(repo, 'relative-out')
    const out = await createOutputDir(repo, relative(process.cwd(), target))
    expect(out.root).toBe(target)
    expect((await stat(join(target, 'raw'))).isDirectory()).toBe(true)
  })

  it('writes artifacts and reports their absolute paths', async () => {
    const out = await createOutputDir(repo)
    const report = await out.write('report.md', '# health\n')
    const raw = await out.writeRaw('oxlint.stderr.txt', 'boom\n')

    expect(report).toBe(out.path('report.md'))
    expect(raw).toBe(join(out.raw, 'oxlint.stderr.txt'))
    expect(await readFile(report, 'utf8')).toBe('# health\n')
    expect(await readFile(raw, 'utf8')).toBe('boom\n')
  })

  it('overwrites a same-name artifact without leaving temp files behind', async () => {
    const out = await createOutputDir(repo)
    await out.write('report.json', '{"run":1}')
    await out.write('report.json', '{"run":2}')

    expect(await readFile(out.path('report.json'), 'utf8')).toBe('{"run":2}')
    expect((await readdir(out.root)).toSorted()).toEqual(['raw', 'report.json'])
  })

  it('reuses an existing --out directory, which names the run dir exactly', async () => {
    const target = join(repo, 'health-out')
    const first = await createOutputDir(repo, target)
    await first.writeRaw('keep.txt', 'kept\n')
    const second = await createOutputDir(repo, target)
    expect(await readFile(join(second.raw, 'keep.txt'), 'utf8')).toBe('kept\n')
  })

  it('refuses artifact names that would escape the run directory', async () => {
    const out = await createOutputDir(repo)
    const names = ['../escape.txt', '/etc/passwd', '', 'a/../../b.txt', 'nested/../x']
    await Promise.all(
      names.map(async (name) => {
        await expect(out.write(name, 'x')).rejects.toThrow(/unsafe output file name/)
        expect(() => out.path(name)).toThrow(/unsafe output file name/)
      }),
    )
  })

  it('allows a nested raw path', async () => {
    const out = await createOutputDir(repo)
    expect(out.path('raw/oxlint.json')).toBe(join(out.root, 'raw', 'oxlint.json'))
  })

  /**
   * Acceptance criterion 4 says a run leaves `git status --porcelain` empty.
   * `--out .` cannot: the artifacts land in the source tree and the marker
   * would have to claim the repo's own `.gitignore`. It is a typo, so it is a
   * usage error rather than a run that quietly does damage.
   */
  it('refuses an --out that is the repo itself', async () => {
    await expect(createRunDirectory(repo, repo)).rejects.toThrow(CliUsageError)
    // Including by a relative path — `--out .` from inside the repo.
    await expect(createRunDirectory(repo, relative(process.cwd(), repo))).rejects.toThrow(
      /is the repo itself/,
    )
    // Same directory, two spellings: the guard compares what the filesystem says.
    const linkDir = await mkdtemp(join(tmpdir(), 'crank-output-link-'))
    const link = join(linkDir, 'repo')
    await symlink(repo, link)
    try {
      await expect(createRunDirectory(await realpath(repo), link)).rejects.toThrow(CliUsageError)
      await expect(createRunDirectory(repo, await realpath(repo))).rejects.toThrow(CliUsageError)
    } finally {
      await rm(linkDir, { recursive: true, force: true })
    }
    expect(await readdir(repo)).toEqual([])
  })

  it('accepts a directory inside the repo, which is what the default is', async () => {
    const out = await createRunDirectory(repo, join(repo, DEFAULT_OUTPUT_DIRNAME))
    expect(out.root).toBe(join(repo, DEFAULT_OUTPUT_DIRNAME))
  })

  it('adopts raw output staged in the scratch dir before scratch is destroyed', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-scratch-'))
    const staged = await writeScratchRaw(scratch, 'oxlint.sarif.json', '{"runs":[]}\n')

    const out = await createOutputDir(repo)
    const adopted = await out.adoptRaw([staged])

    expect(adopted).toEqual(['raw/oxlint.sarif.json'])
    await rm(scratch, { recursive: true, force: true })
    expect(await readFile(join(out.raw, 'oxlint.sarif.json'), 'utf8')).toBe('{"runs":[]}\n')
  })
})

describe('resolveRepoRoot', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crank-resolve-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the physical path when the target is reached through a symlink', async () => {
    const real = join(dir, 'real')
    await mkdir(real)
    const link = join(dir, 'link')
    await symlink(real, link)
    expect(await resolveRepoRoot(link)).toBe(await realpath(real))
  })

  it('resolves a relative target against the cwd, then realpaths it', async () => {
    expect(await resolveRepoRoot(relative(process.cwd(), dir))).toBe(await realpath(dir))
  })

  it('rejects a nonexistent target', async () => {
    await expect(resolveRepoRoot(join(dir, 'nope'))).rejects.toThrow(
      `no such directory: ${join(dir, 'nope')}`,
    )
  })

  it('rejects a target that is a file', async () => {
    const file = join(dir, 'f.txt')
    await writeFile(file, '')
    await expect(resolveRepoRoot(file)).rejects.toThrow(`not a directory: ${file}`)
  })

  it('rejects a dangling symlink as a missing directory', async () => {
    const dangling = join(dir, 'dangling')
    await symlink(join(dir, 'gone'), dangling)
    await expect(resolveRepoRoot(dangling)).rejects.toThrow(`no such directory: ${dangling}`)
  })
})
