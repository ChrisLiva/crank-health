import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/args.ts'
import type { SystemToolSpec } from '../src/adapters/common/system-tool.ts'
import { equivalentCommand, probeRepo, runInteractiveSession } from '../src/interactive.ts'
import type { PromptIO, SessionDeps, SystemToolStatus } from '../src/interactive.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { COMMIT_IDENTITY, createFixtureRepo } from './support/fixture.ts'

/**
 * The interactive walk-through is a front-end over `CliOptions`, so these
 * tests script the prompts and assert on the options that come out — the same
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

/** A PromptIO fed from a fixed answer list; empty string = accept the default. */
function scriptedIO(answers: readonly string[]) {
  const queue = [...answers]
  const transcript: string[] = []
  const io: PromptIO = {
    say: (line) => void transcript.push(line),
    ask: (prompt) => {
      transcript.push(prompt)
      if (queue.length === 0) throw new Error(`unexpected prompt: ${prompt}`)
      return Promise.resolve(queue.shift() as string)
    },
  }
  return { io, transcript, exhausted: () => queue.length === 0 }
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
      // because the only branch is the one we are on.
      const { io, transcript, exhausted } = scriptedIO(['', '', '', '', ''])
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
      expect(transcript.join('\n')).toContain('whole-repo scan')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'the probe reads the repo without leaving a footprint',
    async () => {
      const probe = await probeRepo(fixture.root)
      expect(probe.jsTsFiles).toBeGreaterThan(0)
      expect(probe.pythonFiles).toBe(0)
      expect(probe.currentBranch).toBe('main')
      expect(probe.baseCandidates).toEqual([])
      expect(await fixture.status()).toBe('')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a category subset and a gate survive into the options',
    async () => {
      // depth=quick, categories, gate, allow-missing, out dir, confirm.
      const { io } = scriptedIO(['1', 'lint, types', 'b', '', '', ''])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.only).toEqual(['lint', 'types'])
      expect(session.options.failUnder).toBe('B')
      // test-quality is not selected, so the tailored yes-default does not
      // apply and the gate stays strict.
      expect(session.options.allowMissing).toBe(false)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a quick-mode gate over all categories defaults to --allow-missing',
    async () => {
      // depth, categories=all, gate=B, allow-missing (default yes), out, confirm.
      const { io, transcript } = scriptedIO(['', '', 'B', '', '', ''])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.failUnder).toBe('B')
      expect(session.options.allowMissing).toBe(true)
      expect(transcript.join('\n')).toContain('quick mode always leaves test-quality not-assessed')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'invalid answers re-prompt instead of failing',
    async () => {
      // depth: "9" is out of range, then deep; categories: unknown, then valid;
      // gate, out dir, confirm all default.
      const { io, exhausted } = scriptedIO(['9', '2', 'nope', 'lint', '', '', ''])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.deep).toBe(true)
      expect(session.options.only).toEqual(['lint'])
      expect(exhausted()).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'declining the final confirmation does not run',
    async () => {
      const { io } = scriptedIO(['', '', '', '', 'n'])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())
      expect(session.run).toBe(false)
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
    'offers main as a PR base and choosing it sets --pr',
    async () => {
      // scope=2 (changes vs main), depth, categories, gate, out dir, confirm.
      const { io, transcript } = scriptedIO(['2', '', '', '', '', ''])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, ALL_INSTALLED())

      expect(session.options.pr).toBe('main')
      expect(transcript.join('\n')).toContain('Changes vs main')
      expect(equivalentCommand(session.options)).toBe(`npx crank-health --pr main ${fixture.root}`)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a --pr flag passed alongside -i becomes the scope default',
    async () => {
      // Accept every default: scope defaults to the passed base.
      const { io } = scriptedIO(['', '', '', '', '', ''])
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
      // depth, categories, install gitleaks? (default no), gate, out, confirm.
      const { io, transcript, exhausted } = scriptedIO(['', '', '', '', '', ''])
      await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      const text = transcript.join('\n')
      expect(text).toContain('✗ gitleaks')
      expect(text).toContain('✓ opengrep 1.26.0')
      expect(text).toContain('skipped — later: brew install gitleaks')
      expect(installed).toEqual([])
      expect(exhausted()).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'accepting an install runs it and reports success',
    async () => {
      const { deps, installed } = toolchain({ gitleaks: undefined })
      const { io, transcript } = scriptedIO(['', '', 'y', '', '', ''])
      await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      expect(installed).toEqual(['gitleaks'])
      expect(transcript.join('\n')).toContain('✓ gitleaks installed')
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a failed install reports the hint and the session continues',
    async () => {
      const { deps, installed } = toolchain({ gitleaks: undefined }, { installOk: false })
      const { io, transcript } = scriptedIO(['', '', 'y', '', '', ''])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      expect(installed).toEqual(['gitleaks'])
      expect(transcript.join('\n')).toContain('✗ gitleaks install failed — brew install gitleaks')
      expect(session.run).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'without Homebrew it prints the hints and asks nothing',
    async () => {
      const { deps, installed } = toolchain({ gitleaks: undefined }, { brew: false })
      // depth, categories, gate, out, confirm — no install question.
      const { io, transcript, exhausted } = scriptedIO(['', '', '', '', ''])
      await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)

      const text = transcript.join('\n')
      expect(text).toContain('Homebrew was not found')
      expect(text).toContain('brew install gitleaks')
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
      // depth, categories=lint, gate, out, confirm.
      const { io } = scriptedIO(['', 'lint', '', '', ''])
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io, deps)
      expect(session.options.only).toEqual(['lint'])
    },
    TEST_TIMEOUT_MS,
  )
})

describe('equivalentCommand', () => {
  it('reproduces the full flag surface in a stable order', () => {
    const options = parseCliArgs([
      '--pr',
      'main',
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
      'npx crank-health --pr main --deep --only lint,types --fail-under B --allow-missing --out /tmp/health --timeout 30 repo',
    )
  })

  it('collapses an all-defaults scan of the cwd to the bare command', () => {
    expect(equivalentCommand(parseCliArgs([]))).toBe('npx crank-health')
  })
})
