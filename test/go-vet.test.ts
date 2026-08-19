import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { GO_VET_TOOL, parseVetStream } from '../src/adapters/go/go-vet.ts'
import { firstLine } from '../src/adapters/support.ts'
import type { Finding } from '../src/core/types.ts'
import type { Report } from '../src/render/json.ts'
import { reportFindings } from '../src/render/json.ts'
import { runHealthScan } from '../src/run.ts'
import { COMMIT_IDENTITY } from './support/fixture.ts'
import { pathFarm } from './support/path-farm.ts'

/**
 * `go vet -json ./...` — the toolchain's own analyzer suite, read off the bytes
 * a real `go 1.26.6` printed and driven through the seam that decides whether a
 * run completed: the exit code.
 *
 * The captures come from throwaway modules (a clean package beside two packages
 * carrying diagnostics; and, for the failure pair, a module with an in-package
 * type error), with the module root rewritten to `/repo`.
 */

const REPO = '/repo'

function captured(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./captured/${name}`, import.meta.url)), 'utf8')
}

/** The capture's bytes with `/repo` rewritten to the repo the fake `go` runs in. */
async function capturedFor(repoRoot: string, name: string): Promise<string> {
  return (await captured(name)).replaceAll(REPO, repoRoot)
}

describe('parseVetStream', () => {
  /**
   * The stream is concatenated *pretty-printed* JSON documents — one per
   * package, `{}` for a package with nothing to say — so it is neither a JSON
   * document nor JSON Lines, and every diagnostic of every analyzer of every
   * package has to come out of it exactly once.
   */
  it('reads every diagnostic of every analyzer out of the concatenated documents', async () => {
    const findings = parseVetStream(await captured('go-vet-1.26.6.json'), REPO)

    expect(
      findings.map((finding) => [
        finding.category,
        finding.tool,
        finding.rule,
        finding.file,
        finding.range.startLine,
        finding.range.startCol,
        finding.range.endLine,
        finding.range.endCol,
        finding.message,
      ]),
    ).toEqual([
      [
        'lint',
        GO_VET_TOOL,
        'printf',
        'main.go',
        6,
        14,
        6,
        16,
        'fmt.Printf format %d has arg "not-an-int" of wrong type string',
      ],
      [
        'lint',
        GO_VET_TOOL,
        'copylocks',
        'dirty/dirty.go',
        14,
        14,
        14,
        24,
        'Lock passes lock by value: sync.Mutex',
      ],
      [
        'lint',
        GO_VET_TOOL,
        'copylocks',
        'dirty/dirty.go',
        15,
        9,
        15,
        11,
        'return copies lock value: sync.Mutex',
      ],
      [
        'lint',
        GO_VET_TOOL,
        'printf',
        'dirty/dirty.go',
        10,
        22,
        10,
        24,
        'fmt.Sprintf format %s has arg n of wrong type int',
      ],
    ])
  })

  /** A package with nothing to report is `{}`, and `{}` is not a finding. */
  it('reads a stream of nothing — and of empty documents — as no findings', async () => {
    expect(parseVetStream('', REPO)).toEqual([])
    expect(parseVetStream('\n\n', REPO)).toEqual([])
    expect(parseVetStream('{}\n{}\n', REPO)).toEqual([])
  })

  /**
   * The document boundaries are found by counting braces, so a brace *inside* a
   * message would end a document early and swallow the rest of the stream. A
   * real `go vet` message quotes the source it flagged, and Go source is full of
   * braces and quotes — so the round trip is asserted against a hostile one:
   * braces, an escaped quote, a newline escape and non-ASCII text.
   */
  it('survives messages that carry braces, quotes and unicode', () => {
    const hostile = 'struct{}{} said "☃\\n}" — and }{ too'
    const stream = [
      '{}',
      JSON.stringify(
        {
          'example.com/hostile': {
            structtag: [
              { posn: `${REPO}/pkg/a.go:3:7`, end: `${REPO}/pkg/a.go:3:9`, message: hostile },
            ],
          },
        },
        null,
        '\t',
      ),
      '{}',
    ].join('\n')

    const findings = parseVetStream(stream, REPO)

    expect(findings.map((finding) => [finding.rule, finding.file, finding.message])).toEqual([
      ['structtag', 'pkg/a.go', hostile],
    ])
  })
})

/**
 * The runner, driven through `run.ts` over a farmed `PATH` whose `go` replays
 * captured bytes. What is under test is the one decision `parseVetStream` never
 * sees: `go vet` exits 0 while reporting diagnostics, so the exit code — and
 * nothing else — separates "I found problems" from "I could not run".
 */
describe('a scan whose go vet replays captured output', () => {
  it('reads exit 0 with diagnostics as a completed run that reports no version', async () => {
    const repo = await goSourceRepo()
    try {
      const scan = await scanReplaying(repo, {
        stdout: await capturedFor(repo, 'go-vet-1.26.6.json'),
      })

      expect(scan.tools.filter((tool) => tool.tool === GO_VET_TOOL)).toEqual([
        expect.objectContaining({ category: 'lint', state: 'ok', version: null }),
      ])
      expect(
        scan.findings
          .filter((finding) => finding.tool === GO_VET_TOOL)
          .map((finding) => [finding.rule, finding.file, finding.range.startLine]),
      ).toEqual([
        ['printf', 'dirty/dirty.go', 10],
        ['copylocks', 'dirty/dirty.go', 14],
        ['copylocks', 'dirty/dirty.go', 15],
        ['printf', 'main.go', 6],
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  /**
   * A package that would not type-check takes the whole run down: `go vet`
   * exits non-zero, and the documents it did print are about a package set that
   * was never fully loaded. They are discarded rather than graded — the proof
   * being that the same bytes parse into real findings, which the runner threw
   * away. `types` is staticcheck's to grade, and it still is.
   */
  it('discards the partial stream when the run failed, and says which package failed', async () => {
    const repo = await goSourceRepo()
    try {
      const stdout = await capturedFor(repo, 'go-vet-1.26.6.load-failed.stdout.json')
      const stderr = await captured('go-vet-1.26.6.load-failed.stderr.txt')
      const scan = await scanReplaying(repo, { stdout, stderr, exitCode: 1 })

      expect(scan.tools.filter((tool) => tool.tool === GO_VET_TOOL)).toEqual([
        expect.objectContaining({ state: 'error', reason: firstLine(stderr) }),
      ])
      expect(scan.findings.filter((finding) => finding.tool === GO_VET_TOOL)).toEqual([])
      // The discard is proved, not assumed: those bytes do carry diagnostics.
      expect(parseVetStream(stdout, repo).length).toBeGreaterThan(0)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

/** The tree the captures describe: the files their `posn`s point at, committed. */
async function goSourceRepo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crank-go-vet-')))
  const files: Record<string, string> = {
    'go.mod': 'module example.com/vetprobe\n\ngo 1.25\n',
    'main.go': MAIN_GO,
    'clean/clean.go': CLEAN_GO,
    'dirty/dirty.go': DIRTY_GO,
  }
  for (const [path, contents] of Object.entries(files)) {
    // eslint-disable-next-line no-await-in-loop
    await mkdir(dirname(join(root, path)), { recursive: true })
    // eslint-disable-next-line no-await-in-loop
    await writeFile(join(root, path), contents, 'utf8')
  }
  const git = (args: string[]) => execa('git', args, { cwd: root, env: COMMIT_IDENTITY })
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['add', '--all'])
  await git(['commit', '--quiet', '--no-gpg-sign', '--message', 'fixture'])
  return root
}

/** Line 6 is the `printf` diagnostic's line in both captures. */
const MAIN_GO = `package main

import "fmt"

func main() {
\tfmt.Printf("%d", "not-an-int")
}
`

const CLEAN_GO = `package clean

// Ok is a perfectly fine function.
func Ok() string {
\treturn "ok"
}
`

/** Lines 10, 14 and 15 are the ones the main capture's records point at. */
const DIRTY_GO = `package dirty

import (
\t"fmt"
\t"sync"
)

// Report prints with a mismatched verb.
func Report(n int) string {
\treturn fmt.Sprintf("%s", n)
}

// Lock copies a mutex by value.
func Lock(mu sync.Mutex) sync.Mutex {
\treturn mu
}
`

/**
 * One scan of `repoRoot` under a `PATH` whose `go` answers the gate and then
 * replays the captured streams with the captured exit code.
 */
async function scanReplaying(
  repoRoot: string,
  replay: { stdout: string; stderr?: string; exitCode?: number },
): Promise<{ readonly tools: Report['tools']; readonly findings: readonly Finding[] }> {
  const farm = await pathFarm({
    go: goReplaying(replay.stdout, replay.stderr ?? '', replay.exitCode ?? 0),
    gofmt: '#!/bin/sh\nexit 0\n',
  })
  const out = await mkdtemp(join(tmpdir(), 'crank-go-vet-out-'))
  const original = process.env['PATH']
  process.env['PATH'] = farm.path
  try {
    const result = await runHealthScan({ path: repoRoot, out })
    return { tools: result.report.tools, findings: reportFindings(result.report) }
  } finally {
    process.env['PATH'] = original
    await farm.remove()
    await rm(out, { recursive: true, force: true })
  }
}

/** A fake `go`: a version the gate accepts, then the captured streams. */
function goReplaying(stdout: string, stderr: string, exitCode: number): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = version ]; then echo "go version go1.26.6 darwin/arm64"; exit 0; fi',
    "cat <<'GO_VET_EOF'",
    stdout.trimEnd(),
    'GO_VET_EOF',
    "cat >&2 <<'GO_VET_ERR_EOF'",
    stderr.trimEnd(),
    'GO_VET_ERR_EOF',
    `exit ${exitCode}`,
  ].join('\n')
}
