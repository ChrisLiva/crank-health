import { readFile, readdir, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliUsageError } from '../src/args.ts'
import { writeScratchRaw } from '../src/core/exec.ts'
import { DEFAULT_OUTPUT_DIRNAME, createOutputDir } from '../src/core/output.ts'
import { createRunDirectory } from '../src/run.ts'

describe('createOutputDir', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-output-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('defaults to .codebase-health/ inside the repo, with a raw/ subdir', async () => {
    const out = await createOutputDir(repo)
    expect(out.root).toBe(join(repo, DEFAULT_OUTPUT_DIRNAME))
    expect(out.raw).toBe(join(repo, DEFAULT_OUTPUT_DIRNAME, 'raw'))
    expect((await stat(out.raw)).isDirectory()).toBe(true)
  })

  it('writes a .gitignore that hides the whole run directory', async () => {
    const out = await createOutputDir(repo)
    expect(await readFile(join(out.root, '.gitignore'), 'utf8')).toBe('*\n')
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

  it('overwrites a previous run without leaving temp files behind', async () => {
    const out = await createOutputDir(repo)
    await out.write('report.json', '{"run":1}')
    await out.write('report.json', '{"run":2}')

    expect(await readFile(out.path('report.json'), 'utf8')).toBe('{"run":2}')
    expect((await readdir(out.root)).toSorted()).toEqual(['.gitignore', 'raw', 'report.json'])
  })

  it('reuses an existing run directory', async () => {
    const first = await createOutputDir(repo)
    await first.writeRaw('keep.txt', 'kept\n')
    const second = await createOutputDir(repo)
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
