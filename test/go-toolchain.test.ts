import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GO_ABSENT_REASON } from '../src/adapters/common/govulncheck.ts'
import { MINIMUM_GO_MINOR, meetsGoFloor, parseGoVersion } from '../src/adapters/go/go-toolchain.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { COMMIT_IDENTITY } from './support/fixture.ts'
import { pathFarm } from './support/path-farm.ts'

/**
 * The Go adapter's floor, in the two halves it is decided by: reading a version
 * out of what `go version` printed, and comparing it against the minor this
 * release's pinned analyzers need.
 */

describe('parseGoVersion', () => {
  it('reads the major and minor out of a real `go version` first line', () => {
    expect(parseGoVersion('go version go1.26.6 darwin/arm64')).toEqual({ major: 1, minor: 26 })
    expect(parseGoVersion('go version go1.23.0 linux/amd64')).toEqual({ major: 1, minor: 23 })
  })

  /** A development toolchain prints `devel go1.27-<sha>`; it is still a 1.27. */
  it('reads a development toolchain’s version', () => {
    expect(parseGoVersion('go version devel go1.27-abc123 Wed Jan 1 00:00:00 2025 +0000')).toEqual({
      major: 1,
      minor: 27,
    })
  })

  it('answers undefined for output that carries no version at all', () => {
    expect(parseGoVersion('gibberish')).toBeUndefined()
    expect(parseGoVersion('')).toBeUndefined()
  })
})

describe('meetsGoFloor', () => {
  it('accepts the floor itself and everything above it', () => {
    expect(meetsGoFloor({ major: 1, minor: MINIMUM_GO_MINOR })).toBe(true)
    expect(meetsGoFloor({ major: 2, minor: 0 })).toBe(true)
  })

  it('rejects the minor below the floor', () => {
    expect(meetsGoFloor({ major: 1, minor: MINIMUM_GO_MINOR - 1 })).toBe(false)
  })
})

/**
 * The degradation half, driven through `run.ts` — the seam a user's report is
 * produced at — over a farmed `PATH` holding exactly what each case planted.
 * That is what lets one machine act out "no Go", "Go too old" and "Go
 * unreadable" whether or not it has a toolchain of its own.
 */

/**
 * Every Go-adapter tool *record* the gate must degrade — one per (tool ×
 * category), so staticcheck appears three times: it grades `types`, `dead-code`
 * and `lint` from one run, and a gate failure has to take all three down. Each
 * later task extends the list.
 */
const GO_TOOLS: readonly string[] = ['staticcheck', 'staticcheck', 'staticcheck', 'gofmt']

/** The gate's install hint, verbatim: user copy, so drift has to fail a test. */
const INSTALL_HINT =
  'Go toolchain not found — install Go ≥ 1.25 (https://go.dev/dl) to grade Go code'

/** A fake `go` that prints `line` on stdout and exits 0. */
const goPrinting = (line: string): string => ['#!/bin/sh', `echo '${line}'`, 'exit 0'].join('\n')

/** A fake `gofmt` that lists nothing and exits 0 — a repo it finds well formatted. */
const SILENT_GOFMT = '#!/bin/sh\nexit 0\n'

describe('a Go repo scanned on a machine whose toolchain cannot grade it', () => {
  let fixture: FixtureRepo

  beforeAll(async () => {
    fixture = await goTempRepo()
  })

  afterAll(async () => {
    await fixture.remove()
  })

  /**
   * No `go` at all. Every Go tool degrades with the one install hint, and
   * govulncheck — which is `common`'s, not the Go adapter's — keeps its own
   * conservative-grading sentence unchanged.
   *
   * The "other adapters are unaffected" half is asserted as *no Go-gate reason
   * on a non-Go record*, and no more: the same farm has no `uvx` either, so the
   * Python rows are legitimately not-available for their own reasons.
   */
  it('degrades every Go tool with the install hint when there is no go on PATH', async () => {
    const records = await recordsUnder(fixture, { gofmt: SILENT_GOFMT })
    const tools = byTool(records)

    // Every record, not every name: three of them are staticcheck's.
    expect(
      records
        .filter((record) => GO_TOOLS.includes(record.tool))
        .map((record) => record.tool)
        .toSorted(),
    ).toEqual([...GO_TOOLS].toSorted())
    for (const tool of GO_TOOLS) {
      expect(tools.get(tool)).toEqual({ state: 'not-available', reason: INSTALL_HINT })
    }
    expect(tools.get('govulncheck')).toEqual({
      state: 'not-available',
      reason: GO_ABSENT_REASON,
    })
    const elsewhere = [...tools].filter(([tool]) => !GO_TOOLS.includes(tool))
    expect(elsewhere.filter(([, row]) => row.reason === INSTALL_HINT)).toEqual([])
  })

  it('names both versions when the toolchain is below the floor', async () => {
    const tools = await toolsUnder(fixture, {
      go: goPrinting('go version go1.23.0 linux/amd64'),
      gofmt: SILENT_GOFMT,
    })

    for (const tool of GO_TOOLS) {
      expect(tools.get(tool)?.state).toBe('not-available')
      // The version found and the version needed: a hint without both is not
      // actionable.
      expect(tools.get(tool)?.reason).toContain('1.23')
      expect(tools.get(tool)?.reason).toContain('1.25')
    }
  })

  it('quotes what it could not parse rather than guessing a version', async () => {
    const tools = await toolsUnder(fixture, { go: goPrinting('gibberish'), gofmt: SILENT_GOFMT })

    for (const tool of GO_TOOLS) {
      expect(tools.get(tool)?.state).toBe('not-available')
      expect(tools.get(tool)?.reason).toContain('gibberish')
    }
  })

  /**
   * `gofmt` is a separate binary beside `go` (it lives in `GOROOT/bin`, which
   * is not always on `PATH`), so a working `go` is no proof of a working
   * formatter. The gate passes and the runner's own spawn is what fails — which
   * is the only way the report can name the binary that is actually missing.
   */
  it('names gofmt itself when only the formatter is missing', async () => {
    const tools = await toolsUnder(fixture, { go: goPrinting('go version go1.26.6 darwin/arm64') })

    expect(tools.get('gofmt')?.state).toBe('not-available')
    expect(tools.get('gofmt')?.reason).toContain('gofmt')
    expect(tools.get('gofmt')?.reason).not.toBe(INSTALL_HINT)
  })
})

/** Every tool record's state and reason, keyed by tool name. */
async function toolsUnder(
  fixture: FixtureRepo,
  extras: Readonly<Record<string, string>>,
): Promise<Map<string, ToolRow>> {
  return byTool(await recordsUnder(fixture, extras))
}

function byTool(records: readonly (ToolRow & { tool: string })[]): Map<string, ToolRow> {
  return new Map(
    records.map((record) => [record.tool, { state: record.state, reason: record.reason }]),
  )
}

interface ToolRow {
  readonly state: string
  readonly reason: string | null
}

/** Every tool record, in report order, from a scan run under a farmed `PATH`. */
async function recordsUnder(
  fixture: FixtureRepo,
  extras: Readonly<Record<string, string>>,
): Promise<readonly (ToolRow & { tool: string })[]> {
  const farm = await pathFarm(extras)
  const original = process.env['PATH']
  process.env['PATH'] = farm.path
  try {
    const result = await runHealthScan({ path: fixture.root })
    return result.report.tools.map((tool) => ({
      tool: tool.tool,
      state: tool.state,
      reason: tool.reason ?? null,
    }))
  } finally {
    process.env['PATH'] = original
    await farm.remove()
  }
}

/** The smallest thing that is a Go project: one module, one source file. */
async function goTempRepo(): Promise<FixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), 'crank-go-gate-'))
  const git = (args: string[]) => execa('git', args, { cwd: root, env: COMMIT_IDENTITY })

  await writeFile(join(root, 'go.mod'), 'module example.com/gate\n\ngo 1.25\n', 'utf8')
  await writeFile(join(root, 'main.go'), 'package main\n\nfunc main() {}\n', 'utf8')
  await git(['init', '--quiet', '--initial-branch=main'])
  await git(['add', '--all'])
  await git(['commit', '--quiet', '--no-gpg-sign', '--message', 'fixture'])
  const { stdout: commit } = await git(['rev-parse', 'HEAD'])

  return {
    root,
    commit: commit.trim(),
    status: async () => (await git(['status', '--porcelain'])).stdout,
    remove: () => rm(root, { recursive: true, force: true }),
  }
}
