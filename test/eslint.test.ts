import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eslintRunner, parseEslintJson, toPendingFindings } from '../src/adapters/jsts/eslint.ts'
import { repoDetectContext } from '../src/core/discover.ts'
import type { DetectContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

/**
 * Captured raw output from the pinned ESLint, run against `test/fixtures/
 * ts-owned`. Only the repo root was rewritten to `/repo`, so the checked-in
 * recording is not tied to the machine that made it.
 */
const CAPTURED = fileURLToPath(new URL('./captured/eslint-10.8.1.json', import.meta.url))

describe('parseEslintJson', () => {
  it('reads rule id, numeric severity, message and range from real output', async () => {
    const results = parseEslintJson(await readFile(CAPTURED, 'utf8'))

    expect(results.map((result) => result.filePath)).toEqual([
      '/repo/eslint.config.js',
      '/repo/src/lint.js',
    ])
    expect(results[1]?.messages).toEqual([
      {
        ruleId: 'no-unused-vars',
        severity: 2,
        message: "'unused' is assigned a value but never used.",
        line: 2,
        column: 9,
        endLine: 2,
        endColumn: 15,
      },
      {
        ruleId: 'eqeqeq',
        severity: 1,
        message: "Expected '===' and instead saw '=='.",
        line: 3,
        column: 12,
        endLine: 3,
        endColumn: 14,
      },
    ])
    // A clean file is a result with no messages, not an absence.
    expect(results[0]?.messages).toEqual([])
  })

  it('rejects output that is not ESLint’s array of file results', () => {
    expect(() => parseEslintJson('{"oops":true}')).toThrow('not an array')
    expect(() => parseEslintJson('nonsense')).toThrow()
  })

  it('survives a fatal parse error, which carries a null rule id', () => {
    const document = JSON.stringify([
      {
        filePath: '/repo/src/a.ts',
        messages: [
          { ruleId: null, fatal: true, severity: 2, message: 'Parsing error', line: 1, column: 26 },
        ],
      },
    ])
    expect(parseEslintJson(document)[0]?.messages[0]).toMatchObject({ ruleId: null, severity: 2 })
  })
})

describe('toPendingFindings', () => {
  const results = [
    {
      filePath: '/repo/src/a.js',
      messages: [
        {
          ruleId: 'no-unused-vars',
          severity: 2,
          message: 'x',
          line: 2,
          column: 9,
          endLine: 2,
          endColumn: 15,
        },
        {
          ruleId: 'eqeqeq',
          severity: 1,
          message: 'y',
          line: 3,
          column: 1,
          endLine: 3,
          endColumn: 3,
        },
        {
          ruleId: null,
          severity: 2,
          message: 'Parsing error',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
        },
      ],
    },
  ]

  it('maps ESLint’s numeric severities onto the severity vocabulary', () => {
    const severities = new Map(
      toPendingFindings(results, '/repo').map((finding) => [finding.rule, finding.severity]),
    )
    expect(severities.get('no-unused-vars')).toBe('error')
    expect(severities.get('eqeqeq')).toBe('warning')
  })

  it('tags every finding repo-config and grades it: this is their own config', () => {
    const findings = toPendingFindings(results, '/repo')
    expect(findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings.every((finding) => finding.category === 'lint')).toBe(true)
  })

  it('names the rule for a fatal message ESLint reports without one', () => {
    expect(toPendingFindings(results, '/repo').map((finding) => finding.rule)).toContain(
      'eslint(fatal)',
    )
  })

  it('relativizes the absolute paths ESLint reports', () => {
    expect(
      toPendingFindings(results, '/repo').every((finding) => finding.file === 'src/a.js'),
    ).toBe(true)
  })

  it('sorts by location so identity never depends on ESLint’s file order', () => {
    const reversed = [{ ...results[0]!, messages: [...results[0]!.messages].toReversed() }]
    expect(toPendingFindings(reversed, '/repo')).toEqual(toPendingFindings(results, '/repo'))
  })
})

describe('eslint detection', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-eslint-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('is not repo-owned without a config artifact or a declared dependency', async () => {
    await writeFile(join(repo, 'package.json'), '{"dependencies":{"react":"19"}}')
    expect(await eslintRunner.detect(context(repo, ['package.json', 'src/a.js']))).toBeNull()
  })

  it('is repo-owned on a flat config', async () => {
    await writeFile(join(repo, 'eslint.config.js'), 'export default []')
    expect(await eslintRunner.detect(context(repo, ['eslint.config.js']))).toEqual({
      reason: 'config',
      configFiles: ['eslint.config.js'],
      ownedVia: 'eslint.config.js',
      installed: false,
    })
  })

  it('is repo-owned on a legacy eslintrc too, so the situation can be explained', async () => {
    await writeFile(join(repo, '.eslintrc.json'), '{}')
    expect(await eslintRunner.detect(context(repo, ['.eslintrc.json']))).toMatchObject({
      reason: 'config',
      configFiles: ['.eslintrc.json'],
    })
  })
})

describe('a repo configured through the legacy eslintrc format', () => {
  it('is reported as not-available with a fix, rather than run and failed', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-eslint-run-'))
    try {
      const result = await eslintRunner.run({
        repoRoot: scratch,
        project: makeProject(['src/a.js']),
        files: ['src/a.js'],
        scratch,
        runScratch: scratch,
        detection: { reason: 'config', configFiles: ['.eslintrc.json'], installed: false },
        timeoutMs: 5_000,
        deep: false,
      })
      expect(result.state).toBe('not-available')
      expect(result.reason).toContain('no longer reads')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

function context(repoRoot: string, files: string[]): DetectContext {
  return repoDetectContext(repoRoot, {
    all: files,
    byLanguage: {
      'js-ts': files.filter((file) => file.endsWith('.js')),
      python: [],
      csharp: [],
      go: [],
    },
  })
}
