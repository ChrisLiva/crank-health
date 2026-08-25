import { basename, join } from 'node:path'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  FindingPackage,
  PackageAdvisory,
  PendingFinding,
  DetectContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { verifiedVersion } from '../../manifest.ts'
import {
  asArray,
  asRecord,
  asString,
  byLocation,
  firstLine,
  identify,
  readJson,
  repoRelative,
} from '../support.ts'
import type { SystemToolSpec } from './system-tool.ts'
import { explainMissing, systemToolVersion } from './system-tool.ts'

/**
 * osv-scanner — the dependency vulnerability scanner (spec "Categories and
 * tools": "Dependencies | osv-scanner (offline-capable) | same").
 *
 * **Never `fix`.** osv-scanner v2 ships an `osv-scanner fix` subcommand that
 * rewrites lockfiles in place; it is on spec §7's block-list and unreachable
 * from here — {@link invocationArgs} builds one subcommand and it is `scan`.
 *
 * **When the database cannot be reached.** Vulnerability data is not in the
 * binary: osv-scanner resolves advisories over the network. That makes it the
 * one tool whose *findings* depend on something outside the repo, so a scan on
 * a disconnected machine degrades to `not-assessed` with the reason rather than
 * reporting a clean dependency tree it never checked (spec §8) — the failure
 * mode that would matter most to get wrong.
 */

export const OSV_SCANNER_TOOL = 'osv-scanner'

export const OSV_SCANNER: SystemToolSpec = {
  binary: 'osv-scanner',
  versionArgs: ['--version'],
  install: 'brew install osv-scanner, or see https://google.github.io/osv-scanner/installation/',
}

/** Config artifact that makes osv-scanner repo-owned (spec §1, first check). */
export const OSV_CONFIG_FILES: readonly string[] = ['osv-scanner.toml']

/** Where osv-scanner writes its report, under the scratch dir. */
const REPORT_FILE = 'osv-scanner.json'

/**
 * CVSS base scores → our severities (spec §2), on the standard NVD bands.
 * `critical` is not used: spec §3 makes any critical finding an F outright, and
 * that is reserved for a leaked secret — a 9.8 in a transitive dependency is
 * serious, and it is not the same thing as a credential in the working tree.
 */
const CVSS_BANDS: readonly { readonly min: number; readonly severity: Severity }[] = [
  { min: 7, severity: 'error' },
  { min: 4, severity: 'warning' },
  { min: 0, severity: 'info' },
]

/**
 * Stderr and stdout markers that mean "the advisory database was unreachable",
 * as opposed to "this project has no vulnerable dependencies".
 */
const OFFLINE_MARKERS: readonly RegExp[] = [
  /no such host/i,
  /dial tcp/i,
  /connection refused/i,
  /network is unreachable/i,
  /i\/o timeout/i,
  /context deadline exceeded/i,
  /failed to (?:get|fetch|query)[^\n]*(?:osv|deps\.dev|vulnerabilit)/i,
  /TLS handshake timeout/i,
]

export const osvScannerRunner: ToolRunner = {
  tool: OSV_SCANNER_TOOL,
  category: 'security',
  // Not a pin crank-health can enforce; see `SYSTEM_TOOL_MANIFEST`.
  pinnedVersion: verifiedVersion('osv-scanner'),
  // Dependency vulnerabilities are nobody else's job; see
  // `ToolRunner.complementary`.
  complementary: true,
  // osv-scanner walks the tree for lockfiles itself, and a workspace's lockfile
  // covers every package under it: one scan, findings attributed by path.
  repoScoped: true,
  detect: detectOsvScanner,
  run: runOsvScanner,
}

/**
 * Repo-owned when `osv-scanner.toml` is present, the file carrying the repo's
 * own advisory ignores.
 *
 * osv-scanner discovers a config beside each lockfile on its own, and a root
 * `osv-scanner.toml` reaches a nested lockfile only through `--config`. Probed
 * on 2.5.1 against a nested lockfile: auto-discovery left 1 result standing,
 * `--config` left 0. So the detection decides a command line as well as a
 * provenance tag, and {@link runOsvScanner} passes `ownedVia` on.
 */
function detectOsvScanner(ctx: DetectContext): Promise<Detection | null> {
  const configFiles = OSV_CONFIG_FILES.filter((file) => ctx.files.all.includes(file))
  const ownedVia = configFiles[0]
  return Promise.resolve(
    ownedVia === undefined ? null : { reason: 'config', configFiles, ownedVia, installed: true },
  )
}

async function runOsvScanner(ctx: RunContext): Promise<ToolResult> {
  const report = join(ctx.scratch, REPORT_FILE)
  const ownedVia = ctx.detection?.ownedVia
  const config = ownedVia === undefined ? undefined : join(ctx.repoRoot, ownedVia)
  const execution = await execTool(
    systemCommand(OSV_SCANNER.binary, invocationArgs(ctx.repoRoot, report, config)),
    { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles: string[] = []
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'osv-scanner.stderr.txt', execution.stderr))
  }
  if (execution.failure !== undefined) {
    const failure = explainMissing(OSV_SCANNER, execution.failure)
    return { state: failure.state, findings: [], rawFiles, reason: failure.reason }
  }

  const document = await readJson(report)
  if (document === undefined) {
    return {
      state: offlineState(execution.stderr),
      findings: [],
      rawFiles,
      reason: isDatabaseUnreachable(execution.stderr)
        ? 'the OSV advisory database could not be reached — dependencies were not checked; ' +
          're-run with network access, or pre-populate osv-scanner’s offline database'
        : `osv-scanner wrote no report (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
    }
  }
  rawFiles.unshift(
    await writeScratchRaw(ctx.scratch, REPORT_FILE, `${JSON.stringify(document, null, 2)}\n`),
  )

  let vulnerabilities: OsvVulnerability[]
  try {
    vulnerabilities = parseOsvReport(document, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse osv-scanner output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  const version = await systemToolVersion(OSV_SCANNER, ctx.scratch, ctx.timeoutMs)
  // Only on the `ok` path: a missing osv-scanner already carries its own
  // `not-available` reason, and overwriting that would hide the real gap.
  const reason = centralPackageManagementReason(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(vulnerabilities, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(version === undefined ? {} : { toolVersion: version }),
    ...(reason === undefined ? {} : { reason }),
    rawFiles,
  }
}

/** NuGet's Central Package Management manifest, matched case-sensitively. */
const CPM_MANIFEST = 'Directory.Packages.props'

/**
 * Why a Central Package Management repo's `ok` record still names a gap: with a
 * `Directory.Packages.props` holding the versions, the `.csproj` files carry
 * versionless `PackageReference`s that osv-scanner cannot resolve, so NuGet
 * dependencies silently go unscanned. The sentence keeps that from reading as
 * "no vulnerable dependencies" (spec §8's honest-degradation shape, criterion
 * 8). Case-sensitive on the basename because MSBuild's own import is, on
 * case-sensitive filesystems.
 *
 * @param files repo-relative paths, the run's own inventory
 * @returns the reason to attach, or `undefined` when the repo does not use
 * Central Package Management
 */
export function centralPackageManagementReason(files: readonly string[]): string | undefined {
  return files.some((file) => basename(file) === CPM_MANIFEST)
    ? 'Directory.Packages.props manages versions centrally; osv-scanner cannot read ' +
        'Central Package Management, so NuGet dependencies were not scanned'
    : undefined
}

/**
 * The command line, exported so a test can assert that no mutating subcommand
 * is reachable. `scan source -r` walks the project for manifests and lockfiles
 * and honors `.gitignore`, which is what keeps a vendored dependency's own
 * lockfile out of the result (spec §7).
 *
 * @param config the repo's detected root `osv-scanner.toml`, absolute. Omitted
 * when the repo owns none, and then the command line is unchanged.
 */
export function invocationArgs(repoRoot: string, report: string, config?: string): string[] {
  return [
    'scan',
    'source',
    '--recursive',
    // Most repos crank-health scans have no lockfile at all, and osv-scanner
    // treats that as a usage error (exit 128) unless told otherwise. "Nothing
    // to check" is not a failure.
    '--allow-no-lockfiles',
    '--format',
    'json',
    '--output-file',
    report,
    '--verbosity',
    'error',
    ...(config === undefined ? [] : ['--config', config]),
    repoRoot,
  ]
}

/**
 * Whether osv-scanner's stderr says the advisory database was unreachable.
 * Exported because it is the whole of spec §8's "offline-capable → graceful
 * not-assessed" promise for this tool, and the only way to test it without a
 * network partition.
 */
export function isDatabaseUnreachable(stderr: string): boolean {
  return OFFLINE_MARKERS.some((marker) => marker.test(stderr))
}

/** Unreachable database → `not-available`; anything else → `error`. */
function offlineState(stderr: string): 'not-available' | 'error' {
  return isDatabaseUnreachable(stderr) ? 'not-available' : 'error'
}

/** One vulnerable dependency, as one advisory group affecting one package. */
export interface OsvVulnerability {
  /** Repo-relative path of the lockfile or manifest it was found in. */
  readonly file: string
  readonly packageName: string
  readonly packageVersion: string
  /** npm, PyPI, … */
  readonly ecosystem: string
  /** The advisory id this group is reported under, e.g. `GHSA-…`. */
  readonly id: string
  /** Every id and alias in the group, sorted. */
  readonly aliases: readonly string[]
  /** CVSS base score, or `undefined` when the advisory carries none. */
  readonly maxSeverity: number | undefined
  readonly summary: string
  /**
   * The version that fixes every advisory in the group, from the OSV records'
   * `affected[].ranges[].events[].fixed`. `undefined` when any of them closes no
   * range: the group is not fixed until the last of it is.
   */
  readonly fixedIn: string | undefined
}

/**
 * Parses `osv-scanner --format json`. Exported so a format shift fails a test
 * instead of reporting a project with no vulnerable dependencies (plan M6
 * checks).
 *
 * osv-scanner clusters advisories that describe the same problem into `groups`
 * and gives each a `max_severity`; one finding per group is what stops a
 * package with four aliases of one CVE from looking like four vulnerabilities.
 *
 * @throws {Error} when the payload is not osv-scanner's result envelope
 */
export function parseOsvReport(document: unknown, repoRoot = ''): OsvVulnerability[] {
  const envelope = asRecord(document)
  if (envelope === undefined) throw new Error('osv-scanner output is not an object')
  // A project with nothing to scan gets `"results": null`, not `[]`.
  if (envelope['results'] === null) return []
  const results = asArray(envelope['results'])
  if (results === undefined) throw new Error('osv-scanner output has no results array')

  return results.flatMap((resultEntry) => {
    const result = asRecord(resultEntry)
    const source = asString(asRecord(result?.['source'])?.['path']) ?? ''
    const file = repoRelative(source, repoRoot)
    const packages = asArray(result?.['packages']) ?? []

    return packages.flatMap((packageEntry) => {
      const entry = asRecord(packageEntry)
      const identity = asRecord(entry?.['package'])
      const packageName = asString(identity?.['name'])
      if (packageName === undefined) return []

      const ecosystem = asString(identity?.['ecosystem']) ?? ''
      const records = asArray(entry?.['vulnerabilities']) ?? []
      const summaries = summariesById(records)
      const fixes = fixesById(records, packageName, ecosystem)
      const groups = asArray(entry?.['groups']) ?? []
      return groups.flatMap((groupEntry) => {
        const group = asRecord(groupEntry)
        const ids = (asArray(group?.['ids']) ?? []).flatMap((id) => {
          const value = asString(id)
          return value === undefined ? [] : [value]
        })
        const id = ids.toSorted(compare)[0]
        if (id === undefined) return []

        const aliases = (asArray(group?.['aliases']) ?? []).flatMap((alias) => {
          const value = asString(alias)
          return value === undefined ? [] : [value]
        })
        const score = Number.parseFloat(asString(group?.['max_severity']) ?? '')
        return [
          {
            file,
            packageName,
            packageVersion: asString(identity?.['version']) ?? '',
            ecosystem,
            id,
            aliases: aliases.toSorted(compare),
            maxSeverity: Number.isFinite(score) ? score : undefined,
            summary: summaries.get(id) ?? '',
            fixedIn: groupFix(ids, fixes),
          } satisfies OsvVulnerability,
        ]
      })
    })
  })
}

/**
 * The version that clears a whole group: the highest fix among its ids, or
 * `undefined` as soon as one of them has none. osv-scanner clusters advisories
 * that describe the same problem, and a "fix" that leaves one of them standing
 * is not one.
 */
function groupFix(ids: readonly string[], fixes: ReadonlyMap<string, string>): string | undefined {
  let highest: string | undefined
  for (const id of ids) {
    const fixed = fixes.get(id)
    if (fixed === undefined) return undefined
    if (highest === undefined || compareVersions(fixed, highest) > 0) highest = fixed
  }
  return highest
}

/**
 * Advisory id → the version it was fixed in, walked out of the full OSV records.
 *
 * Only the `affected[]` entries about *this* package count: one lodash advisory
 * also lists `lodash-es`, `lodash.trim` and a RubyGems port, and reading their
 * ranges would report a fix that does not exist for the package in the lockfile.
 * The highest `fixed` event across the package's own ranges is the answer — a
 * version affected by two ranges is only clear of both above the later one.
 */
function fixesById(
  vulnerabilities: readonly unknown[],
  packageName: string,
  ecosystem: string,
): Map<string, string> {
  const fixes = new Map<string, string>()
  for (const entry of vulnerabilities) {
    const record = asRecord(entry)
    const id = asString(record?.['id'])
    if (id === undefined) continue
    for (const affectedEntry of asArray(record?.['affected']) ?? []) {
      const affected = asRecord(affectedEntry)
      const target = asRecord(affected?.['package'])
      if (asString(target?.['name']) !== packageName) continue
      if (asString(target?.['ecosystem']) !== ecosystem) continue
      for (const rangeEntry of asArray(affected?.['ranges']) ?? []) {
        for (const eventEntry of asArray(asRecord(rangeEntry)?.['events']) ?? []) {
          const fixed = asString(asRecord(eventEntry)?.['fixed'])
          const known = fixes.get(id)
          if (fixed !== undefined && (known === undefined || compareVersions(fixed, known) > 0)) {
            fixes.set(id, fixed)
          }
        }
      }
    }
  }
  return fixes
}

/**
 * Orders two release versions without an ecosystem's own resolver: digit runs
 * compare as numbers and everything else byte-wise, left to right, so `4.18.0`
 * beats `4.9.0` and `4.17.21`.
 *
 * That is exactly right for the plain releases advisories name a fix in, across
 * semver and PEP 440 alike. It gets pre-release ordering wrong — `1.2.3-rc`
 * sorts above `1.2.3` — and the cost of that is picking the later of two fixed
 * versions to recommend, which is a version the upgrade clears either way.
 */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const one = left[index]
    const other = right[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (typeof one === 'number' && typeof other === 'number') {
      if (one !== other) return one - other
    } else if (String(one) !== String(other)) {
      return String(one) < String(other) ? -1 : 1
    }
  }
  return 0
}

function versionParts(version: string): (number | string)[] {
  return (version.match(/\d+|\D+/g) ?? []).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
}

/** Advisory id → its one-line summary, from the full OSV records. */
function summariesById(vulnerabilities: readonly unknown[]): Map<string, string> {
  const summaries = new Map<string, string>()
  for (const entry of vulnerabilities) {
    const record = asRecord(entry)
    const id = asString(record?.['id'])
    const summary = asString(record?.['summary'])
    if (id !== undefined && summary !== undefined) summaries.set(id, summary)
  }
  return summaries
}

/** The one rule a dependency finding carries: the package, not the advisory. */
export const OSV_PACKAGE_RULE = 'osv/package'

/**
 * Vulnerable dependencies → the core's vocabulary, **one finding per vulnerable
 * package**, with every advisory against it nested under
 * {@link Finding.packageAdvisories}.
 *
 * One upgrade answers all of a package's advisories, so one row is the unit of
 * work; four rows saying "lodash@4.17.15 is affected by …" were four readings
 * of one problem. It also makes identity survive the advisory database: keyed on
 * the advisory id, a CVE published against a pin nobody touched read as a new
 * finding on the next PR scan. The rule is the same for every such finding and
 * the anchor is `package@version`, so the identity is the dependency (spec §2)
 * — and the file is the lockfile, never a line in it, because lockfiles are
 * generated and their line numbers move for unrelated reasons.
 *
 * Scope is the one thing an advisory decides: a package no published version
 * fixes is not work anyone can do, so it lands in `advisories[]` with the
 * receipt in its message — and out of every grading tier but the one that
 * reserves A for a clean scan (`core/grade.ts`). A D nobody can clear is a mark
 * rather than a grade. Provenance never changes scope here: a known
 * vulnerability in a declared dependency is not a matter of configuration
 * taste.
 */
export function toPendingFindings(
  vulnerabilities: readonly OsvVulnerability[],
  repoConfig: boolean,
): PendingFinding[] {
  return [...groupByPackage(vulnerabilities).values()]
    .map((group) => packageFinding(group, repoConfig))
    .toSorted(byLocation)
}

/**
 * The separator inside a group key, written as an escape rather than as the
 * byte itself: a raw NUL in a source file makes it binary to `grep`, `file` and
 * every editor that reads it. NUL because no field it joins can contain one — a
 * path, an ecosystem, a package name and a version are all text.
 */
const KEY_SEPARATOR = '\u0000'

/** One vulnerable package's advisory groups, keyed so two packages never merge. */
function groupByPackage(
  vulnerabilities: readonly OsvVulnerability[],
): Map<string, OsvVulnerability[]> {
  const groups = new Map<string, OsvVulnerability[]>()
  for (const vulnerability of vulnerabilities) {
    const key = [
      vulnerability.file,
      vulnerability.ecosystem,
      vulnerability.packageName,
      vulnerability.packageVersion,
    ].join(KEY_SEPARATOR)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [vulnerability])
    else group.push(vulnerability)
  }
  // Sorted by key, so the emission order cannot inherit osv-scanner's.
  return new Map([...groups].toSorted(([a], [b]) => compare(a, b)))
}

function packageFinding(
  group: readonly OsvVulnerability[],
  repoConfig: boolean,
): PendingFinding & { readonly anchor: string } {
  const first = group[0]
  if (first === undefined) throw new Error('a package group cannot be empty')
  const pinned = {
    name: first.packageName,
    version: first.packageVersion,
    ecosystem: first.ecosystem,
  }
  const advisories = group
    .map((vulnerability) => advisoryOf(vulnerability))
    .toSorted((a, b) => compare(a.id, b.id))
  const summary = summarizePackage(pinned, advisories)

  return {
    category: 'security',
    tool: OSV_SCANNER_TOOL,
    rule: OSV_PACKAGE_RULE,
    severity: severityOf(highestScore(group)),
    file: first.file,
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
    message: summary.message,
    provenance: repoConfig ? 'repo-config' : 'default-config',
    gradeScope: summary.gradeScope,
    package: pinned,
    packageAdvisories: advisories,
    anchor: summary.anchor,
    fixHint: summary.fixHint,
  }
}

/** What a package's advisories add up to, as a finding says it. */
export interface PackageSummary {
  /** `name@version` — the finding's anchor, and the head of its message. */
  readonly anchor: string
  readonly message: string
  readonly fixHint: string
  /** False only when no advisory against the package has a fix; see below. */
  readonly gradeScope: boolean
}

/**
 * The one-line reading of a vulnerable package, derived from its advisories
 * alone.
 *
 * Exported because a second tool now reports package-level findings —
 * `govulncheck.ts` — and because merging its advisories into an osv-scanner
 * finding changes the count and can change the fix, so the sentence has to be
 * re-derived rather than patched. One function means the two tools' rows read
 * identically and cannot drift apart.
 */
export function summarizePackage(
  pkg: FindingPackage,
  advisories: readonly PackageAdvisory[],
): PackageSummary {
  const anchor = `${pkg.name}@${pkg.version}`
  const fixable = advisories.filter((advisory) => advisory.fixedIn !== undefined)
  const fixedIn = highestFix(fixable)
  const partial = fixable.length > 0 && fixable.length < advisories.length
  return {
    anchor,
    message:
      `${anchor} (${pkg.ecosystem}): ` +
      `${advisories.length} ${advisories.length === 1 ? 'advisory' : 'advisories'}; ` +
      `${fixedIn === undefined ? 'no fixed version available' : `fix: upgrade to ≥${fixedIn}`}` +
      (partial
        ? ` (clears ${fixable.length} of ${advisories.length}; the rest have no published fix)`
        : ''),
    fixHint:
      fixedIn === undefined
        ? `No fixed version is published for ${pkg.name} — replace it, or vendor a patched fork; see ${advisoryUrl(advisories)}`
        : `Upgrade ${pkg.name} to ≥${fixedIn}` +
          (partial ? `, which clears ${fixable.length} of ${advisories.length} advisories` : '') +
          `; see ${advisoryUrl(advisories)}`,
    gradeScope: fixedIn !== undefined,
  }
}

function advisoryOf(vulnerability: OsvVulnerability): PackageAdvisory {
  return {
    id: vulnerability.id,
    aliases: vulnerability.aliases,
    severity: severityOf(vulnerability.maxSeverity),
    summary: vulnerability.summary,
    ...(vulnerability.fixedIn === undefined ? {} : { fixedIn: vulnerability.fixedIn }),
  }
}

/**
 * The highest published fix among the advisories that have one, or `undefined`
 * when none does — the version to upgrade to, and how far it gets.
 *
 * It is *not* "the version that clears the package": one unfixable advisory
 * used to make the whole package unfixable, which demoted a critical CVE with a
 * released fix out of the security grade on the strength of an unrelated low one
 * beside it, under a message reading `no fixed version available` that was
 * false. Demotion is per advisory (see {@link summarizePackage}), and the
 * partial case says so in the sentence rather than by omission.
 */
function highestFix(advisories: readonly PackageAdvisory[]): string | undefined {
  let highest: string | undefined
  for (const advisory of advisories) {
    if (advisory.fixedIn === undefined) continue
    if (highest === undefined || compareVersions(advisory.fixedIn, highest) > 0) {
      highest = advisory.fixedIn
    }
  }
  return highest
}

/** The worst CVSS score among a package's advisories; `undefined` if none has one. */
function highestScore(group: readonly OsvVulnerability[]): number | undefined {
  const scores = group.flatMap((vulnerability) =>
    vulnerability.maxSeverity === undefined ? [] : [vulnerability.maxSeverity],
  )
  return scores.length === 0 ? undefined : Math.max(...scores)
}

/** The first advisory's page — the entry point to the rest, which are listed. */
function advisoryUrl(advisories: readonly PackageAdvisory[]): string {
  return `https://osv.dev/vulnerability/${advisories[0]?.id ?? ''}`
}

/** CVSS base score → severity. An advisory with no score is `info`. */
export function severityOf(score: number | undefined): Severity {
  if (score === undefined) return 'info'
  return CVSS_BANDS.find((band) => score >= band.min)?.severity ?? 'info'
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
