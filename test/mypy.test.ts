import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MYPY_GENERAL_RULE,
  mypyRunner,
  parseMypyJsonl,
  toPendingFindings,
} from '../src/adapters/python/mypy.ts'
import { exists } from '../src/adapters/support.ts'
import { repoDetectContext } from '../src/core/discover.ts'
import type { Detection, ToolResult } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

/**
 * mypy — the type checker a Python repo opts into, and the only one of the three
 * crank-health runs solely on the repo's own say-so.
 *
 * The capture is real `uvx mypy@2.3.1 --output=json` output from two sibling
 * throwaway projects, concatenated: three lines from a run that exited **1**
 * (found type errors, one of them with `column: -1`) and one line from a run
 * that exited **2** (could not even start — two modules named `util`), whose
 * diagnostic carries a `null` code and a four-line `hint`. Both runs were given
 * relative paths, so no machine path is recorded here.
 */

const CAPTURED = fileURLToPath(new URL('./captured/mypy-2.3.1.jsonl', import.meta.url))

const captured = (): Promise<string> => readFile(CAPTURED, 'utf8')

/** A hand-built diagnostic line, for the severities the capture cannot carry. */
const severityLine = (severity: string): string =>
  `{"file":"a.py","line":1,"column":0,"end_line":1,"end_column":1,"message":"m","hint":null,"code":"c","severity":"${severity}"}`

describe('parseMypyJsonl', () => {
  it('reads rule, severity, a 1-based range and message from real output', async () => {
    expect(parseMypyJsonl(await captured())).toEqual([
      {
        rule: 'unused-ignore',
        severity: 'error',
        file: 'notes.py',
        // mypy reports a whole-line diagnostic with `column: -1`; the schema
        // counts from 1, so the converted 0 is clamped back up.
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
        message: 'Unused "type: ignore" comment',
      },
      {
        rule: 'return-value',
        severity: 'error',
        file: 'app.py',
        // Lines are already 1-based in mypy; columns are not.
        startLine: 2,
        startCol: 12,
        endLine: 2,
        endCol: 17,
        message: 'Incompatible return value type (got "int", expected "str")',
      },
      {
        // The duplicate-module diagnostic carries `"code": null` and no real
        // position at all — every axis clamps to the first character.
        rule: MYPY_GENERAL_RULE,
        severity: 'error',
        file: 'pkg2/util.py',
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 1,
        message: 'Duplicate module named "util" (also at "pkg1/util.py")',
      },
    ])
  })

  /**
   * mypy's `note` lines are the explanations attached to an error — and
   * `reveal_type`'s answer, which is an instruction the author left for
   * themselves. Neither is a finding, so the four captured lines are three
   * diagnostics.
   */
  it('drops the note lines rather than reporting them as findings', async () => {
    const diagnostics = parseMypyJsonl(await captured())
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.every((diagnostic) => diagnostic.severity !== 'note')).toBe(true)
  })
})

/**
 * A hand-built line, because the capture cannot contain one: mypy 2.3.1 asserts
 * its own severity is `error` or `note` and emits nothing else. The row is
 * forward compatibility — a future `warning` must not silently grade as an
 * error — and the fallback is the safe direction for a severity we do not know.
 */
describe('mypy severities', () => {
  it('carries a warning through the parser and the mapper', () => {
    const diagnostics = parseMypyJsonl(severityLine('warning'))
    expect(diagnostics[0]?.severity).toBe('warning')
    expect(toPendingFindings(diagnostics, '/repo')[0]?.severity).toBe('warning')
  })

  it('treats a severity it does not recognize as an error', () => {
    expect(
      toPendingFindings(parseMypyJsonl(severityLine('catastrophe')), '/repo')[0]?.severity,
    ).toBe('error')
  })

  /**
   * The duplicate-module diagnostic ships a four-line `hint` explaining how to
   * restructure the project. That is prose about the problem, not a mechanical
   * fix, and the raw output keeps it.
   */
  it('never turns mypy’s hint into a fixHint', async () => {
    const findings = toPendingFindings(parseMypyJsonl(await captured()), '/repo')
    expect(findings).toHaveLength(3)
    expect(findings.every((finding) => !('fixHint' in finding))).toBe(true)
  })
})

describe('mypy toPendingFindings', () => {
  it('sorts by location, so identity never depends on mypy’s worker order', async () => {
    const findings = toPendingFindings(parseMypyJsonl(await captured()), '/repo')
    // Captured in the order mypy printed them: notes.py, app.py, pkg2/util.py.
    expect(findings.map((finding) => finding.file)).toEqual(['app.py', 'notes.py', 'pkg2/util.py'])
  })

  it('relativizes an absolute path against the repo root', () => {
    const diagnostic = {
      rule: 'return-value',
      severity: 'error',
      file: '/repo/pkg/app.py',
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 2,
      message: 'm',
    }
    expect(toPendingFindings([diagnostic], '/repo')[0]?.file).toBe('pkg/app.py')
  })
})

describe('parseMypyJsonl on inputs that are not a clean run', () => {
  it('treats no output as no diagnostics, and skips blank lines between records', async () => {
    expect(parseMypyJsonl('')).toEqual([])
    expect(parseMypyJsonl('   \n\n')).toEqual([])

    const bytes = await captured()
    expect(parseMypyJsonl(bytes.split('\n').join('\n\n'))).toEqual(parseMypyJsonl(bytes))
  })

  it('falls back to the start when a diagnostic carries no end', () => {
    expect(
      parseMypyJsonl(
        '{"file":"a.py","line":4,"column":2,"message":"m","code":"c","severity":"error"}',
      )[0],
    ).toMatchObject({ startLine: 4, startCol: 3, endLine: 4, endCol: 3 })
  })

  /**
   * Output we cannot read is an error the runner reports, never "zero type
   * errors" — so the parser refuses rather than skipping what it cannot make
   * sense of.
   */
  it('rejects a line that is not JSON, and one that is not a diagnostic', () => {
    expect(() => parseMypyJsonl('nonsense')).toThrow()
    expect(() =>
      parseMypyJsonl(
        '{"not":"jsonl"}\n{"file":"a.py","line":1,"column":0,"message":"m","code":"c","severity":"error"}',
      ),
    ).toThrow('no file')
  })
})

/**
 * Ownership (spec §1). mypy is `repoOwnedOnly`, so this is the whole question of
 * whether it runs at all — and `ownedVia` is what the invocation's
 * `--config-file` argument is built from, which is why every case pins it.
 */
describe('mypyRunner.detect', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-mypy-detect-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Writes a file, creating the directories above it. */
  async function write(file: string, body: string): Promise<void> {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), body)
  }

  function detect(files: string[]): Promise<Detection | null> {
    return mypyRunner.detect(
      repoDetectContext(root, {
        all: files,
        byLanguage: {
          'js-ts': [],
          python: files.filter((file) => file.endsWith('.py')),
          csharp: [],
        },
      }),
    )
  }

  it('is owned by a [tool.mypy] section, named at the manifest it was found in', async () => {
    await write('pyproject.toml', '[tool.mypy]\nstrict = true\n')
    expect(await detect(['pyproject.toml', 'app.py'])).toMatchObject({
      reason: 'config',
      configFiles: ['pyproject.toml'],
      ownedVia: 'pyproject.toml',
    })
  })

  /** A per-module override table is configuration just as `[tool.mypy]` is. */
  it('is owned by a [[tool.mypy.overrides]] table alone', async () => {
    await write('pyproject.toml', '[[tool.mypy.overrides]]\nmodule = "legacy.*"\n')
    expect(await detect(['pyproject.toml'])).toMatchObject({ reason: 'config' })
  })

  it('is owned by either spelling of the ini file', async () => {
    await write('mypy.ini', '[mypy]\n')
    expect(await detect(['mypy.ini'])).toMatchObject({ reason: 'config', ownedVia: 'mypy.ini' })

    await rm(join(root, 'mypy.ini'))
    await write('.mypy.ini', '[mypy]\n')
    expect(await detect(['.mypy.ini'])).toMatchObject({ reason: 'config', ownedVia: '.mypy.ini' })
  })

  /**
   * Section matching is on dotted names, so the `[mypy]` header of a *setup.cfg*
   * style config pasted into a `pyproject.toml` is not `[tool.mypy]` and does
   * not make mypy the repo's choice.
   */
  it('is null for a stray top-level [mypy] header, and for a repo that never mentions it', async () => {
    await write('pyproject.toml', '[mypy]\nwarn_unused_ignores = true\n')
    expect(await detect(['pyproject.toml', 'app.py'])).toBeNull()

    await write('pyproject.toml', '[project]\nname = "x"\n')
    expect(await detect(['pyproject.toml', 'app.py'])).toBeNull()
  })
})

/**
 * The two answers the runner gives before it starts a process, driven through
 * `mypyRunner.run` — the seam the orchestrator itself calls. `scratch` is a
 * directory of its own outside the repo, because mypy's cache is written under
 * it and the target repo must come out untouched.
 */
describe('mypyRunner.run before it runs anything', () => {
  let root: string
  let scratch: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-mypy-run-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-mypy-scratch-'))
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(scratch, { recursive: true, force: true }),
    ])
  })

  it('says so plainly when the project has no Python in it', async () => {
    expect(
      await mypyRunner.run({
        repoRoot: root,
        project: makeProject([]),
        files: [],
        scratch,
        runScratch: scratch,
        detection: { reason: 'config', configFiles: ['mypy.ini'], installed: false },
        timeoutMs: 60_000,
        deep: false,
      }),
    ).toEqual({ state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' })
  })

  /**
   * Declared but never installed, and no virtualenv to install into: an
   * ephemeral mypy would resolve none of the project's imports and report a
   * confident wall of `import-not-found`. The honest answer is that we cannot
   * check this project, and the reason says what would make it checkable.
   */
  it('declines rather than guessing when a declared mypy has no virtualenv', async () => {
    await writeFile(join(root, 'app.py'), 'x = 1\n')
    const result = await mypyRunner.run({
      repoRoot: root,
      project: makeProject(['app.py']),
      files: ['app.py'],
      scratch,
      runScratch: scratch,
      detection: {
        reason: 'dependency',
        configFiles: [],
        ownedVia: 'pyproject.toml',
        installed: false,
      },
      timeoutMs: 60_000,
      deep: false,
    })

    expect(result).toEqual({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason:
        'mypy is declared but this project has no virtualenv; ' +
        "create one and install the project's dependencies",
    })
    // Nothing was executed: `writeScratchRaw` is the only thing that makes `raw/`.
    expect(await exists(join(scratch, 'raw'))).toBe(false)
  })
})

/**
 * The invocation ladder's remaining branches, against a planted mypy that does
 * exactly what each case needs. A real mypy cannot be made to exit 2 with an
 * empty stderr on demand, and a test that waits on `uvx` is neither offline nor
 * deterministic; the shape of what the runner does with stdout, stderr and an
 * exit code is the same either way.
 */
describe('mypyRunner.run against a planted mypy', () => {
  let root: string
  let scratch: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-mypy-fake-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-mypy-fake-scratch-'))
    await mkdir(join(root, '.venv', 'bin'), { recursive: true })
    await writeFile(join(root, 'mypy.ini'), '[mypy]\nstrict = True\n')
    await writeFile(join(root, 'app.py'), 'def label(count: int) -> str:\n    return count\n')
    await writeFile(join(root, '.venv', 'bin', 'python'), '', { mode: 0o755 })
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(scratch, { recursive: true, force: true }),
    ])
  })

  const RECORD =
    '{"file":"app.py","line":2,"column":11,"end_line":2,"end_column":16,' +
    '"message":"Incompatible return value type (got \\"int\\", expected \\"str\\")",' +
    '"hint":null,"code":"return-value","severity":"error"}'

  /** Installs a mypy in the repo's virtualenv whose whole behavior is `body`. */
  async function plant(body: string): Promise<void> {
    await writeFile(join(root, '.venv', 'bin', 'mypy'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }

  const run = (): Promise<ToolResult> =>
    mypyRunner.run({
      repoRoot: root,
      project: makeProject(['app.py']),
      files: ['app.py'],
      scratch,
      runScratch: scratch,
      detection: {
        reason: 'config',
        configFiles: ['mypy.ini'],
        ownedVia: 'mypy.ini',
        installed: true,
        binPath: join(root, '.venv', 'bin', 'mypy'),
      },
      timeoutMs: 60_000,
      deep: false,
    })

  /**
   * Exit 1 is mypy saying it found type errors, which is the tool working. The
   * absent `toolVersion` is the witness that the repo's own binary ran: only the
   * ephemeral branch can claim the pinned version.
   */
  it('reads the repo binary’s diagnostics, and claims no pinned version for them', async () => {
    await plant(`echo '${RECORD}'\nexit 1`)
    const result = await run()

    expect(result.state).toBe('ok')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      tool: 'mypy',
      rule: 'return-value',
      file: 'app.py',
      provenance: 'repo-config',
      gradeScope: true,
    })
    expect(result.toolVersion).toBeUndefined()
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['mypy.jsonl'])
  })

  it('keeps stderr as its own evidence file when the tool wrote any', async () => {
    await plant(`echo '${RECORD}'\necho 'note: some advice' >&2\nexit 1`)
    expect((await run()).rawFiles.map((file) => basename(file))).toEqual([
      'mypy.jsonl',
      'mypy.stderr.txt',
    ])
  })

  it('treats unreadable output as an error, and keeps it anyway', async () => {
    await plant('echo nonsense\nexit 1')
    const result = await run()

    expect(result.state).toBe('error')
    expect(result.reason).toContain('could not parse mypy output')
    // The evidence is kept even though nothing could be made of it (spec §8).
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['mypy.jsonl'])
  })

  /**
   * mypy exits 2 when it could not check the project at all — a duplicate
   * module, an unreadable config. It puts that diagnostic on *stdout* and leaves
   * stderr empty, so the reason falls back to what it did say.
   */
  it('names the exit code, falling back to the diagnostic when stderr is empty', async () => {
    const blocked =
      '{"file":"pkg2/util.py","line":-1,"column":-1,"end_line":-1,"end_column":0,' +
      '"message":"Duplicate module named \\"util\\"","hint":null,"code":null,"severity":"error"}'
    await plant(`echo '${blocked}'\nexit 2`)
    const result = await run()

    expect(result.state).toBe('error')
    expect(result.reason).toContain('exit 2')
    expect(result.reason).toContain('Duplicate module named "util"')
  })

  it('names the exit code and what stderr said, when stderr said anything', async () => {
    await plant("echo 'boom: bad interpreter' >&2\nexit 2")
    const result = await run()

    expect(result.state).toBe('error')
    expect(result.reason).toContain('exit 2')
    expect(result.reason).toContain('boom: bad interpreter')
  })

  it('treats a clean run’s empty output as no findings, not as a failure', async () => {
    await plant('exit 0')
    const result = await run()

    expect(result.state).toBe('ok')
    expect(result.findings).toEqual([])
  })
})
