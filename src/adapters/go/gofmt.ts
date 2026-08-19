import { posix } from 'node:path'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type { PendingFinding, RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import {
  batchFiles,
  byLocation,
  firstLine,
  identify,
  repoRelative,
  underProject,
} from '../support.ts'
import { MINIMUM_GO_MINOR, goExecOptions, withGoGate } from './go-toolchain.ts'

/**
 * `gofmt -l` — the Go formatter check (spec "Categories and tools").
 *
 * `gofmt` has no configuration at all: there is one canonical Go formatting and
 * every Go repo is held to it, so there is nothing to detect, nothing to own
 * and no `repo-config` provenance to report. That also means there is nothing
 * to pin — `gofmt` ships with the toolchain, is the machine's own, and reports
 * no version of its own, so the tool record's `version` stays null.
 *
 * `-l` *lists* the files whose formatting differs and writes not one byte;
 * `-w` is the flag that would rewrite them, and it is never passed (spec §7,
 * zero footprint). `go fmt`, which shells out to `gofmt -w`, is never invoked
 * anywhere in this adapter for the same reason.
 */

export const GOFMT_TOOL = 'gofmt'

/** The one rule id every formatting failure reports under. */
export const GOFMT_RULE = 'gofmt/unformatted'

/**
 * Not a pin crank-health can enforce — the formatter is the machine's Go
 * toolchain, and `go` is deliberately absent from `SYSTEM_TOOL_MANIFEST`
 * (it is the *fetcher* for every pinned Go analyzer). What can be stated is the
 * floor the gate holds it to.
 */
const GOFMT_FLOOR = `1.${MINIMUM_GO_MINOR}`

export const gofmtRunner: ToolRunner = {
  tool: GOFMT_TOOL,
  category: 'format',
  pinnedVersion: GOFMT_FLOOR,
  // gofmt has no config, so there is no ownership to detect — and detection
  // never spawns. Every run is Go's one canonical formatting.
  detect: () => Promise.resolve(null),
  run: withGoGate(runGofmt),
}

async function runGofmt(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Go files' }
  }

  const options = goExecOptions(ctx)
  // gofmt runs in the project's own directory (the gate asked about that
  // directory, and a `go.mod` toolchain directive is answered there), so the
  // paths it is given — and the ones it echoes back — are the project's, not
  // the repo's. The root project is the identity case for both conversions.
  const project = ctx.project.path
  const batches = batchFiles(
    ctx.files.map((file) => (project === '.' ? file : posix.relative(project, file))),
  )
  const failing: string[] = []
  const rawFiles: string[] = []

  for (const [index, batch] of batches.entries()) {
    const suffix = batches.length === 1 ? '' : `.${index + 1}`
    // Sequential by design: the orchestrator provides the parallelism.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(systemCommand(GOFMT_TOOL, gofmtArgs(batch)), options)

    // eslint-disable-next-line no-await-in-loop
    rawFiles.push(await writeScratchRaw(ctx.scratch, `gofmt${suffix}.txt`, execution.stdout))

    if (execution.failure !== undefined) {
      return {
        state: execution.failure.state,
        findings: [],
        rawFiles,
        reason: execution.failure.reason,
      }
    }
    // `gofmt -l` exits 0 whether or not it listed anything; a non-zero exit is
    // gofmt itself failing (an unparseable file), never a finding.
    if (execution.exitCode !== 0) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `gofmt failed (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
      }
    }

    failing.push(...parseListed(execution.stdout).map((file) => underProject(project, file)))
  }

  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, toPendingFindings(failing)),
    rawFiles,
    // The `format` denominator (spec §3: "% files failing"): every path handed
    // to this runner is Go source, and gofmt checks all of them.
    metrics: { formattableFiles: ctx.files.length },
  }
}

/**
 * The command line: `-l` and an explicit file list, never a directory.
 *
 * A directory argument would make gofmt walk it itself — picking up the
 * vendored dependencies and generated files discovery deliberately excluded,
 * and reporting a repo as badly formatted for code it did not write. The file
 * list the orchestrator handed this runner is the scan's file set, and it is
 * the only set gofmt is ever pointed at.
 */
export function gofmtArgs(files: readonly string[]): string[] {
  return ['-l', ...files]
}

/**
 * Parses `-l` output: one path per line, relative to the directory gofmt ran
 * in — which is the project's, and it was handed repo-relative paths, so the
 * paths come back exactly as they went in. Blank lines are ignored. Exported so
 * an output-format shift fails a test instead of silently reporting a perfectly
 * formatted repo.
 */
export function parseListed(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => repoRelative(line))
}

/**
 * Listed paths → the core's vocabulary: one finding per file, because
 * "unformatted" is a property of the file and not of a line. The explicit empty
 * anchor keeps identity at `(category, tool, rule, file)` — without it
 * `identify` would read the source and anchor a whole-file finding on line 1's
 * text, so the finding would churn on any edit to the file's first line.
 */
export function toPendingFindings(failing: readonly string[]): PendingFinding[] {
  return [...new Set(failing)]
    .map((file) => ({
      category: 'format' as const,
      tool: GOFMT_TOOL,
      rule: GOFMT_RULE,
      severity: 'warning' as const,
      file,
      range: { startLine: 1, startCol: 1, endLine: 1, endCol: 1 },
      message: 'File does not match gofmt’s formatting',
      // Never `repo-config`: gofmt has no configuration for a repo to own, so
      // every run is Go's one canonical formatting and says so.
      provenance: 'default-config' as const,
      gradeScope: true,
      anchor: '',
      fixHint: `gofmt -w ${file}`,
    }))
    .toSorted(byLocation)
}
