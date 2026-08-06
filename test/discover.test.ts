import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countPhysicalLines,
  discoverFiles,
  discoverProjects,
  isExcluded,
  languageOf,
  partitionProjects,
  readSources,
} from '../src/core/discover.ts'
import type { FileInventory, Project } from '../src/core/types.ts'

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

/** The inventory shape discovery produces, from a hand-written file list. */
function inventoryOf(files: readonly string[]): FileInventory {
  const all = [...files].toSorted()
  return {
    all,
    byLanguage: {
      'js-ts': all.filter((file) => languageOf(file) === 'js-ts'),
      python: all.filter((file) => languageOf(file) === 'python'),
    },
  }
}

function paths(projects: readonly Project[]): string[] {
  return projects.map((project) => project.path)
}

function projectAt(projects: readonly Project[], path: string): Project {
  const found = projects.find((project) => project.path === path)
  if (found === undefined) throw new Error(`no project at ${path}: ${paths(projects).join(', ')}`)
  return found
}

describe('partitionProjects', () => {
  it('assigns every file to its nearest manifest directory', () => {
    const projects = partitionProjects(
      inventoryOf([
        'package.json',
        'README.md',
        'src/root.ts',
        'packages/web/package.json',
        'packages/web/src/app.tsx',
        'packages/api/pyproject.toml',
        'packages/api/api/main.py',
      ]),
    )

    expect(paths(projects)).toEqual(['.', 'packages/api', 'packages/web'])
    expect(projectAt(projects, '.').files.all).toEqual(['README.md', 'package.json', 'src/root.ts'])
    expect(projectAt(projects, 'packages/web').files.all).toEqual([
      'packages/web/package.json',
      'packages/web/src/app.tsx',
    ])
    expect(projectAt(projects, 'packages/api').files.byLanguage.python).toEqual([
      'packages/api/api/main.py',
    ])
    expect(projectAt(projects, 'packages/api').manifests).toEqual(['packages/api/pyproject.toml'])
  })

  it('puts every source file in exactly one project', () => {
    const files = inventoryOf([
      'package.json',
      'src/root.ts',
      'packages/web/package.json',
      'packages/web/src/app.tsx',
      'packages/web/nested/package.json',
      'packages/web/nested/deep.ts',
    ])
    const assigned = partitionProjects(files).flatMap(
      (project) => project.files.byLanguage['js-ts'],
    )

    expect(assigned.toSorted()).toEqual(files.byLanguage['js-ts'])
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('gives a nested package its own files and leaves them out of the parent', () => {
    const projects = partitionProjects(
      inventoryOf([
        'packages/web/package.json',
        'packages/web/src/app.ts',
        'packages/web/nested/package.json',
        'packages/web/nested/deep.ts',
      ]),
    )

    expect(paths(projects)).toEqual(['packages/web', 'packages/web/nested'])
    expect(projectAt(projects, 'packages/web').files.all).toEqual([
      'packages/web/package.json',
      'packages/web/src/app.ts',
    ])
    expect(projectAt(projects, 'packages/web/nested').files.all).toEqual([
      'packages/web/nested/deep.ts',
      'packages/web/nested/package.json',
    ])
  })

  it('drops the root when nearer manifests claim every source file', () => {
    const projects = partitionProjects(
      inventoryOf([
        'package.json',
        'README.md',
        'packages/a/package.json',
        'packages/a/a.js',
        'packages/b/package.json',
        'packages/b/b.js',
      ]),
    )

    expect(paths(projects)).toEqual(['packages/a', 'packages/b'])
  })

  it('keeps the root as a project when source files remain beside the packages', () => {
    const projects = partitionProjects(
      inventoryOf([
        'package.json',
        'scripts/build.js',
        'packages/a/package.json',
        'packages/a/a.js',
      ]),
    )

    expect(paths(projects)).toEqual(['.', 'packages/a'])
    expect(projectAt(projects, '.').files.byLanguage['js-ts']).toEqual(['scripts/build.js'])
  })

  it('drops an intermediate manifest directory that keeps no source of its own', () => {
    const projects = partitionProjects(
      inventoryOf([
        'packages/package.json',
        'packages/a/package.json',
        'packages/a/a.js',
        'packages/b/pyproject.toml',
        'packages/b/b.py',
      ]),
    )

    expect(paths(projects)).toEqual(['packages/a', 'packages/b'])
  })

  it('makes one project with both languages from a directory holding both manifests', () => {
    const projects = partitionProjects(
      inventoryOf(['package.json', 'pyproject.toml', 'src/app.ts', 'src/app.py']),
    )

    expect(paths(projects)).toEqual(['.'])
    expect(projectAt(projects, '.').manifests).toEqual(['package.json', 'pyproject.toml'])
    expect(projectAt(projects, '.').languages).toEqual(['js-ts', 'python'])
  })

  it('reports a language the manifest declares before any file of it exists', () => {
    const projects = partitionProjects(
      inventoryOf(['package.json', 'pyproject.toml', 'src/app.py']),
    )

    expect(projectAt(projects, '.').languages).toEqual(['js-ts', 'python'])
  })

  it('is one root project for a repo with no manifest at all', () => {
    const projects = partitionProjects(inventoryOf(['src/a.js', 'src/b.py']))

    expect(paths(projects)).toEqual(['.'])
    expect(projectAt(projects, '.').manifests).toEqual([])
    expect(projectAt(projects, '.').files.all).toEqual(['src/a.js', 'src/b.py'])
  })

  it('still yields a root project when the repo has no source file anywhere', () => {
    const projects = partitionProjects(inventoryOf(['README.md', 'packages/a/package.json']))

    expect(paths(projects)).toEqual(['.'])
    expect(projectAt(projects, '.').languages).toEqual([])
  })

  it('orders projects by path, byte-wise and stable', () => {
    const files = inventoryOf([
      'z/package.json',
      'z/z.js',
      'a/pyproject.toml',
      'a/a.py',
      'package.json',
      'root.js',
    ])

    expect(paths(partitionProjects(files))).toEqual(['.', 'a', 'z'])
    expect(paths(partitionProjects(files))).toEqual(paths(partitionProjects(files)))
  })
})

describe('discoverProjects', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-projects-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const shellFiles = inventoryOf([
    'package.json',
    'pnpm-workspace.yaml',
    'packages/a/package.json',
    'packages/a/a.js',
  ])

  it('records the declarations that corroborate a workspace shell', async () => {
    await plant(root, 'package.json', '{ "workspaces": ["packages/*"] }')
    await plant(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n')

    const discovery = await discoverProjects(root, shellFiles)

    expect(paths(discovery.projects)).toEqual(['packages/a'])
    expect(discovery.rootShell?.declaredBy).toEqual(['package.json', 'pnpm-workspace.yaml'])
  })

  it('records a uv workspace declaration', async () => {
    const uvRoot = await mkdtemp(join(tmpdir(), 'crank-projects-uv-'))
    try {
      await plant(uvRoot, 'pyproject.toml', '[tool.uv.workspace]\nmembers = ["services/*"]\n')
      const files = inventoryOf([
        'pyproject.toml',
        'services/api/pyproject.toml',
        'services/api/main.py',
      ])

      const discovery = await discoverProjects(uvRoot, files)

      expect(paths(discovery.projects)).toEqual(['services/api'])
      expect(discovery.rootShell?.declaredBy).toEqual(['pyproject.toml'])
    } finally {
      await rm(uvRoot, { recursive: true, force: true })
    }
  })

  it('reports an undeclared folder-per-service shell with no declarations', async () => {
    const plainRoot = await mkdtemp(join(tmpdir(), 'crank-projects-plain-'))
    try {
      await plant(plainRoot, 'README.md', '# services\n')
      const files = inventoryOf([
        'README.md',
        'services/api/pyproject.toml',
        'services/api/main.py',
        'services/web/package.json',
        'services/web/app.js',
      ])

      const discovery = await discoverProjects(plainRoot, files)

      expect(paths(discovery.projects)).toEqual(['services/api', 'services/web'])
      expect(discovery.rootShell).toEqual({ declaredBy: [] })
    } finally {
      await rm(plainRoot, { recursive: true, force: true })
    }
  })

  it('has no shell to report when the root is itself a project', async () => {
    const discovery = await discoverProjects(
      root,
      inventoryOf(['package.json', 'src/app.js', 'packages/a/package.json', 'packages/a/a.js']),
    )

    expect(paths(discovery.projects)).toEqual(['.', 'packages/a'])
    expect(discovery.rootShell).toBeUndefined()
  })

  it('never lets a declaration include or exclude a project', async () => {
    const declaredElsewhere = inventoryOf([
      'package.json',
      'pnpm-workspace.yaml',
      // Not under `packages/*`, and its manifest is all it takes.
      'tools/cli/package.json',
      'tools/cli/cli.js',
    ])

    expect(paths((await discoverProjects(root, declaredElsewhere)).projects)).toEqual(['tools/cli'])
  })

  it('matches the pure partition on the same inventory', async () => {
    expect(paths((await discoverProjects(root, shellFiles)).projects)).toEqual(
      paths(partitionProjects(shellFiles)),
    )
  })
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
