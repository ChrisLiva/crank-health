import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  oxlintRunner,
  parseSarif,
  toPendingFindings,
} from '../src/adapters/jsts/oxlint.ts'
import type { FileInventory, RepoContext } from '../src/core/types.ts'

/**
 * Wrapper tests against captured raw output (plan: "version bumps that shift
 * formats fail tests instead of corrupting reports"). `test/captured/` holds
 * real oxlint output; regenerate it whenever the manifest pins a new version.
 */

const CAPTURED = fileURLToPath(new URL('./captured/oxlint-1.77.0.sarif.json', import.meta.url))

describe('parseSarif', () => {
  it('reads rule id, category, level, message and range from real output', async () => {
    const report = parseSarif(await readFile(CAPTURED, 'utf8'))

    expect(report.version).toBe('1.77.0')
    // Document order, exactly as captured — oxlint lints files in parallel, so
    // this order is not meaningful; `toPendingFindings` is what sorts it.
    expect(report.results).toEqual([
      {
        ruleId: 'eslint(no-const-assign)',
        ruleCategory: 'correctness',
        level: 'error',
        message: 'Unexpected re-assignment of `const` variable limit.',
        file: 'src/const-assign.js',
        startLine: 2,
        startCol: 9,
        endLine: 2,
        endCol: 14,
      },
      {
        ruleId: 'eslint(no-unreachable)',
        ruleCategory: 'correctness',
        level: 'error',
        message: 'Unreachable code.',
        file: 'src/unreachable.js',
        startLine: 6,
        startCol: 3,
        endLine: 6,
        endCol: 24,
      },
      {
        ruleId: 'eslint(no-dupe-keys)',
        ruleCategory: 'correctness',
        level: 'error',
        message: "Duplicate key 'home'",
        file: 'src/dupe-keys.js',
        startLine: 2,
        startCol: 3,
        endLine: 2,
        endCol: 7,
      },
      {
        ruleId: 'oxc(no-accumulating-spread)',
        ruleCategory: 'perf',
        level: 'warning',
        message: 'Do not spread accumulators in loops',
        file: 'src/accumulate.js',
        startLine: 2,
        startCol: 7,
        endLine: 2,
        endCol: 10,
      },
    ])
  })

  it('reads an empty run as zero findings, not as a failure', () => {
    const empty = JSON.stringify({
      runs: [{ tool: { driver: { version: '1.77.0', rules: [] } }, results: [] }],
    })
    expect(parseSarif(empty)).toEqual({ version: '1.77.0', results: [] })
  })

  it('rejects output that is not a SARIF document', () => {
    expect(() => parseSarif('{"oops":true}')).toThrow('no SARIF run')
    expect(() => parseSarif('not json at all')).toThrow()
  })

  it('drops results with no location rather than inventing one', () => {
    const document = JSON.stringify({
      runs: [{ tool: { driver: {} }, results: [{ ruleId: 'x', level: 'error' }] }],
    })
    expect(parseSarif(document).results).toEqual([])
  })
})

describe('toPendingFindings', () => {
  const report = {
    version: '1.77.0',
    results: [
      sarifFinding({ ruleId: 'eslint(no-unreachable)', ruleCategory: 'correctness' }),
      sarifFinding({
        ruleId: 'oxc(no-accumulating-spread)',
        ruleCategory: 'perf',
        level: 'warning',
      }),
      sarifFinding({ ruleId: 'OXL0001', ruleCategory: undefined, file: 'b.js' }),
      sarifFinding({ ruleId: 'eslint(no-alert)', ruleCategory: 'style', level: 'note' }),
    ],
  }

  it('grades only correctness-class rules on our default config', () => {
    const graded = new Map(
      toPendingFindings(report, false).map((finding) => [finding.rule, finding.gradeScope]),
    )
    expect(graded.get('eslint(no-unreachable)')).toBe(true)
    expect(graded.get('oxc(no-accumulating-spread)')).toBe(false)
    expect(graded.get('eslint(no-alert)')).toBe(false)
    // A syntax error carries no rule category and is broken by any standard.
    expect(graded.get('OXL0001')).toBe(true)
  })

  it('grades everything on the repo’s own config, and tags provenance', () => {
    const findings = toPendingFindings(report, true)
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(toPendingFindings(report, false).every((f) => f.provenance === 'default-config')).toBe(
      true,
    )
  })

  it('maps SARIF levels onto the severity vocabulary', () => {
    const severities = new Map(
      toPendingFindings(report, false).map((finding) => [finding.rule, finding.severity]),
    )
    expect(severities.get('eslint(no-unreachable)')).toBe('error')
    expect(severities.get('oxc(no-accumulating-spread)')).toBe('warning')
    expect(severities.get('eslint(no-alert)')).toBe('info')
  })

  it('sorts by location so identity never depends on oxlint’s thread order', () => {
    const shuffled = { version: '1.77.0', results: [...report.results].toReversed() }
    expect(toPendingFindings(shuffled, false)).toEqual(toPendingFindings(report, false))
  })
})

describe('oxlint detection', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-detect-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('is not repo-owned without a config artifact or a declared dependency', async () => {
    await writeFile(join(repo, 'package.json'), '{"name":"x","dependencies":{"react":"19"}}')
    expect(await oxlintRunner.detect(context(repo, ['package.json', 'src/a.js']))).toBeNull()
  })

  it('ignores package.json scripts, which corroborate but never decide', async () => {
    await writeFile(join(repo, 'package.json'), '{"scripts":{"lint":"oxlint --deny-warnings"}}')
    expect(await oxlintRunner.detect(context(repo, ['package.json']))).toBeNull()
  })

  it('is repo-owned on a config artifact alone', async () => {
    await writeFile(join(repo, '.oxlintrc.json'), '{}')
    expect(await oxlintRunner.detect(context(repo, ['.oxlintrc.json']))).toEqual({
      reason: 'config',
      configFiles: ['.oxlintrc.json'],
      installed: false,
    })
  })

  it('is repo-owned on a declared dependency, and reports it as not installed', async () => {
    await writeFile(join(repo, 'package.json'), '{"devDependencies":{"oxlint":"1.77.0"}}')
    expect(await oxlintRunner.detect(context(repo, ['package.json']))).toEqual({
      reason: 'dependency',
      configFiles: [],
      installed: false,
    })
  })

  it('finds the installed binary and its version without running it', async () => {
    await writeFile(join(repo, '.oxlintrc.json'), '{}')
    await writeFile(join(repo, 'package.json'), '{"devDependencies":{"oxlint":"1.77.0"}}')
    await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true })
    await mkdir(join(repo, 'node_modules', 'oxlint'), { recursive: true })
    await writeFile(join(repo, 'node_modules', '.bin', 'oxlint'), '#!/bin/sh\n')
    await writeFile(join(repo, 'node_modules', 'oxlint', 'package.json'), '{"version":"1.70.0"}')

    expect(await oxlintRunner.detect(context(repo, ['.oxlintrc.json', 'package.json']))).toEqual({
      reason: 'config+dependency',
      configFiles: ['.oxlintrc.json'],
      installed: true,
      binPath: join(repo, 'node_modules', '.bin', 'oxlint'),
      version: '1.70.0',
    })
  })
})

describe('the bundled default config', () => {
  it('grades correctness and keeps the rest advisory, with no opinionated style', () => {
    expect(DEFAULT_CONFIG.categories).toEqual({
      correctness: 'error',
      suspicious: 'warn',
      perf: 'warn',
    })
    expect(Object.keys(DEFAULT_CONFIG.categories)).not.toContain('style')
    expect(Object.keys(DEFAULT_CONFIG.categories)).not.toContain('pedantic')
  })
})

function sarifFinding(overrides: {
  ruleId: string
  ruleCategory: string | undefined
  level?: string
  file?: string
}) {
  return {
    ruleId: overrides.ruleId,
    ruleCategory: overrides.ruleCategory,
    level: overrides.level ?? 'error',
    message: `${overrides.ruleId} fired`,
    file: overrides.file ?? 'a.js',
    startLine: 1,
    startCol: 1,
    endLine: 1,
    endCol: 2,
  }
}

function context(repoRoot: string, files: string[]): RepoContext {
  const inventory: FileInventory = {
    all: files,
    byLanguage: { 'js-ts': files.filter((file) => file.endsWith('.js')), python: [] },
  }
  return { repoRoot, files: inventory, scratch: join(repoRoot, 'scratch') }
}
