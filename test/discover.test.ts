import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countPhysicalLines,
  discoverFiles,
  discoverProjects,
  inventoryOf as coreInventoryOf,
  languageOf,
  nearestProjectMap,
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
    // NOT gitignored, but dependencies and caches are never scanned (spec §7)
    await plant(repo, 'node_modules/foo/index.js', 'module.exports = 1\n')
    await plant(repo, '.venv/lib/site.py', 'import os\n')
    await plant(repo, 'packages/web/node_modules/dep/dep.ts', 'export const d = 1\n')
    await plant(repo, 'a/__pycache__/x.py', 'x = 1\n')
    // …while a name that merely contains one of those words is source
    await plant(repo, 'src/node_modules_helper.ts', 'export const h = 1\n')
    await plant(repo, 'src/venvy.py', 'x = 1\n')
    // tracked in the index but removed from disk -> must not be reported
    await rm(join(repo, 'src/deleted.ts'))

    inventory = (await discoverFiles(repo)).files
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
    expect(inventory.all).not.toContain('a/__pycache__/x.py')
    expect(inventory.all.some((file) => file.startsWith('.git/'))).toBe(false)
    // The rule is a path segment, not a substring: these are ordinary source.
    expect(inventory.all).toContain('src/node_modules_helper.ts')
    expect(inventory.all).toContain('src/venvy.py')
  })

  it('drops index entries whose file is gone from disk', () => {
    expect(inventory.all).not.toContain('src/deleted.ts')
  })

  it('returns repo-relative posix paths in a stable, byte-wise order', () => {
    expect(inventory.all.every((file) => !file.startsWith('/') && !file.includes('\\'))).toBe(true)
    expect(inventory.all).toEqual(inventory.all.toSorted())
  })

  it('classifies files by language', () => {
    expect(inventory.byLanguage['js-ts']).toEqual([
      'scripts/tool.mjs',
      'src/app.js',
      'src/new.tsx',
      'src/node_modules_helper.ts',
    ])
    expect(inventory.byLanguage.python).toEqual(['src/mod.py', 'src/venvy.py'])
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

describe('discoverFiles and C# build output', () => {
  it('drops C# files under bin/ and obj/, keeping other languages there', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'crank-discover-cs-'))
    try {
      await git(repo, 'init', '--quiet')
      await plant(repo, 'src/App.cs', 'class App {}\n')
      await plant(repo, 'bin/Debug/App.cs', 'class App {}\n')
      await plant(repo, 'obj/Release/Gen.cs', 'class Gen {}\n')
      await plant(repo, 'bin/cli.js', '#!/usr/bin/env node\n')
      await plant(repo, 'bin/tool.py', 'x = 1\n')

      const inventory = (await discoverFiles(repo)).files

      expect(inventory.all).not.toContain('bin/Debug/App.cs')
      expect(inventory.all).not.toContain('obj/Release/Gen.cs')
      expect(inventory.all).toContain('src/App.cs')
      // The exclusion is C#-only: a JS package's bin/ is source, not MSBuild output.
      expect(inventory.all).toContain('bin/cli.js')
      expect(inventory.all).toContain('bin/tool.py')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('discoverFiles and Go vendoring', () => {
  it('drops .go files under vendor/, keeping everything else there', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'crank-discover-go-'))
    try {
      await git(repo, 'init', '--quiet')
      await plant(repo, 'go.mod', 'module example.com/svc\n')
      await plant(repo, 'a.go', 'package main\n')
      await plant(repo, 'vendor/dep/b.go', 'package dep\n')
      await plant(repo, 'vendor/modules.txt', '# example.com/dep v1.0.0\n')
      await plant(repo, 'vendor/dep/go.mod', 'module example.com/dep\n')
      // The rule is a path segment, not a substring: this is ordinary source.
      await plant(repo, 'vendored/dep/c.go', 'package dep\n')

      const inventory = (await discoverFiles(repo)).files

      expect(inventory.all).not.toContain('vendor/dep/b.go')
      expect(inventory.all).toContain('a.go')
      expect(inventory.all).toContain('vendor/modules.txt')
      expect(inventory.all).toContain('vendor/dep/go.mod')
      expect(inventory.all).toContain('vendored/dep/c.go')

      // The vendored module's own go.mod keeps no source, so it is a shell.
      const projects = partitionProjects(inventory)
      expect(projects.some((project) => project.path === 'vendor/dep')).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('discoverFiles and hidden directories', () => {
  let repo: string
  let inventory: FileInventory

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-discover-hidden-'))
    await git(repo, 'init', '--quiet')

    // Dot-files: the repo's own config, at the root and below it.
    await plant(repo, '.gitignore', 'ignored.txt\n')
    await plant(repo, '.prettierrc', '{}\n')
    await plant(repo, '.env.example', 'TOKEN=\n')
    await plant(repo, 'src/.hidden-named-file.ts', 'export const h = 1\n')
    await plant(repo, 'packages/web/.eslintrc.cjs', 'module.exports = {}\n')
    // Dot-directories: tooling scope, not source.
    await plant(repo, '.crank/hooks/hook.ts', 'export const hook = 1\n')
    await plant(repo, 'packages/web/.next/x.js', 'const n = 1\n')
    await plant(repo, 'a/.b/c/d.ts', 'export const d = 1\n')
    await plant(repo, '.github/.cache/x.js', 'const c = 1\n')
    await plant(repo, 'packages/web/.github/.cache/x.js', 'const c = 1\n')
    await plant(repo, 'packages/web/.next/.github/workflows/x.yml', 'on: push\n')
    await plant(repo, '.hidden/.github/workflows/x.yml', 'on: push\n')
    // The `.github` exemption, at the root and below it.
    await plant(repo, 'packages/web/.github/workflows/x.yml', 'on: push\n')
    await plant(repo, 'packages/web/.github/scripts/build.js', 'const b = 1\n')
    await plant(repo, '.github/workflows/ci.yml', 'on: push\n')
    await plant(repo, '.github/scripts/build.js', 'const b = 1\n')
    await plant(repo, 'src/app.js', 'const a = 1\n')
    await plant(repo, 'README.md', '# repo\n')

    inventory = (await discoverFiles(repo)).files
  })

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('drops files under a hidden directory', () => {
    expect(inventory.all).not.toContain('.crank/hooks/hook.ts')
    expect(inventory.all).not.toContain('packages/web/.next/x.js')
    // A hidden segment anywhere in the path is enough, however deep the file.
    expect(inventory.all).not.toContain('a/.b/c/d.ts')
  })

  it('keeps dot-files wherever they sit', () => {
    expect(inventory.all).toContain('.gitignore')
    expect(inventory.all).toContain('.prettierrc')
    expect(inventory.all).toContain('.env.example')
    expect(inventory.all).toContain('src/.hidden-named-file.ts')
    expect(inventory.all).toContain('packages/web/.eslintrc.cjs')
    // A path with no directory segment at all has no hidden one either.
    expect(inventory.all).toContain('README.md')
    expect(inventory.all).toContain('src/app.js')
  })

  it('exempts .github at any depth, and only that one segment', () => {
    expect(inventory.all).toContain('.github/workflows/ci.yml')
    expect(inventory.all).toContain('.github/scripts/build.js')
    expect(inventory.all).toContain('packages/web/.github/workflows/x.yml')
    expect(inventory.all).toContain('packages/web/.github/scripts/build.js')
    expect(inventory.all).not.toContain('.github/.cache/x.js')
    expect(inventory.all).not.toContain('packages/web/.github/.cache/x.js')
    // A `.github` below some *other* hidden directory is under that one.
    expect(inventory.all).not.toContain('packages/web/.next/.github/workflows/x.yml')
    expect(inventory.all).not.toContain('.hidden/.github/workflows/x.yml')
  })
})

/**
 * A scan that quietly looked at less than the repo is a scan a reader cannot
 * check. One sentence says how much went and what "went" actually means: the
 * language tools did not analyze it, the repo-scoped scanners still walked it.
 */
describe('the scan-scope warning', () => {
  it('says how much went and which tools stopped short, naming no directory', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'crank-discover-scope-'))
    try {
      await git(repo, 'init', '--quiet')
      await plant(repo, '.crank/hooks/hook.ts', 'export const hook = 1\n')
      await plant(repo, '.crank/hooks/other.ts', 'export const other = 1\n')
      await plant(repo, 'packages/web/.next/cache/chunk.js', 'const c = 1\n')
      await plant(repo, 'src/app.js', 'const a = 1\n')

      const { warnings } = await discoverFiles(repo)

      expect(warnings).toEqual([
        'scan scope: 3 files under hidden directories were not analyzed by language tools; ' +
          'repo-scoped scanners (gitleaks, osv-scanner) scan the full tree',
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /**
   * A dependency directory and MSBuild output are already out of scope when the
   * hidden-scope rule is asked, so neither is this sentence's to explain — and
   * the first repo with a `node_modules/.cache/` must not be told its
   * dependencies were skipped for being hidden.
   */
  it('counts only what the hidden-scope rule dropped', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'crank-discover-scope-nearer-'))
    try {
      await git(repo, 'init', '--quiet')
      await plant(repo, 'node_modules/.cache/x.js', 'const x = 1\n')
      await plant(repo, 'bin/Debug/App.cs', 'class App {}\n')
      await plant(repo, 'src/app.js', 'const a = 1\n')

      const { warnings } = await discoverFiles(repo)

      expect(warnings).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /**
   * The sentence goes into `report.json`, which is byte-compared across
   * machines, so it may carry no path from the machine it ran on.
   */
  it('carries no absolute path', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'crank-discover-scope-abs-'))
    try {
      await git(repo, 'init', '--quiet')
      await plant(repo, '.crank/hooks/hook.ts', 'export const hook = 1\n')
      await plant(repo, 'src/app.js', 'const a = 1\n')

      const [warning = ''] = await discoverFiles(repo).then((scan) => scan.warnings)

      expect(warning).not.toContain(repo)
      expect(warning.includes('/tmp') || warning.includes('/var')).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('the project partition after hidden directories leave', () => {
  it('falls through to the root project when hidden directories held the only source', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'crank-discover-hidden-src-'))
    try {
      await git(repo, 'init', '--quiet')
      await plant(repo, 'package.json', '{ "name": "root" }\n')
      await plant(repo, '.crank/hooks/hook.ts', 'export const hook = 1\n')

      const inventory = (await discoverFiles(repo)).files
      const projects = partitionProjects(inventory)

      expect(inventory.all).toEqual(['package.json'])
      expect(paths(projects)).toEqual(['.'])
      expect(projectAt(projects, '.').files.all).toEqual(['package.json'])
      // No source file survives, so the root manifest's own declaration is all
      // the language there is to report.
      expect(projectAt(projects, '.').languages).toEqual(['js-ts'])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('demotes a root whose remaining source is all hidden to a shell', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'crank-discover-hidden-shell-'))
    try {
      await git(repo, 'init', '--quiet')
      await plant(repo, 'package.json', '{ "name": "root" }\n')
      await plant(repo, '.crank/hooks/hook.ts', 'export const hook = 1\n')
      await plant(repo, 'packages/web/package.json', '{ "name": "web" }\n')
      await plant(repo, 'packages/web/src/index.js', 'const a = 1\n')

      const discovery = await discoverProjects(repo, (await discoverFiles(repo)).files)

      expect(paths(discovery.projects)).toEqual(['packages/web'])
      expect(discovery.rootShell).toBeDefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
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
    ['a.cs', 'csharp'],
    ['A.CS', 'csharp'],
    ['a.go', 'go'],
    ['A.GO', 'go'],
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
  return coreInventoryOf([...files].toSorted())
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

  it('makes a project of a directory holding a .csproj, whatever its case', () => {
    const projects = partitionProjects(inventoryOf(['src/App.CSPROJ', 'src/Program.cs']))

    expect(paths(projects)).toEqual(['src'])
    expect(projectAt(projects, 'src').manifests).toEqual(['src/App.CSPROJ'])
    expect(projectAt(projects, 'src').languages).toEqual(['csharp'])
  })

  it('makes a project of a directory holding a go.mod, and gives it the .go files below', () => {
    const projects = partitionProjects(inventoryOf(['svc/go.mod', 'svc/a.go', 'svc/inner/b.go']))

    expect(paths(projects)).toEqual(['svc'])
    expect(projectAt(projects, 'svc').manifests).toEqual(['svc/go.mod'])
    expect(projectAt(projects, 'svc').languages).toEqual(['go'])
    expect(projectAt(projects, 'svc').files.byLanguage.go).toEqual(['svc/a.go', 'svc/inner/b.go'])
  })

  it('treats a go.mod with no .go file of its own as a workspace shell, not a project', () => {
    const projects = partitionProjects(inventoryOf(['api/go.mod', 'api/README.md']))

    expect(paths(projects)).toEqual(['.'])
    expect(projects.some((project) => project.path === 'api')).toBe(false)
  })

  it('keeps the known manifest names case-sensitive', () => {
    const projects = partitionProjects(inventoryOf(['Package.json', 'a.cs']))

    expect(paths(projects)).toEqual(['.'])
    // `Package.json` declares nothing; the language comes from the inventory alone.
    expect(projectAt(projects, '.').manifests).toEqual([])
    expect(projectAt(projects, '.').languages).toEqual(['csharp'])
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

  it('orders projects by path, byte-wise and whatever order the files came in', () => {
    const listed = [
      'z/package.json',
      'z/z.js',
      'a/pyproject.toml',
      'a/a.py',
      'package.json',
      'root.js',
    ]

    expect(paths(partitionProjects(inventoryOf(listed)))).toEqual(['.', 'a', 'z'])
    // A different inventory order is the same partition: the sort is the
    // report's, not the file listing's.
    expect(paths(partitionProjects(inventoryOf(listed.toReversed())))).toEqual(['.', 'a', 'z'])
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

  it('records a root solution file beside a workspaces declaration, byte-ordered', async () => {
    const slnRoot = await mkdtemp(join(tmpdir(), 'crank-projects-sln-'))
    try {
      await plant(slnRoot, 'package.json', '{ "workspaces": ["pkg"] }')
      const files = inventoryOf(['App.sln', 'package.json', 'pkg/package.json', 'pkg/index.js'])

      const discovery = await discoverProjects(slnRoot, files)

      expect(discovery.rootShell?.declaredBy).toEqual(['App.sln', 'package.json'])
      expect(paths(discovery.projects)).toEqual(['pkg'])
    } finally {
      await rm(slnRoot, { recursive: true, force: true })
    }
  })

  it('records a .slnx solution file whatever its case', async () => {
    const slnRoot = await mkdtemp(join(tmpdir(), 'crank-projects-slnx-'))
    try {
      const files = inventoryOf(['Thing.SLNX', 'pkg/package.json', 'pkg/index.js'])

      const discovery = await discoverProjects(slnRoot, files)

      expect(discovery.rootShell?.declaredBy).toEqual(['Thing.SLNX'])
    } finally {
      await rm(slnRoot, { recursive: true, force: true })
    }
  })

  it('ignores a solution file below the root', async () => {
    const slnRoot = await mkdtemp(join(tmpdir(), 'crank-projects-sln-nested-'))
    try {
      const files = inventoryOf(['nested/App.sln', 'pkg/package.json', 'pkg/index.js'])

      const discovery = await discoverProjects(slnRoot, files)

      expect(discovery.rootShell?.declaredBy).toEqual([])
      expect(paths(discovery.projects)).toEqual(['pkg'])
    } finally {
      await rm(slnRoot, { recursive: true, force: true })
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
})

/**
 * Which project a path belongs to, for the findings no project's own run
 * produced: a repo-spanning scan reports across the whole tree at once.
 */
describe('nearestProjectMap', () => {
  const projects = partitionProjects(
    inventoryOf([
      'package.json',
      'packages/web/package.json',
      'packages/web/src/a.ts',
      'src/root.ts',
    ]),
  )

  it('attributes a path to the nearest project above it', () => {
    const projectOf = nearestProjectMap(projects)

    expect(projectOf('packages/web/src/a.ts')).toBe('packages/web')
    expect(projectOf('packages/web/README.md')).toBe('packages/web')
    // No nearer project claims it, and the root is one here.
    expect(projectOf('infra/deploy.yaml')).toBe('.')
  })

  /**
   * A workspace shell is not a project, so a path outside every package belongs
   * to none — and saying `.` would name a project that is not in the list.
   */
  it('attributes nothing to a root that is not a project', () => {
    const shell = partitionProjects(
      inventoryOf(['package.json', 'packages/web/package.json', 'packages/web/src/a.ts']),
    )
    const projectOf = nearestProjectMap(shell)

    expect(projectOf('packages/web/src/a.ts')).toBe('packages/web')
    expect(projectOf('.github/workflows/ci.yml')).toBeUndefined()
    expect(projectOf('README.md')).toBeUndefined()
  })
})
