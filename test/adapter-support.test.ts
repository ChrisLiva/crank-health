import { describe, expect, it } from 'vitest'
import { batchFiles, repoRelative } from '../src/adapters/support.ts'

/**
 * The two shared helpers whose failure modes are silent: an over-long command
 * line truncates a scan, and a path in the wrong form makes a finding land on a
 * file the rest of the pipeline has never heard of.
 */
describe('batchFiles', () => {
  it('keeps a small file list in one invocation', () => {
    expect(batchFiles(['a.js', 'b.js'])).toEqual([['a.js', 'b.js']])
  })

  it('splits a file list that would overflow the command line', () => {
    const files = Array.from({ length: 10 }, (_, index) => `src/file-${index}.js`)
    const batches = batchFiles(files, 40)
    expect(batches.flat()).toEqual(files)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every((batch) => batch.length > 0)).toBe(true)
  })

  it('never drops a file longer than the whole budget', () => {
    expect(batchFiles(['a-very-long-name.js'], 4)).toEqual([['a-very-long-name.js']])
  })
})

describe('repoRelative', () => {
  it('leaves an already repo-relative path alone', () => {
    expect(repoRelative('src/a.ts')).toBe('src/a.ts')
  })

  it('strips the ./ prefix some tools emit', () => {
    expect(repoRelative('./src/a.ts')).toBe('src/a.ts')
  })

  it('relativizes the absolute paths ESLint and tsc report', () => {
    expect(repoRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(repoRelative('/repo/src/nested/a.ts', '/repo')).toBe('src/nested/a.ts')
  })
})
