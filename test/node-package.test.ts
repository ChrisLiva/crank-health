import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isLibraryPackage } from '../src/adapters/jsts/node-package.ts'

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
