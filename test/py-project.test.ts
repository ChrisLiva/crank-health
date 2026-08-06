import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultTypeChecker,
  detectPythonTool,
  findVenv,
  normalizeDistribution,
  requirementNames,
  requirementsFiles,
  tomlDependencies,
  tomlSections,
} from '../src/adapters/python/py-project.ts'
import { partitionProjects, repoDetectContext } from '../src/core/discover.ts'
import type { DetectContext } from '../src/core/types.ts'

/**
 * Python ownership detection (spec §1) and the venv rule the two type checkers
 * split on. The TOML reader here is deliberately minimal — see `py-project.ts`
 * — so these tests are where its limits are pinned down: what it must get right,
 * and what it is documented not to.
 */

describe('tomlSections', () => {
  it('reads plain, nested and array-of-table headers', () => {
    const sections = tomlSections(`
[project]
name = "x"

[tool.ruff.lint]
select = ["F"]

[[tool.mypy.overrides]]
module = "y"
`)
    expect([...sections].toSorted()).toEqual(['project', 'tool.mypy.overrides', 'tool.ruff.lint'])
  })

  it('ignores headers inside a multi-line string, which are prose', () => {
    const sections = tomlSections(`
[project]
readme = """
Configure it with [tool.ruff] in your own project.
"""
`)
    expect([...sections]).toEqual(['project'])
  })

  it('ignores comments', () => {
    expect([...tomlSections('# [tool.ruff]\n[project]\n')]).toEqual(['project'])
  })
})

describe('tomlDependencies', () => {
  it('reads PEP 621 dependencies, extras and PEP 735 groups', () => {
    const names = tomlDependencies(`
[project]
dependencies = ["requests>=2", "Django ~= 5.0"]

[project.optional-dependencies]
dev = ["ruff==0.16.1", "pytest"]

[dependency-groups]
lint = ["vulture"]
`)
    expect([...names].toSorted()).toEqual(['django', 'pytest', 'requests', 'ruff', 'vulture'])
  })

  it('reads a multi-line dependency array', () => {
    const names = tomlDependencies(`
[project]
dependencies = [
  "complexipy>=6",
  "ty",
]
version = "1.0"
`)
    expect([...names].toSorted()).toEqual(['complexipy', 'ty'])
    // The array closed, so a later assignment is not swept up as a dependency.
    expect(names.has('1-0')).toBe(false)
  })

  it('reads poetry-style dependency tables, where the key is the distribution', () => {
    const names = tomlDependencies(`
[tool.poetry.dependencies]
python = "^3.12"
ruff = "^0.16"

[tool.poetry.group.dev.dependencies]
pyright = "^1.1"
`)
    expect([...names].toSorted()).toEqual(['pyright', 'python', 'ruff'])
  })

  it('does not mistake an ordinary array for a dependency list', () => {
    expect([...tomlDependencies('[tool.ruff.lint]\nselect = ["E4", "F"]\n')]).toEqual([])
  })
})

describe('requirementNames', () => {
  it('reads names and drops versions, markers, comments and options', () => {
    const names = requirementNames(`
# tooling
ruff==0.16.1
vulture >= 2.16  # dead code
requests[security]>=2.0; python_version >= "3.11"
-r other.txt
--index-url https://example.invalid/simple
`)
    expect([...names].toSorted()).toEqual(['requests', 'ruff', 'vulture'])
  })
})

describe('normalizeDistribution', () => {
  it('applies PEP 503 normalization so every spelling of a name matches', () => {
    expect(normalizeDistribution('Ruff')).toBe('ruff')
    expect(normalizeDistribution('typing_extensions')).toBe('typing-extensions')
    expect(normalizeDistribution('zope.interface >= 5')).toBe('zope-interface')
  })
})

describe('requirementsFiles', () => {
  it('finds root requirements files and a requirements directory, nothing deeper', () => {
    expect(
      requirementsFiles([
        'requirements.txt',
        'requirements-dev.txt',
        'requirements/base.txt',
        'docs/requirements.txt',
        'requirements.in',
      ]),
    ).toEqual(['requirements.txt', 'requirements-dev.txt', 'requirements/base.txt'])
  })
})

describe('findVenv and defaultTypeChecker', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-venv-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds nothing in a project without one, which is ty’s case', async () => {
    expect(await findVenv(root)).toBeUndefined()
    expect(defaultTypeChecker(undefined)).toBe('ty')
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

  it('finds one that has an interpreter, and hands pyright the decision', async () => {
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    await writeFile(join(root, '.venv', 'bin', 'python'), '', { mode: 0o755 })

    const venv = await findVenv(root)
    expect(venv).toEqual({
      directory: '.venv',
      interpreter: join(root, '.venv', 'bin', 'python'),
    })
    expect(defaultTypeChecker(venv)).toBe('pyright')
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

  function context(files: string[]): DetectContext {
    return repoDetectContext(root, {
      all: files,
      byLanguage: { 'js-ts': [], python: files.filter((file) => file.endsWith('.py')), csharp: [] },
    })
  }

  it('is null for a repo that never mentions the tool', async () => {
    await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "x"\n')
    expect(await detectPythonTool(context(['pyproject.toml', 'a.py']), ruffSpec)).toBeNull()
  })

  it('treats a config file as ownership', async () => {
    await writeFile(join(root, 'ruff.toml'), 'line-length = 100\n')
    expect(await detectPythonTool(context(['ruff.toml']), ruffSpec)).toMatchObject({
      reason: 'config',
      configFiles: ['ruff.toml'],
      installed: false,
    })
  })

  /** A `[tool.ruff.lint]` section owns ruff just as `[tool.ruff]` does. */
  it('treats a pyproject subsection as ownership, and names the manifest as the artifact', async () => {
    await writeFile(join(root, 'pyproject.toml'), '[tool.ruff.lint]\nselect = ["ALL"]\n')
    expect(await detectPythonTool(context(['pyproject.toml']), ruffSpec)).toMatchObject({
      reason: 'config',
      configFiles: ['pyproject.toml'],
    })
  })

  it('treats a declared dependency as ownership, wherever it is declared', async () => {
    await writeFile(join(root, 'requirements-dev.txt'), 'ruff==0.16.1\n')
    expect(await detectPythonTool(context(['requirements-dev.txt']), ruffSpec)).toMatchObject({
      reason: 'dependency',
      configFiles: [],
    })
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
      byLanguage: { 'js-ts': [], python: files.filter((file) => file.endsWith('.py')), csharp: [] },
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
