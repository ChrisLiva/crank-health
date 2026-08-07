import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exists } from '../src/adapters/support.ts'
import { partitionProjects } from '../src/core/discover.ts'
import type { DetectContext, Detection, RunContext, ToolResult } from '../src/core/types.ts'
import { makeProject } from './factories.ts'
import type { ReactDoctorDiagnostic } from '../src/adapters/jsts/react-doctor.ts'
import {
  invocationArgs,
  parseReactDoctorJson,
  reactDoctorRunner,
  toPendingFindings,
} from '../src/adapters/jsts/react-doctor.ts'
import { pinnedVersion } from '../src/manifest.ts'

/**
 * react-doctor — the advisory React-practices signal inside the lint category.
 *
 * The capture is real `react-doctor --json` output (schemaVersion 3) from the
 * `test/fixtures/js-react` tree: three `warning` diagnostics across two files,
 * all advisory. Pin-bump ritual: the pin test and the capture's schemaVersion
 * go stale together — re-capture when either moves.
 */

const CAPTURED = fileURLToPath(new URL('./captured/react-doctor-0.9.5.json', import.meta.url))

const captured = (): Promise<string> => readFile(CAPTURED, 'utf8')

describe('the react-doctor pin', () => {
  it('pins the exact version this release captured and tested against', () => {
    expect(pinnedVersion('react-doctor')).toBe('0.9.5')
  })

  it('was captured from the schema this release parses', async () => {
    expect(JSON.parse(await captured()).schemaVersion).toBe(3)
  })
})

describe('parseReactDoctorJson', () => {
  it('reads the React verdict and every diagnostic from real output, in stdout order', async () => {
    const payload = parseReactDoctorJson(await captured())

    expect(payload.reactDetected).toBe(true)
    expect(payload.diagnostics).toHaveLength(3)
    expect(payload.diagnostics.map((diagnostic) => diagnostic.help)).toSatisfy(
      (helps: readonly (string | undefined)[]) =>
        helps.every((help) => typeof help === 'string' && help.length > 0),
    )
    expect(payload.diagnostics[0]).toMatchObject({
      rule: 'rerender-state-only-in-handlers',
      filePath: 'src/Counter.jsx',
      line: 4,
      column: 9,
      endLine: 4,
      severity: 'warning',
      title: 'State only used in handlers',
    })
    expect(payload.diagnostics[1]).toMatchObject({
      rule: 'control-has-associated-label',
      filePath: 'src/Counter.jsx',
      line: 16,
      column: 7,
      endLine: 16,
      severity: 'warning',
      title: 'Control missing accessible label',
    })
    expect(payload.diagnostics[2]).toMatchObject({
      rule: 'no-array-index-as-key',
      filePath: 'src/List.jsx',
      line: 5,
      column: 13,
      endLine: 5,
      severity: 'warning',
      title: 'Array index used as a key',
    })
  })

  /**
   * Output we cannot read is an error the runner reports, never "no React
   * problems" — so the parser refuses shapes that are not the tool's envelope.
   */
  it('rejects output that is not react-doctor’s envelope', () => {
    expect(() => parseReactDoctorJson('garbage')).toThrow()
    expect(() => parseReactDoctorJson('[]')).toThrow()
    expect(() => parseReactDoctorJson('{"reactDetected":true}')).toThrow()
  })

  /** A partial payload loses the unreadable rows and nothing else. */
  it('drops a diagnostic missing its filePath or rule, keeping the rest', async () => {
    const valid = JSON.parse(await captured()).diagnostics[0]
    const payload = parseReactDoctorJson(
      JSON.stringify({
        reactDetected: true,
        diagnostics: [
          valid,
          { rule: 'r', severity: 'warning', title: 't' },
          { filePath: 'a.jsx', severity: 'warning', title: 't' },
        ],
      }),
    )
    expect(payload.diagnostics).toHaveLength(1)
    expect(payload.diagnostics[0]).toMatchObject({
      rule: 'rerender-state-only-in-handlers',
      filePath: 'src/Counter.jsx',
    })
  })
})

/** A hand-built diagnostic with no optional field, so a test can add exactly the ones it means. */
const bareDiagnostic = (overrides: Partial<ReactDoctorDiagnostic> = {}): ReactDoctorDiagnostic => ({
  filePath: 'src/A.jsx',
  rule: 'no-array-index-as-key',
  severity: 'warning',
  title: 'Array index used as a key',
  ...overrides,
})

/** The same, fully positioned — for the branches the capture cannot express. */
const diagnostic = (overrides: Partial<ReactDoctorDiagnostic> = {}): ReactDoctorDiagnostic =>
  bareDiagnostic({
    help: 'Use a stable id from the item.',
    line: 2,
    column: 3,
    endLine: 2,
    ...overrides,
  })

/** The mapper with both roots at the repo, the single-project case. */
const mapOne = (overrides: Partial<ReactDoctorDiagnostic> = {}, repoConfig = true) =>
  toPendingFindings([diagnostic(overrides)], repoConfig, '/repo', '/repo')[0]

describe('toPendingFindings', () => {
  it('maps the captured diagnostics into advisory lint findings, sorted by location', async () => {
    const findings = toPendingFindings(
      parseReactDoctorJson(await captured()).diagnostics,
      true,
      '/repo',
      '/repo',
    )

    expect(
      findings.map(({ file, range, rule }) => ({ file, startLine: range.startLine, rule })),
    ).toEqual([
      {
        file: 'src/Counter.jsx',
        startLine: 4,
        rule: 'react-doctor/rerender-state-only-in-handlers',
      },
      { file: 'src/Counter.jsx', startLine: 16, rule: 'react-doctor/control-has-associated-label' },
      { file: 'src/List.jsx', startLine: 5, rule: 'react-doctor/no-array-index-as-key' },
    ])
    expect(
      findings.map(({ category, tool, severity, provenance, gradeScope }) => ({
        category,
        tool,
        severity,
        provenance,
        gradeScope,
      })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        category: 'lint',
        tool: 'react-doctor',
        severity: 'warning',
        provenance: 'repo-config',
        gradeScope: false,
      })),
    )
  })

  it('takes the title as the message and the help as the fixHint', () => {
    expect(mapOne()).toMatchObject({
      message: 'Array index used as a key',
      fixHint: 'Use a stable id from the item.',
      range: { startLine: 2, startCol: 3, endLine: 2, endCol: 1 },
    })
  })

  it.each([
    ['error', 'error'],
    ['warning', 'warning'],
    // Forward compatibility: an unrecognized severity floors at info, never a
    // grade-bearing error.
    ['fatal', 'info'],
  ])('maps severity %s to %s', (reported, mapped) => {
    expect(mapOne({ severity: reported })?.severity).toBe(mapped)
  })

  it('omits the fixHint key entirely when the tool offered no help', () => {
    expect(toPendingFindings([bareDiagnostic()], true, '/repo', '/repo')[0]).not.toHaveProperty(
      'fixHint',
    )
  })

  /** Identity is the trimmed source line, like every line-attached diagnostic. */
  it('supplies no explicit anchor', () => {
    expect(mapOne()).not.toHaveProperty('anchor')
  })

  it('is default-config when nothing was detected', () => {
    expect(mapOne({}, false)?.provenance).toBe('default-config')
  })

  it.each([
    ['missing', {}],
    ['zero', { line: 0, column: 0, endLine: 0 }],
    ['negative', { line: -1, column: -2, endLine: -3 }],
    ['non-numeric', { line: Number.NaN, column: Number.NaN, endLine: Number.NaN }],
  ])('clamps a %s position to the first line and column', (_case, overrides) => {
    expect(
      toPendingFindings([bareDiagnostic(overrides)], true, '/repo', '/repo')[0]?.range,
    ).toEqual({
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 1,
    })
  })

  /**
   * The tool reports paths relative to the directory it was pointed at — the
   * project's, not the repo's — so a monorepo package's findings anchor at the
   * scan root before relativizing against the repo.
   */
  it.each([
    ['src/List.jsx', '/repo/packages/a', 'packages/a/src/List.jsx'],
    ['/repo/packages/a/src/List.jsx', '/repo/packages/a', 'packages/a/src/List.jsx'],
    ['src/List.jsx', '/repo', 'src/List.jsx'],
  ])('normalizes %s scanned from %s to %s', (filePath, scanRoot, expected) => {
    expect(toPendingFindings([diagnostic({ filePath })], true, scanRoot, '/repo')[0]?.file).toBe(
      expected,
    )
  })
})

/**
 * Hermeticity, in the arguments: no telemetry, no registry queries, no repo
 * execution, no exit-code blocking, and every write redirected into scratch —
 * unconditionally, in every invocation.
 */
describe('invocationArgs', () => {
  it('builds the hermetic command line, byte for byte', () => {
    expect(invocationArgs('/abs/project', '/scratch/react-doctor')).toEqual([
      '/abs/project',
      '--json',
      '--no-telemetry',
      '--no-supply-chain',
      '--no-dead-code',
      '--blocking',
      'none',
      '--output-dir',
      '/scratch/react-doctor',
    ])
  })
})

describe('the react-doctor runner', () => {
  /**
   * `complementary` is the load-bearing flag: it measures what no lint
   * alternative measures, so an ESLint-owning repo cannot stand it down, and
   * owning react-doctor stands no default linter down.
   */
  it('is the advisory lint complement, at the pinned version', () => {
    expect(reactDoctorRunner.tool).toBe('react-doctor')
    expect(reactDoctorRunner.category).toBe('lint')
    expect(reactDoctorRunner.complementary).toBe(true)
    expect(reactDoctorRunner.pinnedVersion).toBe('0.9.5')
  })

  /**
   * Static analysis with a meaningful default: it runs without being owned,
   * per project, in the quick profile, with no repo-wide pass to add.
   */
  it('carries none of the other runner flags', () => {
    expect(reactDoctorRunner.repoOwnedOnly).toBeUndefined()
    expect(reactDoctorRunner.deepOnly).toBeUndefined()
    expect(reactDoctorRunner.repoScoped).toBeUndefined()
    expect(reactDoctorRunner.repoWidePass).toBeUndefined()
  })
})

/**
 * Ownership inside a workspace, the Node way: a config or a declared dependency
 * in the project or any ancestor owns the tool. A `reactDoctor` manifest block
 * deliberately confers nothing — only the four config files and the dependency
 * declaration do.
 */
describe('reactDoctorRunner.detect', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-react-doctor-detect-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Writes a file, creating the directories above it. */
  async function write(file: string, body: string): Promise<void> {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), body)
  }

  /** Detection context for one project of the tree, partitioned the real way. */
  function context(files: string[], path: string): DetectContext {
    const inventory = {
      all: files,
      byLanguage: {
        'js-ts': files.filter((file) => file.endsWith('.jsx')),
        python: [],
        csharp: [],
      },
    }
    const project = partitionProjects(inventory).find((candidate) => candidate.path === path)
    if (project === undefined) throw new Error(`no project at ${path}`)
    return { repoRoot: root, project, files: inventory }
  }

  it('is owned by an ancestor’s config file, named at the path it was found', async () => {
    await write('package.json', '{"name":"root"}')
    await write('doctor.config.json', '{}')
    await write('packages/a/package.json', '{"name":"a"}')

    const files = [
      'doctor.config.json',
      'package.json',
      'packages/a/package.json',
      'packages/a/src/index.jsx',
    ]
    expect(await reactDoctorRunner.detect(context(files, 'packages/a'))).toMatchObject({
      reason: 'config',
      ownedVia: 'doctor.config.json',
    })
  })

  it('is owned by a declared dependency, honest about not being installed', async () => {
    await write('package.json', '{"devDependencies":{"react-doctor":"0.9.5"}}')

    const detection = await reactDoctorRunner.detect(
      context(['package.json', 'src/index.jsx'], '.'),
    )
    expect(detection).toMatchObject({
      reason: 'dependency',
      ownedVia: 'package.json',
      installed: false,
    })
    expect(detection).not.toHaveProperty('binPath')
  })

  it('is null when nothing configures or declares it', async () => {
    await write('package.json', '{"name":"x","dependencies":{"react":"^19.0.0"}}')
    expect(
      await reactDoctorRunner.detect(context(['package.json', 'src/index.jsx'], '.')),
    ).toBeNull()
  })
})

/**
 * The answers the runner gives before it starts a process. The oracle for "no
 * spawn": `writeScratchRaw` is the only thing that creates `<scratch>/raw`, and
 * the tool's own `--output-dir` is `<scratch>/react-doctor`, a different path.
 */
describe('reactDoctorRunner.run before it runs anything', () => {
  let root: string
  let scratch: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-react-doctor-run-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-react-doctor-scratch-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(scratch, { recursive: true, force: true }),
    ])
  })

  const run = (files: readonly string[]) =>
    reactDoctorRunner.run({
      repoRoot: root,
      project: makeProject([...files]),
      files,
      scratch,
      runScratch: scratch,
      detection: null,
      timeoutMs: 60_000,
      deep: false,
    })

  it('says so plainly when the project has no JS or TS in it', async () => {
    expect(await run([])).toEqual({
      state: 'ok',
      findings: [],
      rawFiles: [],
      reason: 'no JavaScript or TypeScript files',
    })
    expect(await exists(join(scratch, 'raw'))).toBe(false)
  })

  /**
   * A React-practices scan of a repo with no React would be a wall of
   * `reactDetected: false` runs; the gate answers from the manifests instead.
   */
  it('declines without spawning when nothing declares react', async () => {
    await writeFile(join(root, 'package.json'), '{"name":"x","dependencies":{"vue":"^3"}}')
    expect(await run(['src/index.jsx'])).toEqual({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'no React dependency detected',
    })
    expect(await exists(join(scratch, 'raw'))).toBe(false)
  })

  it('treats an unreadable manifest as no React, never a throw', async () => {
    await writeFile(join(root, 'package.json'), 'not json')
    expect(await run(['src/index.jsx'])).toEqual({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'no React dependency detected',
    })
    expect(await exists(join(scratch, 'raw'))).toBe(false)
  })
})

/**
 * The invocation ladder's remaining branches, against a planted react-doctor
 * that does exactly what each case needs. A real react-doctor cannot be made to
 * mis-serialize on demand, and a test that waits on `npx` is neither offline
 * nor deterministic; what the runner does with stdout, stderr and an exit code
 * is the same either way.
 */
describe('reactDoctorRunner.run against a planted react-doctor', () => {
  let root: string
  let scratch: string
  let binPath: string

  const FIXTURE_SRC = fileURLToPath(new URL('./fixtures/js-react/src/', import.meta.url))
  const FILES = ['src/Counter.jsx', 'src/List.jsx', 'src/index.jsx']

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-react-doctor-fake-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-react-doctor-fake-scratch-'))
    binPath = join(root, 'node_modules', '.bin', 'react-doctor')
    await mkdir(dirname(binPath), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"dependencies":{"react":"^19.0.0"}}')
    // The real fixture sources, so anchors read the lines the capture names.
    await cp(FIXTURE_SRC, join(root, 'src'), { recursive: true })
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(scratch, { recursive: true, force: true }),
    ])
  })

  /** Installs a react-doctor whose whole behavior is `body`. */
  async function plant(body: string): Promise<void> {
    await writeFile(binPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }

  const detection = (): Detection => ({
    reason: 'config',
    configFiles: ['doctor.config.json'],
    ownedVia: 'doctor.config.json',
    installed: true,
    binPath,
    version: '0.9.4',
  })

  const run = (overrides: Partial<RunContext> = {}): Promise<ToolResult> =>
    reactDoctorRunner.run({
      repoRoot: root,
      project: makeProject(FILES),
      files: FILES,
      scratch,
      runScratch: scratch,
      detection: detection(),
      timeoutMs: 60_000,
      deep: false,
      ...overrides,
    })

  it('reads the repo binary’s diagnostics, all advisory, at the installed version', async () => {
    await plant(`cat '${CAPTURED}'`)
    const result = await run()

    expect(result.state).toBe('ok')
    expect(result.findings).toHaveLength(3)
    expect(
      result.findings.every(
        (finding) => finding.provenance === 'repo-config' && !finding.gradeScope,
      ),
    ).toBe(true)
    expect(result.toolVersion).toBe('0.9.4')
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['react-doctor.json'])
    // Advisory means grade-neutral end to end: no denominators to grade with…
    expect(result).not.toHaveProperty('metrics')
    // …and no provenance override: detection decides.
    expect(result).not.toHaveProperty('configOwned')
  })

  /**
   * The tool's own verdict outranks the manifest gate: a repo can declare react
   * without a scannable React project at this directory.
   */
  it('degrades to not-available when the tool itself found no React, keeping the evidence', async () => {
    await plant(`echo '{"schemaVersion":3,"reactDetected":false,"diagnostics":[]}'`)
    const result = await run()

    expect(result.state).toBe('not-available')
    expect(result.reason).toBe('react-doctor found no React in this project')
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['react-doctor.json'])
  })

  it('treats a clean React project as zero findings, not a failure', async () => {
    await plant(`echo '{"schemaVersion":3,"reactDetected":true,"diagnostics":[]}'`)
    const result = await run()

    expect(result.state).toBe('ok')
    expect(result.findings).toEqual([])
  })

  /** Criterion 8: the tool runs from scratch, so stray cwd writes land there. */
  it('runs with the scratch dir as cwd, and keeps stderr as its own evidence file', async () => {
    await plant(`pwd >&2\ncat '${CAPTURED}'`)
    const result = await run()

    const stderrFile = result.rawFiles.find((file) => basename(file) === 'react-doctor.stderr.txt')
    expect(stderrFile).toBeDefined()
    expect((await readFile(stderrFile ?? '', 'utf8')).trim()).toBe(await realpath(scratch))
  })

  it.each([
    ['a silent exit', 'exit 0', 'react-doctor produced no output (exit 0): '],
    [
      'an engines rejection',
      `echo 'npm error code EBADENGINE' >&2\nexit 1`,
      'react-doctor produced no output (exit 1): npm error code EBADENGINE',
    ],
  ])('treats %s as an error naming the exit code', async (_case, body, reason) => {
    await plant(body)
    const result = await run()

    expect(result.state).toBe('error')
    expect(result.reason).toBe(reason)
    expect(result.rawFiles.map((file) => basename(file))).toContain('react-doctor.json')
  })

  it('treats unreadable output as an error, and keeps it anyway', async () => {
    await plant('echo garbage')
    const result = await run()

    expect(result.state).toBe('error')
    expect(result.reason?.startsWith('could not parse react-doctor output: ')).toBe(true)
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['react-doctor.json'])
  })

  /**
   * Criterion 12: only discovered files can carry findings, so nothing
   * gitignored or vendored — node_modules being the canonical case — reaches a
   * report even when the tool walked into it.
   */
  it('filters findings outside the discovered file list', async () => {
    const payload = JSON.parse(await captured())
    payload.diagnostics.push({
      filePath: 'node_modules/x.jsx',
      rule: 'no-array-index-as-key',
      severity: 'warning',
      title: 'Array index used as a key',
      line: 1,
      column: 1,
      endLine: 1,
    })
    const planted = join(scratch, 'planted-payload.json')
    await writeFile(planted, JSON.stringify(payload))
    await plant(`cat '${planted}'`)

    const result = await run()
    expect(result.findings).toHaveLength(3)
    expect(result.findings.some((finding) => finding.file.startsWith('node_modules/'))).toBe(false)
  })

  /** The react gate inherits: the workspace root's react covers its packages. */
  it('scans a package whose react lives in the workspace root manifest', async () => {
    const files = FILES.map((file) => `packages/a/${file}`)
    await mkdir(join(root, 'packages', 'a'), { recursive: true })
    await writeFile(join(root, 'packages', 'a', 'package.json'), '{"name":"a"}')
    await cp(FIXTURE_SRC, join(root, 'packages', 'a', 'src'), { recursive: true })
    await plant(`cat '${CAPTURED}'`)

    const inventory = {
      all: ['package.json', 'packages/a/package.json', ...files],
      byLanguage: { 'js-ts': files, python: [], csharp: [] },
    }
    const project = partitionProjects(inventory).find(
      (candidate) => candidate.path === 'packages/a',
    )
    if (project === undefined) throw new Error('no project at packages/a')

    const result = await run({ project, files })
    expect(result.state).toBe('ok')
    expect(result.findings).toHaveLength(3)
    expect(result.findings.map((finding) => finding.file)).toEqual([
      'packages/a/src/Counter.jsx',
      'packages/a/src/Counter.jsx',
      'packages/a/src/List.jsx',
    ])
    expect(
      result.findings.every(
        (finding) => finding.provenance === 'repo-config' && !finding.gradeScope,
      ),
    ).toBe(true)
    expect(result.toolVersion).toBe('0.9.4')
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['react-doctor.json'])
    expect(result).not.toHaveProperty('metrics')
    expect(result).not.toHaveProperty('configOwned')
  })

  /**
   * Criterion 14: a whole-project signal never scopes itself to a PR's touched
   * files. The empty list is the discriminator — a runner that consulted it
   * would return nothing.
   */
  it('never consults changedFiles', async () => {
    await plant(`cat '${CAPTURED}'`)
    const whole = await run()
    const scoped = await run({ changedFiles: [] })

    expect(scoped.findings).toEqual(whole.findings)
  })
})
