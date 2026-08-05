import { access, readFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { readSources } from '../core/discover.ts'
import { computeAnchors } from '../core/fingerprint.ts'
import type { Finding, PendingFinding } from '../core/types.ts'

/**
 * The parts every tool wrapper repeats, in one place: reading JSON off disk
 * without trusting its shape, turning tool-reported paths into the repo-relative
 * posix form the `Finding` schema mandates, and handing pending findings to the
 * core so it — not the adapter — assigns identity.
 */

/**
 * Argument-list budget for one tool invocation. Real repos have more files than
 * a command line can hold, so the file list is spent across several runs and
 * their findings merged.
 */
export const MAX_ARGS_BYTES = 100_000

/** Splits the file list so no single command line exceeds {@link MAX_ARGS_BYTES}. */
export function batchFiles(files: readonly string[], budget = MAX_ARGS_BYTES): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let size = 0

  for (const file of files) {
    const cost = Buffer.byteLength(file, 'utf8') + 1
    if (current.length > 0 && size + cost > budget) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(file)
    size += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Identity is the core's job (`hash(category, tool, rule, file, anchor)`), and
 * it needs the flagged source lines — so the files that actually carry findings
 * are read here, and only those. Findings that supplied their own `anchor`
 * (symbol-level results from a dead-code or complexity tool) never need a read.
 */
export async function identify(
  repoRoot: string,
  pending: readonly PendingFinding[],
): Promise<Finding[]> {
  if (pending.length === 0) return []
  const sources = await readSources(
    repoRoot,
    pending.filter((finding) => finding.anchor === undefined).map((finding) => finding.file),
  )
  return computeAnchors(pending, sources)
}

/**
 * Stable order for parsed findings. Tools analyze files in parallel and report
 * in whatever order their workers finished, so every wrapper sorts before the
 * core sees the results: occurrence numbering — and therefore identity — must
 * not depend on thread scheduling.
 */
export function byLocation(a: PendingFinding, b: PendingFinding): number {
  return (
    compare(a.file, b.file) ||
    a.range.startLine - b.range.startLine ||
    a.range.startCol - b.range.startCol ||
    compare(a.rule, b.rule) ||
    compare(a.message, b.message)
  )
}

/**
 * A tool-reported path in the `Finding` schema's form: repo-relative, posix,
 * no `./` prefix. Tools variously report absolute paths (ESLint, tsc with an
 * external project), cwd-relative paths (Biome, prettier) or `./`-prefixed ones
 * (oxlint), and every one of them has to land on the same string as discovery.
 */
export function repoRelative(file: string, repoRoot = ''): string {
  const relativized = isAbsolute(file)
    ? relative(repoRoot, file).replaceAll('\\', '/')
    : file.replaceAll('\\', '/')
  return relativized.replace(/^\.\//, '')
}

/** Byte-wise ordering, not locale-aware: the sort must not vary by machine. */
export function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** First non-empty line of a stream, for one-line failure reasons. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

/** Parses a JSON file, or `undefined` when it is missing or malformed. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
