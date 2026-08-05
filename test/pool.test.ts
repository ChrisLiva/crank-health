import { describe, expect, it } from 'vitest'
import { mapLimit } from '../src/core/pool.ts'

describe('mapLimit', () => {
  it('keeps input order regardless of completion order', async () => {
    const results = await mapLimit([30, 0, 15], 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return index
    })
    expect(results).toEqual([0, 1, 2])
  })

  it('runs at most `limit` tasks at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapLimit(
      Array.from({ length: 20 }, (_, index) => index),
      3,
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
      },
    )
    expect(peak).toBe(3)
  })

  it('handles an empty list and a nonsensical limit', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
    expect(await mapLimit([1, 2], 0, async (value) => value * 2)).toEqual([2, 4])
  })
})
