import { execTool, repoCommand, uvxCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedPythonVersion } from '../../manifest.ts'
import { byLocation, failed, firstLine, identify, repoRelative } from '../support.ts'
import { detectPythonTool } from './py-project.ts'

/**
 * vulture — the Python dead-code detector (spec "Categories and tools").
 *
 * vulture reports a confidence with every result, and spec §3 grades only the
 * high-confidence tier: at or above {@link GRADED_CONFIDENCE} a finding counts,
 * between {@link MIN_CONFIDENCE} and that it is advisory. In practice that
 * splits vulture's own catalogue in two — unused imports (90%) and unreachable
 * code (100%) are graded, while an unused function or variable (60%) is not,
 * because vulture resolves names textually and cannot see a call made through a
 * framework, a decorator or `getattr`.
 */

const VULTURE_TOOL = 'vulture'

/** PyPI distribution; vulture's command and distribution names coincide. */
const VULTURE_DISTRIBUTION = 'vulture'

/** `pyproject.toml` sections that make vulture repo-owned. */
const VULTURE_SECTIONS: readonly string[] = ['tool.vulture']

/** The lowest confidence we ask vulture for at all (spec: "60% advisory"). */
export const MIN_CONFIDENCE = 60

/** At or above this confidence a finding counts toward the grade (spec §3). */
export const GRADED_CONFIDENCE = 90

/**
 * Flags shared by every invocation. vulture only ever reads — it has no writing
 * mode and no cache — so zero footprint (spec §7) needs nothing but the file
 * list, which is already gitignore-filtered and free of virtualenvs.
 */
const BASE_ARGS: readonly string[] = ['--min-confidence', String(MIN_CONFIDENCE)]

/** vulture exits 0 with nothing to report and 3 when it found dead code. */
const EXPECTED_EXIT_CODES: ReadonlySet<number> = new Set([0, 3])

export const vultureRunner: ToolRunner = {
  tool: VULTURE_TOOL,
  category: 'dead-code',
  pinnedVersion: pinnedPythonVersion(VULTURE_DISTRIBUTION),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: [],
      distribution: VULTURE_DISTRIBUTION,
      sections: VULTURE_SECTIONS,
    }),
  run: runVulture,
}

async function runVulture(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no Python files' }
  }

  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : uvxCommand(VULTURE_DISTRIBUTION, [])

  // One invocation for the whole file list: vulture decides that a name is dead
  // by finding no *other* file that uses it, so splitting the list would invent
  // dead code at the seams.
  const execution = await execTool(
    { ...command, args: [...command.args, ...BASE_ARGS, ...ctx.files] },
    { cwd: ctx.repoRoot, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'vulture.txt', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'vulture.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return failed(execution.failure, rawFiles)
  }
  if (execution.exitCode === undefined || !EXPECTED_EXIT_CODES.has(execution.exitCode)) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `vulture failed (exit ${execution.exitCode ?? 'signal'}): ${
        firstLine(execution.stderr) || firstLine(execution.stdout)
      }`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(
        parseVulture(execution.stdout, ctx.repoRoot),
        ctx.detection !== null,
      ).filter((finding) => analyzed.has(finding.file)),
    ),
    toolVersion: pinnedPythonVersion(VULTURE_DISTRIBUTION),
    rawFiles,
  }
}

/** One vulture result line. */
export interface VultureResult {
  readonly file: string
  readonly line: number
  /** What kind of thing is unused, e.g. `unused import`, `unreachable code`. */
  readonly kind: string
  /** The symbol vulture named, `''` for results that name none. */
  readonly symbol: string
  readonly confidence: number
}

/**
 * vulture has no machine-readable output, so its one-line text form is the
 * contract:
 *
 * ```
 * pkg/mod.py:12: unused function 'handler' (60% confidence)
 * pkg/mod.py:20: unreachable code after 'return' (100% confidence)
 * ```
 *
 * Exported so an output-format shift fails a test instead of reporting a repo
 * with no dead code at all (plan M5 checks).
 */
export function parseVulture(stdout: string, repoRoot = ''): VultureResult[] {
  return stdout.split('\n').flatMap((raw) => {
    const match = LINE_PATTERN.exec(raw.trimEnd())
    const groups = match?.groups
    if (groups === undefined) return []
    return [
      {
        file: repoRelative(groups['file'] ?? '', repoRoot),
        line: Number(groups['line']),
        kind: (groups['kind'] ?? '').trim(),
        symbol: groups['symbol'] ?? '',
        confidence: Number(groups['confidence']),
      } satisfies VultureResult,
    ]
  })
}

/**
 * `<file>:<line>: <description> (<n>% confidence)`, where the description is a
 * kind and — for everything but unreachable code — a quoted symbol name.
 */
const LINE_PATTERN =
  /^(?<file>.+?):(?<line>\d+): (?<kind>[a-z ]+?)(?: '(?<symbol>[^']*)')?(?: after '[^']*')? \((?<confidence>\d+)% confidence\)$/

/**
 * vulture results → the core's vocabulary, with spec §3's confidence tiers
 * applied through `gradeScope` and severity:
 *
 * - **≥ 90%** — graded, `warning`. vulture is sure: an import nothing in the
 *   analyzed set references, or code after a `return`.
 * - **60–89%** — advisory, `info`. Reported so a reader can judge, never graded,
 *   because a name-based analysis cannot see dynamic use.
 *
 * The symbol name is the anchor, so a dead function keeps its identity when the
 * lines above it move (spec §2). Results that name no symbol (unreachable code)
 * anchor on the flagged line instead, which is what the core does by default.
 */
export function toPendingFindings(
  results: readonly VultureResult[],
  repoConfig: boolean,
): PendingFinding[] {
  return results
    .map((result) => ({
      category: 'dead-code' as const,
      tool: VULTURE_TOOL,
      rule: `vulture/${result.kind.replaceAll(' ', '-')}`,
      severity: result.confidence >= GRADED_CONFIDENCE ? ('warning' as const) : ('info' as const),
      file: result.file,
      range: { startLine: result.line, startCol: 1, endLine: result.line, endCol: 1 },
      message:
        `${sentenceCase(result.kind)}${result.symbol === '' ? '' : ` \`${result.symbol}\``} ` +
        `(${result.confidence}% confidence)`,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: result.confidence >= GRADED_CONFIDENCE,
      ...(result.symbol === '' ? {} : { anchor: result.symbol }),
    }))
    .toSorted(byLocation)
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
}
