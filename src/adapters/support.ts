import { access, readFile } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { readSources } from '../core/discover.ts'
import { computeAnchors } from '../core/fingerprint.ts'
import type { Finding, PendingFinding, RunContext } from '../core/types.ts'

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
 * Between a memo key's two halves; can never appear in a path — which a space
 * can, and a project directory holding one would otherwise share a key with its
 * sibling.
 */
const KEY_SEPARATOR = '\u0000'

/**
 * One scan's per-project work, memoized: the trio of runners that share a
 * single expensive invocation (`dotnet build`, `staticcheck ./...`) call
 * {@link ScanMemo.for} and every one of them awaits the same promise.
 *
 * The **promise** is cached, not the result, so runners the orchestrator's pool
 * started concurrently share one invocation instead of racing several — and
 * every one of them reads the same resolved value, which is what makes "the
 * identical reason from all three" hold by construction when the work failed.
 */
export interface ScanMemo<T> {
  /** This scan × project's work, started at most once. */
  for(ctx: RunContext, make: (ctx: RunContext) => Promise<T>): Promise<T>
  /** Releases everything memoized under a scan's scratch dir; see below. */
  forget(runScratch: string): void
}

/**
 * A fresh memo, keyed on {@link RunContext.runScratch} — the scan-root scratch
 * every job shares — plus the project path. The per-job `ctx.scratch` would
 * never collide across one project's trio and would therefore never share.
 *
 * {@link ScanMemo.forget} is called from the scan teardowns beside the `rm` of
 * that dir, so a long-lived process (the test suite) does not retain a scan's
 * parsed output for ever. It matches by path prefix because PR mode nests its
 * two sides (`<scratch>/base-scratch`, `<scratch>/head-scratch`) under the one
 * dir its `finally` holds: forgetting that dir must release both.
 */
export function scanMemo<T>(): ScanMemo<T> {
  const entries = new Map<string, Promise<T>>()
  return {
    for(ctx: RunContext, make: (ctx: RunContext) => Promise<T>): Promise<T> {
      const key = `${ctx.runScratch}${KEY_SEPARATOR}${ctx.project.path}`
      const cached = entries.get(key)
      if (cached !== undefined) return cached
      const started = make(ctx)
      entries.set(key, started)
      return started
    },
    forget(runScratch: string): void {
      const prefix = `${runScratch}/`
      for (const key of entries.keys()) {
        const root = key.slice(0, key.indexOf(KEY_SEPARATOR))
        if (root === runScratch || root.startsWith(prefix)) entries.delete(key)
      }
    },
  }
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

/**
 * A path reported by a tool that was pointed at one project, as the repo sees
 * it. A whole-tree analyzer takes a directory rather than a file list, and it
 * reports inside that directory — `src/index.js`, not
 * `packages/api/src/index.js`. Everything downstream is repo-root-relative, and
 * finding identity is computed from that path, so the offset goes back on here.
 *
 * The root project is the identity case: its directory is the repo's.
 *
 * @param project repo-relative posix project directory, `.` for the root
 */
export function underProject(project: string, file: string): string {
  const path = repoRelative(file)
  return project === '.' ? path : `${project}/${path}`
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

/** What replaces a source excerpt in raw evidence; see {@link sanitizeRawResults}. */
export const OMITTED = '<omitted>'

/**
 * Raw tool output with every entry of its `results` array rewritten.
 *
 * **Why raw evidence is not always literal.** `raw/` is what a reader opens to
 * check a finding, and it is also what they attach to a ticket. Security
 * scanners quote the source line they matched — bandit's `code` window,
 * opengrep's `extra.lines` — and the line a secrets-adjacent rule matched is
 * the one line that must not be copied anywhere. The locations, rules and
 * messages stay; only the excerpts go, and the file they point at is still
 * right there in the repo.
 *
 * Output that is not the tool's result envelope (unparseable, or a different
 * shape) is returned unchanged: it is the only clue to a failure the runner is
 * about to report, and it is not a document this can reason about.
 *
 * @param sanitize called for each result object; return it unchanged when there
 * is nothing in it to drop
 */
export function sanitizeRawResults(
  stdout: string,
  sanitize: (result: Record<string, unknown>) => Record<string, unknown>,
): string {
  if (stdout.trim().length === 0) return stdout
  let document: unknown
  try {
    document = JSON.parse(stdout)
  } catch {
    return stdout
  }
  const record = asRecord(document)
  const results = asArray(record?.['results'])
  if (record === undefined || results === undefined) return stdout

  const sanitized = results.map((entry) => {
    const result = asRecord(entry)
    return result === undefined ? entry : sanitize(result)
  })
  return `${JSON.stringify({ ...record, results: sanitized }, null, 2)}\n`
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
