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
const TOOL_MANIFEST = {
  oxlint: '1.78.0',
  eslint: '10.8.1',
  '@biomejs/biome': '2.5.9',
  prettier: '3.9.6',
  typescript: '7.0.2',
  fallow: '3.17.0',
  knip: '6.32.2',
  'fta-cli': '3.0.1',
  jscpd: '5.0.15',
  // Modified-MIT license: forbids ML-training use and hosted resale, accepted
  // for scanner use. Releases daily, so this pin goes stale fast — bumping it
  // is a crank-health version bump with re-captured fixtures, per the header.
  'react-doctor': '0.9.12',
} as const satisfies Readonly<Record<string, string>>

/**
 * The same contract for the Python side, resolved by `uvx` instead of `npx`.
 * Keys are PyPI distribution names.
 *
 * `ty` is Astral's type checker and still pre-1.0 — its diagnostics and output
 * formats move between releases, which is precisely why the version is pinned
 * here and its parser is tested against captured bytes.
 */
const PYTHON_TOOL_MANIFEST = {
  ruff: '0.16.3',
  ty: '0.0.72',
  pyright: '1.1.411',
  mypy: '2.3.1',
  vulture: '2.16',
  complexipy: '7.0.1',
  bandit: '1.9.4',
  zizmor: '1.29.0',
} as const satisfies Readonly<Record<string, string>>

/**
 * The same contract a third time, for the .NET side: NuGet tool-package names,
 * resolved by `dnx` into the NuGet cache — never into the target repo. `dnx`
 * ships with the .NET SDK itself (see {@link SYSTEM_TOOL_MANIFEST}'s `dotnet`
 * entry), so these pins only apply on a machine that has the SDK.
 */
const DOTNET_TOOL_MANIFEST = {
  'microsoft.codeanalysis.netanalyzers': '10.0.400',
  'roslynator.dotnet.cli': '0.13.1',
} as const satisfies Readonly<Record<string, string>>

/**
 * The Go side, resolved by the `go` command itself: `go run <import-path>@<version>`
 * fetches, builds and runs a tool into the module cache and the build cache,
 * both outside the target repo. Keys are the tool's import path.
 *
 * `go` is not in {@link SYSTEM_TOOL_MANIFEST} because nothing pins it: it is the
 * fetcher here, the way `npx` and `uvx` are, and a machine without it gets the
 * runner's own `not-available` reason rather than a version comparison.
 *
 * The `v` prefix is part of a Go version, so it is part of the pin.
 */
const GO_TOOL_MANIFEST = {
  'github.com/go-gremlins/gremlins/cmd/gremlins': 'v0.6.0',
  'github.com/golangci/golangci-lint/v2/cmd/golangci-lint': 'v2.12.2',
  'github.com/securego/gosec/v2/cmd/gosec': 'v2.28.0',
  'github.com/uudashr/gocognit/cmd/gocognit': 'v1.2.1',
  'golang.org/x/vuln/cmd/govulncheck': 'v1.7.0',
  'honnef.co/go/tools/cmd/staticcheck': 'v0.8.1',
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
 *
 * A language SDK joins on the same contract: crank-health cannot fetch the
 * `dotnet` SDK, uses whatever the machine has installed, and records here the
 * verified floor this release was tested against.
 */
const SYSTEM_TOOL_MANIFEST = {
  dotnet: '10.0.203',
  gitleaks: '8.30.1',
  opengrep: '1.26.0',
  'osv-scanner': '2.5.0',
} as const satisfies Readonly<Record<string, string>>

/**
 * The deep tier's tools (spec §5), which crank-health only ever runs from the
 * repo's own installation.
 *
 * They are not pinnable, and the reason is the deep tier itself: mutation
 * testing and coverage *execute the repo's test suite*, so they have to run
 * inside the environment that suite needs — the repo's `node_modules` with its
 * test-runner plugins, the project's virtualenv with pytest and the project's
 * dependencies. An ephemeral `npx @stryker-mutator/core` has no vitest runner
 * plugin, an ephemeral `uvx cosmic-ray` cannot import the code it is mutating,
 * and an ephemeral `dnx dotnet-stryker` cannot build the solution its mutants
 * must compile against. Fetching them would produce a confident failure instead
 * of an honest "not available" (spec §8), so crank-health does not fetch them.
 *
 * The versions here are what this release's parsers were captured and tested
 * against — a floor for "known to work", the same contract as
 * {@link SYSTEM_TOOL_MANIFEST}, not a pin crank-health can enforce.
 */
const REPO_TOOL_MANIFEST = {
  '@stryker-mutator/core': '10.0.0',
  'cosmic-ray': '8.7.0',
  coverage: '7.15.4',
  'dotnet-stryker': '4.16.0',
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

/** A NuGet tool package crank-health runs through `dnx` at a pinned version. */
export type PinnedDotnetTool = keyof typeof DOTNET_TOOL_MANIFEST

/** A Go tool crank-health runs through `go run` at a pinned version. */
export type PinnedGoTool = keyof typeof GO_TOOL_MANIFEST

/** A tool crank-health runs from `PATH`; see {@link SYSTEM_TOOL_MANIFEST}. */
export type SystemTool = keyof typeof SYSTEM_TOOL_MANIFEST

/** A deep-tier tool crank-health runs from the repo; see {@link REPO_TOOL_MANIFEST}. */
export type RepoTool = keyof typeof REPO_TOOL_MANIFEST

/** The version of `tool` this release was captured and tested against. */
export function verifiedVersion(tool: SystemTool): string {
  return SYSTEM_TOOL_MANIFEST[tool]
}

/** The same, for a deep-tier tool; see {@link REPO_TOOL_MANIFEST}. */
export function verifiedRepoVersion(tool: RepoTool): string {
  return REPO_TOOL_MANIFEST[tool]
}

/** The exact version this release pins for `tool`. */
export function pinnedVersion(tool: PinnedTool): string {
  return TOOL_MANIFEST[tool]
}

/**
 * The `name@version` spec for an ephemeral install, e.g. `oxlint@1.78.0`.
 * Pass this to `npx --yes`, never a bare name.
 */
export function pinnedSpec(tool: PinnedTool): string {
  return `${tool}@${TOOL_MANIFEST[tool]}`
}

/** The exact version this release pins for the Go `tool`, `v` prefix included. */
export function pinnedGoVersion(tool: PinnedGoTool): string {
  return GO_TOOL_MANIFEST[tool]
}

/**
 * The `import-path@version` spec `go run` resolves, e.g.
 * `golang.org/x/vuln/cmd/govulncheck@v1.7.0`. Pass this to `go run`, never a
 * bare import path — that form means `@latest`.
 */
export function pinnedGoSpec(tool: PinnedGoTool): string {
  return `${tool}@${GO_TOOL_MANIFEST[tool]}`
}

/** The exact version this release pins for the Python `tool`. */
export function pinnedPythonVersion(tool: PinnedPythonTool): string {
  return PYTHON_TOOL_MANIFEST[tool]
}

/**
 * The `name@version` spec `uvx` resolves, e.g. `ruff@0.16.3`. `uvx` reads the
 * `@` form as an exact pin; the `==` form is only needed when the command name
 * differs from the distribution name (see
 * {@link import('./core/exec.ts').uvxCommand}).
 */
export function pinnedPythonSpec(tool: PinnedPythonTool): string {
  return `${tool}@${PYTHON_TOOL_MANIFEST[tool]}`
}

/** The exact version this release pins for the .NET `tool`. */
export function pinnedDotnetVersion(tool: PinnedDotnetTool): string {
  return DOTNET_TOOL_MANIFEST[tool]
}

/**
 * The `id@version` spec `dnx` resolves, e.g. `roslynator.dotnet.cli@0.12.0`.
 * `dnx` reads the `@` form as an exact pin (see
 * {@link import('./core/exec.ts').dnxCommand}).
 */
export function pinnedDotnetSpec(tool: PinnedDotnetTool): string {
  return `${tool}@${DOTNET_TOOL_MANIFEST[tool]}`
}
