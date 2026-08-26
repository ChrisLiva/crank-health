import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aislopRunner, generatedConfig } from '../src/adapters/common/aislop.ts'
import { exists } from '../src/adapters/support.ts'
import { inventoryOf, partitionProjects } from '../src/core/discover.ts'
import type { DetectContext, Detection, RunContext, ToolResult } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

/**
 * aislop — the `ai-slop` engine, run over a scratch mirror of one project.
 *
 * The parser and the finding mapper are pinned in `common-parse.test.ts`; what
 * is pinned here is everything the runner decides around them: who owns the
 * tool, what it writes before it spawns anything, which binary it spawns, and
 * what each way the process can end becomes in the report.
 */

describe('aislopRunner', () => {
  /**
   * `complementary` because ai-slop measures an axis no linter here does: a
   * repo that owns ESLint must not stand it down. `languages` is what makes
   * `unitsFor` collapse a repo holding none of the four into a single
   * repo-spanning row instead of one "nothing to scan" per project. The key
   * set is the assertion that the absent flags stay absent: no
   * `repoOwnedOnly` (aislop runs on repos that never heard of it), no
   * `deepOnly` (it executes no repo code), no `repoScoped` and no
   * `repoWidePass` (slop is a property of a project's own files).
   */
  it('is a complementary lint runner over the four languages ai-slop reads', () => {
    expect(aislopRunner).toMatchObject({
      tool: 'aislop',
      category: 'lint',
      complementary: true,
      pinnedVersion: '0.14.1',
      languages: ['js-ts', 'python', 'go', 'csharp'],
    })
    expect(Object.keys(aislopRunner).toSorted()).toEqual([
      'category',
      'complementary',
      'detect',
      'languages',
      'pinnedVersion',
      'run',
      'tool',
    ])
  })
})

/**
 * Ownership, the Node way plus one file aislop reads on its own. The
 * dependency half is `detectNodeTool`'s and is pinned in
 * `node-package.test.ts`; what is aislop's own is `.aislop/config.yml`, which
 * lives under a dot directory the inventory never lists, so it is read off the
 * disk rather than out of `ctx.files`.
 */
describe('aislopRunner.detect', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-aislop-detect-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Writes a file, creating the directories above it. */
  async function write(file: string, body: string, mode?: number): Promise<void> {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), body, mode === undefined ? undefined : { mode })
  }

  /** Detection context for one project of the tree, partitioned the real way. */
  function context(files: readonly string[], path: string): DetectContext {
    const inventory = inventoryOf(files)
    const project = partitionProjects(inventory).find((candidate) => candidate.path === path)
    if (project === undefined) throw new Error(`no project at ${path}`)
    return { repoRoot: root, project, files: inventory }
  }

  const detect = (files: readonly string[], path: string): Promise<Detection | null> =>
    aislopRunner.detect(context(files, path))

  it('names both halves when the repo declares aislop and configures it', async () => {
    await write('package.json', '{"devDependencies":{"aislop":"0.14.1"}}')
    await write('.aislop/config.yml', 'version: 1\n')

    expect(await detect(['package.json', 'src/a.js'], '.')).toStrictEqual({
      reason: 'config+dependency',
      configFiles: ['.aislop/config.yml'],
      ownedVia: '.aislop/config.yml',
      installed: false,
    })
  })

  /**
   * The config is under a dot directory, so `hiddenScopeRoot` keeps it out of
   * the inventory: a detection that read `ctx.files.all` would miss it.
   */
  it('is owned by a config the inventory does not list', async () => {
    await write('.aislop/config.yml', 'version: 1\n')

    expect(await detect(['src/a.js'], '.')).toStrictEqual({
      reason: 'config',
      configFiles: ['.aislop/config.yml'],
      ownedVia: '.aislop/config.yml',
      installed: false,
    })
  })

  /** `peerDependencies` is one of the four blocks `detectNodeTool` reads. */
  it('is owned by a peerDependencies entry, named at the manifest', async () => {
    await write('package.json', '{"peerDependencies":{"aislop":"0.14.1"}}')

    expect(await detect(['package.json', 'src/a.js'], '.')).toMatchObject({
      reason: 'dependency',
      configFiles: [],
      ownedVia: 'package.json',
    })
  })

  it('inherits an ancestor’s config, named at the path it was found', async () => {
    await write('.aislop/config.yml', 'version: 1\n')
    await write('package.json', '{"name":"root"}')
    await write('packages/api/package.json', '{"name":"api"}')

    const files = ['package.json', 'packages/api/package.json', 'packages/api/src/a.js']
    expect(await detect(files, 'packages/api')).toMatchObject({
      reason: 'config',
      configFiles: ['.aislop/config.yml'],
      ownedVia: '.aislop/config.yml',
    })
  })

  /** aislop reads `.aislop/config.yml` and nothing else; near misses are not it. */
  it('is unowned by a config file aislop would never read', async () => {
    await write('.aislop/config.yaml', 'version: 1\n')
    await write('aislop.config.js', 'export default {}\n')

    expect(await detect(['aislop.config.js', 'src/a.js'], '.')).toBeNull()
  })

  it('reports the installed binary and its version off the disk', async () => {
    await write('package.json', '{"devDependencies":{"aislop":"0.14.1"}}')
    await write('node_modules/.bin/aislop', '#!/bin/sh\nexit 0\n', 0o755)
    await write('node_modules/aislop/package.json', '{"version":"0.14.1"}')

    const detection = await detect(['package.json', 'src/a.js'], '.')
    expect(detection).toMatchObject({ reason: 'dependency', installed: true, version: '0.14.1' })
    expect(detection?.binPath?.endsWith(join('node_modules', '.bin', 'aislop'))).toBe(true)
  })

  /**
   * Detection never spawns: the version comes off the disk, so a planted
   * binary that would leave a mark gets no chance to.
   */
  it('never runs the binary it found', async () => {
    await write('package.json', '{"devDependencies":{"aislop":"0.14.1"}}')
    await write('node_modules/.bin/aislop', '#!/bin/sh\ntouch "$(dirname "$0")/SPAWNED"\n', 0o755)
    await write('node_modules/aislop/package.json', '{"version":"0.14.1"}')

    await detect(['package.json', 'src/a.js'], '.')
    expect(await exists(join(root, 'node_modules', '.bin', 'SPAWNED'))).toBe(false)
  })
})

/**
 * The answers the runner gives before it starts a process. The oracle for "no
 * spawn" is the mirror: `<scratch>/aislop` is created in the same step that
 * writes the generated config, and nothing runs until both exist.
 */
describe('aislopRunner.run before it runs anything', () => {
  let root: string
  let scratch: string

  beforeEach(async () => {
    // The prefixes carry the words a leaked absolute path would carry, so the
    // "no absolute path in a reason" assertions below can see one.
    root = await mkdtemp(join(tmpdir(), 'crank-aislop-root-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-aislop-scratch-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(scratch, { recursive: true, force: true }),
    ])
  })

  const run = (
    files: readonly string[],
    overrides: Partial<RunContext> = {},
  ): Promise<ToolResult> =>
    aislopRunner.run({
      repoRoot: root,
      project: makeProject([...files]),
      files,
      scratch,
      runScratch: scratch,
      detection: null,
      timeoutMs: 60_000,
      deep: false,
      ...overrides,
    })

  /** Nothing scanned is not a clean bill: it is a category with no evidence. */
  it('declines a project with none of the four languages in it', async () => {
    expect(await run(['README.md', 'docs/a.yml'])).toEqual({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'no JavaScript, TypeScript, Python, C# or Go files, so aislop assessed nothing',
    })
    expect(await exists(join(scratch, 'aislop'))).toBe(false)
  })

  /**
   * A repo that turned the ai-slop engine off gets no ai-slop grade. Running
   * it anyway under crank-health's own engine list would grade the repo on the
   * one assessment it said it did not want.
   */
  it('declines when the repo’s own config disables the ai-slop engine', async () => {
    await mkdir(join(root, '.aislop'), { recursive: true })
    await writeFile(join(root, '.aislop', 'config.yml'), 'engines:\n  ai-slop: false\n')

    const detection: Detection = {
      reason: 'config',
      configFiles: ['.aislop/config.yml'],
      ownedVia: '.aislop/config.yml',
      installed: false,
    }
    expect(await run(['src/a.js'], { detection })).toEqual({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: "repo's .aislop/config.yml disables aislop's ai-slop engine",
    })
    expect(await exists(join(scratch, 'aislop'))).toBe(false)
  })

  /**
   * A file in the inventory that is not on disk (a broken symlink, a race with
   * a checkout) fails the run rather than silently shrinking the scan. The
   * reason names the repo-relative path and nothing else: an absolute path
   * would make `report.json` machine-dependent.
   */
  it('fails naming the repo-relative file it could not mirror', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.js'), 'export const a = 1\n')

    const result = await run(['src/a.js', 'src/missing.js'])
    expect(result.state).toBe('error')
    expect(result.reason).toContain('could not mirror src/missing.js for aislop: ')
    expect(result.reason).toContain('ENOENT')
    expect(result.reason).not.toContain('scratch')
    expect(result.reason).not.toContain('root')
    expect(result.findings).toEqual([])
    expect(result.rawFiles).toEqual([])
  })
})

/** Real `aislop scan --json` output over the js-aislop-owned fixture. */
const CAPTURED = fileURLToPath(new URL('./captured/aislop-0.14.1.json', import.meta.url))

/**
 * The invocation and every way the process can end, against a planted aislop
 * that does exactly what each case needs. A real aislop cannot be made to
 * mis-serialize on demand, and a test that waits on `npx` is neither offline
 * nor deterministic.
 *
 * Each case is also the proof that the repo's own binary is what ran: the
 * ephemeral branch would fetch aislop and scan the temp mirror, which can
 * never produce the captured rule list.
 */
describe('aislopRunner.run against a planted aislop', () => {
  let root: string
  let scratch: string
  let binPath: string

  const FIXTURE_SRC = fileURLToPath(new URL('./fixtures/js-aislop-owned/src/', import.meta.url))
  const FILES = ['src/excluded.js', 'src/index.js']

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-aislop-root-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-aislop-scratch-'))
    binPath = join(root, 'node_modules', '.bin', 'aislop')
    await mkdir(dirname(binPath), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"devDependencies":{"aislop":"0.14.1"}}')
    // The real fixture sources, so the anchors read the lines the capture names.
    await cp(FIXTURE_SRC, join(root, 'src'), { recursive: true })
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(scratch, { recursive: true, force: true }),
    ])
  })

  /** Installs an aislop whose whole behavior is `body`. */
  async function plant(body: string): Promise<void> {
    await writeFile(binPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }

  /** Writes a repo config and the detection that points the run at it. */
  async function ownConfig(body: string): Promise<Detection> {
    await mkdir(join(root, '.aislop'), { recursive: true })
    await writeFile(join(root, '.aislop', 'config.yml'), body)
    return {
      reason: 'config',
      configFiles: ['.aislop/config.yml'],
      ownedVia: '.aislop/config.yml',
      installed: true,
      binPath,
    }
  }

  const detection = (): Detection => ({
    reason: 'dependency',
    configFiles: [],
    ownedVia: 'package.json',
    installed: true,
    binPath,
  })

  const run = (overrides: Partial<RunContext> = {}): Promise<ToolResult> =>
    aislopRunner.run({
      repoRoot: root,
      project: makeProject([...FILES, 'package.json']),
      files: FILES,
      scratch,
      runScratch: scratch,
      detection: detection(),
      timeoutMs: 60_000,
      deep: false,
      ...overrides,
    })

  it('grades every diagnostic the repo’s own binary reported, at the version it printed', async () => {
    await plant(`cat '${CAPTURED}'`)
    const result = await run()

    expect(result.state).toBe('ok')
    expect(result.findings.map((finding) => finding.rule)).toEqual([
      'ai-slop/swallowed-exception',
      'ai-slop/duplicate-import',
      'ai-slop/hallucinated-import',
      'ai-slop/todo-stub',
      'ai-slop/swallowed-exception',
    ])
    expect(result.findings.every((finding) => finding.tool === 'aislop')).toBe(true)
    expect(result.toolVersion).toBe('0.14.1')
    expect(result.configOwned).toBe(false)
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['aislop.json'])
    // The payload reaches `raw/` unaltered, but for the trailing newline execa
    // strips off every stdout.
    expect((await readFile(result.rawFiles[0] ?? '', 'utf8')).trim()).toBe(
      (await readFile(CAPTURED, 'utf8')).trim(),
    )
  })

  /** aislop exits 1 when it found something; a payload came with it. */
  it('reads exit 1 with a payload as a completed run', async () => {
    await plant(`cat '${CAPTURED}'; exit 1`)
    expect((await run()).findings.map((finding) => finding.rule)).toHaveLength(5)
  })

  /** The version comes from the payload, so a payload without one reports none. */
  it('reports no toolVersion when the payload carries none', async () => {
    await plant(`sed '/"version": /d' '${CAPTURED}'`)
    const result = await run()

    expect(result.state).toBe('ok')
    expect('toolVersion' in result).toBe(false)
  })

  it.each([
    ['an exit code neither 0 nor 1', 'echo boom 1>&2; exit 2', 'aislop exited 2: boom'],
    ['a silent exit', 'exit 0', 'aislop printed no JSON object'],
    [
      'an error envelope',
      `echo '{"error":"config unreadable"}'`,
      'aislop reported an error: config unreadable',
    ],
    // The reason names the tool rather than quoting its bytes: stdout can hold
    // anything, and nothing in the run dir may quote a credential.
    ['output that is not JSON', `echo 'not json'`, 'aislop printed no JSON object'],
  ])('reports %s as an error, keeping the evidence', async (_case, body, reason) => {
    await plant(body)
    const result = await run()

    expect(result.state).toBe('error')
    expect(result.reason).toBe(reason)
    expect(result.findings).toEqual([])
    expect(result.rawFiles.map((file) => basename(file))).toContain('aislop.json')
  })

  it('keeps stderr as its own evidence file beside the payload', async () => {
    await plant('echo boom 1>&2; exit 2')
    expect((await run()).rawFiles.map((file) => basename(file))).toEqual([
      'aislop.json',
      'aislop.stderr.txt',
    ])
  })

  /** A moved JSON contract is a failure, never zero findings. */
  it('refuses a payload whose schemaVersion moved', async () => {
    await plant(`sed 's/"schemaVersion": "1"/"schemaVersion": "2"/' '${CAPTURED}'`)
    const result = await run()

    expect(result.state).toBe('error')
    expect(result.reason).toBe('aislop printed schemaVersion "2", not "1"; its JSON contract moved')
  })

  /** The inventory decides the report: aislop walked a file this run did not offer. */
  it('drops a diagnostic about a file outside this run’s inventory', async () => {
    await plant(`cat '${CAPTURED}'`)
    const result = await run({ files: ['src/index.js'] })

    expect(result.findings).toHaveLength(4)
    expect(result.findings.some((finding) => finding.file === 'src/excluded.js')).toBe(false)
  })

  /**
   * The repo's config decides rules, excludes and includes; crank-health's
   * decides which engine runs. The reason says exactly that, and names the
   * config repo-relative so `report.json` stays machine-independent.
   */
  it('lifts a repo config it can validate, and says which half was the repo’s', async () => {
    await plant(`cat '${CAPTURED}'`)
    const result = await run({ detection: await ownConfig('rules:\n  ai-slop/todo-stub: off\n') })

    expect(result.configOwned).toBe(true)
    expect(result.findings.every((finding) => finding.provenance === 'repo-config')).toBe(true)
    expect(result.reason).toBe(
      "engine selection is crank-health's; rules, exclude and include come from .aislop/config.yml",
    )
    const written = await readFile(join(scratch, 'aislop', '.aislop', 'config.yml'), 'utf8')
    expect(parseYaml(written)).toEqual(generatedConfig({ rules: { 'ai-slop/todo-stub': 'off' } }))
  })

  it('measures with its own defaults when the repo config will not parse, and says so', async () => {
    await plant(`cat '${CAPTURED}'`)
    const result = await run({ detection: await ownConfig('rules: {ai-slop/todo-stub: off') })

    expect(result.configOwned).toBe(false)
    expect(result.findings.every((finding) => finding.provenance === 'default-config')).toBe(true)
    expect(result.reason).toBe(
      ".aislop/config.yml could not be read as aislop config; measured with crank-health's defaults",
    )
    const written = await readFile(join(scratch, 'aislop', '.aislop', 'config.yml'), 'utf8')
    expect(parseYaml(written)).toEqual(generatedConfig())
  })

  /**
   * aislop writes its cache beside its cwd, so the cwd is the scratch dir the
   * mirror sits in and the repo keeps the listing it started with.
   */
  it('runs from the scratch mirror’s parent, leaving the repo’s listing untouched', async () => {
    await plant(`pwd 1>&2; cat '${CAPTURED}'`)
    const before = (await readdir(root)).toSorted()
    const result = await run()

    expect(result.rawFiles.map((file) => basename(file))).toEqual([
      'aislop.json',
      'aislop.stderr.txt',
    ])
    expect((await readFile(result.rawFiles[1] ?? '', 'utf8')).trim()).toBe(
      await realpath(join(scratch, 'aislop')),
    )
    expect((await readdir(root)).toSorted()).toEqual(before)
  })

  it('turns aislop’s telemetry off in the environment as well as in the config', async () => {
    await plant(`printf '%s' "\${AISLOP_NO_TELEMETRY-unset}" 1>&2; cat '${CAPTURED}'`)
    const result = await run()

    expect(await readFile(result.rawFiles[1] ?? '', 'utf8')).toBe('1')
  })

  /**
   * What aislop is allowed to see: this project's inventory, plus the manifests
   * every ancestor declares its dependencies in, plus the repo's own ignore
   * file. The generated config stays outside the scanned tree.
   */
  it('mirrors the inventory and the ancestor manifests, and nothing else', async () => {
    await plant(`cat '${CAPTURED}'`)
    await writeFile(join(root, 'pyproject.toml'), '[project]\n')
    await writeFile(join(root, 'requirements.txt'), 'requests\n')
    await writeFile(join(root, '.aislopignore'), 'dist/\n')

    await run({ project: makeProject(['src/index.js', 'package.json']), files: ['src/index.js'] })

    expect((await readdir(join(scratch, 'aislop', 'repo'))).toSorted()).toEqual([
      '.aislopignore',
      'package.json',
      'pyproject.toml',
      'requirements.txt',
      'src',
    ])
    expect(await readdir(join(scratch, 'aislop', 'repo', 'src'))).toEqual(['index.js'])
  })

  it('mirrors a workspace package under its own path, with the root’s manifests', async () => {
    await plant(`cat '${CAPTURED}'`)
    await mkdir(join(root, 'packages', 'api', 'src'), { recursive: true })
    await writeFile(join(root, 'packages', 'api', 'package.json'), '{"name":"api"}')
    await writeFile(join(root, 'packages', 'api', 'src', 'a.js'), 'export const a = 1\n')
    await writeFile(join(root, 'Pipfile'), '[packages]\n')

    const files = ['packages/api/src/a.js']
    const inventory = inventoryOf(['package.json', 'packages/api/package.json', ...files])
    const project = partitionProjects(inventory).find(
      (candidate) => candidate.path === 'packages/api',
    )
    if (project === undefined) throw new Error('no project at packages/api')

    await run({ project, files })

    expect((await readdir(join(scratch, 'aislop', 'repo'))).toSorted()).toEqual([
      'Pipfile',
      'package.json',
      'packages',
    ])
    expect(await readdir(join(scratch, 'aislop', 'repo', 'packages', 'api', 'src'))).toEqual([
      'a.js',
    ])
  })

  /**
   * A whole-project signal never scopes itself to a PR's touched files. The
   * empty list is the discriminator: a runner that consulted it would return
   * nothing.
   */
  it('never consults changedFiles', async () => {
    await plant(`cat '${CAPTURED}'`)
    const whole = await run()
    const scoped = await run({ changedFiles: ['src/other.js'] })

    expect(scoped.findings).toEqual(whole.findings)
  })
})
