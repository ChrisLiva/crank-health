import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gosecRunner, parseGosecJson, sanitizeRawJson } from '../src/adapters/go/gosec.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'
import { pathFarm } from './support/path-farm.ts'

/**
 * gosec — the Go security scanner, and the one Go tool that quotes the source
 * it flagged.
 *
 * The capture is a real `go run
 * github.com/securego/gosec/v2/cmd/gosec@v2.28.0 -fmt=json ./...` over a
 * throwaway `go-basic`-shaped tree carrying a planted hardcoded credential
 * (G101) and a weak random source (G404). Two bytes were rewritten before it
 * was checked in: the absolute tree root became `/repo`, and every `code`
 * excerpt became `<omitted>` — the same way `bandit-1.9.4.json` is stored,
 * because a capture is a file in this repo and a credential-shaped literal
 * quoted in a `code` window would be a credential checked in.
 */

const CAPTURE = fileURLToPath(new URL('./captured/gosec-2.28.0.json', import.meta.url))

/** The root the capture was sanitized to. */
const REPO = '/repo'

/**
 * A credential-shaped literal that exists only while this test runs: the
 * unscrubbed bytes the sanitizer is fed are built here, so the checked-in
 * capture stays free of one.
 */
const PLANTED_SECRET = 'AKIA4XZQ7WPD2NR6VK8TJ1'

/**
 * The load-failure envelope, from a real run of the same pinned invocation over
 * a module whose package does not type-check: `Issues` empty, and `Golang
 * errors` keyed by file — plus the `""` key Go heads with `# <package>`.
 */
const LOAD_FAILURE = JSON.stringify({
  'Golang errors': {
    '': [
      {
        line: 0,
        column: 0,
        error:
          '# command-line-arguments\n./broken.go:4:9: cannot use "not an int" ' +
          '(untyped string constant) as int value in return statement',
      },
    ],
    '/repo/broken.go': [
      {
        line: 4,
        column: 9,
        error: 'cannot use "not an int" (untyped string constant) as int value in return statement',
      },
    ],
  },
  Issues: [],
  Stats: { files: 1, lines: 5, nosec: 0, found: 0 },
  GosecVersion: 'dev',
})

/** A clean run: gosec prints the whole envelope and exits 0. */
const CLEAN = JSON.stringify({
  'Golang errors': {},
  Issues: [],
  Stats: { files: 1, lines: 9, nosec: 0, found: 0 },
  GosecVersion: 'dev',
})

describe('parseGosecJson', () => {
  let captured: string

  beforeAll(async () => {
    captured = await readFile(CAPTURE, 'utf8')
  })

  /**
   * Every issue of the captured run, in `byLocation` order rather than the
   * order gosec printed them — it reported `tokens.go` first — and with its
   * absolute path relativized and its string `line`/`column` read as numbers.
   */
  it('reads the captured run’s issues, sorted and placed in the repo', () => {
    const outcome = parseGosecJson(captured, REPO)

    expect(
      outcome.findings.map((finding) => [finding.rule, finding.file, finding.range.startLine]),
    ).toEqual([
      ['G101', 'main.go', 5],
      ['G404', 'tokens.go', 7],
    ])
    expect(outcome.loadErrors).toEqual([])
    expect(outcome.findings[0]).toMatchObject({
      category: 'security',
      tool: 'gosec',
      severity: 'warning',
      range: { startLine: 5, startCol: 7, endLine: 5, endCol: 7 },
      provenance: 'default-config',
      gradeScope: true,
    })
    expect(outcome.findings[0]?.message).toContain('Potential hardcoded credentials')
  })

  /**
   * The excerpt never becomes part of a finding: the drop is asserted at the
   * boundary a finding crosses, not by reading a private field.
   */
  it('carries no source excerpt into the findings it produces', () => {
    expect(JSON.stringify(parseGosecJson(captured, REPO))).not.toContain('"code"')
  })

  /**
   * A module whose packages do not load: gosec has nothing to say about the
   * code and says why instead. The `# command-line-arguments` header Go writes
   * is not the diagnostic, so the entry carries the line that is.
   */
  it('reads a load failure as load errors and no findings', () => {
    const outcome = parseGosecJson(LOAD_FAILURE, REPO)

    expect(outcome.findings).toEqual([])
    expect(outcome.loadErrors).toEqual([
      './broken.go:4:9: cannot use "not an int" (untyped string constant) as int value in return ' +
        'statement',
      'broken.go:4:9: cannot use "not an int" (untyped string constant) as int value in return ' +
        'statement',
    ])
  })

  /** Nothing to read is no findings and no errors, never a throw. */
  it('reads an empty, clean or unparseable stream as nothing at all', () => {
    const nothing = { loadErrors: [], findings: [] }
    expect(parseGosecJson('', REPO)).toEqual(nothing)
    expect(parseGosecJson(CLEAN, REPO)).toEqual(nothing)
    expect(parseGosecJson('not json at all', REPO)).toEqual(nothing)
    expect(parseGosecJson('{"Issues":[]}', REPO)).toEqual(nothing)
  })
})

/**
 * The scrub that stands between a security scanner's source window and the run
 * directory. gosec's `code` is three lines of the flagged file, and on a G101
 * the middle one is the credential itself.
 */
describe('sanitizeRawJson', () => {
  let captured: string
  /** The capture with one `code` excerpt put back, as gosec really printed it. */
  let unscrubbed: string

  beforeAll(async () => {
    captured = await readFile(CAPTURE, 'utf8')
    unscrubbed = captured.replace(
      '"code": "<omitted>"',
      JSON.stringify('code') +
        ': ' +
        JSON.stringify(`4: \n5: const apiPassword = "${PLANTED_SECRET}"\n6: \n`),
    )
  })

  it('replaces every excerpt and leaves the evidence usable', () => {
    // The premise: the bytes fed in really do quote the credential.
    expect(unscrubbed).toContain(PLANTED_SECRET)

    const sanitized = sanitizeRawJson(unscrubbed)

    expect(sanitized).not.toContain(PLANTED_SECRET)
    expect(sanitized).not.toContain('AKIA')
    expect(sanitized).toContain('"code": "<omitted>"')
    // Still a gosec report, and still says where to look.
    expect(
      parseGosecJson(sanitized, REPO).findings.map((finding) => [
        finding.rule,
        finding.file,
        finding.range.startLine,
      ]),
    ).toEqual(
      parseGosecJson(unscrubbed, REPO).findings.map((finding) => [
        finding.rule,
        finding.file,
        finding.range.startLine,
      ]),
    )
  })

  /**
   * The scrub is a parse/serialize pair with the tool, so it is asserted
   * against a hostile excerpt rather than a friendly one: a matched line made
   * of quotes, braces, a tab, a backslash and non-ASCII text.
   */
  it('survives an excerpt made of quotes, braces, escapes and unicode', () => {
    const excerpt = '7: \tpwd := "ü\\{“x”}\t" // 秘密\n'
    const stdout = JSON.stringify({
      'Golang errors': {},
      Issues: [
        {
          severity: 'HIGH',
          confidence: 'LOW',
          rule_id: 'G101',
          details: 'Potential hardcoded credentials',
          file: '/repo/odd dir/a.go',
          code: excerpt,
          line: '7',
          column: '2',
        },
      ],
    })

    const sanitized = sanitizeRawJson(stdout)

    expect(sanitized).not.toContain('秘密')
    expect(JSON.parse(sanitized)).toEqual({
      'Golang errors': {},
      Issues: [
        {
          severity: 'HIGH',
          confidence: 'LOW',
          rule_id: 'G101',
          details: 'Potential hardcoded credentials',
          file: '/repo/odd dir/a.go',
          code: '<omitted>',
          line: '7',
          column: '2',
        },
      ],
    })
    expect(parseGosecJson(sanitized, REPO).findings.map((finding) => finding.file)).toEqual([
      'odd dir/a.go',
    ])
  })

  /** Output nothing can be made of is the only clue to why; it is kept as-is. */
  it.each(['', 'not json at all', '{"oops":true}'])(
    'passes through output that is not a gosec envelope: %s',
    (stdout) => {
      expect(sanitizeRawJson(stdout)).toBe(stdout)
    },
  )
})

/**
 * The runner over four real payload shapes: gosec's exit code alone does not
 * say whether a run happened, because it exits 1 both for "here are your
 * findings" and for "I could not load your packages".
 */
describe('the gosec runner', () => {
  let repoRoot: string
  let scratch: string
  let captured: string
  let original: string | undefined
  let farm: { path: string; remove(): Promise<void> } | undefined

  beforeAll(async () => {
    captured = await readFile(CAPTURE, 'utf8')
    repoRoot = await mkdtemp(join(tmpdir(), 'crank-gosec-repo-'))
    scratch = await mkdtemp(join(tmpdir(), 'crank-gosec-scratch-'))
    original = process.env['PATH']
  })

  afterAll(async () => {
    process.env['PATH'] = original
    await farm?.remove()
    await rm(repoRoot, { recursive: true, force: true })
    await rm(scratch, { recursive: true, force: true })
  })

  /** One run of the runner against a `go` that prints `stdout` and exits `code`. */
  async function runAgainst(
    stdout: string,
    exitCode: number,
    files: readonly string[] = ['main.go', 'tokens.go'],
  ) {
    // The farm resolves its own required binaries off `PATH`, so the real one
    // goes back before the next one is built.
    process.env['PATH'] = original
    await farm?.remove()
    farm = await pathFarm({ go: goReplaying(stdout, exitCode) })
    process.env['PATH'] = farm.path
    return await gosecRunner.run(contextFor(repoRoot, scratch, files))
  }

  it('reads exit 0 with an empty envelope as a completed clean run', async () => {
    const result = await runAgainst(CLEAN, 0)

    expect(result).toMatchObject({ state: 'ok', findings: [], toolVersion: 'v2.28.0' })
  })

  it('reads exit 1 with issues as a completed run with findings', async () => {
    const result = await runAgainst(captured.replaceAll(REPO, repoRoot), 1)

    expect(result.state).toBe('ok')
    expect(result.findings.map((finding) => finding.rule)).toEqual(['G101', 'G404'])
  })

  /**
   * No issues and a package that would not load: gosec analyzed nothing, and a
   * security category graded off nothing is the flattering A this refuses.
   */
  it('reads a load failure with no issues as an error naming the first one', async () => {
    const result = await runAgainst(LOAD_FAILURE, 1, ['broken.go'])

    expect(result).toMatchObject({
      state: 'error',
      findings: [],
      reason:
        './broken.go:4:9: cannot use "not an int" (untyped string constant) as int value in ' +
        'return statement',
    })
  })

  /**
   * Partial analysis beats nothing: gosec scanned the packages that loaded and
   * reported issues in them, so the run completed with what it found.
   */
  it('reads issues beside load errors as a completed run with findings', async () => {
    const partial = JSON.parse(captured.replaceAll(REPO, repoRoot)) as Record<string, unknown>
    partial['Golang errors'] = (JSON.parse(LOAD_FAILURE) as Record<string, unknown>)[
      'Golang errors'
    ]

    const result = await runAgainst(JSON.stringify(partial), 1)

    expect(result.state).toBe('ok')
    expect(result.findings.map((finding) => finding.rule)).toEqual(['G101', 'G404'])
  })

  /** Output that is not gosec's envelope at all: the run failed, and says so. */
  it('reads output it cannot parse as an error quoting the tool', async () => {
    const result = await runAgainst('panic: runtime error\n', 2)

    expect(result.state).toBe('error')
    expect(result.reason).toContain('gosec')
  })

  it('answers ok with nothing to measure when the project has no Go files', async () => {
    const result = await runAgainst(CLEAN, 0, [])

    expect(result).toEqual({ state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' })
  })
})

/** One project's run context over a file list this test chose. */
function contextFor(repoRoot: string, scratch: string, files: readonly string[]): RunContext {
  return {
    repoRoot,
    project: { ...makeProject(files), path: '.' },
    files,
    scratch,
    runScratch: scratch,
    detection: null,
    timeoutMs: 60_000,
    deep: false,
  }
}

/** A fake `go`: the gate's version line, then one payload and one exit code. */
function goReplaying(stdout: string, exitCode: number): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = version ]; then echo "go version go1.26.6 darwin/arm64"; exit 0; fi',
    "cat <<'CRANK_OUT'",
    stdout.replace(/\n$/, ''),
    'CRANK_OUT',
    `exit ${exitCode}`,
  ].join('\n')
}
