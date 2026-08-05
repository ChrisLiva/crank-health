import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/args.ts'
import { equivalentCommand, probeRepo, runInteractiveSession } from '../src/interactive.ts'
import type { PromptIO } from '../src/interactive.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { COMMIT_IDENTITY, createFixtureRepo } from './support/fixture.ts'

/**
 * The interactive walk-through is a front-end over `CliOptions`, so these
 * tests script the prompts and assert on the options that come out — the same
 * contract the printed "equivalent command" makes to the user.
 */

const TEST_TIMEOUT_MS = 60_000

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
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io)

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
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io)

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
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io)

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
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io)

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
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io)
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
      const session = await runInteractiveSession(parseCliArgs([fixture.root]), io)

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
      const session = await runInteractiveSession(parseCliArgs(['--pr', 'main', fixture.root]), io)
      expect(session.options.pr).toBe('main')
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
