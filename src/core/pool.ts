/**
 * Bounded-concurrency map. Used for tool runs (spec §5 concurrency cap) and for
 * the file-system fan-out in discovery, where unbounded `Promise.all` risks
 * EMFILE on large repos.
 *
 * Results keep the input order regardless of completion order, so callers stay
 * deterministic. Never rejects: `fn` is expected to settle every task itself.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  const width = Math.max(1, Math.min(Math.trunc(limit), items.length))
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      // Sequential by design: this is one worker draining the shared queue.
      // eslint-disable-next-line no-await-in-loop
      results[index] = await fn(items[index] as T, index)
    }
  }

  await Promise.all(Array.from({ length: width }, worker))
  return results
}
