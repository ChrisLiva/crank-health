/**
 * The determinism contract in executable form (spec §6): two runs of the same
 * crank-health on the same commit differ only in how long they took and where
 * the repo happened to be checked out. Everything else must be byte-identical,
 * so those two things — and only those two — are normalized away here.
 */
export function normalizeReport(json: string): string {
  const report: Record<string, unknown> = JSON.parse(json)
  delete report['timings']
  const repo = report['repo'] as { path: string } | undefined
  if (repo !== undefined) repo.path = '<repo>'
  return `${JSON.stringify(report, null, 2)}\n`
}
