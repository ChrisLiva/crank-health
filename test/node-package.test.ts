import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeToolSpec } from '../src/adapters/jsts/node-package.ts'
import { detectNodeTool, isLibraryPackage } from '../src/adapters/jsts/node-package.ts'
import { partitionProjects } from '../src/core/discover.ts'
import type { DetectContext } from '../src/core/types.ts'

/** Writes `body` verbatim as the manifest of a throwaway repo root. */
async function withManifest<T>(body: string | undefined, use: (root: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), 'crank-manifest-'))
  try {
    if (body !== undefined) await writeFile(join(root, 'package.json'), body)
    return await use(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('isLibraryPackage', () => {
  it.each([
    // Published-surface fields win outright, whatever `private` says: zustand
    // ships from a `private: true` manifest.
    ['{ "private": true, "exports": "./src/index.js", "types": "./src/index.d.ts" }', true],
    ['{ "module": "./m.js" }', true],
    ['{ "types": "./t.d.ts" }', true],
    // Presence, not truthiness.
    ['{ "exports": {} }', true],
    ['{ "exports": null }', true],
    // `main` alone is a library only while `private` does not veto it.
    ['{ "main": "./index.js" }', true],
    ['{ "main": "./index.js", "private": false }', true],
    ['{ "main": "./index.js", "private": true }', false],
    ['{ "main": "./index.js", "private": "yes" }', true],
    // An app that ships a binary is still an app — crank-health's own shape.
    ['{ "bin": "./cli.js", "files": ["dist"] }', false],
    // The trap: the `type` field is not the `module` entry field.
    ['{ "type": "module" }', false],
    // Malformed and non-object manifests degrade to "not a library".
    ['{ not json', false],
    ['[]', false],
  ])('classifies %s as library=%s', async (body, expected) => {
    expect(await withManifest(body, isLibraryPackage)).toBe(expected)
  })

  it('is false when there is no package.json at all', async () => {
    expect(await withManifest(undefined, isLibraryPackage)).toBe(false)
  })

  /**
   * Every checked-in fixture is an application, so turning this predicate into
   * a behaviour change must leave every golden report byte-identical. Read as
   * plain trees — no git, no scan.
   */
  it.each([
    'js-basic',
    'js-multi-tool',
    'js-owned',
    'js-weak-tests',
    'mixed-basic',
    'py-basic',
    'py-venv',
    'py-weak-tests',
    'sec-basic',
    'ts-owned',
  ])('classifies the %s fixture as an application', async (name) => {
    const root = fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url))
    expect(await isLibraryPackage(root)).toBe(false)
  })
})

/**
 * Ownership inside a workspace: Node resolves upward, so a package inherits the
 * config above it, the dependency the root declared, and the install npm
 * hoisted — and the nearest of each wins. The one exception is a config the
 * tool does not resolve upward (`NodeToolSpec.configInherits`).
 */
describe('detectNodeTool across a workspace', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-workspace-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const prettierSpec: NodeToolSpec = {
    configFiles: ['.prettierrc.json'],
    packageName: 'prettier',
    binName: 'prettier',
    manifestKeys: ['prettier'],
  }

  /** tsc's spec: a `tsconfig.json` belongs to its own project and no other. */
  const tscSpec: NodeToolSpec = {
    configFiles: ['tsconfig.json'],
    packageName: 'typescript',
    binName: 'tsc',
    configInherits: false,
  }

  /** Writes a file, creating the directories above it. */
  async function write(file: string, body: string): Promise<void> {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), body)
  }

  /** Detection context for one project of the tree, partitioned the real way. */
  function context(files: string[], path: string): DetectContext {
    const inventory = {
      all: files,
      byLanguage: { 'js-ts': files.filter((file) => file.endsWith('.ts')), python: [], csharp: [] },
    }
    const project = partitionProjects(inventory).find((candidate) => candidate.path === path)
    if (project === undefined) throw new Error(`no project at ${path}`)
    return { repoRoot: root, project, files: inventory }
  }

  /** Root manifest, one package under it, and one source file in that package. */
  const WORKSPACE = ['package.json', 'packages/a/package.json', 'packages/a/src/index.ts']

  it('is not owned when neither the package nor an ancestor mentions the tool', async () => {
    await write('package.json', '{"devDependencies":{"vitest":"4"}}')
    await write('packages/a/package.json', '{"name":"a"}')
    expect(await detectNodeTool(context(WORKSPACE, 'packages/a'), prettierSpec)).toBeNull()
  })

  it('is owned by a dependency the root manifest declares, which is where npm hoists it', async () => {
    await write('package.json', '{"devDependencies":{"prettier":"3.9.6"}}')
    await write('packages/a/package.json', '{"name":"a"}')
    expect(await detectNodeTool(context(WORKSPACE, 'packages/a'), prettierSpec)).toMatchObject({
      reason: 'dependency',
      configFiles: [],
      ownedVia: 'package.json',
    })
  })

  it('is owned by an ancestor’s config file, named at the path it was found', async () => {
    await write('package.json', '{"name":"root"}')
    await write('.prettierrc.json', '{"semi":false}')
    await write('packages/a/package.json', '{"name":"a"}')
    expect(
      await detectNodeTool(context([...WORKSPACE, '.prettierrc.json'], 'packages/a'), prettierSpec),
    ).toMatchObject({
      reason: 'config',
      configFiles: ['.prettierrc.json'],
      ownedVia: '.prettierrc.json',
    })
  })

  it('is owned by an ancestor’s config block, and names that manifest, not the package’s', async () => {
    await write('package.json', '{"prettier":{"semi":false}}')
    await write('packages/a/package.json', '{"name":"a"}')
    expect(await detectNodeTool(context(WORKSPACE, 'packages/a'), prettierSpec)).toMatchObject({
      reason: 'config',
      configFiles: ['package.json'],
    })
  })

  it('runs the binary hoisted to an ancestor, at the version installed there', async () => {
    await write('package.json', '{"devDependencies":{"prettier":"3.9.6"}}')
    await write('packages/a/package.json', '{"name":"a"}')
    await write('node_modules/.bin/prettier', '')
    await write('node_modules/prettier/package.json', '{"version":"3.9.6"}')

    expect(await detectNodeTool(context(WORKSPACE, 'packages/a'), prettierSpec)).toMatchObject({
      installed: true,
      binPath: join(root, 'node_modules', '.bin', 'prettier'),
      version: '3.9.6',
    })
  })

  it('prefers the package’s own install to the hoisted one', async () => {
    await write('package.json', '{"devDependencies":{"prettier":"3.9.6"}}')
    await write('packages/a/package.json', '{"name":"a"}')
    await write('node_modules/.bin/prettier', '')
    await write('node_modules/prettier/package.json', '{"version":"3.9.6"}')
    await write('packages/a/node_modules/.bin/prettier', '')
    await write('packages/a/node_modules/prettier/package.json', '{"version":"2.8.8"}')

    expect(await detectNodeTool(context(WORKSPACE, 'packages/a'), prettierSpec)).toMatchObject({
      binPath: join(root, 'packages', 'a', 'node_modules', '.bin', 'prettier'),
      version: '2.8.8',
    })
  })

  /**
   * The spec's one exception: a package without its own `tsconfig.json` is not
   * covered by the root's, so it is graded on the bundled default — while the
   * TypeScript the root declared and installed is still the compiler that runs.
   */
  it('does not inherit a config the tool never resolves upward, but still inherits the dependency', async () => {
    await write('package.json', '{"devDependencies":{"typescript":"5.9.4"}}')
    await write('tsconfig.json', '{"compilerOptions":{"strict":true}}')
    await write('packages/a/package.json', '{"name":"a"}')
    await write('node_modules/.bin/tsc', '')
    await write('node_modules/typescript/package.json', '{"version":"5.9.4"}')

    const files = [...WORKSPACE, 'tsconfig.json']
    expect(await detectNodeTool(context(files, 'packages/a'), tscSpec)).toMatchObject({
      reason: 'dependency',
      configFiles: [],
      installed: true,
      binPath: join(root, 'node_modules', '.bin', 'tsc'),
      version: '5.9.4',
    })
  })

  it('does take the package’s own tsconfig.json, which is the project it defines', async () => {
    await write('package.json', '{"devDependencies":{"typescript":"5.9.4"}}')
    await write('tsconfig.json', '{}')
    await write('packages/a/package.json', '{"name":"a"}')
    await write('packages/a/tsconfig.json', '{}')

    const files = [...WORKSPACE, 'tsconfig.json', 'packages/a/tsconfig.json']
    expect(await detectNodeTool(context(files, 'packages/a'), tscSpec)).toMatchObject({
      reason: 'config+dependency',
      configFiles: ['packages/a/tsconfig.json'],
      // The package's own artifact, not the root's: nearest wins.
      ownedVia: 'packages/a/tsconfig.json',
    })
  })
})
