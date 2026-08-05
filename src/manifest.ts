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
