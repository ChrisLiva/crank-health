import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDiagnostics, toPendingFindings, tscRunner } from '../src/adapters/jsts/tsc.ts'
import type { FileInventory, RepoContext } from '../src/core/types.ts'

/** Captured raw output from the pinned tsc, run against `test/fixtures/ts-owned`. */
const CAPTURED = fileURLToPath(new URL('./captured/tsc-7.0.2.txt', import.meta.url))

describe('parseDiagnostics', () => {
  it('reads file, position, code and message from real output', async () => {
    expect(parseDiagnostics(await readFile(CAPTURED, 'utf8'))).toEqual([
      {
        file: 'src/types.ts',
        line: 2,
        column: 9,
        level: 'error',
        code: 'TS2322',
        message: "Type 'number' is not assignable to type 'string'.",
      },
    ])
  })

  it('reads a clean project as zero diagnostics, not as a failure', () => {
    expect(parseDiagnostics('')).toEqual([])
  })

  it('ignores the indented related-information lines under a diagnostic', () => {
    const output = [
      "src/a.ts(3,5): error TS2345: Argument of type 'string' is not assignable.",
      "  src/b.ts(9,1): The expected type comes from property 'x'.",
    ].join('\n')
    expect(parseDiagnostics(output)).toHaveLength(1)
  })

  it('ignores project-level messages, which carry no file at all', () => {
    expect(parseDiagnostics("error TS5083: Cannot read file 'tsconfig.json'.")).toEqual([])
  })

  it('reads warnings and messages as well as errors', () => {
    const output = [
      'src/a.ts(1,1): warning TS0001: careful.',
      'src/a.ts(2,1): message TS0002: note.',
    ].join('\n')
    expect(parseDiagnostics(output).map((diagnostic) => diagnostic.level)).toEqual([
      'warning',
      'message',
    ])
  })
})

describe('toPendingFindings', () => {
  const diagnostics = [
    { file: 'src/a.ts', line: 2, column: 9, level: 'error', code: 'TS2322', message: 'x' },
    { file: 'src/a.ts', line: 1, column: 1, level: 'error', code: 'TS2307', message: 'no module' },
    { file: 'src/a.ts', line: 4, column: 1, level: 'warning', code: 'TS0001', message: 'w' },
  ]

  it('maps tsc levels onto the severity vocabulary', () => {
    const severities = new Map(
      toPendingFindings(diagnostics, true, '/repo').map((finding) => [
        finding.rule,
        finding.severity,
      ]),
    )
    expect(severities.get('TS2322')).toBe('error')
    expect(severities.get('TS0001')).toBe('warning')
  })

  it('grades everything when the diagnostics came from the repo’s own tsconfig', () => {
    const findings = toPendingFindings(diagnostics, true, '/repo')
    expect(findings.every((finding) => finding.gradeScope)).toBe(true)
    expect(findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
  })

  /**
   * On our bundled tsconfig, "cannot find module" is a fact about the repo's
   * uninstalled dependencies, not about its code — so it is reported and not
   * graded.
   */
  it('keeps environment-only diagnostics advisory under our own config', () => {
    const graded = new Map(
      toPendingFindings(diagnostics, false, '/repo').map((finding) => [
        finding.rule,
        finding.gradeScope,
      ]),
    )
    expect(graded.get('TS2322')).toBe(true)
    expect(graded.get('TS2307')).toBe(false)
    expect(
      toPendingFindings(diagnostics, false, '/repo').every(
        (finding) => finding.provenance === 'default-config',
      ),
    ).toBe(true)
  })

  it('sorts by location so identity never depends on tsc’s emission order', () => {
    expect(toPendingFindings(diagnostics.toReversed(), true, '/repo')).toEqual(
      toPendingFindings(diagnostics, true, '/repo'),
    )
    expect(toPendingFindings(diagnostics, true, '/repo').map((f) => f.range.startLine)).toEqual([
      1, 2, 4,
    ])
  })
})

describe('tsc detection', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'crank-tsc-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('is repo-owned on a tsconfig.json alone (spec §1)', async () => {
    await writeFile(join(repo, 'tsconfig.json'), '{}')
    expect(await tscRunner.detect(context(repo, ['tsconfig.json']))).toEqual({
      reason: 'config',
      configFiles: ['tsconfig.json'],
      installed: false,
    })
  })

  it('is not repo-owned by TypeScript sources alone', async () => {
    await writeFile(join(repo, 'package.json'), '{"name":"x"}')
    expect(await tscRunner.detect(context(repo, ['package.json', 'src/a.ts']))).toBeNull()
  })
})

describe('a repo with neither a tsconfig.json nor TypeScript sources', () => {
  it('leaves types not assessed rather than type-checking JavaScript', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-tsc-run-'))
    try {
      const result = await tscRunner.run({
        repoRoot: scratch,
        files: ['src/a.js', 'src/b.jsx'],
        scratch,
        detection: null,
        timeoutMs: 5_000,
      })
      expect(result.state).toBe('not-available')
      expect(result.reason).toContain('nothing owns the types category')
      expect(result.findings).toEqual([])
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

function context(repoRoot: string, files: string[]): RepoContext {
  const inventory: FileInventory = {
    all: files,
    byLanguage: { 'js-ts': files.filter((file) => file.endsWith('.ts')), python: [] },
  }
  return { repoRoot, files: inventory, scratch: join(repoRoot, 'scratch') }
}
