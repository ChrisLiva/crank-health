import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GO_VET_TOOL } from '../src/adapters/go/go-vet.ts'
import {
  GOLANGCI_LINT_TOOL,
  golangciLintRunner,
  parseGolangciJson,
} from '../src/adapters/go/golangci-lint.ts'
import { STATICCHECK_TOOL } from '../src/adapters/go/staticcheck.ts'
import { inventoryOf, repoProject } from '../src/core/discover.ts'
import type { Report } from '../src/render/json.ts'
import { reportFindings } from '../src/render/json.ts'
import { runHealthScan } from '../src/run.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { pathFarm } from './support/path-farm.ts'

/**
 * golangci-lint — the linter a Go repo chooses for itself, and the only Go lint
 * tool that stands crank-health's defaults down.
 *
 * The capture is a real `go run
 * github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 run
 * --output.json.path stdout` over a throwaway copy of `test/fixtures/go-owned`.
 * Nothing in those bytes was rewritten: v2.12.2 reports `Pos.Filename` relative
 * to the directory it ran in, so the capture quotes no absolute path at all.
 */

const REPO = '/repo'

function captured(name: string): Promise<string> {
  return readFile(fileURLToPath(new URL(`./captured/${name}`, import.meta.url)), 'utf8')
}

const CAPTURE = 'golangci-lint-2.12.2.json'

describe('parseGolangciJson', () => {
  /**
   * Every `Issues` entry, once, with its linter as the rule and its `Pos` as
   * the place — read off bytes whose stdout is *not* a JSON document: v2.12.2
   * appends its human summary (`2 issues:` …) after the document, so a parser
   * that handed the whole stream to `JSON.parse` would report nothing at all.
   */
  it('reads every issue of the captured run, one per Issues entry', async () => {
    const findings = parseGolangciJson(await captured(CAPTURE), REPO, REPO)

    expect(
      findings.map((finding) => [
        finding.rule,
        finding.file,
        finding.range.startLine,
        finding.range.startCol,
      ]),
    ).toEqual([
      ['staticcheck', 'main.go', 12, 5],
      ['unused', 'main.go', 20, 6],
    ])
    expect(findings.map((finding) => [finding.category, finding.tool, finding.severity])).toEqual([
      ['lint', GOLANGCI_LINT_TOOL, 'warning'],
      ['lint', GOLANGCI_LINT_TOOL, 'warning'],
    ])
    expect(findings[0]?.message).toBe(
      'S1002: should omit comparison to bool constant, can be simplified to verbose',
    )
  })

  /** A run with nothing to say, and a stream with nothing in it at all. */
  it('reads an empty run — and an empty stream — as no findings', () => {
    expect(parseGolangciJson('{"Issues":[]}\n0 issues.\n', REPO, REPO)).toEqual([])
    expect(parseGolangciJson('', REPO, REPO)).toEqual([])
    expect(parseGolangciJson('not json at all\n', REPO, REPO)).toEqual([])
  })

  /**
   * The document has to be found inside a stream the tool also writes prose
   * into, so the search is asserted against a hostile issue: a message carrying
   * braces, quotes, a newline and non-ASCII text, in a package under a path
   * with a space, with the summary appended as the real tool appends it.
   */
  it('survives a message that carries braces, quotes and unicode', () => {
    const text = 'struct{}{} said "☃\n}" — and }{ too'
    const stream = `${JSON.stringify({
      Issues: [
        {
          FromLinter: 'gocritic',
          Text: text,
          Pos: { Filename: 'odd dir/a.go', Line: 3, Column: 7 },
        },
      ],
    })}\n1 issues:\n* gocritic: 1\n`

    expect(
      parseGolangciJson(stream, REPO, REPO).map((finding) => [
        finding.rule,
        finding.file,
        finding.message,
      ]),
    ).toEqual([['gocritic', 'odd dir/a.go', text]])
  })

  /**
   * `Pos.Filename` is relative to the directory the run happened in, so a
   * project below the repo root places its findings under that project — and an
   * absolute path, which golangci-lint prints for a file outside the run
   * directory, is placed against the root instead of joined onto it.
   */
  it('places a relative filename under the project and an absolute one under the root', () => {
    const stream = JSON.stringify({
      Issues: [
        { FromLinter: 'errcheck', Text: 'a', Pos: { Filename: 'a.go', Line: 1, Column: 1 } },
        {
          FromLinter: 'errcheck',
          Text: 'b',
          Pos: { Filename: `${REPO}/services/api/b.go`, Line: 2, Column: 2 },
        },
      ],
    })

    expect(
      parseGolangciJson(stream, `${REPO}/services/api`, REPO).map((finding) => finding.file),
    ).toEqual(['services/api/a.go', 'services/api/b.go'])
  })
})

describe('the golangci-lint runner', () => {
  /**
   * Ownership is a config file and nothing else: `go run` fetches the binary,
   * so there is never a repo-local install — which is what puts the runner on
   * the standby branch rather than letting it suppress our defaults outright.
   */
  it('is owned by a repo that carries a .golangci config, and by nothing else', async () => {
    let fixture: FixtureRepo | undefined
    const bare = await mkdtemp(join(tmpdir(), 'crank-golangci-bare-'))
    try {
      fixture = await createFixtureRepo('go-owned')
      const owned = inventoryOf(['go.mod', 'main.go', '.golangci.yml'])

      expect(
        await golangciLintRunner.detect({
          repoRoot: fixture.root,
          project: repoProject(owned),
          files: owned,
        }),
      ).toEqual({
        reason: 'config',
        configFiles: ['.golangci.yml'],
        ownedVia: '.golangci.yml',
        installed: false,
      })

      await writeFile(join(bare, 'go.mod'), 'module example.com/bare\n\ngo 1.25\n', 'utf8')
      const none = inventoryOf(['go.mod', 'main.go'])
      expect(
        await golangciLintRunner.detect({
          repoRoot: bare,
          project: repoProject(none),
          files: none,
        }),
      ).toBeNull()
    } finally {
      await fixture?.remove()
      await rm(bare, { recursive: true, force: true })
    }
  })
})

/**
 * The standby machinery, at report level: `run.ts` over the `go-owned` fixture
 * under a farmed `PATH` whose `go` replays captured bytes per subcommand.
 *
 * What is under test is not new code — no suppression logic ships with this
 * runner — it is the *wiring*: a `repoOwnedOnly` owner whose binary has to be
 * fetched claims `lint` without suppressing crank-health's own Go linters, and
 * whether those linters' verdicts count is decided by whether the owner graded.
 */
describe('a Go repo that owns golangci-lint', () => {
  it(
    'grades lint by golangci-lint alone, and leaves staticcheck’s other categories alone',
    async () => {
      const fixture = await createFixtureRepo('go-owned')
      try {
        const scan = await scanReplaying(fixture, {
          stdout: await captured(CAPTURE),
          exitCode: 1,
        })

        expect(toolRows(scan.tools, 'lint')).toEqual([
          { tool: GO_VET_TOOL, state: 'ok', reason: 'stood down: lint graded by golangci-lint' },
          { tool: GOLANGCI_LINT_TOOL, state: 'ok', reason: null },
          {
            tool: STATICCHECK_TOOL,
            state: 'ok',
            reason: 'stood down: lint graded by golangci-lint',
          },
        ])
        // The two categories the same staticcheck run answers for are untouched:
        // standing a tool down is per category, not per tool.
        expect(toolRows(scan.tools, 'types')).toEqual([
          { tool: STATICCHECK_TOOL, state: 'ok', reason: null },
        ])
        expect(toolRows(scan.tools, 'dead-code')).toEqual([
          { tool: STATICCHECK_TOOL, state: 'ok', reason: null },
        ])

        expect(lintRules(scan.findings)).toEqual([
          [GOLANGCI_LINT_TOOL, 'staticcheck'],
          [GOLANGCI_LINT_TOOL, 'unused'],
        ])
      } finally {
        await fixture.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )

  /**
   * The owner could not speak — a v2 binary handed a v1 config exits 6 having
   * printed no report — so the standbys are promoted and grade `lint` on
   * crank-health's defaults. Never a crash, never a flattering grade, and the
   * report says whose config the grade came from.
   */
  it(
    'promotes the standbys when golangci-lint could not run',
    async () => {
      const fixture = await createFixtureRepo('go-owned')
      try {
        const scan = await scanReplaying(fixture, {
          stdout: '',
          stderr: CONFIG_REJECTED,
          exitCode: 6,
        })

        expect(toolRows(scan.tools, 'lint')).toEqual([
          { tool: GO_VET_TOOL, state: 'ok', reason: null },
          {
            tool: GOLANGCI_LINT_TOOL,
            state: 'error',
            reason: `golangci-lint exited 6 with nothing to report: ${CONFIG_REJECTED.split('\n')[0]}`,
          },
          { tool: STATICCHECK_TOOL, state: 'ok', reason: null },
        ])
        expect(lintRules(scan.findings)).toEqual([
          [STATICCHECK_TOOL, 'S1002'],
          [STATICCHECK_TOOL, 'SA1006'],
          [STATICCHECK_TOOL, 'SA4006'],
        ])
        expect(scan.categories.lint.status).toBe('graded')
        expect(scan.warnings).toContain(
          'staticcheck: graded lint on its default config because golangci-lint reported error',
        )
      } finally {
        await fixture.remove()
      }
    },
    SCAN_TIMEOUT_MS,
  )
})

/** Roomy: the run drives a real `npx jscpd` over the fixture. */
const SCAN_TIMEOUT_MS = 180_000

/** What a v2.12.2 binary says about a config written for v1. */
const CONFIG_REJECTED =
  'Error: can\'t load config: unsupported version of the configuration: ""\nFailed executing command with error: can\'t load config\n'

/** One category's tool records, in report order, as tool/state/reason triples. */
function toolRows(
  tools: Report['tools'],
  category: string,
): { tool: string; state: string; reason: string | null }[] {
  return tools
    .filter((tool) => tool.category === category)
    .map((tool) => ({ tool: tool.tool, state: tool.state, reason: tool.reason }))
}

/** Every lint finding as a tool/rule pair, in report order. */
function lintRules(findings: readonly { category: string; tool: string; rule: string }[]) {
  return findings
    .filter((finding) => finding.category === 'lint')
    .map((finding) => [finding.tool, finding.rule])
}

/**
 * One scan of a fixture under a `PATH` whose `go` dispatches on its argv: the
 * gate's `version`, `vet`'s empty document, staticcheck's captured stream and
 * golangci-lint's replayed one. A subcommand nobody planted exits 0 saying
 * nothing — a `go run` this table does not know is a tool that reported
 * nothing, not a tool that failed.
 */
async function scanReplaying(
  fixture: FixtureRepo,
  golangci: { stdout: string; stderr?: string; exitCode?: number },
): Promise<{
  readonly tools: Report['tools']
  readonly categories: Report['categories']
  readonly warnings: readonly string[]
  readonly findings: ReturnType<typeof reportFindings>
}> {
  const staticcheck = (await captured('staticcheck-0.7.0.jsonl')).replaceAll(REPO, fixture.root)
  const farm = await pathFarm({
    go: goDispatching([
      { match: '*staticcheck*', stdout: staticcheck, exitCode: 1 },
      {
        match: '*golangci*',
        stdout: golangci.stdout,
        stderr: golangci.stderr ?? '',
        exitCode: golangci.exitCode ?? 0,
      },
      { match: '*gocognit*', stdout: await captured('gocognit-1.2.1.json') },
      { match: '*gosec*', stdout: '{"Golang errors":{},"Issues":[]}' },
      { match: 'vet', stdout: '{}\n' },
    ]),
    gofmt: '#!/bin/sh\nexit 0\n',
  })
  const out = await mkdtemp(join(tmpdir(), 'crank-golangci-out-'))
  const original = process.env['PATH']
  process.env['PATH'] = farm.path
  try {
    const result = await runHealthScan({ path: fixture.root, out })
    return {
      tools: result.report.tools,
      categories: result.report.categories,
      warnings: result.report.warnings,
      findings: reportFindings(result.report),
    }
  } finally {
    process.env['PATH'] = original
    await farm.remove()
    await rm(out, { recursive: true, force: true })
  }
}

/** One replay entry: which argv word selects it, and what it then says. */
interface Replay {
  readonly match: string
  readonly stdout: string
  readonly stderr?: string
  readonly exitCode?: number
}

/**
 * A fake `go`: the gate's version line, then a case table over every argument,
 * so `go run <path>@<version> …` is selected by the analyzer's import path
 * rather than by an argument position. Tasks that add a Go analyzer extend the
 * table rather than leaving their runner on the silent branch.
 */
function goDispatching(replays: readonly Replay[]): string {
  const branches = replays.flatMap((replay) => [
    `    ${replay.match})`,
    "      cat <<'CRANK_OUT'",
    replay.stdout.replace(/\n$/, ''),
    'CRANK_OUT',
    "      cat >&2 <<'CRANK_ERR'",
    (replay.stderr ?? '').replace(/\n$/, ''),
    'CRANK_ERR',
    `      exit ${replay.exitCode ?? 0} ;;`,
  ])
  return [
    '#!/bin/sh',
    'if [ "$1" = version ]; then echo "go version go1.26.6 darwin/arm64"; exit 0; fi',
    'for arg in "$@"; do',
    '  case "$arg" in',
    ...branches,
    '  esac',
    'done',
    'exit 0',
  ].join('\n')
}
