import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/args.ts'
import type { SystemToolSpec } from '../src/adapters/common/system-tool.ts'
import { LANGUAGES } from '../src/core/types.ts'
import {
  equivalentCommand,
  isPromptCancelled,
  probeRepo,
  runInteractiveSession,
} from '../src/interactive.ts'
import type { PromptIO, PromptKey, SessionDeps, SystemToolStatus } from '../src/interactive.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { COMMIT_IDENTITY, createFixtureRepo } from './support/fixture.ts'

/**
 * The interactive walk-through is a front-end over `CliOptions`, so these
 * tests script the keyboard and assert on the options that come out — the same
 * contract the printed "equivalent command" makes to the user.
 *
 * The machine's toolchain must not decide what the session asks, so every test
 * injects a scripted {@link SessionDeps} instead of probing `PATH` for real.
 */

const TEST_TIMEOUT_MS = 60_000

function spec(binary: string): SystemToolSpec {
  return {
    binary: binary as SystemToolSpec['binary'],
    versionArgs: ['--version'],
    install: `brew install ${binary}`,
  }
}

/**
 * A scripted toolchain: `versions` says what is installed, `brew`/`installOk`
 * script the install path, and `installed` records what got installed.
 */
function toolchain(
  versions: Record<string, string | undefined>,
  options: { brew?: boolean; installOk?: boolean } = {},
) {
  const installed: string[] = []
  const deps: SessionDeps = {
    checkSystemTools: () =>
      Promise.resolve(
        Object.entries(versions).map(([binary, version]): SystemToolStatus => ({
          spec: spec(binary),
          purpose: `${binary} purpose`,
          version,
        })),
      ),
    hasBrew: () => Promise.resolve(options.brew ?? true),
    install: (toolSpec) => {
      installed.push(toolSpec.binary)
      return Promise.resolve(options.installOk ?? true)
    },
  }
  return { deps, installed }
}

/** Every tool present: the session shows status and asks nothing extra. */
const ALL_INSTALLED = () =>
  toolchain({ gitleaks: '8.30.1', opengrep: '1.26.0', 'osv-scanner': '2.4.0' }).deps

// The keys a session is scripted with, named the way readline names them.
const key = (name: string): PromptKey => ({ name })
const ENTER = key('return')
const ESC = key('escape')
const DOWN = key('down')
const UP = key('up')
const SPACE = key('space')
/** A run of printable characters, as the path edit receives them. */
const typed = (text: string): PromptKey[] => [...text].map((sequence) => ({ sequence }))

// The repaint traffic the widgets write; stripped so assertions see the text.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g

/** A PromptIO fed from a fixed keypress list. */
function scriptedIO(keys: readonly PromptKey[]) {
  const queue = [...keys]
  const transcript: string[] = []
  const io: PromptIO = {
    say: (line) => void transcript.push(line),
    write: (chunk) => void transcript.push(chunk),
    nextKey: () =>
      queue.length === 0
        ? Promise.reject(new Error('session asked for a key the script did not provide'))
        : Promise.resolve(queue.shift() as PromptKey),
  }
  return {
    io,
    text: () => transcript.join('\n').replaceAll(ANSI, ''),
    exhausted: () => queue.length === 0,
  }
}

describe('interactive session', () => {
  let fixture: FixtureRepo

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it(
    'accepting every default yields a plain whole-repo quick scan',
    async () => {
      // depth, categories, gate, output dir, final confirm — no scope question,
      // because the only branch is the one we are on, and no security keys,
      // because every tool is already installed.
      const { io, text, exhausted } = scriptedIO([ENTER, ENTER, ENTER, ENTER, ENTER])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.run).toBe(true)
      expect(session.options).toMatchObject({
        path: fixture.root,
        pr: undefined,
        deep: false,
        only: undefined,
        failUnder: undefined,
        allowMissing: false,
        out: undefined,
        interactive: false,
      })
      expect(exhausted()).toBe(true)
      expect(text()).toContain('whole-repo scan')
      // A language with nothing in the tree still gets its count: absence is
      // rendered, never elided, for every member of LANGUAGES in order.
      expect(text()).toContain(' JS/TS · 0 Python · 0 C#')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'the probe reads the repo without leaving a footprint',
    async () => {
      const probe = await probeRepo(fixture.root)
      expect(probe.fileCounts.map(({ language }) => language)).toEqual([...LANGUAGES])
      const counts = Object.fromEntries(
        probe.fileCounts.map(({ language, count }) => [language, count]),
      )
      expect(counts['js-ts']).toBeGreaterThan(0)
      expect(counts['python']).toBe(0)
      expect(counts['csharp']).toBe(0)
      expect(probe.projects).toEqual(['.'])
      expect(probe.currentBranch).toBe('main')
      expect(probe.baseCandidates).toEqual([])
      expect(await fixture.status()).toBe('')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'spacebar-picked categories and an arrowed gate survive into the options',
    async () => {
      // depth: quick. categories: `a` clears all eight, space re-picks types
      // (row 2) and lint (row 6). gate: two rows down is B. allow-missing: No.
      const { io, exhausted } = scriptedIO([
        ENTER,
        key('a'),
        DOWN,
        SPACE,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        SPACE,
        ENTER,
        DOWN,
        DOWN,
        ENTER,
        ENTER,
        ENTER,
        ENTER,
      ])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      // Selection order is irrelevant: the subset comes out in canonical
      // category order, exactly as --only normalizes it.
      expect(session.options.only).toEqual(['types', 'lint'])
      expect(session.options.failUnder).toBe('B')
      // test-quality is not selected, so the tailored yes-default does not
      // apply and the gate stays strict.
      expect(session.options.allowMissing).toBe(false)
      expect(exhausted()).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a quick-mode gate over all categories defaults to --allow-missing',
    async () => {
      // depth, categories=all, gate=B, allow-missing (default yes), out, confirm.
      const { io, text } = scriptedIO([ENTER, ENTER, DOWN, DOWN, ENTER, ENTER, ENTER, ENTER])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.failUnder).toBe('B')
      expect(session.options.allowMissing).toBe(true)
      expect(text()).toContain('quick mode always leaves test-quality not-assessed')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'unbound keys are ignored and an empty category selection cannot confirm',
    async () => {
      // depth: "x" does nothing, then arrow to Deep. categories: `a` empties
      // the selection, enter is refused, `a` restores all, enter confirms.
      const { io, text, exhausted } = scriptedIO([
        key('x'),
        DOWN,
        ENTER,
        key('a'),
        ENTER,
        key('a'),
        ENTER,
        ENTER,
        ENTER,
        ENTER,
      ])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.deep).toBe(true)
      expect(session.options.only).toBeUndefined()
      expect(text()).toContain('keep at least one selected')
      expect(exhausted()).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'escape steps back to the previous question with the draft answer intact',
    async () => {
      // depth: Deep. categories: escape — back to depth, which now defaults to
      // Deep, so one arrow up re-picks Quick. Then defaults to the end.
      const { io } = scriptedIO([DOWN, ENTER, ESC, UP, ENTER, ENTER, ENTER, ENTER, ENTER])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.deep).toBe(false)
      expect(session.run).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a digit jumps straight to that menu entry',
    async () => {
      // gate menu: 1 is "No gate", so 3 is B.
      const { io } = scriptedIO([ENTER, ENTER, { sequence: '3' }, ENTER, ENTER, ENTER])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())
      expect(session.options.failUnder).toBe('B')
      expect(session.options.allowMissing).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a custom output path is the one place the session asks for typing',
    async () => {
      // out: one arrow down to "Somewhere else…", then the typed path.
      const { io } = scriptedIO([
        ENTER,
        ENTER,
        ENTER,
        DOWN,
        ENTER,
        ...typed('/tmp/health-x'),
        ENTER,
        ENTER,
      ])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.out).toBe('/tmp/health-x')
      expect(equivalentCommand(session.options)).toContain('--out /tmp/health-x')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'declining the final confirmation does not run',
    async () => {
      const { io } = scriptedIO([ENTER, ENTER, ENTER, ENTER, key('n')])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())
      expect(session.run).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'Ctrl-C anywhere cancels the whole session',
    async () => {
      const { io } = scriptedIO([{ name: 'c', ctrl: true }])
      await expect(
        runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED()),
      ).rejects.toSatisfy(isPromptCancelled)
    },
    TEST_TIMEOUT_MS,
  )
})

describe('interactive session on a feature branch', () => {
  let fixture: FixtureRepo

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
    const git = (args: string[]) => execa('git', args, { cwd: fixture.root, env: COMMIT_IDENTITY })
    await git(['checkout', '--quiet', '-b', 'feature'])
    await git(['commit', '--quiet', '--allow-empty', '--no-gpg-sign', '--message', 'work'])
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it(
    'offers main as a PR base and arrowing onto it sets --pr',
    async () => {
      // scope: one arrow down is "Changes vs main"; defaults from there on.
      const { io, text } = scriptedIO([DOWN, ENTER, ENTER, ENTER, ENTER, ENTER, ENTER])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.pr).toBe('main')
      expect(text()).toContain('Changes vs main')
      expect(equivalentCommand(session.options)).toBe(`npx crank-health --pr main ${fixture.root}`)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a --pr flag passed alongside -i becomes the scope default',
    async () => {
      // Accept every default: scope defaults to the passed base.
      const { io } = scriptedIO([ENTER, ENTER, ENTER, ENTER, ENTER, ENTER])
      const session = await runInteractiveSession(
        parseCliArgs(['--pr', 'main', fixture.root]),
        io,
        ALL_INSTALLED(),
      )
      expect(session.options.pr).toBe('main')
    },
    TEST_TIMEOUT_MS,
  )
})

describe('security tool walkthrough', () => {
  let fixture: FixtureRepo

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await fixture.remove()
  })

  it(
    'shows status and offers installs for missing tools; declining installs nothing',
    async () => {
      const { deps, installed } = toolchain({ gitleaks: undefined, opengrep: '1.26.0' })
      // depth, categories, install gitleaks? (default No), gate, out, confirm.
      const { io, text, exhausted } = scriptedIO([ENTER, ENTER, ENTER, ENTER, ENTER, ENTER])
      await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      expect(text()).toContain('✗ gitleaks')
      expect(text()).toContain('✓ opengrep 1.26.0')
      expect(text()).toContain('skipped — later: brew install gitleaks')
      expect(installed).toEqual([])
      expect(exhausted()).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'pressing y on an install offer runs it and reports success',
    async () => {
      const { deps, installed } = toolchain({ gitleaks: undefined })
      const { io, text } = scriptedIO([ENTER, ENTER, key('y'), ENTER, ENTER, ENTER])
      await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      expect(installed).toEqual(['gitleaks'])
      expect(text()).toContain('✓ gitleaks installed')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a failed install reports the hint and the session continues',
    async () => {
      const { deps, installed } = toolchain({ gitleaks: undefined }, { installOk: false })
      const { io, text } = scriptedIO([ENTER, ENTER, key('y'), ENTER, ENTER, ENTER])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      expect(installed).toEqual(['gitleaks'])
      expect(text()).toContain('✗ gitleaks install failed — brew install gitleaks')
      expect(session.run).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'without Homebrew it prints the hints and asks nothing',
    async () => {
      const { deps, installed } = toolchain({ gitleaks: undefined }, { brew: false })
      // depth, categories, gate, out, confirm — no install question.
      const { io, text, exhausted } = scriptedIO([ENTER, ENTER, ENTER, ENTER, ENTER])
      await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      expect(text()).toContain('Homebrew was not found')
      expect(text()).toContain('brew install gitleaks')
      expect(installed).toEqual([])
      expect(exhausted()).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'is skipped entirely when security is not among the selected categories',
    async () => {
      const deps: SessionDeps = {
        checkSystemTools: () => Promise.reject(new Error('must not be called')),
        hasBrew: () => Promise.reject(new Error('must not be called')),
        install: () => Promise.reject(new Error('must not be called')),
      }
      // categories: clear all, arrow to lint (row 6), pick it alone.
      const { io } = scriptedIO([
        ENTER,
        key('a'),
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        DOWN,
        SPACE,
        ENTER,
        ENTER,
        ENTER,
        ENTER,
      ])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)
      expect(session.options.only).toEqual(['lint'])
    },
    TEST_TIMEOUT_MS,
  )
})

describe('the header’s file counts', () => {
  let root: string

  beforeAll(async () => {
    // Not a checked-in fixture: the exact counts are the point, so the tree is
    // built here — two JS files, one C# file, no Python at all.
    root = await mkdtemp(join(tmpdir(), 'crank-interactive-counts-'))
    await writeFile(join(root, 'a.js'), 'export const a = 1\n')
    await writeFile(join(root, 'b.js'), 'export const b = 2\n')
    await writeFile(join(root, 'c.cs'), 'class C { }\n')
    const git = (args: string[]) => execa('git', args, { cwd: root, env: COMMIT_IDENTITY })
    await git(['init', '--quiet', '--initial-branch=main'])
    await git(['add', '--all'])
    await git(['commit', '--quiet', '--no-gpg-sign', '--message', 'fixture'])
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'renders one count per language, dot-separated, in canonical order',
    async () => {
      const { io, text } = scriptedIO([ENTER, ENTER, ENTER, ENTER, ENTER])
      await runInteractiveSession(parseCliArgs([root]), io, ALL_INSTALLED())
      expect(text()).toContain('2 JS/TS · 0 Python · 1 C#')
    },
    TEST_TIMEOUT_MS,
  )
})

describe('equivalentCommand', () => {
  it('reproduces the full flag surface in a stable order', () => {
    const options = parseCliArgs([
      '--pr',
      'main',
      '--project',
      'packages/api',
      '--deep',
      '--only',
      'lint,types',
      '--fail-under',
      'B',
      '--allow-missing',
      '--out',
      '/tmp/health',
      '--timeout',
      '30',
      'repo',
    ])
    expect(equivalentCommand(options)).toBe(
      'npx crank-health --pr main --project packages/api --deep --only lint,types --fail-under B --allow-missing --out /tmp/health --timeout 30 repo',
    )
  })

  it('collapses an all-defaults scan of the cwd to the bare command', () => {
    expect(equivalentCommand(parseCliArgs([]))).toBe('npx crank-health')
  })
})
