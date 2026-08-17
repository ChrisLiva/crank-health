import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_PROJECT, ancestryOf, repoPath } from '../../core/discover.ts'
import { asArray, asRecord, asString, compare } from '../support.ts'
import { BIOME_CONFIG_FILES } from './biome.ts'
import { FALLOW_CONFIG_FILES } from './fallow.ts'

/**
 * The file sets a repo has already told its own tools to skip.
 *
 * Spec §1 keeps the *thresholds* crank-health's own — a repo cannot tune its way
 * to an A — but the file set is a different question. A generated tree the repo
 * excluded from Biome and fallow is not code anyone wrote, and measuring its
 * self-similarity marks a repo down for owning a code generator. So the
 * excludes, and only the excludes, are inherited: what narrows is which files
 * are looked at, never what a number has to be to earn a letter.
 *
 * **Ownership is detection's rule.** A config in an ancestor directory
 * configures the project below it (see {@link detectNodeTool}), so the chain is
 * walked nearest-first and the nearest config of each family answers. Patterns
 * are read relative to the directory that *declared* them — an inherited
 * `!gen/**` means the declaring directory's `gen/`, not the inheriting one's.
 *
 * **Translation is faithful or absent.** A pattern that cannot be carried over
 * without reaching further than the config meant is dropped, and the note names
 * only what was actually inherited: an exclude wider than the repo wrote would
 * hide real duplication behind a grade nobody can audit.
 */

/** Biome's exclusions are the negated entries of `files.includes`. */
const BIOME_INCLUDES = ['files', 'includes'] as const

/** fallow states its exclusions positively, as globs. */
const FALLOW_IGNORE = 'ignorePatterns'

/** One config that contributed at least one exclude. */
export interface RepoExcludeSource {
  /** Repo-relative posix path of the config, e.g. `biome.json`. */
  readonly config: string
  /** The globs it contributed, repo-relative posix, deduped and sorted. */
  readonly patterns: readonly string[]
}

/**
 * What the repo's own configs exclude, ready for a consumer to apply and to
 * attribute. Consumed by the jscpd runner (which turns {@link patterns} into
 * ignore globs) and by `agent.md`, which uses the same list to tell generated
 * files from hand-written ones.
 */
export interface RepoExcludes {
  /** Every contributed glob, repo-relative posix, deduped and stable-sorted. */
  readonly patterns: readonly string[]
  /** Per-config provenance, in read order: Biome first, then fallow. */
  readonly sources: readonly RepoExcludeSource[]
  /**
   * Configs found but not parseable as JSON, repo-relative posix, in read
   * order. Present so a consumer can say that a file it could not read is the
   * reason nothing was inherited from it.
   */
  readonly unreadable: readonly string[]
}

/**
 * The excludes that apply to one project.
 *
 * @param repoRoot absolute path of the repo
 * @param projectPath repo-relative posix project directory, `.` for the root
 */
export async function readRepoExcludes(
  repoRoot: string,
  projectPath: string = ROOT_PROJECT,
): Promise<RepoExcludes> {
  const families = [
    { files: BIOME_CONFIG_FILES, read: biomeExcludes },
    { files: FALLOW_CONFIG_FILES, read: fallowExcludes },
  ]
  const found = await Promise.all(
    families.map(async ({ files, read }) => {
      const config = await nearestConfig(repoRoot, projectPath, files)
      if (config === undefined) return undefined
      const document = parse(config.text)
      if (document === undefined) return { config: config.path, patterns: undefined }
      const patterns = read(document).flatMap((pattern) => translate(pattern, config.directory))
      return { config: config.path, patterns: sortUnique(patterns) }
    }),
  )

  const sources = found.flatMap((entry) =>
    entry?.patterns === undefined || entry.patterns.length === 0
      ? []
      : [{ config: entry.config, patterns: entry.patterns }],
  )
  return {
    patterns: sortUnique(sources.flatMap((source) => source.patterns)),
    sources,
    unreadable: found.flatMap((entry) =>
      entry !== undefined && entry.patterns === undefined ? [entry.config] : [],
    ),
  }
}

interface FoundConfig {
  /** Repo-relative posix path of the config file. */
  readonly path: string
  /** Repo-relative posix directory that declared it — what its globs are relative to. */
  readonly directory: string
  readonly text: string
}

/**
 * The nearest config of one family, walking the project's directory and then its
 * ancestors — the chain {@link detectNodeTool} walks, so a project inherits the
 * excludes of the same config it inherits the tool from.
 *
 * Only the JSON-shaped members of a family are read. fallow also accepts TOML,
 * and a format this cannot parse is not a config it can honor: it inherits
 * nothing and claims nothing, which is today's behaviour rather than a note
 * about a file it never opened.
 */
async function nearestConfig(
  repoRoot: string,
  projectPath: string,
  files: readonly string[],
): Promise<FoundConfig | undefined> {
  const names = files.filter((file) => file.endsWith('.json') || file.endsWith('.jsonc'))
  for (const directory of ancestryOf(projectPath)) {
    for (const name of names) {
      const path = repoPath(directory, name)
      // Nearest-first, and the first name in the family list wins inside a
      // directory: the loop has to stop at the first hit, so it cannot fan out.
      // eslint-disable-next-line no-await-in-loop
      const text = await readText(join(repoRoot, path))
      if (text !== undefined) return { path, directory, text }
    }
  }
  return undefined
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** The document, or `undefined` when the file is not JSON we can read. */
function parse(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** `files.includes` entries starting with `!`; everything else there is an *include*. */
function biomeExcludes(document: Record<string, unknown>): string[] {
  const [outer, inner] = BIOME_INCLUDES
  const includes = asArray(asRecord(document[outer])?.[inner]) ?? []
  return includes.flatMap((entry) => {
    const pattern = asString(entry)
    return pattern === undefined || !pattern.startsWith('!') ? [] : [pattern.slice(1)]
  })
}

/** fallow's `ignorePatterns`: every entry is an exclusion already. */
function fallowExcludes(document: Record<string, unknown>): string[] {
  return (asArray(document[FALLOW_IGNORE]) ?? []).flatMap((entry) => {
    const pattern = asString(entry)
    return pattern === undefined ? [] : [pattern]
  })
}

/**
 * One config pattern → the repo-relative globs it means, or nothing.
 *
 * Dropped rather than approximated:
 *
 * - an empty pattern, and one that is still negated after a `!` came off — a
 *   double negation is a re-inclusion, and a list of excludes has nowhere to put
 *   it;
 * - an absolute pattern, which names a path outside the repo's own terms;
 * - one that walks up through `..`, which reaches outside the directory that
 *   declared it.
 *
 * A pattern that does not end in `*` names a path rather than the files under
 * it, and jscpd matches files — so `!**\/dist` as written would exclude nothing
 * at all. Both forms go in: what the repo wrote, and the tree beneath it, which
 * is what it meant. That is the one expansion here, and it cannot reach past the
 * directory the config already named.
 *
 * @param directory repo-relative posix directory of the config that declared it
 */
function translate(pattern: string, directory: string): string[] {
  const normalized = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (normalized.length === 0 || normalized.startsWith('!') || normalized.startsWith('/')) return []
  if (normalized.split('/').includes('..')) return []

  const rooted = repoPath(directory, normalized)
  return normalized.endsWith('*') ? [rooted] : [rooted, `${rooted}/**`]
}

/** Deduped and byte-wise sorted: the config a run writes must not vary by read order. */
function sortUnique(patterns: readonly string[]): string[] {
  return [...new Set(patterns)].toSorted(compare)
}
