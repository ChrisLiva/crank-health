import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeDelta } from './core/delta.ts'
import {
  addWorktree,
  headCommit,
  mergeBase,
  readDiffFacts,
  removeWorktree,
  resolveCommit,
} from './core/git.ts'
import { createOutputDir } from './core/output.ts'
import type { Category, CategoryState } from './core/types.ts'
import { buildReport } from './render/json.ts'
import type { HealthScanOptions, HealthScanResult } from './run.ts'
import { adoptRawFiles, resolveRepoRoot, scanTree, writeArtifacts } from './run.ts'

/**
 * `--pr <base>` — the two-scan delta of spec §4.
 *
 * The mechanics, and why each one is what it is:
 *
 * - **Merge-base, not the base tip.** A PR is what its author did, not what
 *   landed on `main` while they were working.
 * - **A detached worktree in scratch.** The base scan needs a real tree with a
 *   real `.git` — discovery is `git ls-files`-based — and it must not disturb
 *   the working tree the head scan is about to read. `git worktree add
 *   --detach` gives both, and the target repo sees no checkout, no stash, no
 *   changed branch.
 * - **The identical pipeline on both sides.** Same adapters, same `--only`,
 *   same timeouts, whole-repo both times. Spec §4 is explicit that the global
 *   metrics (duplication, dead code) have to run whole-repo on each side —
 *   scanning only the changed files gives the wrong answer for both.
 * - **Sequential, base first.** Two full scans in parallel would double peak
 *   memory and contend for the same tool caches for no wall-clock win worth
 *   having, and the base scan is the one whose worktree we want to be done with.
 * - **Head is the primary.** The report's grades, findings and metrics are
 *   head's; the delta is what moved. See {@link ReportDelta}.
 *
 * One documented approximation: repo-owned tools run head's installed binaries
 * against the base worktree. Installing the base commit's dependencies would
 * mean an `npm ci` and a venv build inside a scan that promises zero footprint
 * and a sub-minute quick profile. The version that ran is in `report.json` for
 * both scans, so the approximation is visible rather than implied.
 */

export interface PrScanOptions extends HealthScanOptions {
  /** The base ref: a branch, tag or sha the delta is measured against. */
  readonly base: string
}

/**
 * Runs the base and head scans, computes the delta, and writes the run
 * directory.
 *
 * @throws {Error} when the base ref cannot be resolved, when there is no merge
 * base, or for crank-health's own failures. Tool failures are degraded
 * categories on either side, never exceptions (spec §8).
 */
export async function runPrScan(options: PrScanOptions): Promise<HealthScanResult> {
  const startedAt = Date.now()
  const repoRoot = await resolveRepoRoot(options.path)

  const commit = await headCommit(repoRoot)
  if (commit === null) {
    throw new Error(`--pr needs a commit to compare against, and ${repoRoot} has none yet`)
  }
  if ((await resolveCommit(repoRoot, options.base)) === null) {
    throw new Error(
      `unknown base ref "${options.base}" — check the spelling, or fetch it first ` +
        '(a shallow clone often has no base branch)',
    )
  }
  const base = await mergeBase(repoRoot, options.base)
  if (base === null) {
    throw new Error(`no merge base between "${options.base}" and HEAD: unrelated histories`)
  }

  const scratch = await mkdtemp(join(tmpdir(), 'crank-health-pr-'))
  const worktree = join(scratch, 'base')

  try {
    const out = await createOutputDir(repoRoot, options.out)
    const diff = await readDiffFacts(repoRoot, base)

    await addWorktree(repoRoot, worktree, base)
    const baseScan = await scanTree({
      ...options,
      repoRoot: worktree,
      scratch: await subdir(scratch, 'base-scratch'),
      // The deep tier is head-only, whatever the profile: mutation testing
      // executes the repo's test suite, and the base worktree has no installed
      // dependencies of its own to run it with (see the approximation above).
      // Running it twice would also double the most expensive thing
      // crank-health does to answer a question the delta does not ask —
      // "did this change make the tests weaker" is head's mutation score
      // against head's code.
      deep: false,
    })
    // Adopted before the worktree goes: the raw files are staged in scratch,
    // and `base/` keeps them apart from head's same-named evidence.
    const baseRuns = await adoptRawFiles(out, baseScan.scan, 'base')
    await removeWorktree(repoRoot, worktree)

    const headScan = await scanTree({
      ...options,
      repoRoot,
      scratch: await subdir(scratch, 'head-scratch'),
      // Spec §4: "deep mutation scopes to diff-touched files". Only the head
      // scan gets them, because only the head scan runs the deep tier.
      changedFiles: diff.changedFiles,
    })

    const delta = computeDelta({
      baseFindings: baseScan.scan.findings,
      headFindings: headScan.scan.findings,
      renames: diff.renames,
      touchedLines: diff.touchedLines,
      baseCategories: headOnlyDeepNote(baseScan.categories, options.deep === true),
      headCategories: headScan.categories,
    })

    return await writeArtifacts(
      out,
      buildReport({
        repoPath: repoRoot,
        commit,
        profile: options.deep === true ? 'deep' : 'quick',
        delta: { ...delta, baseRef: options.base, mergeBase: base },
        selected: headScan.selected,
        categories: headScan.categories,
        metrics: headScan.scan.metrics,
        // Both scans' tool records, so a reader can see what ran on each side —
        // and, when a base tool failed, why a "resolved" count is not a promise.
        runs: [...baseRuns, ...(await adoptRawFiles(out, headScan.scan, 'head'))],
        findings: headScan.scan.findings,
        warnings: [
          ...headScan.scan.warnings,
          ...baseScan.scan.warnings.map((warning) => `base scan: ${warning}`),
        ],
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      }),
    )
  } finally {
    // Best-effort and in this order on purpose. Neither step throws — whatever
    // brought us here is the error worth reporting — and deleting the directory
    // first means the registration is cleared by `git worktree prune`, which
    // cannot fail for the reasons `git worktree remove` can. A leftover
    // registration in the target repo's `.git` is exactly the footprint this
    // tool promises never to leave. On the happy path both are already done.
    await rm(scratch, { recursive: true, force: true })
    await removeWorktree(repoRoot, worktree)
  }
}

/**
 * Says why the base has no test-quality state in a `--deep --pr` run, in the
 * one place a reader would otherwise find the quick profile's "run `--deep`" —
 * which they just did. The base scan really is quick, deliberately; this is the
 * label for that decision rather than a change to it.
 */
function headOnlyDeepNote(
  categories: Record<Category, CategoryState>,
  deep: boolean,
): Record<Category, CategoryState> {
  const state = categories['test-quality']
  if (!deep || state.status !== 'not-assessed') return categories
  return {
    ...categories,
    'test-quality': {
      status: 'not-assessed',
      reason: 'deep mutation testing runs on the head commit only',
    },
  }
}

async function subdir(scratch: string, name: string): Promise<string> {
  const path = join(scratch, name)
  await mkdir(path, { recursive: true })
  return path
}
