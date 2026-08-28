import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDiagnostics, toPendingFindings, tscRunner } from '../src/adapters/jsts/tsc.ts'
import { partitionProjects, repoDetectContext } from '../src/core/discover.ts'
import type { DetectContext, Detection } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

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
    { file: 'src/a.ts', line: 3, column: 1, level: 'error', code: 'TS2591', message: 'no @types' },
    { file: 'src/a.ts', line: 4, column: 1, level: 'warning', code: 'TS0001', message: 'w' },
    {
      file: 'src/a.ts',
      line: 5,
      column: 1,
      level: 'error',
      code: 'TS2592',
      // Verbatim from the pinned compiler. TypeScript has one of these per
      // ambient library and `DEFAULT_ADVISORY_CODES` does not name this one,
      // so the wording is the only thing that makes it advisory.
      message:
        "Cannot find name '$'. Do you need to install type definitions for jQuery? Try `npm i --save-dev @types/jquery` and then add 'jquery' to the types field in your tsconfig.",
    },
    {
      file: 'src/a.ts',
      line: 6,
      column: 1,
      level: 'error',
      code: 'TS2345',
      // An ordinary assignability error that happens to name a declaration
      // file: tsc prints fully-qualified `node_modules/@types/…` paths inside
      // types it has no shorter name for.
      message:
        "Argument of type 'import(\"/repo/node_modules/@types/react/index\").ReactNode' is not assignable to parameter of type 'string'.",
    },
    { file: 'src/a.ts', line: 7, column: 1, level: 'error', code: 'TS2571', message: '' },
  ]

  /** Rule → `gradeScope`, so no assertion addresses a finding by position. */
  const gradedByRule = (repoConfig: boolean): Map<string, boolean> =>
    new Map(
      toPendingFindings(diagnostics, repoConfig, '/repo').map((finding) => [
        finding.rule,
        finding.gradeScope,
      ]),
    )

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
   * On our bundled tsconfig, "cannot find module" — and equally "install
   * @types/node" for a file importing `node:fs` — is a fact about the repo's
   * uninstalled type declarations, not about its code, so it is reported and
   * not graded. A hook script or a build helper living outside every package
   * is the common case, and it must not sink the repo's types grade.
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
    expect(graded.get('TS2591')).toBe(false)
    expect(
      toPendingFindings(diagnostics, false, '/repo').every(
        (finding) => finding.provenance === 'default-config',
      ),
    ).toBe(true)
  })

  /**
   * The code list cannot name every diagnostic that means "a `@types` package
   * is missing" — TypeScript has one per ambient library and TS2592 (jQuery) is
   * absent from `DEFAULT_ADVISORY_CODES`, so only its message says the missing
   * name is a library we never installed types for. Under our own config that
   * is a fact about `node_modules`, so the wording is read too.
   *
   * What is read is the *instruction to install* one, not the substring
   * `@types/`: TS2345 here is an ordinary assignability error whose only
   * `@types` mention is a path inside a type name, and a path is not an
   * environment fact. Demoting it would drop a real type error out of the
   * grade on nothing but where a declaration file happens to live.
   */
  it('reads a missing @types package out of the message as well as the code', () => {
    const graded = gradedByRule(false)
    expect(graded.get('TS2592')).toBe(false)
    expect(graded.get('TS2345')).toBe(true)
  })

  it('reads an empty message as ordinary code, not as an environment fact', () => {
    expect(gradedByRule(false).get('TS2571')).toBe(true)
  })

  /**
   * Determinism (spec §7): the message test carries no state, so the same
   * wording classifies the same way however many diagnostics precede it. A
   * `g`-flagged regex would alternate on repeats and make the grade depend on
   * emission order.
   */
  it('classifies repeats of one message identically', () => {
    const environment = diagnostics.filter((diagnostic) => diagnostic.code === 'TS2592')
    const repeated = [1, 2, 3].flatMap((line) =>
      environment.map((diagnostic) => ({ ...diagnostic, line })),
    )
    expect(
      toPendingFindings(repeated, false, '/repo').map((finding) => finding.gradeScope),
    ).toEqual([false, false, false])
    expect(toPendingFindings(diagnostics, false, '/repo')).toEqual(
      toPendingFindings(diagnostics, false, '/repo'),
    )
  })

  it('sorts by location so identity never depends on tsc’s emission order', () => {
    expect(toPendingFindings(diagnostics.toReversed(), true, '/repo')).toEqual(
      toPendingFindings(diagnostics, true, '/repo'),
    )
    expect(toPendingFindings(diagnostics, true, '/repo').map((f) => f.range.startLine)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
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
      ownedVia: 'tsconfig.json',
      installed: false,
    })
  })

  it('is not repo-owned by TypeScript sources alone', async () => {
    await writeFile(join(repo, 'package.json'), '{"name":"x"}')
    expect(await tscRunner.detect(context(repo, ['package.json', 'src/a.ts']))).toBeNull()
  })

  /**
   * A `tsconfig.json` is the definition of one project, not a setting the
   * package below it inherits — so a package without its own gets the bundled
   * default, and only the declared TypeScript reaches it from above.
   */
  it('does not hand a package the tsconfig.json of the workspace above it', async () => {
    await mkdir(join(repo, 'packages', 'a'), { recursive: true })
    await writeFile(join(repo, 'tsconfig.json'), '{}')
    await writeFile(join(repo, 'package.json'), '{"devDependencies":{"typescript":"5.9.4"}}')
    await writeFile(join(repo, 'packages', 'a', 'package.json'), '{"name":"a"}')

    const files = ['package.json', 'tsconfig.json', 'packages/a/package.json', 'packages/a/a.ts']
    const inventory = {
      all: files,
      byLanguage: { 'js-ts': ['packages/a/a.ts'], python: [], csharp: [], go: [] },
    }
    const project = partitionProjects(inventory).find(({ path }) => path === 'packages/a')
    if (project === undefined) throw new Error('no project at packages/a')

    expect(await tscRunner.detect({ repoRoot: repo, project, files: inventory })).toMatchObject({
      reason: 'dependency',
      configFiles: [],
    })
  })
})

describe('a repo with neither a tsconfig.json nor TypeScript sources', () => {
  it('leaves types not assessed rather than type-checking JavaScript', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-tsc-run-'))
    try {
      const result = await tscRunner.run({
        repoRoot: scratch,
        project: makeProject(['src/a.js', 'src/b.jsx']),
        files: ['src/a.js', 'src/b.jsx'],
        scratch,
        runScratch: scratch,
        detection: null,
        timeoutMs: 5_000,
        deep: false,
      })
      expect(result.state).toBe('not-available')
      expect(result.reason).toContain('nothing owns the types category')
      expect(result.findings).toEqual([])
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

/**
 * The repo's own TypeScript, so these run a real tsc without a network fetch.
 * `typescript` is a devDependency here and the manifest pins the same version.
 */
const LOCAL_TSC = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url))

const OWNED: Detection = {
  reason: 'config',
  configFiles: ['tsconfig.json'],
  installed: true,
  binPath: LOCAL_TSC,
}

/**
 * The failure this pins: tsc exits non-zero and every diagnostic it produced is
 * about the *project*, not about a file we analyze. A `"files": []` config is
 * the plainest way to get there — tsc type-checks nothing and says so with
 * TS18002 against `tsconfig.json`, which is not in any runner's file list.
 * Dropping those and reporting `ok` graded the repo A for having checked
 * nothing at all, which is the worst possible answer to "are the types sound".
 */
describe('a tsconfig.json that type-checks nothing', () => {
  let repo: string

  beforeEach(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'crank-tsc-empty-')))
    await mkdir(join(repo, 'src'), { recursive: true })
    await writeFile(join(repo, 'src', 'a.ts'), 'export const answer: string = 42\n')
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('is an error, not a clean bill of health', async () => {
    await writeFile(join(repo, 'tsconfig.json'), '{ "files": [] }\n')
    const result = await run(repo)

    expect(result.state).toBe('error')
    expect(result.reason).toContain('TS18002')
    expect(result.findings).toEqual([])
  })

  it('still reports the type errors when the config does check files', async () => {
    await writeFile(join(repo, 'tsconfig.json'), '{ "include": ["src"] }\n')
    const result = await run(repo)

    expect(result.state).toBe('ok')
    expect(result.findings.map((finding) => [finding.rule, finding.file])).toEqual([
      ['TS2322', 'src/a.ts'],
    ])
  })

  const run = (repoRoot: string) =>
    tscRunner.run({
      repoRoot,
      project: makeProject(['src/a.ts']),
      files: ['src/a.ts'],
      scratch: repoRoot,
      runScratch: repoRoot,
      detection: OWNED,
      timeoutMs: 60_000,
      deep: false,
    })
})

function context(repoRoot: string, files: string[]): DetectContext {
  return repoDetectContext(repoRoot, {
    all: files,
    byLanguage: {
      'js-ts': files.filter((file) => file.endsWith('.ts')),
      python: [],
      csharp: [],
      go: [],
    },
  })
}
