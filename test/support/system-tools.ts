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
 * apply only when the machine's toolchain matches the one that recorded them.
 * Everything that does not depend on the toolchain (byte-identity across two
 * runs, planted findings, zero footprint, and the parse tests over captured
 * bytes) is asserted unconditionally.
 */

export const SYSTEM_TOOLS = ['gitleaks', 'opengrep', 'osv-scanner'] as const

export type SystemToolName = (typeof SYSTEM_TOOLS)[number]

/** Which of {@link SYSTEM_TOOLS} this machine has on `PATH`. */
export async function installedSystemTools(): Promise<Set<SystemToolName>> {
  const present = await Promise.all(
    SYSTEM_TOOLS.map(async (tool) => [tool, await onPath(tool)] as const),
  )
  return new Set(present.filter(([, found]) => found).map(([tool]) => tool))
}

/**
 * True when no release-binary tool is installed — the toolchain the checked-in
 * goldens were recorded against.
 */
export const GOLDEN_TOOLCHAIN = (await installedSystemTools()).size === 0

async function onPath(binary: string): Promise<boolean> {
  try {
    await execa('which', [binary])
    return true
  } catch {
    return false
  }
}
