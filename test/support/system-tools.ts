import { execa } from 'execa'

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
 * It is the three above *and Go's*. `go` is not a tool crank-health reports
 * under its own name — it is govulncheck's fetcher and its analyzer both
 * (`go run golang.org/x/vuln/cmd/govulncheck@…`) — so a machine that has it
 * analyzes a repo's Go modules for reachability and a machine that does not
 * degrades to `not-available` (`GO_ABSENT_REASON`). Two different, equally
 * correct reports, exactly like gitleaks: the goldens record the machine with
 * neither. `govulncheck` itself is listed for symmetry — nothing resolves it
 * from `PATH` today, and a machine that has one installed is still the machine
 * a future runner would use it on.
 *
 * `scripts/capture-goldens.sh` asserts the same list is unresolvable inside the
 * PATH it builds, so the recapture cannot record a toolchain no one else has.
 */
export const TOOLCHAIN_BINARIES = [...SYSTEM_TOOLS, 'go', 'govulncheck'] as const

/** Which of {@link SYSTEM_TOOLS} this machine has on `PATH`. */
export async function installedSystemTools(): Promise<Set<SystemToolName>> {
  const present = await Promise.all(
    SYSTEM_TOOLS.map(async (tool) => [tool, await onPath(tool)] as const),
  )
  return new Set(present.filter(([, found]) => found).map(([tool]) => tool))
}

/**
 * True when this machine resolves none of {@link TOOLCHAIN_BINARIES} — the
 * toolchain the checked-in goldens were recorded against.
 */
export const GOLDEN_TOOLCHAIN = (
  await Promise.all(TOOLCHAIN_BINARIES.map((binary) => onPath(binary)))
).every((found) => !found)

/** Whether `binary` resolves on this machine's `PATH`. */
export async function onPath(binary: string): Promise<boolean> {
  try {
    await execa('which', [binary])
    return true
  } catch {
    return false
  }
}
