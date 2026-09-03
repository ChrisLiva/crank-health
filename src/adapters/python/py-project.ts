import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ROOT_PROJECT, ancestryOf, repoPath } from '../../core/discover.ts'
import type { DetectContext, Detection } from '../../core/types.ts'
import { exists } from '../support.ts'

/**
 * Spec §1's ownership test in the shape every Python tool shares: a config
 * artifact (`ruff.toml`, `pyrightconfig.json`, a `[tool.X]` section in
 * `pyproject.toml`) or a declared dependency (`pyproject.toml` dependencies and
 * groups, `requirements*.txt`). Detection never spawns a process, so "installed"
 * means "there is a binary in the project's virtualenv".
 *
 * **Ancestors count.** Every tool here resolves its configuration upward — ruff
 * walks parent directories for the `pyproject.toml` that applies, and a package
 * inside a workspace is installed into, and run out of, the environment above
 * it. So each check walks the project's directory and then its ancestors,
 * nearest first, and the nearest answer wins.
 *
 * **Why there is a TOML reader in here.** Runtime dependencies are frozen at
 * execa + picocolors, so `pyproject.toml` is read by the smallest scanner that
 * answers the only two questions detection asks — *is there a `[tool.X]`
 * section* and *is distribution X named as a dependency*. It is deliberately not
 * a TOML parser, and its limits are documented on {@link tomlSections} and
 * {@link tomlDependencies}: it is wrong only for inputs that would also be
 * unusual for a human reader, and being wrong costs a wrong provenance tag, not
 * a crash.
 */

/** Where a project's virtualenv can live, in the order we look (spec §7). */
const VENV_DIRECTORIES: readonly string[] = ['.venv', 'venv', 'env']

/** Interpreter path inside a virtualenv, relative to its root. */
const VENV_INTERPRETERS: readonly string[] = ['bin/python3', 'bin/python', 'Scripts/python.exe']

/** Where an executable lives inside a virtualenv, relative to its root. */
const VENV_BIN_DIRECTORIES: readonly string[] = ['bin', 'Scripts']

/** Sections whose *keys* are distribution names (poetry- and pdm-style tables). */
const DEPENDENCY_TABLE_PATTERNS: readonly RegExp[] = [
  /^tool\.poetry\.dependencies$/,
  /^tool\.poetry\.dev-dependencies$/,
  /^tool\.poetry\.group\.[^.]+\.dependencies$/,
]

/** Sections whose array values are all dependency lists, whatever the key. */
const DEPENDENCY_ARRAY_SECTIONS: readonly RegExp[] = [
  /^project\.optional-dependencies$/,
  /^dependency-groups$/,
  /^tool\.pdm\.dev-dependencies$/,
  /^tool\.uv$/,
  /^tool\.hatch\.envs\.[^.]+$/,
]

/** Keys whose array value is a dependency list in any section. */
const DEPENDENCY_ARRAY_KEYS: ReadonlySet<string> = new Set([
  'dependencies',
  'dev-dependencies',
  'dev_dependencies',
  'requires',
])

/** The manifest a Python project's tool configuration lives in. */
const PYPROJECT = 'pyproject.toml'

/** A project virtualenv crank-health found, and the interpreter inside it. */
export interface Venv {
  /** Repo-relative posix path of the virtualenv root, e.g. `.venv`. */
  readonly directory: string
  /** Absolute path of the interpreter, for `--python`/`--pythonpath`. */
  readonly interpreter: string
}

export interface PythonToolSpec {
  /** Config artifacts that make the tool repo-owned, relative to a project dir. */
  readonly configFiles: readonly string[]
  /** PyPI distribution name, e.g. `ruff`. */
  readonly distribution: string
  /** The executable inside a virtualenv's `bin/`, when it differs. */
  readonly binName?: string
  /**
   * `pyproject.toml` sections that are themselves a config artifact — normally
   * `tool.<name>`, and every subsection of it counts too.
   */
  readonly sections: readonly string[]
}

/**
 * @returns the {@link Detection} when the repo owns this tool, `null` otherwise
 */
export async function detectPythonTool(
  ctx: DetectContext,
  spec: PythonToolSpec,
): Promise<Detection | null> {
  const ancestry = ancestryOf(ctx.project.path)
  const manifests = await Promise.all(
    ancestry.map((directory) => readTextFile(join(ctx.repoRoot, directory, PYPROJECT))),
  )
  const present = new Set(ctx.files.all)

  const configFiles = ancestry.flatMap((directory, depth) => {
    const found = spec.configFiles
      .map((file) => repoPath(directory, file))
      .filter((file) => present.has(file))
    const manifest = manifests[depth]
    if (manifest !== undefined && ownsSection(manifest, spec.sections)) {
      found.push(repoPath(directory, PYPROJECT))
    }
    return found
  })

  const declaredIn = await declaringFile(ctx, ancestry, manifests, spec.distribution)
  const declared = declaredIn !== undefined
  if (configFiles.length === 0 && !declared) return null

  // Both chains are walked nearest-first, so the first answer is the nearest
  // one — `configFiles` is only sorted on its way into the report.
  const ownedVia = configFiles[0] ?? declaredIn

  const venv = await findVenv(ctx.repoRoot, ctx.project.path)
  const binPath =
    venv === undefined ? undefined : await venvBin(venv, spec.binName ?? spec.distribution)

  return {
    reason:
      configFiles.length > 0 && declared
        ? 'config+dependency'
        : configFiles.length > 0
          ? 'config'
          : 'dependency',
    configFiles: configFiles.toSorted(compare),
    ...(ownedVia === undefined ? {} : { ownedVia }),
    installed: binPath !== undefined,
    ...(binPath === undefined ? {} : { binPath }),
  }
}

/**
 * The project's virtualenv, or `undefined` when there is none. The project's
 * own directory is searched first, then its ancestors: a package inside a
 * workspace is normally installed into the environment at the root.
 *
 * A directory only counts when it actually contains an interpreter: the whole
 * point of finding it is to hand a real `python` to a type checker so that
 * third-party imports resolve, and an empty `.venv/` would just make pyright
 * fail in a more confusing way than not running it at all.
 *
 * `VIRTUAL_ENV` is consulted last and only as a fallback, so an activated shell
 * cannot override what the repo itself carries. It is part of "the same repo
 * toolchain" clause of the determinism contract (spec §6): a scan run inside an
 * activated environment may resolve imports a scan outside it cannot.
 */
export async function findVenv(
  repoRoot: string,
  projectPath = ROOT_PROJECT,
): Promise<Venv | undefined> {
  const candidates = ancestryOf(projectPath).flatMap((directory) =>
    VENV_DIRECTORIES.map((name) => repoPath(directory, name)),
  )
  for (const directory of candidates) {
    // Ordered on purpose: the first virtualenv that exists wins, deterministically.
    // eslint-disable-next-line no-await-in-loop
    const interpreter = await findInterpreter(join(repoRoot, directory))
    if (interpreter !== undefined) return { directory, interpreter }
  }

  const activated = process.env['VIRTUAL_ENV']
  if (activated !== undefined && activated.length > 0) {
    const interpreter = await findInterpreter(activated)
    if (interpreter !== undefined) return { directory: activated, interpreter }
  }
  return undefined
}

/**
 * Which type checker crank-health runs when the repo owns neither of them —
 * spec "Categories and tools", verbatim: "ty (beta) → pyright when venv
 * exists". pyright needs an interpreter to resolve third-party imports, and
 * with a virtualenv present it has one; without it, ty's stdlib-only checking
 * is the more useful of the two.
 *
 * Both runners ask this one function so the two halves of the decision cannot
 * drift into "both ran" or "neither ran".
 */
export function defaultTypeChecker(venv: Venv | undefined): 'ty' | 'pyright' {
  return venv === undefined ? 'ty' : 'pyright'
}

async function findInterpreter(venvRoot: string): Promise<string | undefined> {
  for (const relative of VENV_INTERPRETERS) {
    const candidate = join(venvRoot, relative)
    // eslint-disable-next-line no-await-in-loop
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/** The repo's own installed copy of a tool, when its virtualenv has one. */
async function venvBin(venv: Venv, binName: string): Promise<string | undefined> {
  const root = venv.interpreter.replace(/[/\\](bin|Scripts)[/\\][^/\\]+$/, '')
  for (const directory of VENV_BIN_DIRECTORIES) {
    const candidate = join(root, directory, binName)
    // eslint-disable-next-line no-await-in-loop
    if (await exists(candidate)) return candidate
  }
  return undefined
}

/** True when any of `sections` — or a subsection of one — is present. */
function ownsSection(manifest: string, sections: readonly string[]): boolean {
  const present = tomlSections(manifest)
  return sections.some((section) =>
    [...present].some((name) => name === section || name.startsWith(`${section}.`)),
  )
}

/**
 * The nearest file that names the distribution as a dependency — a
 * `pyproject.toml` or a requirements file, the project's own or an ancestor's —
 * or `undefined` when nothing declares it. The path is what
 * {@link Detection.ownedVia} reports; that it exists at all is the dependency
 * half of ownership.
 */
async function declaringFile(
  ctx: DetectContext,
  ancestry: readonly string[],
  manifests: readonly (string | undefined)[],
  distribution: string,
): Promise<string | undefined> {
  const wanted = normalizeDistribution(distribution)
  for (const [depth, directory] of ancestry.entries()) {
    const manifest = manifests[depth]
    if (manifest !== undefined && tomlDependencies(manifest).has(wanted)) {
      return repoPath(directory, PYPROJECT)
    }
    for (const file of requirementsFiles(ctx.files.all, directory)) {
      // A handful of small files; reading them in order keeps the result stable.
      // eslint-disable-next-line no-await-in-loop
      const text = await readTextFile(join(ctx.repoRoot, file))
      if (text !== undefined && requirementNames(text).has(wanted)) return file
    }
  }
  return undefined
}

/**
 * `requirements.txt`, `requirements-dev.txt`, `requirements/*.txt` (spec §1),
 * in one project directory — the repo root unless a nearer one is named.
 */
function requirementsFiles(files: readonly string[], directory = ROOT_PROJECT): string[] {
  const prefix = directory === ROOT_PROJECT ? '' : `${directory}/`
  return files.filter((file) => {
    const name = file.startsWith(prefix) ? file.slice(prefix.length) : ''
    return /^requirements[^/]*\.txt$/.test(name) || /^requirements\/[^/]+\.txt$/.test(name)
  })
}

/**
 * Section headers in a TOML document, as dotted names (`[tool.ruff.lint]` →
 * `tool.ruff.lint`). Array-of-table headers (`[[tool.x]]`) count as `tool.x`.
 *
 * Limits, all deliberate: a header inside a multi-line string is skipped
 * (triple-quoted spans are tracked), but a header written on the same line as
 * other content — which TOML forbids anyway — is not recognized, and quoted key
 * segments keep their quotes. Neither can turn a real `[tool.ruff]` into a miss.
 */
function tomlSections(text: string): Set<string> {
  const sections = new Set<string>()
  for (const line of significantLines(text)) {
    const match = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(line)
    if (match?.[1] !== undefined) sections.add(match[1])
  }
  return sections
}

/**
 * Distribution names declared as dependencies anywhere in a `pyproject.toml`,
 * normalized per PEP 503. Covers the four layouts in the wild: PEP 621
 * `dependencies` arrays, `[project.optional-dependencies]`, PEP 735
 * `[dependency-groups]`, and poetry/pdm dependency tables.
 *
 * Limits: only single-line array entries and single-line table keys are read
 * (an entry split across lines mid-string is missed), and a requirement is
 * reduced to the name before its first extra/marker/version specifier. Missing a
 * declaration costs a `default-config` tag on a tool the repo owns — visible in
 * the report, never a crash.
 */
function tomlDependencies(text: string): Set<string> {
  const names = new Set<string>()
  let section = ''
  let inArray = false

  for (const line of significantLines(text)) {
    const header = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(line)
    if (header?.[1] !== undefined) {
      section = header[1]
      inArray = false
      continue
    }

    if (inArray) {
      for (const entry of quotedStrings(line)) names.add(normalizeDistribution(entry))
      if (line.includes(']')) inArray = false
      continue
    }

    const declared = declaredNames(line, section)
    for (const name of declared.names) names.add(name)
    inArray = declared.opensArray
  }

  names.delete('')
  return names
}

/**
 * What one `key = value` line inside `section` declares: the distribution names
 * it names, and whether it opened an array the following lines continue. A line
 * that is not an assignment, and one whose section makes it no dependency at
 * all, declares nothing.
 */
function declaredNames(
  line: string,
  section: string,
): { readonly names: readonly string[]; readonly opensArray: boolean } {
  const assignment = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line)
  const key = assignment?.[1]?.replaceAll(/["']/g, '')
  if (key === undefined) return NOTHING_DECLARED

  if (DEPENDENCY_TABLE_PATTERNS.some((pattern) => pattern.test(section))) {
    return { names: [normalizeDistribution(key)], opensArray: false }
  }

  const value = assignment?.[2] ?? ''
  const isDependencyArray =
    value.startsWith('[') &&
    (DEPENDENCY_ARRAY_KEYS.has(key) ||
      DEPENDENCY_ARRAY_SECTIONS.some((pattern) => pattern.test(section)))
  if (!isDependencyArray) return NOTHING_DECLARED

  return {
    names: quotedStrings(value).map((entry) => normalizeDistribution(entry)),
    opensArray: !value.includes(']'),
  }
}

/** A line that declares no dependency and opens no array. */
const NOTHING_DECLARED = { names: [], opensArray: false } as const

/**
 * Distribution names in a `requirements.txt`, normalized per PEP 503. Option
 * lines (`-r other.txt`, `--index-url …`) and comments are skipped; a `-e`
 * editable install contributes nothing, because its argument is a path.
 */
function requirementNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? ''
    if (line.length === 0 || line.startsWith('-')) continue
    names.add(normalizeDistribution(line))
  }
  names.delete('')
  return names
}

/**
 * A requirement string reduced to its normalized distribution name: PEP 503
 * normalization (lowercase, runs of `-`, `_` and `.` collapsed to `-`) applied
 * to everything before the first extra, marker, URL or version specifier.
 */
function normalizeDistribution(requirement: string): string {
  const name = requirement.trim().split(/[\s[<>=!~;(@,]/)[0] ?? ''
  return name.toLowerCase().replaceAll(/[-_.]+/g, '-')
}

/**
 * Meaningful lines of a TOML document: trimmed, comment-only lines dropped, and
 * the interior of multi-line (triple-quoted) strings skipped so that prose
 * cannot be mistaken for structure.
 */
function significantLines(text: string): string[] {
  const lines: string[] = []
  let delimiter: string | undefined

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (delimiter !== undefined) {
      if (line.includes(delimiter)) delimiter = undefined
      continue
    }
    if (line.length === 0 || line.startsWith('#')) continue

    const opened = /("""|''')/.exec(line)
    if (opened?.[1] !== undefined && line.split(opened[1]).length === 2) {
      delimiter = opened[1]
    }
    lines.push(line)
  }
  return lines
}

/** Every single- or double-quoted string in a line, in order. */
function quotedStrings(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? '')
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

function compare(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
