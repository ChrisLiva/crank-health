import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  batchFiles,
  errorMessage,
  failed,
  readFileOrUndefined,
  repoRelative,
  unavailable,
} from '../src/adapters/support.ts'

/**
 * The two shared helpers whose failure modes are silent: an over-long command
 * line truncates a scan, and a path in the wrong form makes a finding land on a
 * file the rest of the pipeline has never heard of.
 */
describe('batchFiles', () => {
  it('splits a file list that would overflow the command line', () => {
    const files = Array.from({ length: 10 }, (_, index) => `src/file-${index}.js`)
    const budget = 40
    const batches = batchFiles(files, budget)

    // Every batch is one invocation's worth of argument bytes — the point of
    // splitting at all is that none of them can overflow.
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0)
      expect(Buffer.byteLength(batch.join(' '), 'utf8')).toBeLessThanOrEqual(budget)
    }
    // …and between them the batches scan exactly the list they were handed.
    expect(batches.flat()).toEqual(files)

    // A list that fits stays one invocation.
    expect(batchFiles(['a.js', 'b.js'])).toEqual([['a.js', 'b.js']])
  })

  it('never drops a file longer than the whole budget', () => {
    expect(batchFiles(['a-very-long-name.js'], 4)).toEqual([['a-very-long-name.js']])
  })
})

describe('repoRelative', () => {
  it('strips the ./ prefix some tools emit', () => {
    const cases = [
      ['./src/a.ts', 'src/a.ts'],
      // …and a path already in repo-relative form is left alone.
      ['src/a.ts', 'src/a.ts'],
    ] as const
    for (const [reported, expected] of cases) {
      expect(repoRelative(reported)).toBe(expected)
    }
  })

  it('relativizes the absolute paths ESLint and tsc report', () => {
    expect(repoRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(repoRelative('/repo/src/nested/a.ts', '/repo')).toBe('src/nested/a.ts')
  })
})

/**
 * The four helpers every runner leans on for its unhappy path. Each one is a
 * few lines, and each one was copied into a dozen files before it lived here,
 * so what these pin is the exact shape those copies agreed on.
 */
describe('failed', () => {
  it('turns a tool failure into the ToolResult that carries it', () => {
    expect(failed({ state: 'timeout', reason: 'r' }, ['a'])).toEqual({
      state: 'timeout',
      findings: [],
      rawFiles: ['a'],
      reason: 'r',
    })
  })

  it('reports no raw evidence when the run produced none', () => {
    expect(failed({ state: 'error', reason: 'r' })).toEqual({
      state: 'error',
      findings: [],
      rawFiles: [],
      reason: 'r',
    })
  })
})

describe('unavailable', () => {
  it('states the reason a tool could not be assessed', () => {
    expect(unavailable('x')).toEqual({
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'x',
    })
  })
})

describe('readFileOrUndefined', () => {
  it('reads a file a tool left behind, and answers undefined when it did not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crank-support-'))
    try {
      const file = join(dir, 'report.json')
      await writeFile(file, 'hi', 'utf8')
      expect(await readFileOrUndefined(file)).toBe('hi')

      // The tool wrote the file but put nothing in it: '' is an answer and
      // undefined is not, and the callers branch on which one they got.
      const empty = join(dir, 'empty.json')
      await writeFile(empty, '', 'utf8')
      expect(await readFileOrUndefined(empty)).toBe('')

      // Decoded as utf8 byte for byte: mutation reports quote source lines,
      // CRLF and all.
      const hostile = '{"m":"héllo → 🧪\r\n "}'
      const unicode = join(dir, 'unicode.json')
      await writeFile(unicode, hostile, 'utf8')
      expect(await readFileOrUndefined(unicode)).toBe(hostile)

      // ENOENT and its siblings alike: a directory where a file was expected
      // (EISDIR) is the same "no output to parse" as nothing there at all.
      expect(await readFileOrUndefined(join(dir, 'missing.json'))).toBeUndefined()
      expect(await readFileOrUndefined(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('errorMessage', () => {
  it('names what went wrong whether or not it was thrown as an Error', () => {
    expect(errorMessage(new Error('m'))).toBe('m')
    expect(errorMessage(42)).toBe('42')
  })
})
