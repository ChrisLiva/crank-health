/**
 * The per-release tool manifest (spec §6). Every ephemeral invocation pins an
 * exact version from this table — never `@latest`, never a range — so the
 * determinism contract holds: same crank-health version + same commit + same
 * repo toolchain ⇒ byte-identical report.
 *
 * Repo-owned tools run at the repo's installed version instead; the resolved
 * version of every run lands in `report.json` either way.
 *
 * Bumping a version here can change grades, so it is a crank-health version
 * bump and it must come with re-captured parse fixtures under `test/captured/`.
 */
export const TOOL_MANIFEST = {
  oxlint: '1.77.0',
  eslint: '10.8.0',
  '@biomejs/biome': '2.5.7',
  prettier: '3.9.6',
  typescript: '7.0.2',
  fallow: '3.14.0',
  knip: '6.31.0',
  'fta-cli': '3.0.0',
  jscpd: '5.0.14',
} as const satisfies Readonly<Record<string, string>>

/**
 * The same contract for the Python side, resolved by `uvx` instead of `npx`.
 * Keys are PyPI distribution names.
 *
 * `ty` is Astral's type checker and still pre-1.0 — its diagnostics and output
 * formats move between releases, which is precisely why the version is pinned
 * here and its parser is tested against captured bytes.
 */
export const PYTHON_TOOL_MANIFEST = {
  ruff: '0.16.1',
  ty: '0.0.66',
  pyright: '1.1.411',
  vulture: '2.16',
  complexipy: '6.2.0',
  bandit: '1.9.4',
  zizmor: '1.29.0',
} as const satisfies Readonly<Record<string, string>>

/**
 * Tools crank-health cannot fetch at all, and runs from `PATH` when the machine
 * already has them.
 *
 * gitleaks, opengrep and osv-scanner are single-file binaries distributed
 * through GitHub releases, Homebrew and Docker — none of them publishes a
 * first-party npm or PyPI package, so neither `npx` nor `uvx` can resolve one
 * (the `gitleaks` and `opengrep` names on npm are, respectively, an unrelated
 * package and an empty placeholder; `osv-scanner` on PyPI is a reserved name
 * with no code). Third-party binary-downloading wrappers exist, and adopting an
 * unaudited one for a *security* scanner would be exactly the supply-chain
 * mistake these tools are meant to catch.
 *
 * So the contract is different from the pinned one: crank-health uses the
 * version already installed, reports it, and degrades to `not-available` with an
 * install hint when there is none (spec §8). The version recorded here is the
 * one this release's parsers were captured and tested against — a floor for
 * "known to work", not a pin crank-health can enforce.
 */
export const SYSTEM_TOOL_MANIFEST = {
  gitleaks: '8.30.1',
  opengrep: '1.26.0',
  'osv-scanner': '2.4.0',
} as const satisfies Readonly<Record<string, string>>

/**
 * A tool crank-health can invoke ephemerally at a pinned version. Keys are npm
 * package names — that is what `npx` resolves — which is not always the command
 * name (`typescript` ships `tsc`, `fta-cli` ships `fta`); see
 * {@link import('./core/exec.ts').ephemeralCommand}.
 */
export type PinnedTool = keyof typeof TOOL_MANIFEST

/** A PyPI distribution crank-health runs through `uvx` at a pinned version. */
export type PinnedPythonTool = keyof typeof PYTHON_TOOL_MANIFEST

/** A tool crank-health runs from `PATH`; see {@link SYSTEM_TOOL_MANIFEST}. */
export type SystemTool = keyof typeof SYSTEM_TOOL_MANIFEST

/** The version of `tool` this release was captured and tested against. */
export function verifiedVersion(tool: SystemTool): string {
  return SYSTEM_TOOL_MANIFEST[tool]
}

/** The exact version this release pins for `tool`. */
export function pinnedVersion(tool: PinnedTool): string {
  return TOOL_MANIFEST[tool]
}

/**
 * The `name@version` spec for an ephemeral install, e.g. `oxlint@1.77.0`.
 * Pass this to `npx --yes`, never a bare name.
 */
export function pinnedSpec(tool: PinnedTool): string {
  return `${tool}@${TOOL_MANIFEST[tool]}`
}

/** The exact version this release pins for the Python `tool`. */
export function pinnedPythonVersion(tool: PinnedPythonTool): string {
  return PYTHON_TOOL_MANIFEST[tool]
}

/**
 * The `name@version` spec `uvx` resolves, e.g. `ruff@0.16.1`. `uvx` reads the
 * `@` form as an exact pin; the `==` form is only needed when the command name
 * differs from the distribution name (see
 * {@link import('./core/exec.ts').uvxCommand}).
 */
export function pinnedPythonSpec(tool: PinnedPythonTool): string {
  return `${tool}@${PYTHON_TOOL_MANIFEST[tool]}`
}
