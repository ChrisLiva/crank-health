import { asArray, asRecord, asString, compare } from '../support.ts'

/**
 * govulncheck — the Go vulnerability analyzer from `golang.org/x/vuln`.
 *
 * **What it adds that a lockfile audit cannot.** osv-scanner reads `go.mod` and
 * reports every advisory published against a pinned module. govulncheck loads
 * the package graph and says which of those the repo can actually reach: the
 * symbol is called, the package is imported but the symbol never called, or the
 * module is in the graph and the vulnerable package is not imported at all.
 *
 * **Verdicts are recorded verbatim.** govulncheck itself over-claims when a
 * database record carries no symbol information — every advisory against such a
 * module reads as module-level whatever the code does — and we still take its
 * word in both directions. Second-guessing a reachability analyzer with a local
 * heuristic is how a scanner starts reporting a confident answer nobody can
 * check; the verdict is on every advisory in `report.json`, so a reader can.
 */

/** The reachability verdicts govulncheck's trace granularity distinguishes. */
export type Reachability = 'symbol-reachable' | 'imported-no-call' | 'not-imported'

/**
 * Deepest first: a module reported at several granularities is as reachable as
 * its deepest trace says, which is what govulncheck's own summary reports.
 */
const GRANULARITY: readonly Reachability[] = ['symbol-reachable', 'imported-no-call', 'not-imported']

/** One advisory govulncheck reported against one module, with its verdict. */
export interface GoVulnerability {
  /** The Go vulnerability database id, e.g. `GO-2026-4945`. */
  readonly osv: string
  /** Every other id this advisory is published under, sorted; `[]` when none. */
  readonly aliases: readonly string[]
  /** The advisory's one-line summary; empty when it publishes none. */
  readonly summary: string
  /** The vulnerable module's path, as Go names it. */
  readonly module: string
  /** The version in the module graph, `v`-prefixed as Go reports it. */
  readonly version: string
  /** `fixed_version`, or `undefined` when the advisory names no fix. */
  readonly fixedIn: string | undefined
  readonly reachability: Reachability
}

/**
 * Parses `govulncheck -json`, which is a *stream* of brace-balanced JSON
 * objects rather than one document: a `config` record, an `SBOM`, `progress`
 * notes, one `osv` record per advisory in the database slice it loaded, and one
 * `finding` per (advisory, trace) pair.
 *
 * The advisory metadata and the verdict come from different records, so both
 * halves are collected before either is used: `osv` carries the summary and the
 * aliases that join this to osv-scanner's report, `finding` carries the module,
 * the fix and the trace. An `osv` record no finding references is an advisory
 * that did not apply, and produces nothing.
 *
 * Exported so a format shift fails a test instead of silently reporting a Go
 * repo with no reachable vulnerabilities.
 *
 * @returns one entry per advisory *with* a finding, sorted by advisory id
 */
export function parseGovulncheckStream(stream: string): GoVulnerability[] {
  const records = streamObjects(stream)
  const advisories = new Map<string, { aliases: readonly string[]; summary: string }>()
  for (const record of records) {
    const osv = asRecord(record['osv'])
    const id = asString(osv?.['id'])
    if (osv === undefined || id === undefined) continue
    advisories.set(id, {
      aliases: (asArray(osv['aliases']) ?? [])
        .flatMap((alias) => (asString(alias) === undefined ? [] : [String(alias)]))
        .toSorted(compare),
      summary: asString(osv['summary']) ?? '',
    })
  }

  const found = new Map<string, GoVulnerability>()
  for (const record of records) {
    const finding = asRecord(record['finding'])
    const id = asString(finding?.['osv'])
    if (finding === undefined || id === undefined) continue
    const head = asRecord(asArray(finding['trace'])?.[0])
    const module = asString(head?.['module'])
    if (head === undefined || module === undefined) continue

    const advisory = advisories.get(id)
    const entry: GoVulnerability = {
      osv: id,
      aliases: advisory?.aliases ?? [],
      summary: advisory?.summary ?? '',
      module,
      version: asString(head['version']) ?? '',
      fixedIn: asString(finding['fixed_version']),
      reachability: granularityOf(head),
    }
    found.set(id, deepest(found.get(id), entry))
  }

  return [...found.values()].toSorted((a, b) => compare(a.osv, b.osv))
}

/**
 * How deep this trace reaches, read off its head — the vulnerable end of the
 * call chain. A `function` there means govulncheck traced a call to the
 * vulnerable symbol; a `package` without one means the package is imported and
 * the symbol is not called; neither means only the module is in the graph.
 */
function granularityOf(head: Record<string, unknown>): Reachability {
  if (asString(head['function']) !== undefined) return 'symbol-reachable'
  return asString(head['package']) === undefined ? 'not-imported' : 'imported-no-call'
}

/**
 * The deeper of two findings for one advisory. govulncheck emits a finding per
 * trace, so a reachable symbol arrives alongside the module-level record of the
 * same advisory; reporting the shallower of them would call a live call site
 * "not imported".
 */
function deepest(known: GoVulnerability | undefined, entry: GoVulnerability): GoVulnerability {
  if (known === undefined) return entry
  return GRANULARITY.indexOf(entry.reachability) < GRANULARITY.indexOf(known.reachability)
    ? { ...entry, fixedIn: entry.fixedIn ?? known.fixedIn }
    : { ...known, fixedIn: known.fixedIn ?? entry.fixedIn }
}

/**
 * Splits a concatenated JSON object stream into its objects.
 *
 * `JSON.parse` cannot read the stream and a line-based split cannot either —
 * govulncheck pretty-prints, so one object spans many lines and `}` at column 0
 * is both the end of an object and the end of most of its members. Counting
 * braces outside strings is the only rule that holds, and it has to know about
 * escapes: a `}` inside a summary is not a delimiter.
 *
 * Anything that does not parse is dropped rather than thrown: a truncated
 * stream (the tool was killed mid-write) still yields the objects that
 * completed, which is more than a scan reporting nothing at all.
 */
function streamObjects(stream: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < stream.length; index++) {
    const char = stream[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char !== '}' || depth === 0) continue
    depth--
    if (depth !== 0) continue
    const parsed = parseObject(stream.slice(start, index + 1))
    if (parsed !== undefined) objects.push(parsed)
  }

  return objects
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}
