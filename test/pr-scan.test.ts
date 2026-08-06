import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LanguageAdapter, ToolRunner } from '../src/core/types.ts'
import type { HealthScanResult } from '../src/run.ts'
import { runPrScan } from '../src/run-pr.ts'
import type { HistoryRepo } from './support/history.ts'
import { createHistoryRepo, paddedFile } from './support/history.ts'
import { CLEAN, CONST_ASSIGN, GOLDEN_HISTORY } from './support/pr-fixture.ts'
import { normalizePrMarkdown, normalizePrReport } from './support/report.ts'

/**
 * `--pr` end to end, on scripted histories (spec acceptance criterion 3).
 *
 * Every scan here is `--only lint`: lint findings are the cheapest signal that
 * exercises the whole pipeline, and a PR run is two full scans. What the delta
 * then *decides* is covered exhaustively and instantly by `delta.test.ts`; what
 * these prove is that a real pair of scans over a real git history feeds it the
 * right findings, renames and touched lines.
 */

/** Two scans, each fetching pinned tools on a cold npm cache. */
const SCAN_TIMEOUT_MS = 240_000

async function scanPr(repo: HistoryRepo): Promise<HealthScanResult> {
  return runPrScan({ path: repo.root, base: 'main', only: ['lint'] })
}

/** The delta a test asserts on, in the fewest fields that carry the claim. */
function shape(result: HealthScanResult) {
  const delta = result.report.delta
  return {
    new: (delta?.newFindings ?? []).map((finding) => ({
      rule: finding.rule,
      file: finding.file,
      line: finding.range.startLine,
      touchedLine: finding.touchedLine,
    })),
    resolved: (delta?.resolvedFindings ?? []).map((finding) => ({
      rule: finding.rule,
      file: finding.file,
    })),
  }
}

describe('a change that introduces a finding', () => {
  let repo: HistoryRepo
  let result: HealthScanResult

  beforeAll(async () => {
    repo = await createHistoryRepo({
      base: { 'src/a.js': 'export const value = 1\n' },
      head: [{ write: 'src/a.js', content: CONST_ASSIGN }],
    })
    result = await scanPr(repo)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await repo.remove()
  })

  it('reports exactly the new finding, flagged as on a touched line', () => {
    expect(shape(result)).toEqual({
      new: [
        {
          rule: 'eslint(no-const-assign)',
          file: 'src/a.js',
          line: 2,
          touchedLine: true,
        },
      ],
      resolved: [],
    })
    expect(result.report.delta?.counts).toEqual({
      new: 1,
      touchedLine: 1,
      resolved: 0,
      unchanged: 0,
    })
  })

  it('records the grade movement the change caused, with the base state', () => {
    const lint = result.report.delta?.categories.find((entry) => entry.category === 'lint')
    expect(lint).toEqual({
      category: 'lint',
      base: { status: 'graded', grade: 'A' },
      head: { status: 'graded', grade: 'F' },
      newFindings: 1,
      resolvedFindings: 0,
    })
  })

  it('is a PR report about head, pinned to the head commit and the merge base', () => {
    expect(result.report.mode).toBe('pr')
    expect(result.report.repo.commit).toBe(repo.headCommit)
    expect(result.report.delta?.baseRef).toBe('main')
    expect(result.report.delta?.mergeBase).toBe(repo.baseCommit)
    // Head's own findings and grades are the report's; the delta is what moved.
    expect(result.report.findings).toHaveLength(1)
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'F' })
  })

  it('keeps each side’s evidence apart, base under raw/base/', async () => {
    const raw = result.report.tools.flatMap((tool) => tool.raw)
    expect(raw).toContain('raw/root/oxlint.sarif.json')
    expect(raw).toContain('raw/base/root/oxlint.sarif.json')
    expect(await readdir(join(result.outputDir, 'raw', 'base', 'root'))).toContain(
      'oxlint.sarif.json',
    )
  })

  it('leaves the target repo clean, with no leftover worktree', async () => {
    expect(await repo.status()).toBe('')
    expect(await repo.worktrees()).toEqual([await realRoot(repo)])
  })

  it(
    'produces byte-identical output when run twice on the same two commits',
    async () => {
      const second = await scanPr(repo)
      expect(normalizePrReport(second.json)).toBe(normalizePrReport(result.json))
    },
    SCAN_TIMEOUT_MS,
  )
})

describe('a change that resolves a finding', () => {
  let repo: HistoryRepo
  let result: HealthScanResult

  beforeAll(async () => {
    repo = await createHistoryRepo({
      base: { 'src/a.js': CONST_ASSIGN },
      head: [{ write: 'src/a.js', content: CLEAN }],
    })
    result = await scanPr(repo)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await repo.remove()
  })

  it('reports the finding resolved and nothing new', () => {
    expect(shape(result)).toEqual({
      new: [],
      resolved: [{ rule: 'eslint(no-const-assign)', file: 'src/a.js' }],
    })
    expect(result.report.categories.lint).toEqual({ status: 'graded', grade: 'A' })
  })

  it('lists the resolved finding in agent.md as context, with no task', () => {
    expect(result.agentMarkdown).toContain('## Resolved by this change (1)')
    expect(result.agentMarkdown).toContain('Context only — nothing to do here.')
    expect(result.agentMarkdown).toContain('No tasks: this change introduced no new findings.')
  })
})

/**
 * Spec §2's rename mapping. The content is byte-identical, so git reports
 * `R100` and the base findings are re-hashed under the new path before anything
 * is compared — which is the difference between "nothing happened" and "one
 * finding resolved, one identical finding introduced".
 */
describe('a change that renames a file carrying findings', () => {
  let repo: HistoryRepo
  let result: HealthScanResult

  beforeAll(async () => {
    repo = await createHistoryRepo({
      base: { 'src/a.js': CONST_ASSIGN },
      head: [{ rename: 'src/a.js', to: 'src/renamed.js' }],
    })
    result = await scanPr(repo)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await repo.remove()
  })

  it('reports no churn: the finding’s identity survives the move', () => {
    expect(shape(result)).toEqual({ new: [], resolved: [] })
    expect(result.report.delta?.counts.unchanged).toBe(1)
    // The finding is still there, at its new path.
    expect(result.report.findings.map((finding) => finding.file)).toEqual(['src/renamed.js'])
  })
})

/**
 * The line-shift-proof promise of spec §2, end to end: identity is the trimmed
 * flagged line, not its line number, so inserting above a finding must not make
 * it look resolved-and-reintroduced.
 */
describe('a change that inserts lines above a finding', () => {
  let repo: HistoryRepo
  let result: HealthScanResult

  beforeAll(async () => {
    repo = await createHistoryRepo({
      base: { 'src/a.js': CONST_ASSIGN },
      head: [{ write: 'src/a.js', content: `// a note\n// and another\n${CONST_ASSIGN}` }],
    })
    result = await scanPr(repo)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await repo.remove()
  })

  it('reports neither a new nor a resolved finding', () => {
    expect(shape(result)).toEqual({ new: [], resolved: [] })
    expect(result.report.delta?.counts.unchanged).toBe(1)
  })

  it('still reports the finding, at its shifted line', () => {
    expect(result.report.findings.map((finding) => finding.range.startLine)).toEqual([4])
  })
})

/**
 * Spec §4: "non-local regressions included". Here the head commit changes one
 * line (an early `return`), and the findings it causes are forty lines below
 * it, on lines the diff never touched. Both are new; neither is flagged.
 */
describe('a change whose findings are not on the lines it touched', () => {
  let repo: HistoryRepo
  let result: HealthScanResult

  beforeAll(async () => {
    const reachable = paddedFile(42, {
      1: 'export function reach(value) {',
      2: '  if (value) return 1',
      40: '  console.log(value)',
      41: '  return 2',
      42: '}',
    })
    repo = await createHistoryRepo({
      base: { 'src/a.js': reachable, 'src/b.js': 'export const value = 1\n' },
      head: [
        { write: 'src/a.js', content: reachable.replace('  if (value) return 1', '  return 1') },
        { write: 'src/b.js', content: CONST_ASSIGN },
      ],
    })
    result = await scanPr(repo)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await repo.remove()
  })

  it('includes the non-local findings, unflagged, next to the flagged one', () => {
    expect(shape(result)).toEqual({
      // Report order (file, then line) — the flag is a flag, not a sort key.
      new: [
        { rule: 'eslint(no-unreachable)', file: 'src/a.js', line: 40, touchedLine: false },
        { rule: 'eslint(no-unreachable)', file: 'src/a.js', line: 41, touchedLine: false },
        { rule: 'eslint(no-const-assign)', file: 'src/b.js', line: 2, touchedLine: true },
      ],
      resolved: [],
    })
    expect(result.report.delta?.counts).toMatchObject({ new: 3, touchedLine: 1 })
  })

  it('puts the directly-actionable task first inside its category', () => {
    const tasks = result.agentMarkdown
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .map((line) => line.replace('### ', ''))
    expect(tasks[0]).toContain('no-const-assign')
    expect(tasks[0]).toContain('[in-diff]')
    expect(tasks[1]).toContain('no-unreachable')
    expect(tasks[1]).not.toContain('[in-diff]')
  })
})

/**
 * Spec §7's zero footprint, in the mode that is hardest to keep it in: PR mode
 * registers a worktree inside the target repo's `.git`, and a crash between
 * `worktree add` and `worktree remove` would leave it there.
 */
describe('a PR scan that crashes mid-run', () => {
  it(
    'removes the base worktree and the scratch dir anyway',
    async () => {
      const repo = await createHistoryRepo({
        base: { 'src/a.js': CLEAN },
        head: [{ write: 'src/a.js', content: CONST_ASSIGN }],
      })
      try {
        await expect(
          runPrScan({
            path: repo.root,
            base: 'main',
            only: ['lint'],
            adapters: [explodingAdapter],
          }),
        ).rejects.toThrow('adapter exploded')

        expect(await repo.worktrees()).toEqual([await realRoot(repo)])
        expect(await repo.status()).toBe('')
        // The bookkeeping goes too, not just the directory.
        expect(await readdir(join(repo.root, '.git', 'worktrees')).catch(() => [])).toEqual([])
      } finally {
        await repo.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

/**
 * An adapter that blows up while the scan is planning, which is the one place
 * the orchestrator's per-tool isolation cannot catch it — exactly the "crank-
 * health itself failed" case the cleanup has to survive.
 */
const explodingAdapter: LanguageAdapter = {
  language: 'js-ts',
  detect: () => Promise.resolve(true),
  get runners(): readonly ToolRunner[] {
    throw new Error('adapter exploded')
  },
}

describe('--pr in a repo with nothing to compare against', () => {
  it('refuses a repo with no commits yet', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'crank-empty-'))
    try {
      await execa('git', ['init', '--quiet'], { cwd: empty })
      await expect(runPrScan({ path: empty, base: 'main', only: ['lint'] })).rejects.toThrow(
        'has none yet',
      )
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('--pr against a ref that cannot be resolved', () => {
  let repo: HistoryRepo

  beforeAll(async () => {
    repo = await createHistoryRepo({ base: { 'src/a.js': CLEAN }, head: [] })
  })

  afterAll(async () => {
    await repo.remove()
  })

  it('says so instead of scanning, and leaves no worktree behind', async () => {
    await expect(runPrScan({ path: repo.root, base: 'nope', only: ['lint'] })).rejects.toThrow(
      'unknown base ref "nope"',
    )
    expect(await repo.worktrees()).toEqual([await realRoot(repo)])
  })
})

describe('the PR goldens', () => {
  let repo: HistoryRepo
  let result: HealthScanResult

  beforeAll(async () => {
    repo = await createHistoryRepo(GOLDEN_HISTORY)
    result = await scanPr(repo)
  }, SCAN_TIMEOUT_MS)

  afterAll(async () => {
    await repo.remove()
  })

  it('matches the golden normalized report.json', async () => {
    expect(normalizePrReport(result.json)).toBe(await golden('pr-lint.report.json'))
  })

  it('matches the golden report.md', async () => {
    expect(normalizePrMarkdown(result.markdown, result.report.repo.path)).toBe(
      await golden('pr-lint.report.md'),
    )
  })

  it('matches the golden agent.md', async () => {
    expect(normalizePrMarkdown(result.agentMarkdown, result.report.repo.path)).toBe(
      await golden('pr-lint.agent.md'),
    )
  })
})

async function golden(name: string): Promise<string> {
  return readFile(new URL(`./golden/${name}`, import.meta.url), 'utf8')
}

/**
 * The repo root as git reports it. `git worktree list` prints resolved paths,
 * and macOS temp dirs are symlinks (`/var` → `/private/var`).
 */
async function realRoot(repo: HistoryRepo): Promise<string> {
  return realpath(repo.root)
}
