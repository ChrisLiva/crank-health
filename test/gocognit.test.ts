import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gocognitRunner, parseGocognitJson } from '../src/adapters/go/gocognit.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'
import { pathFarm } from './support/path-farm.ts'

/**
 * gocognit — the complexity census for Go, and the only thing this runner
 * produces: two numbers, no findings.
 *
 * The capture is a real `go run
 * github.com/uudashr/gocognit/cmd/gocognit@v1.2.1 -json -over -1 .` over a
 * throwaway `go-basic`-shaped tree. Nothing in those bytes was rewritten:
 * v1.2.1 reports `Pos.Filename` relative to the directory it ran in, so the
 * capture quotes no absolute path at all — which is exactly why the parser has
 * to be told which project the run happened in.
 */

const CAPTURE = fileURLToPath(new URL('./captured/gocognit-1.2.1.json', import.meta.url))

/** The project the capture's tree sat at, repo-relative. */
const PROJECT = 'svc'

/** Every function the captured run measured, in the order it reported them. */
const MEASURED = [
  { file: 'svc/complex.go', name: 'Classify', complexity: 25 },
  { file: 'svc/dupe_b.go', name: 'AccumulateSecond', complexity: 6 },
  { file: 'svc/dupe_a.go', name: 'AccumulateFirst', complexity: 6 },
  { file: 'svc/unformatted.go', name: 'Widen', complexity: 1 },
  { file: 'svc/checks.go', name: 'Describe', complexity: 1 },
  { file: 'svc/vendor/example.com/dep/dep.go', name: 'Name', complexity: 0 },
  { file: 'svc/main.go', name: 'main', complexity: 0 },
  { file: 'svc/checks.go', name: 'unusedHelper', complexity: 0 },
  { file: 'svc/brokenpkg/broken.go', name: 'Answer', complexity: 0 },
]

describe('parseGocognitJson', () => {
  /**
   * Every entry, once, joined onto the project it was measured in — including
   * the complexity-0 ones, which only `-over -1` reports and which the
   * denominator would be wrong without: the default listing carries five of
   * these nine.
   */
  it('reads every measured function of the captured run, under its project', async () => {
    const entries = parseGocognitJson(await readFile(CAPTURE, 'utf8'), PROJECT)

    expect(entries).toEqual(MEASURED)
    expect(entries.every((entry) => entry.file.startsWith('svc/'))).toBe(true)
  })

  /** A tree with no Go in it: gocognit prints `null`, not an empty array. */
  it('reads a walk that measured nothing as no entries', () => {
    expect(parseGocognitJson('null\n', PROJECT)).toEqual([])
    expect(parseGocognitJson('', PROJECT)).toEqual([])
    expect(parseGocognitJson('[]', PROJECT)).toEqual([])
  })

  /**
   * The census is a serialize/parse pair with the tool, so it is asserted
   * against a hostile entry rather than a friendly one: a generic method whose
   * name carries quotes, braces and non-ASCII text, in a directory with a
   * space, measured at the ceiling itself.
   */
  it('survives a function name with braces, quotes and unicode', () => {
    const name = 'func (s *Store[T]) Load(“k” string) map[string]struct{}'
    const stream = JSON.stringify([
      {
        PkgName: 'störe',
        FuncName: name,
        Complexity: 15,
        Pos: { Filename: 'odd dir/a.go', Offset: 12, Line: 3, Column: 1 },
      },
    ])

    expect(parseGocognitJson(stream, PROJECT)).toEqual([
      { file: 'svc/odd dir/a.go', name, complexity: 15 },
    ])
  })

  /** The root project is the identity case: nothing to join on. */
  it('leaves a root-project run’s paths alone', () => {
    const stream = JSON.stringify([
      { PkgName: 'main', FuncName: 'main', Complexity: 0, Pos: { Filename: 'main.go', Line: 1 } },
    ])

    expect(parseGocognitJson(stream, '.')).toEqual([
      { file: 'main.go', name: 'main', complexity: 0 },
    ])
  })
})

/**
 * The runner over the same bytes, twice: what the census counts is decided by
 * the scan's file list and not by what gocognit walked into. gocognit is handed
 * a *directory*, so it measures the vendored copy and the nested module too —
 * and neither is this project's to answer for.
 */
describe('the gocognit runner', () => {
  let repoRoot: string
  let scratch: string
  let captured: string
  let original: string | undefined
  let farm: { path: string; remove(): Promise<void> }

  beforeAll(async () => {
    captured = await readFile(CAPTURE, 'utf8')
    repoRoot = await mkdtemp(join(tmpdir(), 'crank-gocognit-repo-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-gocognit-scratch-'))
    await mkdir(join(repoRoot, PROJECT), { recursive: true })
    farm = await pathFarm({ go: goReplaying(captured) })
    original = process.env['PATH']
    process.env['PATH'] = farm.path
  })

  afterAll(async () => {
    process.env['PATH'] = original
    await farm.remove()
    await rm(repoRoot, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  it('counts only the functions in files the scan owns', async () => {
    const owned = MEASURED.map((entry) => entry.file).filter(
      (file) => !file.startsWith('svc/vendor/'),
    )

    const result = await gocognitRunner.run(contextFor(repoRoot, scratch, owned))

    expect(result.state).toBe('ok')
    expect(result.findings).toEqual([])
    expect(result.metrics).toEqual({ functionsTotal: 8, functionsOverCeiling: 1 })
    expect(result.toolVersion).toBe('v1.2.1')
  })

  /** The same bytes, the vendored file put back: the filter is what moved. */
  it('counts the vendored function when the scan owns that file too', async () => {
    const all = MEASURED.map((entry) => entry.file)

    const result = await gocognitRunner.run(contextFor(repoRoot, scratch, all))

    expect(result.metrics).toEqual({ functionsTotal: 9, functionsOverCeiling: 1 })
  })

  it('answers ok with nothing to measure when the project has no Go files', async () => {
    const result = await gocognitRunner.run(contextFor(repoRoot, scratch, []))

    expect(result).toEqual({ state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' })
  })
})

/** One project's run context over a file list this test chose. */
function contextFor(repoRoot: string, scratch: string, files: readonly string[]): RunContext {
  return {
    repoRoot,
    project: { ...makeProject(files), path: PROJECT },
    files,
    scratch,
    runScratch: scratch,
    detection: null,
    timeoutMs: 60_000,
    deep: false,
  }
}

/** A fake `go`: the gate's version line, then the captured census for a run. */
function goReplaying(stdout: string): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = version ]; then echo "go version go1.26.6 darwin/arm64"; exit 0; fi',
    "cat <<'CRANK_OUT'",
    stdout.replace(/\n$/, ''),
    'CRANK_OUT',
    'exit 0',
  ].join('\n')
}
