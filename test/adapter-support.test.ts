import { describe, expect, it } from 'vitest'
import { batchFiles, repoRelative } from '../src/adapters/support.ts'

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
