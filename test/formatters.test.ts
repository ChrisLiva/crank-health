import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseListDifferent,
  prettierRunner,
  toPendingFindings,
} from '../src/adapters/jsts/prettier.ts'
import { repoDetectContext } from '../src/core/discover.ts'
import type { DetectContext } from '../src/core/types.ts'

/** Captured raw output from the pinned prettier, run against `test/fixtures/js-basic`. */
const CAPTURED = fileURLToPath(new URL('./captured/prettier-3.9.6.txt', import.meta.url))

describe('parseListDifferent', () => {
  it('reads the failing paths from real output', async () => {
    expect(parseListDifferent(await readFile(CAPTURED, 'utf8'))).toEqual(['src/unformatted.js'])
  })

  it('reads a perfectly formatted repo as zero failures', () => {
    expect(parseListDifferent('')).toEqual([])
    expect(parseListDifferent('\n\n')).toEqual([])
  })

  it('normalizes the ./ prefix and ignores blank lines', () => {
    expect(parseListDifferent('./src/a.ts\n\nsrc/b.ts\n')).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('toPendingFindings', () => {
  it('makes one file-level, graded finding per failing file', () => {
    const findings = toPendingFindings(['src/b.ts', 'src/a.ts'], false)
    expect(findings.map((finding) => finding.file)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(findings.every((finding) => finding.rule === 'prettier/format')).toBe(true)
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true)
    expect(findings.every((finding) => finding.category === 'format')).toBe(true)
    // Identity is (category, tool, rule, file): a formatting verdict is about
    // the file, and must not churn when its first line changes.
    expect(findings.every((finding) => finding.anchor === '')).toBe(true)
  })

  it('counts one finding per file however many times it was listed', () => {
    expect(toPendingFindings(['src/a.ts', 'src/a.ts'], false)).toHaveLength(1)
  })

  /**
   * Spec §1 grades only "correctness-class rules" under a default config — and
   * for a formatter that is every rule it has: there is one verdict, and the
   * `format` category is that verdict. See the runner's file comment.
   */
  it('grades formatting findings under both provenances, and says which is which', () => {
    const repo = toPendingFindings(['src/a.ts'], true)[0]
    const bundled = toPendingFindings(['src/a.ts'], false)[0]
    expect(repo).toMatchObject({ provenance: 'repo-config', gradeScope: true })
    expect(bundled).toMatchObject({ provenance: 'default-config', gradeScope: true })
    expect(repo?.message).toContain('repo’s prettier configuration')
    expect(bundled?.message).toContain('default formatting')
  })
})

describe('prettier detection', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-prettier-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('is our default formatter, so it runs whether or not the repo owns it', () => {
    expect(prettierRunner.repoOwnedOnly).toBeUndefined()
  })

  it('is not repo-owned by a .prettierignore alone — that is not a config', async () => {
    await writeFile(join(repo, 'package.json'), '{"name":"x"}')
    expect(
      await prettierRunner.detect(context(repo, ['package.json', '.prettierignore'])),
    ).toBeNull()
  })

  it('is repo-owned on a config artifact', async () => {
    await writeFile(join(repo, '.prettierrc.json'), '{"semi":false}')
    expect(await prettierRunner.detect(context(repo, ['.prettierrc.json']))).toEqual({
      reason: 'config',
      configFiles: ['.prettierrc.json'],
      ownedVia: '.prettierrc.json',
      installed: false,
    })
  })

  it('is repo-owned on a "prettier" block in package.json', async () => {
    await writeFile(join(repo, 'package.json'), '{"prettier":{"semi":false}}')
    expect(await prettierRunner.detect(context(repo, ['package.json']))).toEqual({
      reason: 'config',
      configFiles: ['package.json'],
      ownedVia: 'package.json',
      installed: false,
    })
  })

  it('is repo-owned on a declared dependency alone', async () => {
    await writeFile(join(repo, 'package.json'), '{"devDependencies":{"prettier":"3.9.6"}}')
    expect(await prettierRunner.detect(context(repo, ['package.json']))).toMatchObject({
      reason: 'dependency',
      configFiles: [],
    })
  })
})

function context(repoRoot: string, files: string[]): DetectContext {
  return repoDetectContext(repoRoot, {
    all: files,
    byLanguage: { 'js-ts': files.filter((file) => file.endsWith('.js')), python: [] },
  })
}
