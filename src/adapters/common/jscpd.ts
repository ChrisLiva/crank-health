import { join } from 'node:path'
import { execTool, ephemeralCommand, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
import { detectNodeTool } from '../jsts/node-package.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  firstLine,
  identify,
  readJson,
  repoRelative,
} from '../support.ts'

/**
 * jscpd — the duplication detector, for both languages at once (spec
 * "Categories and tools": "jscpd v5 (both languages)").
 *
 * **Where the grade comes from.** Spec §3 grades duplication on "jscpd token %",
 * a single whole-codebase ratio — so the grade is
 * {@link ToolMetrics.duplicationPercent}, and the clone findings are evidence,
 * not the measure. That split is deliberate: 40 findings from one 400-line
 * copy-paste and 40 findings scattered across a large repo are very different
 * healths, and only the percentage can tell them apart. Every clone finding is
 * therefore `gradeScope: false` — reported so a reader knows *where*, never
 * double-counted into a grade the percentage already decided.
 *
 * **Once per project, plus once over the repo** (`ToolRunner.repoWidePass`).
 * Each project's percentage is measured over that project's directory alone,
 * minus the projects nested inside it ({@link invocationArgs}), so it grades
 * what that project duplicated; a clone *between* two packages is in neither of
 * those measurements, which is what the repo-wide pass is for — its percentage
 * is the rollup's.
 */

export const JSCPD_TOOL = 'jscpd'

/** npm package and command name coincide. */
const JSCPD_PACKAGE = 'jscpd'

export const JSCPD_CONFIG_FILES: readonly string[] = ['.jscpd.json', '.jscpd.jsonc']

/** The one rule id every clone reports under. */
export const JSCPD_RULE = 'jscpd/duplicate-block'

/**
 * The formats jscpd is asked to look at: exactly the languages crank-health
 * grades. Left to itself jscpd also tokenizes JSON, YAML and Markdown, and a
 * lockfile's inevitable self-similarity would then drive the duplication grade
 * of a repo whose *code* is fine.
 */
const FORMATS = 'javascript,jsx,typescript,tsx,python,csharp'

/**
 * Directories excluded regardless of what the repo's `.gitignore` says. jscpd
 * honors `.gitignore` natively, which is most of spec §7's requirement; these
 * are the dependency and VCS directories a repo may have forgotten to ignore.
 *
 * `bin/` and `obj/` are MSBuild output. Unlike discovery's C#-only file rule,
 * these two are language-blind — jscpd walks the tree itself instead of taking
 * our inventory, so it cannot ask what language a file is before descending.
 * That is the accepted trade: a JS package's `bin/cli.js` stays in the
 * inventory but out of the duplication measurement.
 */
const IGNORE_GLOBS =
  '**/.git/**,**/node_modules/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/bin/**,**/obj/**'

/** Where jscpd's own report lands, under the scratch dir. */
const REPORT_DIRECTORY = 'jscpd'
const REPORT_FILE = 'jscpd-report.json'

export const jscpdRunner: ToolRunner = {
  tool: JSCPD_TOOL,
  category: 'duplication',
  pinnedVersion: pinnedVersion(JSCPD_PACKAGE),
  // Duplication between two projects belongs to neither of them; see the file
  // comment and `ToolRunner.repoWidePass`.
  repoWidePass: true,
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      configFiles: JSCPD_CONFIG_FILES,
      packageName: JSCPD_PACKAGE,
      binName: JSCPD_TOOL,
      manifestKeys: ['jscpd'],
    }),
  run: runJscpd,
}

async function runJscpd(ctx: RunContext): Promise<ToolResult> {
  const sources = ctx.files.filter(isAnalyzable)
  if (sources.length === 0) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      // See `bandit.ts`'s `NOTHING_TO_SCAN`: a repo with no source in it has no
      // duplication percentage, and "0%" would be a grade nobody measured.
      reason: 'no JavaScript, TypeScript, Python or C# files, so jscpd measured nothing',
    }
  }

  const output = join(ctx.scratch, REPORT_DIRECTORY)
  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : ephemeralCommand(JSCPD_PACKAGE, [])

  const execution = await execTool(
    {
      ...command,
      args: [
        ...command.args,
        ...invocationArgs(join(ctx.repoRoot, ctx.project.path), output, ctx.nestedProjects ?? []),
      ],
    },
    // Started outside the repo: jscpd's default reporter writes `report/` into
    // the working directory, and `-o` is the flag that redirects it — but a
    // scratch cwd means even a flag we got wrong cannot land in the target.
    { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles: string[] = []
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'jscpd.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }

  const document = await readJson(join(output, REPORT_FILE))
  if (document === undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `jscpd wrote no report (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
    }
  }
  rawFiles.unshift(
    await writeScratchRaw(ctx.scratch, REPORT_FILE, `${JSON.stringify(document, null, 2)}\n`),
  )

  let report: JscpdReport
  try {
    report = parseJscpdReport(document, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse jscpd output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(report.clones, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(ctx.detection?.version === undefined
      ? { toolVersion: pinnedVersion(JSCPD_PACKAGE) }
      : { toolVersion: ctx.detection.version }),
    rawFiles,
    metrics: { duplicationPercent: report.duplicationPercent },
  }
}

/**
 * The command line, exported so the license-and-footprint test can read it
 * without running anything.
 *
 * jscpd is handed a *directory* rather than the discovered file list, for one
 * blunt reason: with explicit file arguments it reports every clone with an
 * empty file name, so the findings would have nowhere to point. It honors
 * `.gitignore` itself, which puts its file set within a hair of discovery's,
 * and every clone is filtered against the discovered set afterwards — so a path
 * discovery excluded can never reach a report. The percentage is jscpd's own
 * over its own set; on a repo where those sets differ it is an approximation,
 * and a documented one.
 *
 * A project's nested projects are ignored rather than measured: handing jscpd a
 * directory means handing it everything under it, and a parent whose packages
 * live inside it would otherwise grade their code — and the clones *between*
 * them — as its own duplication. That measurement belongs to the repo-wide pass
 * alone, which passes no nested list.
 *
 * @param scanRoot absolute path of the directory to measure: the project's own,
 * or the repo root for the repo-wide pass
 * @param nested repo-relative posix paths of the projects inside this one
 */
export function invocationArgs(
  scanRoot: string,
  output: string,
  nested: readonly string[] = [],
): string[] {
  return [
    '--reporters',
    'json',
    // Spec §7: without this jscpd writes `report/` into the working directory.
    '--output',
    output,
    '--format',
    FORMATS,
    '--ignore',
    [IGNORE_GLOBS, ...nested.map((project) => `**/${project}/**`)].join(','),
    // Absolute names in the report; with relative ones jscpd resolves them
    // against its own cwd, which is the scratch dir, not the repo.
    '--absolute',
    '--no-colors',
    scanRoot,
  ]
}

/** Whether jscpd will look at this path at all — see {@link FORMATS}. */
function isAnalyzable(file: string): boolean {
  return /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|cs)$/i.test(file)
}

/** One clone pair, as jscpd reports it. */
export interface JscpdClone {
  readonly firstFile: string
  readonly firstStartLine: number
  readonly firstEndLine: number
  readonly secondFile: string
  readonly secondStartLine: number
  readonly secondEndLine: number
  readonly lines: number
  readonly tokens: number
  /** jscpd's format label, e.g. `javascript`, `python`. */
  readonly format: string
}

export interface JscpdReport {
  readonly clones: readonly JscpdClone[]
  /** Duplicated *tokens* as a percentage — the measure spec §3 grades on. */
  readonly duplicationPercent: number
}

/**
 * Parses `jscpd --reporters json`. Exported so a format shift fails a test
 * instead of reporting a repo with no duplication at all (plan M6 checks).
 *
 * `statistics.total.percentageTokens` is the token-based ratio; jscpd also
 * reports a line-based `percentage`, which is not what spec §3 grades on.
 *
 * @throws {Error} when the payload is not jscpd's report envelope
 */
export function parseJscpdReport(document: unknown, repoRoot = ''): JscpdReport {
  const report = asRecord(document)
  const total = asRecord(asRecord(report?.['statistics'])?.['total'])
  const percent = asNumber(total?.['percentageTokens'])
  if (report === undefined || percent === undefined) {
    throw new Error('jscpd output has no statistics.total.percentageTokens')
  }

  const duplicates = asArray(report['duplicates']) ?? []
  const clones = duplicates.flatMap((entry) => {
    const clone = asRecord(entry)
    const first = asRecord(clone?.['firstFile'])
    const second = asRecord(clone?.['secondFile'])
    const firstFile = asString(first?.['name'])
    const secondFile = asString(second?.['name'])
    if (firstFile === undefined || secondFile === undefined) return []
    return [
      {
        firstFile: repoRelative(firstFile, repoRoot),
        firstStartLine: asNumber(first?.['start']) ?? 1,
        firstEndLine: asNumber(first?.['end']) ?? 1,
        secondFile: repoRelative(secondFile, repoRoot),
        secondStartLine: asNumber(second?.['start']) ?? 1,
        secondEndLine: asNumber(second?.['end']) ?? 1,
        lines: asNumber(clone?.['lines']) ?? 0,
        tokens: asNumber(clone?.['tokens']) ?? 0,
        format: asString(clone?.['format']) ?? '',
      } satisfies JscpdClone,
    ]
  })

  return { clones, duplicationPercent: percent }
}

/**
 * Clone pairs → the core's vocabulary, one finding per *pair*: both sides
 * describe the same duplication, so reporting each of them would say the same
 * thing twice. The side that carries the finding is the one {@link byLocation}
 * — the module's one ordering rule — puts first *of those two*, decided within
 * the pair before the whole list is sorted, and its message names the other
 * side so nothing the twin said is lost.
 *
 * `gradeScope: false` on every one of them — see the file comment: the grade is
 * the percentage, and counting the clones too would grade the same duplication
 * twice. Severity is `warning`, since a duplicated block is a maintenance
 * hazard rather than a defect.
 *
 * The anchor names the *file* on the other side of the pair — not its line
 * range, which would put a line number back into an identity spec §2 defines as
 * range-free. A clone is identified by what it duplicates; a second clone
 * between the same two files is a second occurrence, which the core numbers.
 */
export function toPendingFindings(
  clones: readonly JscpdClone[],
  repoConfig: boolean,
): PendingFinding[] {
  const provenance = repoConfig ? ('repo-config' as const) : ('default-config' as const)
  return clones
    .map((clone) => {
      const first = {
        ...side(
          clone,
          clone.firstFile,
          clone.firstStartLine,
          clone.firstEndLine,
          clone.secondFile,
          {
            line: clone.secondStartLine,
            endLine: clone.secondEndLine,
          },
        ),
        provenance,
      }
      const second = {
        ...side(
          clone,
          clone.secondFile,
          clone.secondStartLine,
          clone.secondEndLine,
          clone.firstFile,
          { line: clone.firstStartLine, endLine: clone.firstEndLine },
        ),
        provenance,
      }
      return byLocation(first, second) <= 0 ? first : second
    })
    .toSorted(byLocation)
}

function side(
  clone: JscpdClone,
  file: string,
  startLine: number,
  endLine: number,
  twinFile: string,
  twin: { readonly line: number; readonly endLine: number },
): Omit<PendingFinding, 'provenance'> {
  return {
    category: 'duplication' as const,
    tool: JSCPD_TOOL,
    rule: JSCPD_RULE,
    severity: 'warning' as const,
    file,
    range: { startLine, startCol: 1, endLine, endCol: 1 },
    message:
      `${clone.lines} lines (${clone.tokens} tokens) duplicated from ` +
      `${twinFile}:${twin.line}-${twin.endLine}`,
    gradeScope: false,
    anchor: twinFile,
    fixHint: 'Extract the duplicated block into a shared function or module',
  }
}
