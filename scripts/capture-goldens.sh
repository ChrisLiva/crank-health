#!/usr/bin/env bash
#
# The golden toolchain, made reproducible.
#
# A golden snapshot records one machine's toolchain (see
# `test/support/system-tools.ts`): gitleaks, opengrep and osv-scanner ship as
# release binaries with no npm or PyPI distribution, and `go` runs govulncheck,
# so a machine that has one installed produces a different — equally correct —
# report, and the goldens are recorded against the machine that has none of them.
#
# This script builds that machine: a PATH made of the system utilities every
# tool shells out to plus a symlink farm holding the development binaries the
# suite needs by name, and nothing else. Package managers install a release
# binary beside their own (`/opt/homebrew/bin`, `~/.local/bin`), and none of
# those directories is on the PATH this assembles — but that is an argument, not
# a guarantee, so the absence is asserted before a single test runs.
#
#   scripts/capture-goldens.sh            run the whole suite, goldens included
#   scripts/capture-goldens.sh capture    re-capture every golden, then verify
#
# Capture is two passes because the renderer goldens are rendered *from* the
# captured `report.json` files: the scans write the reports, then the renderers
# write the markdown from what the scans just wrote. Both passes are the ordinary
# suite with `CRANK_CAPTURE_GOLDENS=1`, so a golden can only ever record what the
# tests already assert.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-check}"

if [[ $mode != check && $mode != capture ]]; then
  echo "usage: ${BASH_SOURCE[0]} [check|capture]" >&2
  exit 2
fi

# Development binaries, taken from wherever this machine keeps them: node and
# its package runners, uv's, the .NET SDK's, and git for the fixture repos.
required=(node npm npx uv uvx git dotnet)

# The base system, where the utilities a tool's own wrapper script calls live —
# `sh`, `cat`, `realpath`, `which` itself.
system_path=/usr/bin:/bin

# Binaries whose presence makes a machine a different toolchain: the three
# release-binary scanners crank-health can only use when they are installed, and
# Go — govulncheck's fetcher and its analyzer both, so a machine with `go`
# analyzes Go modules for reachability where this one reports the toolchain
# absent. The goldens are the toolchain that has none of them, so the PATH below
# must not resolve one; `test/support/system-tools.ts` gates the same list.
absent=(gitleaks opengrep osv-scanner go govulncheck)

farm="$(mktemp -d "${TMPDIR:-/tmp}/crank-golden-path.XXXXXX")"
trap '/bin/rm -rf "$farm"' EXIT

for binary in "${required[@]}"; do
  resolved="$(command -v "$binary" || true)"
  if [[ $resolved != /* ]]; then
    echo "capture-goldens: $binary is not an executable on PATH; the suite needs it" >&2
    exit 1
  fi
  ln -s "$resolved" "$farm/$binary"
done

export PATH="$farm:$system_path"

# The retiring check for this whole script: if any of them resolves here, every
# golden captured would record a toolchain the checked-in ones do not have, and
# the suite would be red on every machine that does not have that one too.
for binary in "${absent[@]}"; do
  if which "$binary" >/dev/null 2>&1; then
    echo "capture-goldens: $binary resolves inside the sanitized PATH ($PATH)" >&2
    echo "capture-goldens: the golden toolchain is the one that has none of it" >&2
    exit 1
  fi
done

cd "$repo_root"

if [[ $mode == capture ]]; then
  echo "capture-goldens: pass 1 — the scans write report.json, and their own markdown"
  CRANK_CAPTURE_GOLDENS=1 npx vitest run \
    test/scan.test.ts \
    test/py-scan.test.ts \
    test/cs-scan.test.ts \
    test/sec-scan.test.ts \
    test/mono-scan.test.ts \
    test/pr-scan.test.ts

  echo "capture-goldens: pass 2 — the renderers write report.md and agent.md"
  CRANK_CAPTURE_GOLDENS=1 npx vitest run test/report-md.test.ts test/agent-md.test.ts
fi

echo "capture-goldens: verifying the whole suite against the goldens"
npm test
