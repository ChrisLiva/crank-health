import type { Finding, FindingPackage, PackageAdvisory, PendingFinding } from '../../core/types.ts'
import { asArray, asRecord, asString, byLocation, compare } from '../support.ts'
import { OSV_PACKAGE_RULE, severityOf, summarizePackage } from './osv-scanner.ts'

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

export const GOVULNCHECK_TOOL = 'govulncheck'

/** The advisory database Go modules are reported under, in OSV's vocabulary. */
export const GO_ECOSYSTEM = 'Go'

/** The reachability verdicts govulncheck's trace granularity distinguishes. */
export type Reachability = 'symbol-reachable' | 'imported-no-call' | 'not-imported'

/**
 * Deepest first: a module reported at several granularities is as reachable as
 * its deepest trace says, which is what govulncheck's own summary reports.
 */
const GRANULARITY: readonly Reachability[] = [
  'symbol-reachable',
  'imported-no-call',
  'not-imported',
]

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

/**
 * The verdicts that leave a finding in the graded set: a reachable symbol, and
 * no verdict at all.
 *
 * "No verdict" is the honest default rather than a gap. An advisory nothing
 * analyzed for reachability — every advisory outside Go, and every Go one on a
 * machine with no `go` — is graded exactly as it always was; only a reachability
 * analyzer's explicit "this cannot be reached from here" demotes one. That is
 * what keeps a missing toolchain from quietly improving a grade.
 */
export function isGraded(reachability: string | undefined): boolean {
  return reachability === undefined || reachability === 'symbol-reachable'
}

/**
 * What a demoted finding's message says it was demoted for. The verdict token
 * itself leads, so the reason in the human report and the `reachability` field
 * in `report.json` are searchable as one string.
 */
const VERDICT_TEXT: Readonly<Record<Reachability, string>> = {
  'symbol-reachable': 'symbol-reachable — govulncheck traced a call to a vulnerable symbol',
  'imported-no-call': 'imported-no-call — govulncheck traced no call to a vulnerable symbol',
  'not-imported': 'not-imported — govulncheck found no import of a vulnerable package',
}

/**
 * govulncheck's vulnerabilities → the core's vocabulary, **one finding per
 * vulnerable module**, matching `osv-scanner.ts`'s shape exactly: same rule,
 * same `package@version` anchor, same one-line message. That is what lets
 * {@link mergeReachability} fold one into the other where both tools saw the
 * same dependency, and what makes a Go-only repo's row read the same as an
 * npm repo's when only govulncheck ran.
 *
 * **Severity is `info`.** The Go vulnerability database publishes no CVSS
 * score, so there is nothing to map (spec §2) and inventing one would be the
 * local inference this runner exists to avoid. Where osv-scanner also saw the
 * package it supplies the severity and govulncheck supplies the reachability —
 * the division of labour that makes the two `complementary` rather than
 * alternatives.
 *
 * @param goMod repo-relative path of the `go.mod` these modules are pinned by:
 * the file a reader edits, and the file identity is hashed from
 */
export function toPendingFindings(
  vulnerabilities: readonly GoVulnerability[],
  goMod: string,
): (PendingFinding & { readonly anchor: string })[] {
  return [...byModule(vulnerabilities).values()]
    .map((group) => moduleFinding(group, goMod))
    .toSorted(byLocation)
}

/** One module's advisories, keyed so two versions of one module never merge. */
function byModule(vulnerabilities: readonly GoVulnerability[]): Map<string, GoVulnerability[]> {
  const groups = new Map<string, GoVulnerability[]>()
  for (const vulnerability of vulnerabilities) {
    const key = `${vulnerability.module} ${vulnerability.version}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [vulnerability])
    else group.push(vulnerability)
  }
  return new Map([...groups].toSorted(([a], [b]) => compare(a, b)))
}

function moduleFinding(
  group: readonly GoVulnerability[],
  goMod: string,
): PendingFinding & { readonly anchor: string } {
  const first = group[0]
  if (first === undefined) throw new Error('a module group cannot be empty')
  const pkg: FindingPackage = {
    name: first.module,
    version: first.version,
    ecosystem: GO_ECOSYSTEM,
  }
  const advisories = group
    .map((vulnerability) => advisoryOf(vulnerability))
    .toSorted((a, b) => compare(a.id, b.id))
  const summary = summarizePackage(pkg, advisories)
  const demotion = demotionOf(advisories)

  return {
    category: 'security',
    tool: GOVULNCHECK_TOOL,
    rule: OSV_PACKAGE_RULE,
    severity: severityOf(undefined),
    file: goMod,
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    message: summary.message + (demotion === undefined ? '' : `; advisory only: ${demotion}`),
    // Nobody configures a vulnerability into a repo: this is our tool, run on
    // its own defaults, and the pinned module is a fact either way.
    provenance: 'default-config',
    gradeScope: summary.gradeScope && demotion === undefined,
    package: pkg,
    packageAdvisories: advisories,
    anchor: summary.anchor,
    fixHint: summary.fixHint,
  }
}

function advisoryOf(vulnerability: GoVulnerability): PackageAdvisory {
  return {
    id: vulnerability.osv,
    aliases: vulnerability.aliases,
    severity: severityOf(undefined),
    summary: vulnerability.summary,
    ...(vulnerability.fixedIn === undefined ? {} : { fixedIn: vulnerability.fixedIn }),
    reachability: vulnerability.reachability,
  }
}

/**
 * Why a package's whole advisory set is out of the graded count, or `undefined`
 * when any one of them still counts.
 *
 * The deepest verdict present is the one named: a package with one
 * `imported-no-call` advisory and fifteen `not-imported` ones is imported, and
 * saying it is not would be the stronger claim than the evidence supports.
 * Reachability alone decides this — a package with no published fix is demoted
 * by `summarizePackage` for a different reason, and quoting a verdict there
 * would blame the wrong thing.
 */
export function demotionOf(advisories: readonly PackageAdvisory[]): string | undefined {
  if (advisories.some((advisory) => isGraded(advisory.reachability))) return undefined
  const strongest = GRANULARITY.find((verdict) =>
    advisories.some((advisory) => advisory.reachability === verdict),
  )
  return strongest === undefined ? undefined : VERDICT_TEXT[strongest]
}

/**
 * Folds govulncheck's verdicts into the dependency findings a lockfile audit
 * already produced, over the whole scan's findings at once.
 *
 * Runners never see each other (`core/types.ts`), and reachability is *about*
 * another tool's finding: osv-scanner names the advisory, its severity and its
 * fix, govulncheck says whether the repo can reach it. So the join happens once
 * downstream, in `run.ts`, where both tools' results are in hand.
 *
 * **The join key is the advisory, not the row.** A Go module's finding is
 * matched by `name@version` — with Go's `v` prefix normalized away, because
 * osv-scanner strips it and govulncheck keeps it — and inside it each advisory
 * is matched by *alias intersection*: govulncheck reports `GO-2026-4945`,
 * osv-scanner files the same advisory under `GHSA-78h2-9frx-2jm8` and lists the
 * `GO-` id among its aliases. An advisory only govulncheck knows is appended
 * rather than dropped, and the package's sentence is re-derived from the
 * combined set so its count and its fix cannot go stale.
 *
 * Severity is the host finding's throughout: govulncheck publishes no CVSS, so
 * an appended advisory is `info` and cannot make a package look worse than the
 * scored advisories against it already do.
 *
 * A govulncheck finding nothing matched stays as its own row — that is the
 * `complementary` contract (a union, never a suppression), and it is what a
 * repo whose lockfile audit could not run still gets.
 *
 * @returns the findings in the order given, minus the govulncheck rows folded in
 */
export function mergeReachability(findings: readonly Finding[]): Finding[] {
  const hosts = new Map<string, Finding>()
  for (const finding of findings) {
    const key = finding.tool === GOVULNCHECK_TOOL ? undefined : packageKey(finding)
    if (key !== undefined && !hosts.has(key)) hosts.set(key, finding)
  }

  const folded = new Set<Finding>()
  const contributions = new Map<Finding, PackageAdvisory[]>()
  for (const finding of findings) {
    if (finding.tool !== GOVULNCHECK_TOOL) continue
    const key = packageKey(finding)
    const host = key === undefined ? undefined : hosts.get(key)
    if (host === undefined) continue
    folded.add(finding)
    contributions.set(host, [
      ...(contributions.get(host) ?? []),
      ...(finding.packageAdvisories ?? []),
    ])
  }

  return findings.flatMap((finding) => {
    if (folded.has(finding)) return []
    const contributed = contributions.get(finding)
    return [contributed === undefined ? finding : annotated(finding, contributed)]
  })
}

/**
 * A Go dependency finding's identity as both tools can state it, or `undefined`
 * for every finding that is not one. The `v` prefix is Go's own and osv-scanner
 * drops it, so `v1.0.0` and `1.0.0` are the same pin.
 */
function packageKey(finding: Finding): string | undefined {
  const pkg = finding.package
  if (finding.rule !== OSV_PACKAGE_RULE || pkg === undefined) return undefined
  if (pkg.ecosystem !== GO_ECOSYSTEM) return undefined
  return `${pkg.name}@${pkg.version.replace(/^v/, '')}`
}

/** One host finding with the verdicts merged in and its sentence re-derived. */
function annotated(host: Finding, contributed: readonly PackageAdvisory[]): Finding {
  const known = host.packageAdvisories ?? []
  const merged = known.map((advisory) => {
    const verdict = contributed.find((entry) => sameAdvisory(advisory, entry))?.reachability
    return verdict === undefined ? advisory : { ...advisory, reachability: verdict }
  })
  const extra = contributed.filter(
    (entry) => !known.some((advisory) => sameAdvisory(advisory, entry)),
  )
  const advisories = [...merged, ...extra].toSorted((a, b) => compare(a.id, b.id))

  const pkg = host.package
  if (pkg === undefined) return host
  const summary = summarizePackage(pkg, advisories)
  const demotion = demotionOf(advisories)
  return {
    ...host,
    message: summary.message + (demotion === undefined ? '' : `; advisory only: ${demotion}`),
    gradeScope: summary.gradeScope && demotion === undefined,
    packageAdvisories: advisories,
    fixHint: summary.fixHint,
  }
}

/** Two advisories are one when any id either publishes is shared. */
function sameAdvisory(one: PackageAdvisory, other: PackageAdvisory): boolean {
  const ids = new Set([one.id, ...one.aliases])
  return [other.id, ...other.aliases].some((id) => ids.has(id))
}
