import { execa } from 'execa'
import { meetsGoFloor, parseGoVersion } from '../../src/adapters/go/go-toolchain.ts'

/**
 * The three security tools crank-health can only use when the machine already
 * has them: gitleaks, opengrep and osv-scanner ship as release binaries with no
 * npm or PyPI distribution, so unlike every other tool they cannot be fetched.
 *
 * **Why the tests have to know.** The determinism contract is "same
 * crank-health version + same commit + *same repo toolchain* ⇒ byte-identical
 * report" (spec §6), and a machine with gitleaks installed is a different
 * toolchain. So the golden snapshots — which record a specific toolchain —
 * apply only when the machine's toolchain matches the one that recorded them,
 * which is what {@link TOOLCHAIN_BINARIES} and {@link GOLDEN_TOOLCHAIN} decide.
 * Everything that does not depend on the toolchain (byte-identity across two
 * runs, planted findings, zero footprint, and the parse tests over captured
 * bytes) is asserted unconditionally.
 */

export const SYSTEM_TOOLS = ['gitleaks', 'opengrep', 'osv-scanner'] as const

export type SystemToolName = (typeof SYSTEM_TOOLS)[number]

/**
 * Every binary whose presence on `PATH` makes a machine a different toolchain,
 * and therefore decides whether the checked-in goldens apply at all.
 *
 * It is the three above, plus `govulncheck` as a standalone binary: nothing
 * resolves it from `PATH` today — the runner fetches the pinned version with
 * `go run golang.org/x/vuln/cmd/govulncheck@…` — but an installed one would
 * flip `detection.installed` and change the reports, so it is listed with the
 * scanners rather than trusted to stay unused.
 *
 * `go` is deliberately *not* here. It is the Go adapter's fetcher and the
 * toolchain every Go analyzer runs on, so a machine without it grades no Go at
 * all: the goldens would then record eight `not-available` rows instead of the
 * Go adapter's work. Go is a *prerequisite* of the golden toolchain, asserted
 * by {@link GOLDEN_TOOLCHAIN} below, not a contaminant of it.
 *
 * `scripts/capture-goldens.sh` asserts the same list is unresolvable inside the
 * PATH it builds — and symlinks `go`/`gofmt` into it — so the recapture cannot
 * record a toolchain no one else has.
 */
const TOOLCHAIN_BINARIES = [...SYSTEM_TOOLS, 'govulncheck'] as const

/** Which of {@link SYSTEM_TOOLS} this machine has on `PATH`. */
export async function installedSystemTools(): Promise<Set<SystemToolName>> {
  const present = await Promise.all(
    SYSTEM_TOOLS.map(async (tool) => [tool, await onPath(tool)] as const),
  )
  return new Set(present.filter(([, found]) => found).map(([tool]) => tool))
}

/**
 * Whether this machine's `go` clears the floor the pinned Go analyzers need.
 *
 * The version line is read by the **imported** {@link parseGoVersion} and
 * {@link meetsGoFloor} — the same pair the Go gate itself uses — because two
 * copies of the floor rule is how a support file and the runtime gate come to
 * disagree about what `MINIMUM_GO_MINOR` means.
 */
async function goMeetsFloor(): Promise<boolean> {
  try {
    const { stdout } = await execa('go', ['version'])
    const version = parseGoVersion(stdout.split('\n')[0] ?? '')
    return version !== undefined && meetsGoFloor(version)
  } catch {
    return false
  }
}

/**
 * True when this machine resolves none of {@link TOOLCHAIN_BINARIES} **and**
 * has a Go toolchain at or above the floor — the toolchain the checked-in
 * goldens were recorded against.
 *
 * The conjunction is what makes the goldens honest about Go: a machine without
 * Go, or with a Go below `MINIMUM_GO_MINOR`, *skips* the golden
 * assertions rather than comparing a report its toolchain could not produce.
 */
export const GOLDEN_TOOLCHAIN =
  (await Promise.all(TOOLCHAIN_BINARIES.map((binary) => onPath(binary)))).every(
    (found) => !found,
  ) && (await goMeetsFloor())

/** Whether `binary` resolves on this machine's `PATH`. */
export async function onPath(binary: string): Promise<boolean> {
  try {
    await execa('which', [binary])
    return true
  } catch {
    return false
  }
}
