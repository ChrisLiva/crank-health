import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import type { HistoryRepo, HistorySpec } from './support/history.ts'
import { createHistoryRepo, paddedFile } from './support/history.ts'
import { CLEAN, CONST_ASSIGN } from './support/pr-fixture.ts'
import { GOLDEN_TOOLCHAIN } from './support/system-tools.ts'

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

/** Every test here shells out to a real scan, and a cold one fetches tools; `--pr` runs two. */
const CLI_TIMEOUT_MS = 240_000

/** Runs the CLI as a real process so exit codes and streams are the real ones. */
function runCli(args: readonly string[], env: Record<string, string> = {}) {
  return execa('node', [CLI_ENTRY, ...args], { reject: false, env, extendEnv: true })
}

/** Signal 0 tests for existence without delivering anything. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe(
  'crank-health binary',
  () => {
    let fixture: FixtureRepo
    let out: string

    beforeAll(async () => {
      fixture = await createFixtureRepo('js-basic')
      out = await mkdtemp(join(tmpdir(), 'crank-cli-'))
    })

    afterAll(async () => {
      await fixture.remove()
      await rm(out, { recursive: true, force: true })
    })

    it('prints usage and the flag surface for --help, and exits 0', async () => {
      const result = await runCli(['--help'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Usage:')
      expect(result.stdout).toContain('npx crank-health [path]')
      // The flags a caller of this binary is entitled to find in its help.
      for (const flag of ['--pr', '--project', '--deep', '--only', '--fail-under', '--out']) {
        expect(result.stdout).toContain(flag)
      }
      expect(result.stdout).toContain('Exit codes:')
    })

    it('prints the version and exits 0', async () => {
      const result = await runCli(['--version'])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
    })

    it('exits 2 with a message on an unknown flag', async () => {
      const result = await runCli(['--bogus'])
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--bogus')
      expect(result.stderr).toContain('--help')
    })

    it('exits 2 on a path that is not a directory', async () => {
      const result = await runCli([join(fixture.root, 'README.md')])
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('not a directory')
    })

    it('scans a repo and prints the grades table, exit 0', async () => {
      const result = await runCli(['--out', out, fixture.root], { NO_COLOR: '1' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('lint')
      expect(result.stdout).toContain('test quality')
      expect(result.stdout).toContain('not assessed — run `--deep`')
      expect(result.stdout).toContain('eslint(no-const-assign)')
      // NO_COLOR is honoured: not one escape sequence on the way out.
      expect(result.stdout).not.toContain('\u001B[')
    })

    // The three release-binary scanners add findings and change what is
    // assessed; see `support/system-tools.ts`.
    it.runIf(GOLDEN_TOOLCHAIN)('prints report.json and nothing else with --json', async () => {
      const result = await runCli(['--json', '--out', out, fixture.root])
      expect(result.exitCode).toBe(0)
      const report = JSON.parse(result.stdout) as {
        advisories: unknown[]
        findings: unknown[]
        schemaVersion: number
      }
      expect(report.schemaVersion).toBe(2)
      // js-basic's seven graded findings: six from the language runners plus
      // aislop's `ai-slop/unreachable-code` on the same statement oxlint's
      // `no-unreachable` reports.
      expect(report.findings).toHaveLength(7)
      expect(report.advisories).toHaveLength(1)
    })

    it('exits 1 when --fail-under is tripped, naming the categories', async () => {
      const result = await runCli([
        '--only',
        'lint',
        '--fail-under',
        'B',
        '--out',
        out,
        fixture.root,
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('lint F')
    })

    it.runIf(GOLDEN_TOOLCHAIN)(
      'trips the gate on categories nothing assessed, unless --allow-missing',
      async () => {
        const strict = await runCli(['--fail-under', 'F', '--out', out, fixture.root])
        expect(strict.exitCode).toBe(1)
        expect(strict.stderr).toContain('security not-assessed')

        const lenient = await runCli([
          '--fail-under',
          'F',
          '--allow-missing',
          '--out',
          out,
          fixture.root,
        ])
        expect(lenient.exitCode).toBe(0)
      },
    )

    /**
     * `--deep` on a repo with no mutation tooling: the profile is deep, the run
     * completes, and test quality is not-assessed for the honest reason rather
     * than the quick profile's "run `--deep`" (spec §5, §8).
     */
    it('runs the deep profile and says why a repo without mutation tooling has no score', async () => {
      const result = await runCli(['--deep', '--only', 'test-quality', '--out', out, fixture.root])

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('deep')
      const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as {
        profile: string
        categories: Record<string, { status: string; reason?: string }>
      }
      expect(report.profile).toBe('deep')
      expect(report.categories['test-quality']?.status).toBe('not-assessed')
      expect(report.categories['test-quality']?.reason).not.toContain('run `--deep`')
    })

    /**
     * Acceptance criterion 4: a run leaves the target's `git status` empty. With
     * the repo itself as the run directory it could not — so the run never
     * starts, and nothing is written.
     */
    it('exits 2 when --out is the repo itself, before writing anything', async () => {
      const result = await execa('node', [CLI_ENTRY, '--out', '.'], {
        reject: false,
        cwd: fixture.root,
        extendEnv: true,
      })
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('is the repo itself')
      expect(await fixture.status()).toBe('')
    })

    /**
     * Spec §5's "per-tool timeout 120s (configurable)", and the thing a budget
     * has to mean: the run is over when the budget is.
     *
     * The stub is a shell that backgrounds a 60-second sleep and waits on it —
     * the shape of every real tool here, where `npx`, `uvx` or a `.bin` wrapper
     * spawns the analyzer. Terminating only the direct child leaves the sleep
     * holding the stdout pipe crank-health is reading, and the CLI cannot exit
     * until it finishes on its own: a one-tool hang becomes a run that never
     * returns. So this asserts three things at once — the budget is honoured, the
     * process leaves promptly, and the whole tree is gone with it.
     */
    it('applies --timeout as the per-tool budget, and takes the tool’s children with it', async () => {
      const slow = await createFixtureRepo('js-basic')
      const budgeted = await mkdtemp(join(tmpdir(), 'crank-cli-timeout-'))
      const pidFile = join(budgeted, 'grandchild.pid')
      try {
        await writeFile(join(slow.root, '.oxlintrc.json'), '{}\n')
        await mkdir(join(slow.root, 'node_modules', '.bin'), { recursive: true })
        await writeFile(
          join(slow.root, 'node_modules', '.bin', 'oxlint'),
          `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n`,
          { mode: 0o755 },
        )

        const startedAt = Date.now()
        const result = await runCli([
          '--only',
          'lint',
          '--timeout',
          '1',
          '--out',
          budgeted,
          slow.root,
        ])
        const elapsedMs = Date.now() - startedAt

        expect(result.exitCode).toBe(0)
        const report = JSON.parse(await readFile(join(budgeted, 'report.json'), 'utf8')) as {
          tools: { tool: string; state: string; reason: string | null }[]
          findings: { tool: string }[]
        }
        const oxlint = report.tools.find((tool) => tool.tool === 'oxlint')
        expect(oxlint).toMatchObject({ tool: 'oxlint', state: 'timeout' })
        expect(oxlint?.reason).toContain('budget')
        // A tool the budget stopped contributes nothing: the report carries no
        // finding from it. The lint *category* is not asserted here, because
        // aislop is the other runner in it and a 1 s budget is a race against
        // its `npx` fetch — whether the category ends up graded is that race's
        // answer, not this test's subject.
        expect(report.findings.some((finding) => finding.tool === 'oxlint')).toBe(false)

        // Far inside the 60s the abandoned sleep would otherwise have run for.
        expect(elapsedMs).toBeLessThan(20_000)
        expect(isRunning(Number((await readFile(pidFile, 'utf8')).trim()))).toBe(false)
      } finally {
        await slow.remove()
        await rm(budgeted, { recursive: true, force: true })
      }
    })

    it('exits 2 on a --pr base that does not exist here', async () => {
      const result = await runCli(['--pr', 'no-such-branch', '--out', out, fixture.root])
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('unknown base ref "no-such-branch"')
    })
  },
  CLI_TIMEOUT_MS,
)

/**
 * A workspace whose two packages answer the same question differently: `big` is
 * two thousand clean lines (one statement, so it is not the empty file oxlint
 * would flag, and padding for the rest), `small` is five lines with a `const`
 * reassignment in them. One finding over both packages' KLOC is a B for the
 * blend and an F for the package it is actually in — which is the whole reason
 * the gate is asked per project and not only of the rollup.
 */
const MONO_GATE: HistorySpec = {
  base: {
    'package.json': `${JSON.stringify({ name: 'mono-gate', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
    'packages/big/package.json': `${JSON.stringify({ name: 'big', version: '0.0.0', private: true }, null, 2)}\n`,
    'packages/big/src/index.js': paddedFile(2000, { 1: 'export const value = 1' }),
    'packages/small/package.json': `${JSON.stringify({ name: 'small', version: '0.0.0', private: true }, null, 2)}\n`,
    'packages/small/src/index.js': CONST_ASSIGN,
  },
  head: [],
}

/** The keys these tests read back out of `report.json`. */
interface GateReport {
  readonly scopedTo?: readonly string[]
  readonly categories: Record<string, { status: string; grade?: string }>
  readonly projects: {
    path: string
    categories: Record<string, { status: string; grade?: string }>
  }[]
  readonly tools: { tool: string; project: string }[]
}

describe(
  'crank-health --project and the gate',
  () => {
    let repo: HistoryRepo
    let out: string

    beforeAll(async () => {
      repo = await createHistoryRepo(MONO_GATE)
      out = await mkdtemp(join(tmpdir(), 'crank-cli-mono-'))
    }, CLI_TIMEOUT_MS)

    afterAll(async () => {
      await repo.remove()
      await rm(out, { recursive: true, force: true })
    })

    async function report(): Promise<GateReport> {
      return JSON.parse(await readFile(join(out, 'report.json'), 'utf8')) as GateReport
    }

    it('exits 1 for a package below the threshold, though the rollup clears it', async () => {
      const result = await runCli(['--only', 'lint', '--fail-under', 'B', '--out', out, repo.root])

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('packages/small lint F')
      // The blend really does pass: without the per-project gate this run
      // would have exited 0 on a package graded F.
      expect((await report()).categories['lint']).toEqual({ status: 'graded', grade: 'B' })
    })

    it('scopes the scan and the rollup to --project, and exits 0', async () => {
      const result = await runCli([
        '--only',
        'lint,security',
        '--project',
        'packages/big',
        '--fail-under',
        'B',
        '--allow-missing',
        '--out',
        out,
        repo.root,
      ])
      expect(result.exitCode).toBe(0)

      const scoped = await report()
      expect(scoped.projects.map((project) => project.path)).toEqual(['packages/big'])
      // …and the report records what the rollup above it was computed over.
      expect(scoped.scopedTo).toEqual(['packages/big'])
      // The rollup is what was scanned: `small`'s finding is not in it.
      expect(scoped.categories['lint']).toEqual({ status: 'graded', grade: 'A' })
      // …and a repo-spanning runner still spans the repo under scoping
      // (spec acceptance criterion 7).
      expect(scoped.tools.some((tool) => tool.project === 'repo')).toBe(true)
    })

    it('exits 2 on an unknown --project, listing the projects it did find', async () => {
      const result = await runCli(['--project', 'packages/nope', '--out', out, repo.root])

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('unknown --project "packages/nope"')
      expect(result.stderr).toContain('packages/big, packages/small')
    })
  },
  CLI_TIMEOUT_MS,
)

describe(
  'crank-health --pr',
  () => {
    let repo: HistoryRepo
    let out: string

    beforeAll(async () => {
      repo = await createHistoryRepo({
        base: { 'src/a.js': CLEAN },
        head: [{ write: 'src/a.js', content: CONST_ASSIGN }],
      })
      out = await mkdtemp(join(tmpdir(), 'crank-cli-pr-'))
    })

    afterAll(async () => {
      await repo.remove()
      await rm(out, { recursive: true, force: true })
    })

    it('prints the delta summary and exits 0', async () => {
      const result = await runCli(['--pr', 'main', '--out', out, repo.root], { NO_COLOR: '1' })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('PR delta vs main')
      expect(result.stdout).toContain('+1 new (1 on changed lines) · -0 resolved')
      expect(result.stdout).toContain('Top new findings')
      expect(result.stdout).toContain('eslint(no-const-assign)')

      // …and the two-scan run left the target clean, with no worktree behind it.
      expect(await repo.status()).toBe('')
      expect(await repo.worktrees()).toEqual([await realpath(repo.root)])
    })
  },
  CLI_TIMEOUT_MS,
)
