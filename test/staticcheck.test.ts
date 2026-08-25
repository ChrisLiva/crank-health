import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import {
  STATICCHECK_TOOL,
  parseStaticcheckStream,
  staticcheckDeadCodeRunner,
  staticcheckLintRunner,
  staticcheckTypesRunner,
} from '../src/adapters/go/staticcheck.ts'
import { scanMemo } from '../src/adapters/support.ts'
import { inventoryOf, partitionProjects } from '../src/core/discover.ts'
import type { DetectContext, Finding, RunContext } from '../src/core/types.ts'
import type { Report } from '../src/render/json.ts'
import { reportFindings } from '../src/render/json.ts'
import { runHealthScan } from '../src/run.ts'
import { COMMIT_IDENTITY } from './support/fixture.ts'
import { pathFarm } from './support/path-farm.ts'

/**
 * The per-scan memo shared by every runner trio, and the staticcheck runners
 * built on it: what the captured bytes are read as, which category each record
 * lands in, and what the report says when the module graph would not load.
 */

/** The two fields a memo key is built from; nothing else is read. */
function context(runScratch: string, project: string): RunContext {
  return { runScratch, project: { path: project } } as unknown as RunContext
}

describe('scanMemo', () => {
  it('runs the work once per scan × project and hands every caller the same promise', async () => {
    const memo = scanMemo<number>()
    let made = 0
    const make = (): Promise<number> => Promise.resolve((made += 1))

    const first = memo.for(context('/tmp/scan-1', '.'), make)
    const second = memo.for(context('/tmp/scan-1', '.'), make)
    const other = memo.for(context('/tmp/scan-1', 'svc'), make)

    expect(first).toBe(second)
    expect(await first).toBe(1)
    expect(await other).toBe(2)
    expect(made).toBe(2)
  })

  /**
   * The prefix rule PR mode depends on: both sides of a delta run nest their
   * scratch dirs under the one directory `run-pr.ts`'s `finally` holds, so
   * forgetting that directory has to release the nested entries too — and
   * nothing belonging to another scan.
   */
  it('forgets every entry under a scan’s scratch, and only that scan’s', async () => {
    const memo = scanMemo<string>()
    const made: string[] = []
    const making = (label: string) => (): Promise<string> => {
      made.push(label)
      return Promise.resolve(label)
    }

    await memo.for(context('/tmp/scan-1', '.'), making('root'))
    await memo.for(context('/tmp/scan-1/head-scratch', '.'), making('head'))
    await memo.for(context('/tmp/scan-2', '.'), making('other'))

    memo.forget('/tmp/scan-1')

    await memo.for(context('/tmp/scan-1', '.'), making('root'))
    await memo.for(context('/tmp/scan-1/head-scratch', '.'), making('head'))
    await memo.for(context('/tmp/scan-2', '.'), making('other'))

    expect(made).toEqual(['root', 'head', 'other', 'root', 'head'])
  })

  /**
   * The key is two paths joined by a separator no path can contain. A space
   * would not do: these are real paths, and a project directory is allowed to
   * hold one — under a space separator `<scratch> <a b>` and `<scratch> <a> <b>`
   * are the same key, and the wrong scan's work gets handed back.
   */
  it('keeps scans apart when the paths themselves hold spaces and unicode', async () => {
    const memo = scanMemo<string>()
    const scratch = '/tmp/scan dir/ünïcode'
    const made: string[] = []
    const making = (label: string) => (): Promise<string> => {
      made.push(label)
      return Promise.resolve(label)
    }

    await memo.for(context(scratch, 'a b'), making('a b'))
    await memo.for(context(scratch, 'a'), making('a'))
    await memo.for(context(`${scratch}/b`, '.'), making('nested'))

    expect(made).toEqual(['a b', 'a', 'nested'])
    memo.forget(scratch)
    await memo.for(context(scratch, 'a b'), making('a b again'))
    expect(made).toEqual(['a b', 'a', 'nested', 'a b again'])
  })
})

/**
 * The parser, over bytes a real `staticcheck v0.8.1 -f json ./...` printed —
 * captured from a throwaway module shaped like `test/fixtures/go-basic`, with
 * the repo root rewritten to `/repo`.
 *
 * Every check code and line the v0.7.0 corpus carried survived the bump. The
 * refusal sentence did not: on go 1.27 an absent import under `GOPROXY=off`
 * and the default `-mod=readonly` reads `no required module provides package
 * …; to add it:` where go 1.26 read `cannot find module providing package …:
 * import lookup disabled by -mod=readonly`. Both phrases are in
 * `MODULE_GRAPH_FAILURES`, so the refusal still fires.
 */
describe('parseStaticcheckStream', () => {
  it('routes every record it was given, and drops none of them', async () => {
    const outcome = parseStaticcheckStream(await captured('staticcheck-0.8.1.jsonl'), REPO, REPO)

    expect(
      outcome.findings.map((finding) => [
        finding.category,
        finding.rule,
        finding.file,
        finding.range.startLine,
      ]),
    ).toEqual([
      ['types', 'compile', 'sub/sub.go', 4],
      ['lint', 'S1002', 'main.go', 7],
      ['lint', 'SA1006', 'main.go', 11],
      ['lint', 'SA4006', 'main.go', 13],
      ['dead-code', 'U1000', 'main.go', 21],
    ])
    expect(outcome.moduleGraphFailure).toBeUndefined()
  })

  /**
   * A `U1000` record's `end` is zeroed and a compile record's `location.file`
   * is empty — the range still has to be a real one-based span, because the
   * renderers print it and a delta rehashes against it.
   */
  it('reads a range even where the tool reported none', async () => {
    const outcome = parseStaticcheckStream(await captured('staticcheck-0.8.1.jsonl'), REPO, REPO)
    const unused = outcome.findings.find((finding) => finding.rule === 'U1000')
    const compile = outcome.findings.find((finding) => finding.rule === 'compile')

    expect(unused?.range).toEqual({ startLine: 21, startCol: 6, endLine: 21, endCol: 6 })
    expect(compile?.range).toEqual({ startLine: 4, startCol: 9, endLine: 4, endCol: 9 })
  })

  /**
   * A project below the repo root: the paths staticcheck reports *relative to
   * the directory it ran in* — the compile record's — resolve against that
   * directory, while the absolute ones are already the repo's and are only
   * relativized. Both have to land on the path discovery gave the same file, or
   * the finding is about a file nobody scanned.
   */
  it('resolves a run-relative path against the project it ran in', async () => {
    const outcome = parseStaticcheckStream(
      await captured('staticcheck-0.8.1.jsonl'),
      `${REPO}/svc`,
      REPO,
    )

    expect([...new Set(outcome.findings.map((finding) => finding.file))]).toEqual([
      'svc/sub/sub.go',
      'main.go',
    ])
  })

  it('reads a silent run as no findings and no failure', () => {
    for (const stream of ['', '\n\n']) {
      expect(parseStaticcheckStream(stream, REPO, REPO)).toEqual({ findings: [] })
    }
  })

  /**
   * A module graph that would not load is a refusal, not a `types` grade: the
   * compile record says nothing about the repo's own code, and reporting it as
   * a type error would put a D on a repo whose types were never checked (the
   * `NU1102` precedent in `csharp/build.ts`).
   */
  it('refuses the run when the module graph would not load', async () => {
    const outcome = parseStaticcheckStream(
      await captured('staticcheck-0.8.1.module-graph.jsonl'),
      REPO,
      REPO,
    )

    expect(outcome.moduleGraphFailure).toBe(
      'no required module provides package example.com/absent/pkg; to add it:\n' +
        '\tgo get example.com/absent/pkg',
    )
    expect(outcome.findings).toEqual([])
  })
})

const REPO = '/repo'

function captured(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./captured/${name}`, import.meta.url)), 'utf8')
}

/**
 * Ownership, driven through the runners' own `detect`. `staticcheck.conf` is
 * the only artifact that says a repo owns staticcheck — `go run` fetches the
 * binary, so there is never one installed to find — and the walk is the shared
 * one, nearest first.
 */
describe('the staticcheck runners’ detection', () => {
  const runners = [staticcheckTypesRunner, staticcheckDeadCodeRunner, staticcheckLintRunner]

  it('is inherited from an ancestor directory’s config, by all three alike', async () => {
    const tree = await goTree({ 'staticcheck.conf': 'checks = ["all"]\n' })
    try {
      for (const runner of runners) {
        // eslint-disable-next-line no-await-in-loop
        expect(await runner.detect(detectContext(tree))).toEqual({
          reason: 'config',
          configFiles: ['staticcheck.conf'],
          ownedVia: 'staticcheck.conf',
          installed: false,
        })
      }
    } finally {
      await rm(tree, { recursive: true, force: true })
    }
  })

  it('lets the project’s own config decide, and still reports the inherited one', async () => {
    const tree = await goTree({
      'staticcheck.conf': 'checks = ["all"]\n',
      'svc/staticcheck.conf': 'checks = ["all"]\n',
    })
    try {
      expect(await staticcheckTypesRunner.detect(detectContext(tree))).toEqual({
        reason: 'config',
        configFiles: ['staticcheck.conf', 'svc/staticcheck.conf'],
        ownedVia: 'svc/staticcheck.conf',
        installed: false,
      })
    } finally {
      await rm(tree, { recursive: true, force: true })
    }
  })

  it('is null when no directory above the project holds one', async () => {
    const tree = await goTree({})
    try {
      expect(await staticcheckTypesRunner.detect(detectContext(tree))).toBeNull()
    } finally {
      await rm(tree, { recursive: true, force: true })
    }
  })
})

/** The `svc` project of a two-level tree, as detection is handed it. */
function detectContext(repoRoot: string): DetectContext {
  const files = inventoryOf(['svc/go.mod', 'svc/main.go'])
  const project = partitionProjects(files).find((candidate) => candidate.path === 'svc')
  if (project === undefined) throw new Error('no svc project')
  return { repoRoot, project, files }
}

/** A repo root holding `svc/` and whatever config files the case plants. */
function goTree(configs: Readonly<Record<string, string>>): Promise<string> {
  return tempTree({
    'svc/go.mod': 'module example.com/svc\n\ngo 1.25\n',
    'svc/main.go': 'package svc\n',
    ...configs,
  })
}

/** A temp directory holding exactly `files`, repo-relative posix keys. */
async function tempTree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crank-staticcheck-')))
  for (const [path, contents] of Object.entries(files)) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(dirname(join(root, path)), { recursive: true })
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(root, path), contents, 'utf8')
  }
  return root
}

/**
 * The runner, driven through `run.ts` over a farmed `PATH` whose `go` replays
 * the captured bytes: what the *exit code* means, and what a refusal does to
 * all three records at once. Exit 1 is how staticcheck says it reported
 * something, so reading it as a failure would turn every repo with a finding
 * into a repo crank-health could not grade.
 */
describe('a scan whose staticcheck replays captured output', () => {
  it('reads exit 1 with findings as a completed run, in all three categories', async () => {
    const repo = await goSourceRepo()
    try {
      const scan = await scanReplaying(repo, await capturedFor(repo, 'staticcheck-0.8.1.jsonl'))
      const records = scan.tools.filter((tool) => tool.tool === STATICCHECK_TOOL)

      expect(records.map((tool) => [tool.category, tool.state])).toEqual([
        ['types', 'ok'],
        ['dead-code', 'ok'],
        ['lint', 'ok'],
      ])
      expect(
        scan.findings
          .filter((finding) => finding.tool === STATICCHECK_TOOL)
          .map((finding) => [finding.category, finding.rule]),
      ).toEqual([
        ['types', 'compile'],
        ['dead-code', 'U1000'],
        ['lint', 'S1002'],
        ['lint', 'SA1006'],
        ['lint', 'SA4006'],
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /**
   * One process, one file of evidence: the three records cite the same staged
   * stream rather than three copies of it, which is the only thing a reader can
   * check "these three grades came from one analysis" against.
   */
  it('stages the stream once and has all three records name it', async () => {
    const repo = await goSourceRepo()
    try {
      const scan = await scanReplaying(repo, await capturedFor(repo, 'staticcheck-0.8.1.jsonl'))
      const raw = scan.tools
        .filter((tool) => tool.tool === STATICCHECK_TOOL)
        .map((tool) => tool.raw)

      expect(raw).toEqual([
        ['raw/root/staticcheck.jsonl'],
        ['raw/root/staticcheck.jsonl'],
        ['raw/root/staticcheck.jsonl'],
      ])
      expect(scan.rawFiles.filter((file) => file.endsWith('staticcheck.jsonl'))).toEqual([
        'raw/root/staticcheck.jsonl',
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /** A module graph that would not load: three refusals, no findings, no grade. */
  it('reports the refusal on every category when the module graph fails', async () => {
    const repo = await goSourceRepo()
    try {
      const scan = await scanReplaying(
        repo,
        await capturedFor(repo, 'staticcheck-0.8.1.module-graph.jsonl'),
      )
      const records = scan.tools.filter((tool) => tool.tool === STATICCHECK_TOOL)

      expect(records.map((tool) => tool.state)).toEqual(['error', 'error', 'error'])
      for (const record of records) {
        expect(record.reason).toContain(
          'no required module provides package example.com/absent/pkg',
        )
      }
      expect(scan.findings.filter((finding) => finding.tool === STATICCHECK_TOOL)).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /**
   * A cold module cache narrates its downloads on stderr and a warm one says
   * nothing, so the same failed run must explain itself the same way either
   * way: `reason` is a `report.json` field, and a narration line reaching it is
   * both a wrong explanation and a cold/warm difference in the report.
   */
  it('explains a silent failure from the error, not the module cache’s narration', async () => {
    const repo = await goSourceRepo()
    try {
      const scan = await scanReplaying(
        repo,
        '',
        'go: downloading honnef.co/go/tools v0.8.1\n' +
          'go: downloading golang.org/x/tools v0.30.0\n' +
          'staticcheck: fatal: could not load packages\n',
      )
      const reasons = scan.tools
        .filter((tool) => tool.tool === STATICCHECK_TOOL)
        .map((tool) => tool.reason)

      expect(reasons).toEqual([
        'staticcheck exited 1 with nothing to report: staticcheck: fatal: could not load packages',
        'staticcheck exited 1 with nothing to report: staticcheck: fatal: could not load packages',
        'staticcheck exited 1 with nothing to report: staticcheck: fatal: could not load packages',
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /**
   * A repo that owns a `staticcheck.conf` is held to *its* rules, and the
   * report says so: `configOwned` is what `report.json` reads a run's
   * provenance off, and a run that stayed silent about it would be filed as
   * repo-config on the strength of a detection the findings did not come from.
   */
  it('reports repo-config provenance where the repo owns a staticcheck.conf', async () => {
    const repo = await goSourceRepo({ 'staticcheck.conf': 'checks = ["all"]\n' })
    try {
      const scan = await scanReplaying(repo, await capturedFor(repo, 'staticcheck-0.8.1.jsonl'))

      expect(
        scan.tools
          .filter((tool) => tool.tool === STATICCHECK_TOOL)
          .map((tool) => [tool.provenance, tool.detection?.ownedVia]),
      ).toEqual([
        ['repo-config', 'staticcheck.conf'],
        ['repo-config', 'staticcheck.conf'],
        ['repo-config', 'staticcheck.conf'],
      ])
      expect(
        scan.findings
          .filter((finding) => finding.tool === STATICCHECK_TOOL)
          .every((finding) => finding.provenance === 'repo-config'),
      ).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

/** The capture's bytes with `/repo` rewritten to the repo the fake `go` runs in. */
async function capturedFor(repoRoot: string, name: string): Promise<string> {
  return (await captured(name)).replaceAll(REPO, repoRoot)
}

/** The tree the capture describes: the files its records point at, committed. */
async function goSourceRepo(extras: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await tempTree({
    'go.mod': 'module example.com/probe\n\ngo 1.25\n',
    'main.go': MAIN_GO,
    'sub/sub.go': 'package sub\n\nfunc Answer() int {\n\treturn "forty-two"\n}\n',
    ...extras,
  })
  const git = (args: string[]) => execa('git', args, { cwd: root, env: COMMIT_IDENTITY })
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['add', '--all'])
  await git(['commit', '--quiet', '--no-gpg-sign', '--message', 'fixture'])
  return root
}

/** Lines 7, 11, 13 and 21 are the ones the captured records point at. */
const MAIN_GO = `package main

import "fmt"

func main() {
\tcond := len("x") > 0
\tif cond == true {
\t\tfmt.Println(Widen(7))
\t}
\tname := "world"
\tfmt.Printf(name)
\tvalues := []int{1, 2}
\tvalues = append(values, 3)
}

// Widen doubles n.
func Widen(n int) int {
\treturn n * 2
}

func unusedHelper() int {
\treturn 41
}
`

/**
 * One scan of `repoRoot` under a `PATH` whose `go` answers the gate and then
 * replays `stdout`, exiting 1 the way staticcheck does when it reported
 * something.
 */
async function scanReplaying(
  repoRoot: string,
  stdout: string,
  stderr = '',
): Promise<{
  readonly tools: Report['tools']
  readonly findings: readonly Finding[]
  readonly rawFiles: readonly string[]
}> {
  const farm = await pathFarm({ go: goReplaying(stdout, stderr), gofmt: '#!/bin/sh\nexit 0\n' })
  const out = await mkdtemp(join(tmpdir(), 'crank-staticcheck-out-'))
  const original = process.env['PATH']
  process.env['PATH'] = farm.path
  try {
    const result = await runHealthScan({ path: repoRoot, out })
    const files = await readdir(result.outputDir, { recursive: true })
    return {
      tools: result.report.tools,
      findings: reportFindings(result.report),
      rawFiles: files.map((file) => file.split(sep).join('/')),
    }
  } finally {
    process.env['PATH'] = original
    await farm.remove()
    await rm(out, { recursive: true, force: true })
  }
}

/** A fake `go`: a version the gate accepts, then the captured stream on exit 1. */
function goReplaying(stdout: string, stderr = ''): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = version ]; then echo "go version go1.26.6 darwin/arm64"; exit 0; fi',
    "cat <<'STATICCHECK_EOF'",
    stdout.trimEnd(),
    'STATICCHECK_EOF',
    "cat >&2 <<'STATICCHECK_ERR_EOF'",
    stderr.trimEnd(),
    'STATICCHECK_ERR_EOF',
    'exit 1',
  ].join('\n')
}
