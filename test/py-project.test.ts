import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectPythonTool, findVenv } from '../src/adapters/python/py-project.ts'
import { partitionProjects, repoDetectContext } from '../src/core/discover.ts'
import type { DetectContext } from '../src/core/types.ts'

/**
 * Python ownership detection (spec §1) and the venv rule the two type checkers
 * split on. The TOML and requirements readers behind detection are deliberately
 * minimal — see `py-project.ts` — so the declaration layouts they have to get
 * right are exercised here, through the detection they exist to answer.
 */

describe('findVenv', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-venv-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /**
   * The point of finding a virtualenv is handing a real interpreter to pyright,
   * so a directory without one is not a virtualenv as far as detection cares.
   */
  it('ignores a virtualenv directory with no interpreter in it', async () => {
    await mkdir(join(root, '.venv'), { recursive: true })
    await writeFile(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr\n')
    expect(await findVenv(root)).toBeUndefined()
  })

  it('prefers .venv over venv, so the choice never depends on directory order', async () => {
    await Promise.all(
      ['venv', '.venv'].map(async (name) => {
        await mkdir(join(root, name, 'bin'), { recursive: true })
        await writeFile(join(root, name, 'bin', 'python'), '', { mode: 0o755 })
      }),
    )
    expect((await findVenv(root))?.directory).toBe('.venv')
  })
})

describe('detectPythonTool', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-pydetect-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const ruffSpec = {
    configFiles: ['ruff.toml', '.ruff.toml'],
    distribution: 'ruff',
    sections: ['tool.ruff'],
  }

  /** mypy's spec: the tool whose section is written as an array of tables. */
  const mypySpec = {
    configFiles: ['mypy.ini'],
    distribution: 'mypy',
    sections: ['tool.mypy'],
  }

  /** cosmic-ray's spec: a distribution whose name has a separator in it. */
  const cosmicRaySpec = {
    configFiles: ['cosmic-ray.toml'],
    distribution: 'cosmic-ray',
    sections: ['tool.cosmic-ray'],
  }

  function context(files: string[]): DetectContext {
    return repoDetectContext(root, {
      all: files,
      byLanguage: {
        'js-ts': [],
        python: files.filter((file) => file.endsWith('.py')),
        csharp: [],
        go: [],
      },
    })
  }

  /** Writes a file, creating the directories above it. */
  async function write(file: string, body: string): Promise<void> {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), body)
  }

  it('is null for a repo that never mentions the tool', async () => {
    // Two ways this manifest could be misread into an answer: the readme names
    // `[tool.ruff]`, but a header inside a multi-line string is prose and not a
    // section; and the project is itself named `mypy`, which is not a
    // dependency because the array above it closed.
    await writeFile(
      join(root, 'pyproject.toml'),
      [
        '[project]',
        'dependencies = [',
        '  "requests>=2",',
        ']',
        'name = "mypy"',
        'readme = """',
        'Configure it with [tool.ruff] in your own project.',
        '"""',
        '',
      ].join('\n'),
    )
    const ctx = context(['pyproject.toml', 'a.py'])
    expect(await detectPythonTool(ctx, ruffSpec)).toBeNull()
    expect(await detectPythonTool(ctx, mypySpec)).toBeNull()
  })

  it('treats a config file as ownership', async () => {
    await writeFile(join(root, 'ruff.toml'), 'line-length = 100\n')
    expect(await detectPythonTool(context(['ruff.toml']), ruffSpec)).toMatchObject({
      reason: 'config',
      configFiles: ['ruff.toml'],
      installed: false,
    })
  })

  /**
   * A `[tool.ruff.lint]` section owns ruff just as `[tool.ruff]` does, and an
   * array-of-table header — `[[tool.mypy.overrides]]` — owns mypy the same way.
   * The `select` array is not a dependency list, so neither reason is
   * `config+dependency`.
   */
  it('treats a pyproject subsection as ownership, and names the manifest as the artifact', async () => {
    await writeFile(
      join(root, 'pyproject.toml'),
      [
        '[project]',
        'name = "x"',
        '',
        '[tool.ruff.lint]',
        'select = ["ALL"]',
        '',
        '[[tool.mypy.overrides]]',
        'module = "y"',
        '',
      ].join('\n'),
    )
    const ctx = context(['pyproject.toml'])
    expect(await detectPythonTool(ctx, ruffSpec)).toMatchObject({
      reason: 'config',
      configFiles: ['pyproject.toml'],
    })
    expect(await detectPythonTool(ctx, mypySpec)).toMatchObject({
      reason: 'config',
      configFiles: ['pyproject.toml'],
    })
  })

  /**
   * Every layout a dependency is declared in: PEP 621 arrays, extras and PEP
   * 735 groups, poetry's tables where the key is the distribution, and the
   * requirements files spec §1 names — with versions, extras, markers, comments
   * and pip options around the name, and in any PEP 503 spelling of it.
   */
  it.each([
    [
      'a PEP 621 dependencies array',
      { 'pyproject.toml': '[project]\ndependencies = ["requests>=2", "Django ~= 5.0", "ruff"]\n' },
      'pyproject.toml',
      ruffSpec,
    ],
    [
      'a PEP 621 extra',
      { 'pyproject.toml': '[project.optional-dependencies]\ndev = ["ruff==0.16.1", "pytest"]\n' },
      'pyproject.toml',
      ruffSpec,
    ],
    [
      'a PEP 735 dependency group',
      { 'pyproject.toml': '[dependency-groups]\nlint = ["vulture", "ruff"]\n' },
      'pyproject.toml',
      ruffSpec,
    ],
    [
      'a multi-line dependency array, which closes before the next assignment',
      {
        'pyproject.toml':
          '[project]\ndependencies = [\n  "complexipy>=6",\n  "ruff",\n]\nversion = "1.0"\n',
      },
      'pyproject.toml',
      ruffSpec,
    ],
    [
      'a poetry dependency table, where the key is the distribution',
      {
        'pyproject.toml':
          '[tool.poetry.group.dev.dependencies]\npyright = "^1.1"\nruff = "^0.16"\n',
      },
      'pyproject.toml',
      ruffSpec,
    ],
    [
      'a requirements file, among versions, markers, comments and pip options',
      {
        'requirements-dev.txt': [
          '# tooling',
          'ruff==0.16.1',
          'vulture >= 2.16  # dead code',
          'requests[security]>=2.0; python_version >= "3.11"',
          '-r other.txt',
          '--index-url https://example.invalid/simple',
          '',
        ].join('\n'),
      },
      'requirements-dev.txt',
      ruffSpec,
    ],
    ['the root requirements.txt', { 'requirements.txt': 'ruff\n' }, 'requirements.txt', ruffSpec],
    [
      'a file in the requirements directory',
      { 'requirements/lint.txt': 'ruff\n' },
      'requirements/lint.txt',
      ruffSpec,
    ],
    [
      'another spelling of the distribution name entirely',
      { 'requirements.txt': 'Cosmic_Ray >= 8.4\n' },
      'requirements.txt',
      cosmicRaySpec,
    ],
  ])(
    'treats a declared dependency as ownership, wherever it is declared: %s',
    async (_layout, files, ownedVia, spec) => {
      await Promise.all(Object.entries(files).map(([file, body]) => write(file, body)))

      expect(await detectPythonTool(context(Object.keys(files)), spec)).toMatchObject({
        reason: 'dependency',
        configFiles: [],
        ownedVia,
      })
    },
  )

  /** Only the root's own requirements files count — nothing deeper, and only `.txt`. */
  it('is not owned by a requirements file the project does not carry', async () => {
    await write('docs/requirements.txt', 'ruff==0.16.1\n')
    await write('requirements.in', 'ruff==0.16.1\n')
    expect(
      await detectPythonTool(context(['docs/requirements.txt', 'requirements.in']), ruffSpec),
    ).toBeNull()
  })

  it('reports config+dependency when the repo does both', async () => {
    await writeFile(join(root, 'ruff.toml'), '')
    await writeFile(join(root, 'pyproject.toml'), '[project]\ndependencies = ["ruff"]\n')
    expect(
      await detectPythonTool(context(['ruff.toml', 'pyproject.toml']), ruffSpec),
    ).toMatchObject({ reason: 'config+dependency' })
  })

  it('runs the repo’s own binary when the virtualenv has one installed', async () => {
    await writeFile(join(root, 'ruff.toml'), '')
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    await writeFile(join(root, '.venv', 'bin', 'python'), '', { mode: 0o755 })
    await writeFile(join(root, '.venv', 'bin', 'ruff'), '', { mode: 0o755 })

    expect(await detectPythonTool(context(['ruff.toml']), ruffSpec)).toMatchObject({
      installed: true,
      binPath: join(root, '.venv', 'bin', 'ruff'),
    })
  })

  it('is declared-but-not-installed when the virtualenv lacks the binary', async () => {
    await writeFile(join(root, 'pyproject.toml'), '[project]\ndependencies = ["ruff"]\n')
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    await writeFile(join(root, '.venv', 'bin', 'python'), '', { mode: 0o755 })

    const detection = await detectPythonTool(context(['pyproject.toml']), ruffSpec)
    expect(detection?.installed).toBe(false)
    expect(detection?.binPath).toBeUndefined()
  })
})

/**
 * Ownership inside a Python workspace: ruff and its neighbours resolve their
 * configuration upward, and a package is installed into the environment above
 * it — so a package inherits an ancestor's config, dependency declaration and
 * virtualenv, and its own answer wins where it has one.
 */
describe('detectPythonTool across a workspace', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-pyworkspace-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const ruffSpec = {
    configFiles: ['ruff.toml', '.ruff.toml'],
    distribution: 'ruff',
    sections: ['tool.ruff'],
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
      byLanguage: {
        'js-ts': [],
        python: files.filter((file) => file.endsWith('.py')),
        csharp: [],
        go: [],
      },
    }
    const project = partitionProjects(inventory).find((candidate) => candidate.path === path)
    if (project === undefined) throw new Error(`no project at ${path}`)
    return { repoRoot: root, project, files: inventory }
  }

  /** Workspace root, one member under it, and one module in that member. */
  const WORKSPACE = ['pyproject.toml', 'services/api/pyproject.toml', 'services/api/app.py']

  it('is not owned when neither the member nor an ancestor mentions the tool', async () => {
    await write('pyproject.toml', '[project]\nname = "root"\n')
    await write('services/api/pyproject.toml', '[project]\nname = "api"\n')
    expect(await detectPythonTool(context(WORKSPACE, 'services/api'), ruffSpec)).toBeNull()
  })

  it('is owned by a dependency the workspace root declares', async () => {
    await write('pyproject.toml', '[project]\ndependencies = ["ruff"]\n')
    await write('services/api/pyproject.toml', '[project]\nname = "api"\n')
    expect(await detectPythonTool(context(WORKSPACE, 'services/api'), ruffSpec)).toMatchObject({
      reason: 'dependency',
      configFiles: [],
      ownedVia: 'pyproject.toml',
    })
  })

  it('is owned by an ancestor’s requirements file', async () => {
    await write('pyproject.toml', '[project]\nname = "root"\n')
    await write('requirements-dev.txt', 'ruff==0.16.1\n')
    await write('services/api/pyproject.toml', '[project]\nname = "api"\n')
    expect(
      await detectPythonTool(
        context([...WORKSPACE, 'requirements-dev.txt'], 'services/api'),
        ruffSpec,
      ),
    ).toMatchObject({ reason: 'dependency', ownedVia: 'requirements-dev.txt' })
  })

  it('is configured by an ancestor’s [tool.ruff], named at the manifest it was found in', async () => {
    await write('pyproject.toml', '[tool.ruff]\nline-length = 100\n')
    await write('services/api/pyproject.toml', '[project]\nname = "api"\n')
    expect(await detectPythonTool(context(WORKSPACE, 'services/api'), ruffSpec)).toMatchObject({
      reason: 'config',
      configFiles: ['pyproject.toml'],
      ownedVia: 'pyproject.toml',
    })
  })

  it('runs the binary in the virtualenv at the workspace root when the member has none', async () => {
    await write('pyproject.toml', '[project]\ndependencies = ["ruff"]\n')
    await write('services/api/pyproject.toml', '[project]\nname = "api"\n')
    await write('.venv/bin/python', '')
    await write('.venv/bin/ruff', '')

    expect(await detectPythonTool(context(WORKSPACE, 'services/api'), ruffSpec)).toMatchObject({
      installed: true,
      binPath: join(root, '.venv', 'bin', 'ruff'),
    })
  })

  it('prefers the member’s own virtualenv to the one above it', async () => {
    await write('.venv/bin/python', '')
    await write('services/api/.venv/bin/python', '')

    expect(await findVenv(root, 'services/api')).toEqual({
      directory: 'services/api/.venv',
      interpreter: join(root, 'services', 'api', '.venv', 'bin', 'python'),
    })
  })
})
