import { basename, join } from 'node:path'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
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
 * Repo-owned when `osv-scanner.toml` is present — the scanner reads that file
 * itself (it carries the repo's own advisory ignores), so ownership here is a
 * provenance tag rather than a different command line.
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
  const execution = await execTool(
    systemCommand(OSV_SCANNER.binary, invocationArgs(ctx.repoRoot, report)),
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
 */
export function invocationArgs(repoRoot: string, report: string): string[] {
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

      const summaries = summariesById(asArray(entry?.['vulnerabilities']) ?? [])
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
            ecosystem: asString(identity?.['ecosystem']) ?? '',
            id,
            aliases: aliases.toSorted(compare),
            maxSeverity: Number.isFinite(score) ? score : undefined,
            summary: summaries.get(id) ?? '',
          } satisfies OsvVulnerability,
        ]
      })
    })
  })
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

/**
 * Vulnerable dependencies → the core's vocabulary, one finding per advisory
 * group, banded by CVSS score ({@link CVSS_BANDS}) and always graded: a known
 * vulnerability in a declared dependency is not a matter of configuration
 * taste, which is why provenance never changes `gradeScope` here.
 *
 * The file is the lockfile, and the anchor is the pinned package — not a line
 * in it. Lockfiles are generated, their line numbers move whenever anything
 * else in the tree changes, and identity has to survive that (spec §2).
 */
export function toPendingFindings(
  vulnerabilities: readonly OsvVulnerability[],
  repoConfig: boolean,
): PendingFinding[] {
  return vulnerabilities
    .map((vulnerability) => ({
      category: 'security' as const,
      tool: OSV_SCANNER_TOOL,
      rule: vulnerability.id,
      severity: severityOf(vulnerability.maxSeverity),
      file: vulnerability.file,
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      message:
        `${vulnerability.packageName}@${vulnerability.packageVersion} ` +
        `(${vulnerability.ecosystem}) is affected by ${vulnerability.id}` +
        `${vulnerability.summary === '' ? '' : `: ${vulnerability.summary}`}` +
        `${vulnerability.maxSeverity === undefined ? '' : ` [CVSS ${vulnerability.maxSeverity}]`}`,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: true,
      anchor: `${vulnerability.ecosystem}/${vulnerability.packageName}@${vulnerability.packageVersion}`,
      fixHint: `Upgrade ${vulnerability.packageName} past the affected range — see https://osv.dev/vulnerability/${vulnerability.id}`,
    }))
    .toSorted(byLocation)
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
