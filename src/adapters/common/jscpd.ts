import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EXCLUDED_SEGMENTS } from '../../core/discover.ts'
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
import { type RepoExcludes, readRepoExcludes } from '../jsts/repo-excludes.ts'
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

/**
 * The config artifacts that make jscpd repo-owned — detected, and never
 * applied. jscpd resolves a config from its *working directory*, which is the
 * scratch dir by design ({@link runJscpd}): a flag we got wrong cannot then
 * write into the target. The config it does read is ours, and has to be — it
 * carries {@link ignoreGlobs}, so a repo's own file in its place would lapse
 * the hidden-scope and anchoring rules and hand a repo `minTokens`, the one
 * knob that tunes a duplication grade to A.
 *
 * So detection decides which *binary* runs (the repo's installed jscpd over the
 * ephemeral one) and is reported under `Detection.ownedVia`, while every run
 * says `configOwned: false` — the settings that produced the number were ours.
 */
export const JSCPD_CONFIG_FILES: readonly string[] = ['.jscpd.json', '.jscpd.jsonc']

/** The one rule id every clone reports under. */
export const JSCPD_RULE = 'jscpd/duplicate-block'

/**
 * The formats jscpd is asked to look at: exactly the languages crank-health
 * grades. Left to itself jscpd also tokenizes JSON, YAML and Markdown, and a
 * lockfile's inevitable self-similarity would then drive the duplication grade
 * of a repo whose *code* is fine.
 */
const FORMATS = 'javascript,jsx,typescript,tsx,python,csharp,go'

/**
 * Directories excluded regardless of what the repo's `.gitignore` says. jscpd
 * honors `.gitignore` natively, which is most of spec §7's requirement; these
 * are the dependency and VCS directories a repo may have forgotten to ignore —
 * {@link EXCLUDED_SEGMENTS}, the same list discovery keeps out of the
 * inventory, so the measured set and the graded set cannot drift apart.
 *
 * A dot-directory glob carries discovery's hidden-scope rule across too, and
 * carries it further than discovery does: a glob list has no negation, so the
 * `.github/` discovery allows back in cannot be carved back in here.
 * Duplication inside `.github/scripts/` is therefore neither measured nor
 * reported — the percentage and the clones come from this one list, so the
 * report never shows a clone the percentage did not count — while discovery
 * still grades those files for every other category. That is the same class of
 * approximation {@link invocationArgs} records for jscpd's own walk.
 *
 * `bin/` and `obj/` are MSBuild output, and stay literal because discovery
 * covers them with a C#-only file rule rather than a segment. Here they are
 * language-blind — jscpd walks the tree itself instead of taking our
 * inventory, so it cannot ask what language a file is before descending. That
 * is the accepted trade: a JS package's `bin/cli.js` stays in the inventory but
 * out of the duplication measurement.
 *
 * `vendor/` is Go's copied module graph, and records the same trade for the
 * same reason: discovery drops it with a Go-only file rule, because `vendor/`
 * is authored source in a PHP or a JS repo, and here it cannot be — so a
 * `vendor/` of PHP stays in the inventory and out of the measurement.
 */
const IGNORE_GLOBS: readonly string[] = [
  ...EXCLUDED_SEGMENTS.map((segment) => `**/${segment}/**`),
  '**/.*/**',
  '**/bin/**',
  '**/obj/**',
  '**/vendor/**',
]

/**
 * Glob metacharacters in a literal path segment, backslash-escaped so the
 * anchoring prefix below matches the directory it names rather than a pattern.
 * A repo checked out to `~/src/br[ack]et/` would otherwise turn its own address
 * into a character class that matches nothing, and every ignore rule with it.
 */
function escapeGlob(literal: string): string {
  return literal.replace(/[\\*?[\]{}()!+@|^$]/g, String.raw`\$&`)
}

/**
 * Every glob rooted at the directory being measured. jscpd matches against the
 * absolute paths it walks, so an unanchored `**` reaches *upwards* as readily
 * as downwards: a repo living under `~/.cache/`, `.claude/worktrees/` or any
 * other hidden directory matches `**\/.*\/**` on a segment of its own address,
 * and jscpd then ignores the whole tree — 0% of tokens duplicated and a
 * flattering A for a repo it never looked at.
 *
 * Anchoring confines each rule to the tree it is about, and the prefix is
 * escaped because it is a literal path spliced into a pattern. The globs travel
 * in a config file rather than on `--ignore` for the last case escaping cannot
 * reach: jscpd splits that flag's value on `,`, so a single comma anywhere in
 * the repo's path would truncate every rule after it.
 *
 * Exported so the invocation tests can read the list without running anything.
 *
 * @param scanRoot absolute path of the directory to measure
 * @param nested repo-relative posix paths of the projects inside this one
 */
export function ignoreGlobs(scanRoot: string, nested: readonly string[] = []): string[] {
  const root = escapeGlob(scanRoot)
  return [...IGNORE_GLOBS, ...nested.map((project) => `${project}/**`)].map(
    (glob) => `${root}/${glob}`,
  )
}

/**
 * The repo's own excludes ({@link readRepoExcludes}), anchored the way every
 * other rule here is — but to the *repo root* rather than the scanned
 * directory, because that is what the patterns are relative to: a config above
 * a package configures the package, and its `gen/**` is the declaring
 * directory's. Anchoring is still what confines each rule to the repo, so a
 * checkout under a hidden or bracketed path cannot turn one into a rule about
 * its own address.
 *
 * Exported so the invocation tests can read the list without running anything.
 *
 * @param repoRoot absolute path of the repo the patterns are relative to
 * @param patterns repo-relative posix globs, already sorted and deduped
 */
export function inheritedIgnoreGlobs(repoRoot: string, patterns: readonly string[]): string[] {
  const root = escapeGlob(repoRoot)
  return patterns.map((pattern) => `${root}/${pattern}`)
}

/**
 * What the tool row says about a narrowed file set, or `undefined` when nothing
 * narrowed it. Two clauses, because they are two different facts: what was
 * inherited, and what could not be. A repo whose config crank-health cannot read
 * is measured as though it had none — the honest outcome, said out loud rather
 * than left to look like a config that excluded nothing.
 *
 * Exported so the wording is asserted without running jscpd.
 */
export function inheritanceNote(excludes: RepoExcludes): string | undefined {
  const clauses: string[] = []
  if (excludes.sources.length > 0) {
    clauses.push(
      `duplication excludes inherited from ${excludes.sources.map((source) => source.config).join(', ')}`,
    )
  }
  if (excludes.unreadable.length > 0) {
    clauses.push(
      `no duplication excludes inherited from ${excludes.unreadable.join(', ')}: not readable as JSON`,
    )
  }
  return clauses.length === 0 ? undefined : clauses.join('; ')
}

/** Where jscpd's own report lands, under the scratch dir. */
const REPORT_DIRECTORY = 'jscpd'
const REPORT_FILE = 'jscpd-report.json'

/** Where the ignore list is handed to jscpd, under the scratch dir. */
const CONFIG_FILE = 'jscpd.json'

/**
 * jscpd acknowledges `--config` on stderr. Kept out of the evidence directory:
 * it is an echo of a flag we passed rather than anything jscpd observed about
 * the repo, and keeping it would put a file whose only content is an absolute
 * scratch path into every run's raw output. Anything else jscpd says still
 * lands there verbatim.
 */
function withoutConfigEcho(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('Using config from '))
    .join('\n')
}

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
      configOwned: false,
      // See `bandit.ts`'s `NOTHING_TO_SCAN`: a repo with no source in it has no
      // duplication percentage, and "0%" would be a grade nobody measured.
      reason: 'no JavaScript, TypeScript, Python, C# or Go files, so jscpd measured nothing',
    }
  }

  const output = join(ctx.scratch, REPORT_DIRECTORY)
  const scanRoot = join(ctx.repoRoot, ctx.project.path)
  // The one thing a repo's own config gets to decide about its duplication
  // grade: which files are in it. See `repo-excludes.ts`.
  const excludes = await readRepoExcludes(ctx.repoRoot, ctx.project.path)
  // Scratch-confined, like every other write this runner makes.
  const config = join(ctx.scratch, CONFIG_FILE)
  await writeFile(
    config,
    JSON.stringify({
      ignore: [
        ...ignoreGlobs(scanRoot, ctx.nestedProjects ?? []),
        ...inheritedIgnoreGlobs(ctx.repoRoot, excludes.patterns),
      ],
    }),
    'utf8',
  )
  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : ephemeralCommand(JSCPD_PACKAGE, [])

  const execution = await execTool(
    {
      ...command,
      args: [...command.args, ...invocationArgs(scanRoot, output, config)],
    },
    // Started outside the repo: jscpd's default reporter writes `report/` into
    // the working directory, and `-o` is the flag that redirects it — but a
    // scratch cwd means even a flag we got wrong cannot land in the target.
    { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles: string[] = []
  const stderr = withoutConfigEcho(execution.stderr)
  if (stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'jscpd.stderr.txt', stderr))
  }

  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      configOwned: false,
      reason: execution.failure.reason,
    }
  }

  const document = await readJson(join(output, REPORT_FILE))
  if (document === undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      configOwned: false,
      // The filtered stderr: jscpd's config echo is line 1 of every run, and
      // reporting it here would state the flag we passed instead of why the
      // run failed — with a scratch path that changes on every run.
      reason: `jscpd wrote no report (exit ${execution.exitCode ?? 'signal'}): ${firstLine(stderr)}`,
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
      configOwned: false,
      reason: `could not parse jscpd output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const analyzed = new Set(ctx.files)
  const note = inheritanceNote(excludes)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(report.clones).filter((finding) => analyzed.has(finding.file)),
    ),
    ...(ctx.detection?.version === undefined
      ? { toolVersion: pinnedVersion(JSCPD_PACKAGE) }
      : { toolVersion: ctx.detection.version }),
    rawFiles,
    // Still ours: the thresholds and every other setting came from the config
    // above, and only the file set narrowed. `reason` is where the row says so.
    configOwned: false,
    ...(note === undefined ? {} : { reason: note }),
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
 * @param output directory jscpd's json report is written to
 * @param config path of the scratch config file carrying {@link ignoreGlobs}
 */
export function invocationArgs(scanRoot: string, output: string, config: string): string[] {
  return [
    '--reporters',
    'json',
    // Spec §7: without this jscpd writes `report/` into the working directory.
    '--output',
    output,
    '--format',
    FORMATS,
    // The ignore list travels here rather than on `--ignore`, whose value jscpd
    // splits on `,` — a comma in the repo's own path would truncate it.
    '--config',
    config,
    // Absolute names in the report; with relative ones jscpd resolves them
    // against its own cwd, which is the scratch dir, not the repo.
    '--absolute',
    '--no-colors',
    scanRoot,
  ]
}

/** Whether jscpd will look at this path at all — see {@link FORMATS}. */
function isAnalyzable(file: string): boolean {
  return /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|cs|go)$/i.test(file)
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
 *
 * `provenance` is the constant `default-config` and takes no parameter: the
 * scratch config always wins (see {@link JSCPD_CONFIG_FILES}), so a seam here
 * could only ever be set wrong.
 */
export function toPendingFindings(clones: readonly JscpdClone[]): PendingFinding[] {
  const provenance = 'default-config' as const
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
