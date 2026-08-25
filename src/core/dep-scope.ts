import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Finding, PackageAdvisory } from './types.ts'

/**
 * Dependency scope — which half of a `package.json` pulls a vulnerable package
 * in (spec §2, "Dependencies").
 *
 * **Why it moves a grade.** A known vulnerability in a build tool that never
 * ships is not the same exposure as one in the code a user runs, and grading
 * them identically is what makes a dependency audit read as noise: a repo with
 * a clean runtime closure and an old test runner gets the same F as one
 * shipping the vulnerable parser. So a package the lockfile says *only* a
 * `devDependency` reaches is demoted to the advisory bucket with `scope: 'dev'`
 * on every advisory against it — still in `report.json`, out of the graded
 * count.
 *
 * **The conservative direction is graded.** Every uncertainty resolves to
 * `unknown`, and `unknown` grades exactly as it did before scope existed: a
 * lockfile format this does not read (yarn.lock), one that would not parse, one
 * that is not there, a package the lockfile never mentions, a reference whose
 * snapshot entry is missing. A parse error must never be able to quiet a
 * security finding — that is the failure mode this module is written around,
 * and it is why nothing here infers `dev` from an absence.
 *
 * **What decides `prod`.** Reachability from a runtime root, not a flag on the
 * package: pnpm's lockfile records scope only at the importers, so the runtime
 * closure has to be walked (`dependencies` + `optionalDependencies`, breadth
 * first, cycles visited once). npm's records it inline on every entry, so
 * reading the flags is the whole job.
 */

/** The two lockfiles whose scope information this reads. */
export const PNPM_LOCK = 'pnpm-lock.yaml'
export const NPM_LOCK = 'package-lock.json'

/** The advisory database's name for the ecosystem these lockfiles describe. */
const NPM_ECOSYSTEM = 'npm'

/**
 * What a lockfile says about one package: it ships (`prod`), only the
 * toolchain pulls it in (`dev`), or nothing readable said (`unknown`).
 */
export type DependencyScope = 'prod' | 'dev' | 'unknown'

/** One lockfile, read. */
export interface LockfileScopes {
  /**
   * `name@version` → scope, for every package the lockfile records. Sorted by
   * key, so nothing downstream can inherit a YAML document's own key order.
   */
  readonly packages: ReadonlyMap<string, DependencyScope>
  /**
   * What the read could not answer, at most one sentence per cause. Empty when
   * the lockfile was read whole, and empty for a format this does not read at
   * all — an unreadable lockfile is worth saying, and yarn.lock is not a fault.
   */
  readonly notes: readonly string[]
}

const EMPTY: LockfileScopes = { packages: new Map(), notes: [] }

/**
 * A lockfile's text → the scope of every package in it.
 *
 * @param file the lockfile's path — only its basename selects the reader, and
 * it heads any note, so a monorepo's two lockfiles are told apart
 * @param text the lockfile as read from disk
 */
export function classifyLockfile(file: string, text: string): LockfileScopes {
  const reader = READERS[basename(file)]
  if (reader === undefined) return EMPTY
  let read: LockfileScopes
  try {
    read = reader(text)
  } catch (error) {
    read = {
      packages: new Map(),
      notes: [
        `could not be read (${describe(error)}), so no dependency scope was resolved and ` +
          'every package in it is graded',
      ],
    }
  }
  // Every note names its own lockfile here rather than in each reader, so a
  // monorepo's second `package-lock.json` cannot be mistaken for its first.
  return { packages: read.packages, notes: read.notes.map((note) => `${file}: ${note}`) }
}

/** What a classification says about one pinned package. */
export function scopeIn(scopes: LockfileScopes, name: string, version: string): DependencyScope {
  return scopes.packages.get(`${name}@${version}`) ?? 'unknown'
}

const READERS: Readonly<Record<string, (text: string) => LockfileScopes>> = {
  [PNPM_LOCK]: readPnpmLock,
  [NPM_LOCK]: readNpmLock,
}

/** The importer fields whose packages are shipped, as against built with. */
const PROD_FIELDS: readonly string[] = ['dependencies', 'optionalDependencies']

/**
 * `pnpm-lock.yaml` (lockfileVersion 9) → scopes, by walking the runtime closure.
 *
 * pnpm records prod/dev/optional **only on the importers** — the workspace
 * packages — and stores every resolved package once, flat, under `snapshots`.
 * So the split is a graph question: everything the importers' `dependencies`
 * and `optionalDependencies` reach is `prod`, and every other snapshot entry is
 * reached only by a `devDependency` and is `dev`.
 *
 * **Optional dependencies count as shipped**, at both levels. An importer's
 * optional dependency is a package that installs when the platform allows and
 * runs when it installs; an optional dependency *of* a runtime dependency is
 * the same thing one level down. Calling either one dev-only would demote a
 * finding about code that ships — the one direction this module must not get
 * wrong. A `devDependency`'s optional dependencies are never reached from a
 * runtime root and stay `dev`.
 *
 * **Keys carry their peers.** A snapshot key is `name@version` plus a
 * parenthesised list of the peer resolutions it was built for —
 * `@base-ui/react@1.6.0(@types/react@19.2.17)(react@19.2.7)` — and the same
 * package can appear under several such keys. The walk follows the full keys,
 * because that is what the edges name, and reports the scope of the base
 * `name@version`, because that is what an advisory is about. A package that is
 * prod under any peer resolution is prod.
 *
 * **Workspace links are not packages.** A `link:../common` version is another
 * importer, which the walk already has as a root of its own.
 *
 * @throws {Error} when the document is not a YAML mapping
 */
function readPnpmLock(text: string): LockfileScopes {
  const root = asRecord(parseYaml(text))
  if (root === undefined) {
    // An empty lockfile parses to null: nothing to classify, and not a fault.
    return text.trim().length === 0 ? EMPTY : throwNotAMapping()
  }
  const snapshots = asRecord(root['snapshots']) ?? {}
  const importers = asRecord(root['importers']) ?? {}

  const queue: string[] = []
  for (const importer of Object.values(importers)) {
    const entry = asRecord(importer)
    if (entry === undefined) continue
    for (const field of PROD_FIELDS) {
      for (const [name, spec] of Object.entries(asRecord(entry[field]) ?? {})) {
        const key = snapshotKey(name, asString(asRecord(spec)?.['version']))
        if (key !== undefined) queue.push(key)
      }
    }
  }

  // Breadth first over the snapshot graph. `visited` is keyed on the full
  // peer-suffixed key — two resolutions of one package are two nodes — and is
  // what stops a dependency cycle from running forever.
  const visited = new Set<string>()
  const reached = new Set<string>()
  const missing = new Set<string>()
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]
    if (key === undefined || visited.has(key)) continue
    visited.add(key)
    const snapshot = asRecord(snapshots[key])
    if (snapshot === undefined) {
      missing.add(baseId(key))
      continue
    }
    reached.add(baseId(key))
    for (const field of PROD_FIELDS) {
      for (const [name, version] of Object.entries(asRecord(snapshot[field]) ?? {})) {
        const next = snapshotKey(name, asString(version))
        if (next !== undefined) queue.push(next)
      }
    }
  }

  // Weakest claim first, strongest last: a package the walk resolved is `prod`
  // whatever else any other key of it said, and one the walk *reached* through
  // a missing entry is `unknown` rather than dev-only — it is not a package
  // only the toolchain pulls in, and demoting it would be the one wrong answer.
  const packages = new Map<string, DependencyScope>()
  for (const key of Object.keys(snapshots)) packages.set(baseId(key), 'dev')
  for (const id of missing) packages.set(id, 'unknown')
  for (const id of reached) packages.set(id, 'prod')

  return {
    packages: sorted(packages),
    notes:
      missing.size === 0
        ? []
        : [
            missing.size === 1
              ? '1 package reachable from a runtime dependency has no snapshot entry, so its ' +
                'scope is unknown and it is graded'
              : `${missing.size} packages reachable from a runtime dependency have no snapshot ` +
                'entry, so their scope is unknown and they are graded',
          ],
  }
}

/** `name` + the resolved version pnpm recorded → the snapshot key, or nothing. */
function snapshotKey(name: string, version: string | undefined): string | undefined {
  // `link:` is another importer of the workspace: a directory, not a published
  // package, and a root of the walk in its own right.
  if (version === undefined || version.startsWith('link:')) return undefined
  // An aliased install (`h3-v2: npm:h3@2.0.1-rc.20`) records the *real*
  // `name@version` as its resolved version, and the snapshot is stored under
  // that. Keying it on the alias would leave a real dependency unresolvable.
  return isAliased(version) ? version : `${name}@${version}`
}

/**
 * Whether a resolved version is really a `name@version` reference. A version
 * never contains an `@`; a reference always does, after any leading `@scope/`.
 * Only the part before the peer suffix is read — every peer resolution in it
 * is a `name@version` and would make this true of everything.
 */
function isAliased(version: string): boolean {
  const suffix = version.indexOf('(')
  const head = suffix === -1 ? version : version.slice(0, suffix)
  return head.slice(1).includes('@')
}

/**
 * A snapshot key without its peer resolutions — `name@version`, the identity an
 * advisory names. The suffix is parenthesised and a version never contains a
 * `(`, so the first one is where the package ends.
 */
function baseId(key: string): string {
  const suffix = key.indexOf('(')
  return suffix === -1 ? key : key.slice(0, suffix)
}

/**
 * `package-lock.json` (lockfileVersion 2 and 3) → scopes, read off npm's own
 * inline flags. npm resolves the closure when it writes the file and marks
 * every entry, so there is no graph to walk.
 *
 * `dev: true` is the only flag that demotes. `optional` is a package that ships
 * when the platform allows, and `devOptional` is npm's word for one reached
 * from *both* a dev dependency and an optional runtime dependency — shipped,
 * conditionally, either way.
 *
 * **The published name wins over the install path.** An aliased install lives
 * at `node_modules/<alias>` and carries the real `name`, which is what the
 * advisory database knows it as.
 *
 * **A package installed twice is prod if either copy is.** npm dedupes to the
 * root and nests conflicting versions, so one `name@version` can appear both
 * under a dev tree and hoisted for the runtime one.
 *
 * @throws {Error} when the document is not npm 7+'s `packages` map
 */
function readNpmLock(text: string): LockfileScopes {
  const root = asRecord(JSON.parse(text))
  const entries = asRecord(root?.['packages'])
  if (entries === undefined) {
    throw new Error('no packages map — npm 6 lockfiles record no resolved tree')
  }

  const packages = new Map<string, DependencyScope>()
  for (const [path, value] of Object.entries(entries)) {
    // The root entry is the project itself, not one of its dependencies.
    if (path === '') continue
    const record = asRecord(value)
    const version = asString(record?.['version'])
    const name = asString(record?.['name']) ?? installedName(path)
    if (version === undefined || name === undefined) continue
    const id = `${name}@${version}`
    if (record?.['dev'] === true) {
      if (!packages.has(id)) packages.set(id, 'dev')
    } else packages.set(id, 'prod')
  }

  return { packages: sorted(packages), notes: [] }
}

/** The package a `node_modules/…` path installs, nesting and all. */
function installedName(path: string): string | undefined {
  const marker = path.lastIndexOf('node_modules/')
  return marker === -1 ? undefined : path.slice(marker + 'node_modules/'.length)
}

/**
 * Every npm dependency finding, with the scope its lockfile puts it in — the
 * one thing a runner cannot do for itself, for the same reason reachability is
 * not a runner's job: it is a fact about the repo's lockfile rather than about
 * the tool's output, and the lockfile has to be read once for a scan rather
 * than once per finding.
 *
 * A finding is scoped by *its own* `file`, which for a dependency finding is
 * the lockfile it was found in — so a monorepo's two lockfiles each answer for
 * their own packages, and a finding filed against a `package.json` (no
 * lockfile to read) stays `unknown` and graded.
 *
 * @param repoRoot absolute path of the tree the findings are about
 * @returns the findings in the order given, and one warning per lockfile that
 * could not be read whole
 */
export async function applyDependencyScopes(
  repoRoot: string,
  findings: readonly Finding[],
): Promise<{ readonly findings: Finding[]; readonly warnings: string[] }> {
  const lockfiles = [
    ...new Set(findings.filter((finding) => isNpmDependency(finding)).map(({ file }) => file)),
  ].toSorted(compare)
  if (lockfiles.length === 0) return { findings: [...findings], warnings: [] }

  const read = new Map<string, LockfileScopes>()
  const warnings: string[] = []
  for (const lockfile of lockfiles) {
    // Sequential: a scan has one lockfile, or a monorepo's handful.
    // eslint-disable-next-line no-await-in-loop
    const scopes = await readLockfile(repoRoot, lockfile)
    read.set(lockfile, scopes)
    warnings.push(...scopes.notes)
  }

  return {
    findings: findings.map((finding) => {
      const scopes = read.get(finding.file)
      const pkg = finding.package
      if (scopes === undefined || pkg === undefined || !isNpmDependency(finding)) return finding
      return scoped(finding, scopeIn(scopes, pkg.name, pkg.version))
    }),
    warnings,
  }
}

/**
 * A lockfile that is not there classifies nothing and is not worth a warning:
 * osv-scanner reports a manifest it could not find a lockfile beside, and the
 * package is graded, which is the answer either way.
 */
async function readLockfile(repoRoot: string, file: string): Promise<LockfileScopes> {
  let text: string
  try {
    text = await readFile(join(repoRoot, file), 'utf8')
  } catch {
    return EMPTY
  }
  return classifyLockfile(file, text)
}

/** Whether this finding is about an npm package, and so has a scope at all. */
function isNpmDependency(finding: Finding): boolean {
  return finding.package?.ecosystem === NPM_ECOSYSTEM
}

/**
 * What a demoted finding's row says it was demoted for. The scope token leads,
 * so the sentence in the human report and the `scope` field in `report.json`
 * are searchable as one string — the shape `govulncheck.ts` established for
 * reachability.
 */
const DEV_SCOPE_TEXT =
  'dev — the lockfile pulls this package in as a devDependency only, so it does not ship'

/** The clause a demotion is announced in, matching every other demotion's. */
const ADVISORY_ONLY = '; advisory only: '

/**
 * One finding with its scope stamped on every advisory, demoted when the
 * package does not ship.
 *
 * `unknown` stamps nothing: the field is absent until scope resolution has
 * answered (`core/types.ts`), and "we could not tell" is the same information
 * as no field at all — while writing `scope: 'unknown'` on every package of
 * every yarn repo would read as a finding about the repo.
 *
 * A demotion is appended rather than re-derived: stamping a scope changes no
 * advisory's id, severity or fix, so the one-line message
 * `summarizePackage` built is still exactly right. A finding already demoted
 * for another reason gains a second clause in the same sentence rather than a
 * second sentence.
 */
function scoped(finding: Finding, scope: DependencyScope): Finding {
  if (scope === 'unknown') return finding
  const advisories = (finding.packageAdvisories ?? []).map(
    (advisory) => ({ ...advisory, scope }) satisfies PackageAdvisory,
  )
  if (scope === 'prod') return { ...finding, packageAdvisories: advisories }
  return {
    ...finding,
    message: finding.message.includes(ADVISORY_ONLY)
      ? `${finding.message}; ${DEV_SCOPE_TEXT}`
      : `${finding.message}${ADVISORY_ONLY}${DEV_SCOPE_TEXT}`,
    gradeScope: false,
    packageAdvisories: advisories,
  }
}

function sorted(packages: Map<string, DependencyScope>): Map<string, DependencyScope> {
  return new Map([...packages].toSorted(([a], [b]) => compare(a, b)))
}

function throwNotAMapping(): never {
  throw new Error('the lockfile is not a YAML mapping')
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
