import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countPhysicalLines,
  discoverFiles,
  isExcluded,
  languageOf,
  readSources,
} from '../src/core/discover.ts'
import type { FileInventory } from '../src/core/types.ts'

/** Ignores the developer's own global git config so the fixture is hermetic. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa('git', args, { cwd, env: GIT_ENV, extendEnv: true })
}

async function plant(root: string, file: string, contents: string): Promise<void> {
  const target = join(root, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

describe('discoverFiles', () => {
  let repo: string
  let inventory: FileInventory

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-discover-'))
    await git(repo, 'init', '--quiet')

    await plant(repo, '.gitignore', 'ignored.txt\nbuild/\n')
    await plant(repo, 'src/app.js', 'const a = 1\n')
    await plant(repo, 'src/mod.py', 'x = 1\n')
    await plant(repo, 'src/deleted.ts', 'export const gone = 1\n')
    await git(repo, 'add', '.gitignore', 'src/app.js', 'src/mod.py', 'src/deleted.ts')

    // untracked but not ignored -> in scope
    await plant(repo, 'src/new.tsx', 'export const B = () => null\n')
    await plant(repo, 'scripts/tool.mjs', 'export default 1\n')
    // ignored by the repo's own .gitignore -> out of scope
    await plant(repo, 'ignored.txt', 'nope\n')
    await plant(repo, 'build/out.js', 'nope\n')
    // NOT gitignored, but dependencies are never scanned (spec §7)
    await plant(repo, 'node_modules/foo/index.js', 'module.exports = 1\n')
    await plant(repo, '.venv/lib/site.py', 'import os\n')
    await plant(repo, 'packages/web/node_modules/dep/dep.ts', 'export const d = 1\n')
    // tracked in the index but removed from disk -> must not be reported
    await rm(join(repo, 'src/deleted.ts'))

    inventory = await discoverFiles(repo)
  })

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('includes tracked and untracked-but-not-ignored files', () => {
    expect(inventory.all).toContain('src/app.js')
    expect(inventory.all).toContain('src/mod.py')
    expect(inventory.all).toContain('src/new.tsx')
    expect(inventory.all).toContain('scripts/tool.mjs')
    expect(inventory.all).toContain('.gitignore')
  })

  it('excludes gitignored files', () => {
    expect(inventory.all).not.toContain('ignored.txt')
    expect(inventory.all).not.toContain('build/out.js')
  })

  it('excludes dependency directories even when they are not gitignored', () => {
    expect(inventory.all).not.toContain('node_modules/foo/index.js')
    expect(inventory.all).not.toContain('.venv/lib/site.py')
    expect(inventory.all).not.toContain('packages/web/node_modules/dep/dep.ts')
    expect(inventory.all.some((file) => file.startsWith('.git/'))).toBe(false)
  })

  it('drops index entries whose file is gone from disk', () => {
    expect(inventory.all).not.toContain('src/deleted.ts')
  })

  it('returns repo-relative posix paths in a stable, byte-wise order', () => {
    expect(inventory.all.every((file) => !file.startsWith('/') && !file.includes('\\'))).toBe(true)
    expect(inventory.all).toEqual(inventory.all.toSorted())
  })

  it('is deterministic across runs', async () => {
    expect((await discoverFiles(repo)).all).toEqual(inventory.all)
  })

  it('classifies files by language', () => {
    expect(inventory.byLanguage['js-ts']).toEqual(['scripts/tool.mjs', 'src/app.js', 'src/new.tsx'])
    expect(inventory.byLanguage.python).toEqual(['src/mod.py'])
  })

  it('counts physical lines for the KLOC denominator', async () => {
    expect(await countPhysicalLines(repo, ['src/app.js', 'src/mod.py'])).toBe(2)
    expect(await countPhysicalLines(repo, ['does/not/exist.js'])).toBe(0)
  })

  it('reads sources for anchor computation, skipping unreadable files', async () => {
    const sources = await readSources(repo, ['src/app.js', 'nope.js'])
    expect(sources.get('src/app.js')).toBe('const a = 1\n')
    expect(sources.has('nope.js')).toBe(false)
  })

  it('fails loudly outside a git work tree', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'crank-notrepo-'))
    try {
      await expect(discoverFiles(notARepo)).rejects.toThrow(/git ls-files failed/)
    } finally {
      await rm(notARepo, { recursive: true, force: true })
    }
  })
})

describe('languageOf', () => {
  it.each([
    ['a.js', 'js-ts'],
    ['a.jsx', 'js-ts'],
    ['a.mjs', 'js-ts'],
    ['a.cjs', 'js-ts'],
    ['a.ts', 'js-ts'],
    ['a.tsx', 'js-ts'],
    ['a.mts', 'js-ts'],
    ['a.cts', 'js-ts'],
    ['a.PY', 'python'],
    ['a.pyi', 'python'],
  ])('classifies %s as %s', (file, language) => {
    expect(languageOf(file)).toBe(language)
  })

  it.each(['README.md', 'Makefile', '.gitignore', 'a.json', 'noext'])(
    'leaves %s unclassified',
    (file) => {
      expect(languageOf(file)).toBeUndefined()
    },
  )
})

describe('isExcluded', () => {
  it.each([
    'node_modules/x.js',
    'a/b/node_modules/x.js',
    '.venv/x.py',
    'a/__pycache__/x.py',
    '.git/config',
  ])('excludes %s', (file) => {
    expect(isExcluded(file)).toBe(true)
  })

  it.each(['src/node_modules_helper.ts', 'src/venvy.py', 'src/app.js'])('keeps %s', (file) => {
    expect(isExcluded(file)).toBe(false)
  })
})
