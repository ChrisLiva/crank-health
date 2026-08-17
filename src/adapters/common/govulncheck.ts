import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { ToolExecution, ToolFailure } from '../../core/exec.ts'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  DetectContext,
  Detection,
  Finding,
  FindingPackage,
  PackageAdvisory,
  PendingFinding,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedGoSpec, pinnedGoVersion } from '../../manifest.ts'
import {
  asArray,
  asRecord,
  asString,
  byLocation,
  compare,
  firstLine,
  identify,
} from '../support.ts'
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

/** The Go module manifest that makes a directory a module worth analyzing. */
export const GO_MOD = 'go.mod'

/** The fetcher: `go run <path>@<version>` builds and runs the pinned analyzer. */
const GO_BINARY = 'go'

/** The pinned analyzer's import path; see `GO_TOOL_MANIFEST`. */
const GOVULNCHECK_PACKAGE = 'golang.org/x/vuln/cmd/govulncheck'

/**
 * Spec §8's honest degradation for a missing Go toolchain, in the words the
 * grade depends on: with no `go`, no advisory gets a reachability verdict, and
 * `isGraded` therefore counts every Go advisory. A repo is never graded better
 * for a tool that could not run.
 */
export const GO_ABSENT_REASON =
  'Go toolchain absent — Go advisories graded conservatively (reachability unknown)'

/** Nothing to analyze is not a failure, and it is not a clean bill of health. */
export const NO_GO_MODULES_REASON =
  'no go.mod in this repo, so govulncheck assessed no Go dependencies'

/**
 * govulncheck's own wall-clock budget, overriding the 120 s every other quick
 * runner gets ({@link import('../../core/orchestrator.ts').DEFAULT_TIMEOUT_MS}).
 *
 * It loads the whole package graph and, on a cold module cache, downloads the
 * analyzer and every dependency of the module it is analyzing first. Two
 * minutes is a timeout for that on any real service; five is enough that a real
 * module finishes and small enough that a wedged one still ends. `--timeout`
 * still wins — a user who names a budget means it.
 */
export const GOVULNCHECK_TIMEOUT_MS = 300_000

export const govulncheckRunner: ToolRunner = {
  tool: GOVULNCHECK_TOOL,
  category: 'security',
  pinnedVersion: pinnedGoVersion(GOVULNCHECK_PACKAGE),
  // Reachability is nobody else's job, and osv-scanner must never stand this
  // down or be stood down by it; see `ToolRunner.complementary`.
  complementary: true,
  // Go modules are found by walking the repo, and a repo's modules do not line
  // up with its `package.json`/`pyproject.toml` projects at all — so this is
  // asked once, and it visits every go.mod it finds.
  repoScoped: true,
  timeoutMs: GOVULNCHECK_TIMEOUT_MS,
  detect: detectGovulncheck,
  run: runGovulncheck,
}

/**
 * A `go.mod` anywhere in the inventory is what gives govulncheck something to
 * analyze, and {@link Detection.ownedVia} names the nearest one.
 *
 * This is *not* a claim that the repo owns govulncheck — nobody configures a
 * reachability analyzer into a Go module, and `installed: false` plus the
 * `configOwned: false` every result carries keep the tool record's provenance at
 * `default-config`. What it records is the artifact that decided this runner
 * applies here, which is the same thing every other detector's `ownedVia` says.
 */
function detectGovulncheck(ctx: DetectContext): Promise<Detection | null> {
  const ownedVia = goModules(ctx.files.all)[0]
  return Promise.resolve(
    ownedVia === undefined
      ? null
      : { reason: 'dependency', configFiles: [], ownedVia, installed: false },
  )
}

/**
 * The command line, exported so a test can assert that no `go` subcommand which
 * could touch the repo is reachable from here.
 *
 * `run` is the only one built: `go get`, `go mod tidy` and `go mod vendor` all
 * rewrite files in the module, and none of them is on this command line. The
 * pin is exact — a bare import path would mean `@latest` and break determinism
 * (spec §6). `./...` is every package in the module at `cwd`.
 */
export function invocationArgs(): string[] {
  return ['run', pinnedGoSpec(GOVULNCHECK_PACKAGE), '-json', './...']
}

/**
 * The environment every `go` spawn carries — the zero-footprint contract (spec
 * §7) for a toolchain that is perfectly willing to write into the module it is
 * pointed at.
 *
 * `GOFLAGS=-mod=readonly` is Go's own default, set explicitly so an ambient
 * `GOFLAGS=-mod=mod` cannot turn a scan into a `go.mod`/`go.sum` rewrite. It is
 * safe for a vendored module too: verified against a `go mod vendor`ed tree,
 * where it produces byte-identical findings.
 *
 * `GOMODCACHE` is pinned to the machine's warm cache — `$HOME/go/pkg/mod`,
 * Go's own default — for the same reason `dotnet-project.ts` pins
 * `NUGET_PACKAGES`: it is the one setting that could otherwise be pointed
 * inside the repo being scanned. The build cache (`GOCACHE`) is derived from
 * the OS cache directory and is never inside a repo.
 */
export function goEnv(): Record<string, string> {
  return {
    GOFLAGS: '-mod=readonly',
    GOMODCACHE: join(homedir(), 'go', 'pkg', 'mod'),
  }
}

/**
 * One `go run govulncheck` per module in the repo, merged.
 *
 * **The quick profile still applies.** govulncheck reads source and the module
 * graph — it builds nothing of the repo's and runs none of its tests — so it is
 * a quick-tier runner (spec §5), unlike the mutation tools.
 *
 * A module that fails takes only itself down: the rest are still analyzed, and
 * the reasons travel with the result. When *every* module failed the same way
 * — which is what a machine with no `go` looks like — that one reason is the
 * whole result.
 */
async function runGovulncheck(ctx: RunContext): Promise<ToolResult> {
  const modules = goModules(ctx.files)
  if (modules.length === 0) {
    return { state: 'not-available', findings: [], rawFiles: [], reason: NO_GO_MODULES_REASON }
  }

  const rawFiles: string[] = []
  const pending: (PendingFinding & { readonly anchor: string })[] = []
  const failures: ToolFailure[] = []

  for (const goMod of modules) {
    // Sequential: each module is a full package-graph load, and the scan's own
    // concurrency pool is what parallelizes work across tools.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(systemCommand(GO_BINARY, invocationArgs()), {
      cwd: join(ctx.repoRoot, dirname(goMod)),
      timeoutMs: ctx.timeoutMs,
      env: goEnv(),
    })
    // eslint-disable-next-line no-await-in-loop
    rawFiles.push(...(await stage(ctx.scratch, goMod, execution)))
    if (execution.failure !== undefined) {
      failures.push(explainGo(execution.failure))
      continue
    }
    const vulnerabilities = parseGovulncheckStream(execution.stdout)
    const collapsed = collapsedRun(execution, vulnerabilities.length, goMod)
    if (collapsed !== undefined) {
      failures.push(collapsed)
      continue
    }
    pending.push(...toPendingFindings(vulnerabilities, goMod))
  }

  const failure = wholesale(failures, modules.length)
  if (failure !== undefined) {
    return { state: failure.state, findings: [], rawFiles, reason: failure.reason }
  }
  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending.toSorted(byLocation)),
    // `go run <import-path>@<version>` is an exact spec with no resolution step
    // that could land elsewhere, so the pin is what ran (spec §6).
    toolVersion: pinnedGoVersion(GOVULNCHECK_PACKAGE),
    rawFiles,
    // Our tool on our defaults, whatever `detect` found; see `detectGovulncheck`.
    configOwned: false,
    ...(failures.length === 0 ? {} : { reason: reasonsOf(failures) }),
  }
}

/**
 * One module's evidence, staged: the stream it produced and anything it said on
 * stderr. Both, because the run that failed is the one whose evidence a reader
 * most needs — and `go` says why on stderr while stdout carries only the
 * `config` and `progress` records it managed before giving up.
 */
async function stage(scratch: string, goMod: string, execution: ToolExecution): Promise<string[]> {
  const staged: string[] = []
  if (execution.stdout.trim().length > 0) {
    staged.push(await writeScratchRaw(scratch, rawName(goMod, 'json'), execution.stdout))
  }
  if (execution.stderr.trim().length > 0) {
    staged.push(await writeScratchRaw(scratch, rawName(goMod, 'stderr.txt'), execution.stderr))
  }
  return staged
}

/**
 * A module that gave up rather than reported nothing, or `undefined` when the
 * run stands.
 *
 * {@link execTool} deliberately does not call a non-zero exit a failure —
 * most analyzers exit non-zero precisely when they find something — so a runner
 * that reads only `execution.failure` would report a module that never built as
 * a clean scan. `go run` exits non-zero for the ordinary cases: the module does
 * not compile, the pinned analyzer cannot be fetched on a cold cache with no
 * network, the `go` directive is newer than the toolchain. It writes its
 * `config` and `progress` records before giving up, so stdout is never empty
 * and "nothing parsed" is not "nothing to find".
 *
 * Both halves of the test matter. A clean module exits 0 with no vulnerability
 * and must stay `ok`; a module that reported vulnerabilities and *then* exited
 * non-zero keeps them. It is only the pair — nothing parsed **and** a non-zero
 * exit — that means the tool never answered. Same shape as `tsc.ts` and
 * `osv-scanner.ts`, so a reader who knows one knows all three.
 */
function collapsedRun(
  execution: ToolExecution,
  reported: number,
  goMod: string,
): ToolFailure | undefined {
  if (reported > 0 || execution.exitCode === 0) return undefined
  return {
    state: 'error',
    reason:
      `govulncheck analyzed nothing in ${dirname(goMod)} ` +
      `(exit ${execution.exitCode ?? 'on a signal'}): ${firstLine(execution.stderr)}`,
  }
}

/**
 * The one failure that stands for the whole run, or `undefined` when at least
 * one module was analyzed. A partial failure is reported beside the findings
 * that did come back; a total one is the result.
 */
function wholesale(failures: readonly ToolFailure[], modules: number): ToolFailure | undefined {
  if (failures.length < modules) return undefined
  const worst =
    failures.find((entry) => entry.state === 'error') ??
    failures.find((entry) => entry.state === 'timeout') ??
    failures[0]
  return worst === undefined ? undefined : { state: worst.state, reason: reasonsOf(failures) }
}

/** Identical reasons collapse: one repo, one sentence, however many modules. */
function reasonsOf(failures: readonly ToolFailure[]): string {
  return [...new Set(failures.map((failure) => failure.reason))].join('; ')
}

/**
 * A missing `go` is the toolchain gap spec §8 wants named, not a generic "not
 * executable"; every other failure is left exactly as `execTool` classified it.
 */
function explainGo(failure: ToolFailure): ToolFailure {
  return failure.state === 'not-available'
    ? { state: 'not-available', reason: GO_ABSENT_REASON }
    : failure
}

/** Every `go.mod` in an inventory, repo-relative and stable-sorted. */
function goModules(files: readonly string[]): string[] {
  return files.filter((file) => basename(file) === GO_MOD).toSorted(compare)
}

/**
 * Where one module's evidence is staged. All of a repo-scoped run's evidence
 * lands in one directory, so a monorepo's second module must not overwrite its
 * first — the module's own directory is what tells them apart.
 */
function rawName(goMod: string, extension: string): string {
  const directory = dirname(goMod)
  return directory === '.'
    ? `govulncheck.${extension}`
    : `govulncheck-${directory.replaceAll('/', '-')}.${extension}`
}
