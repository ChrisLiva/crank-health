import { join } from 'node:path'
import { languageOf } from '../../core/discover.ts'
import { execTool, repoCommand, uvxCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  DetectContext,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedPythonVersion } from '../../manifest.ts'
import { detectPythonTool } from '../python/py-project.ts'
import {
  OMITTED,
  asArray,
  asNumber,
  asRecord,
  asString,
  batchFiles,
  byLocation,
  firstLine,
  identify,
  repoRelative,
  sanitizeRawResults,
} from '../support.ts'

/**
 * bandit — the Python security linter (spec "Categories and tools": Python
 * security is "+ bandit, ruff `S`").
 *
 * **On overlapping with ruff's `S` rules.** ruff's `S` family is a port of
 * bandit's checks, so on a repo that selected them both tools report the same
 * class of problem. They are not deduplicated, by design: spec §1 says
 * "multiple tools detected for one category → run all, merge findings (tool is
 * in the fingerprint; grade on the union)", and the tool being in the
 * fingerprint is what keeps two reports of one problem from collapsing into a
 * silent one. The absolute security grade (spec §3) bands on the worst
 * severity, so a duplicate cannot inflate it.
 *
 * **Grading tiers.** bandit's own severity is the split: `HIGH` and `MEDIUM`
 * count toward the grade, `LOW` is advisory. Its low tier is mostly
 * "you imported subprocess" — true, and not a finding a repo should be graded
 * on. bandit reports a confidence alongside the severity, and its high tier at
 * anything below `HIGH` confidence is a guess worth reading, not a proven
 * problem: those become `warning`, still graded, never silenced. Only
 * `HIGH`/`HIGH` is an `error`.
 */

export const BANDIT_TOOL = 'bandit'

/** PyPI distribution; bandit's command and distribution names coincide. */
const BANDIT_DISTRIBUTION = 'bandit'

/** Config artifacts that make bandit repo-owned (spec §1, first check). */
const BANDIT_CONFIG_FILES: readonly string[] = ['.bandit', 'bandit.yaml', 'bandit.yml']

/** `pyproject.toml` sections that make bandit repo-owned. */
const BANDIT_SECTIONS: readonly string[] = ['tool.bandit']

/**
 * bandit's severities, mapped to ours (spec §2).
 *
 * Except for `HIGH`: it counts as `error` only at `HIGH` confidence — the gate
 * in {@link toPendingFindings} branches before this table, so the `HIGH` row
 * here documents the un-gated ceiling; below `HIGH` confidence it is `warning`.
 */
const SEVERITIES: Readonly<Record<string, Severity>> = {
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'info',
  UNDEFINED: 'info',
}

/** Severities that count toward the grade; see the file comment. */
const GRADED_SEVERITIES: ReadonlySet<Severity> = new Set(['error', 'warning'])

/**
 * bandit's hardcoded-secret tests: `B105` (string), `B106` (function argument),
 * `B107` (argument default). Their `issue_text` quotes the literal it found —
 * "Possible hardcoded password: 'hunter2'" — and a `message` goes into
 * `report.json`, `report.md` and `agent.md` verbatim.
 *
 * A secrets finding must never carry the secret; gitleaks is redacted at the
 * source (`--redact=100`) and bandit has no such flag, so {@link redactSecret}
 * is that flag. The reader is told where to look, not what was found.
 */
const SECRET_TEST_IDS: ReadonlySet<string> = new Set(['B105', 'B106', 'B107'])

/** The quoted literal in a message, either quoting style. */
const QUOTED_LITERAL = /(['"])(?:(?!\1).)*\1/g

/** What replaces it. */
const REDACTED = '<redacted>'

/**
 * What a common-adapter runner says when what it was given holds nothing of its
 * kind — and why that is `not-available` rather than `ok` with no findings.
 *
 * A category is `graded` as soon as one of its runners returns `ok`
 * (`aggregate` in the orchestrator). bandit finding nothing where there is no
 * Python is not evidence that the code is secure, and reporting it as `ok`
 * would put "security: A" on a JavaScript repo whose secrets scanner never ran.
 * The language runners have no such problem — their adapter only detects when
 * its language is present — but the `common` adapter runs against every repo,
 * so each of its runners has to say for itself whether it assessed anything.
 *
 * The sentence names no scope, because this runner has two: one job per project
 * where the repo has Python, and a single repo-spanning job where it has none
 * (`unitsFor` in the orchestrator). Which projects a row stands for is the tool
 * table's answer (`standInNote`), not a claim baked into the reason.
 */
const NOTHING_TO_SCAN = 'no Python files, so bandit assessed nothing'

/** bandit exits 0 with nothing to report and 1 when it found something. */
const EXPECTED_EXIT_CODES: ReadonlySet<number> = new Set([0, 1])

export const banditRunner: ToolRunner = {
  tool: BANDIT_TOOL,
  category: 'security',
  pinnedVersion: pinnedPythonVersion(BANDIT_DISTRIBUTION),
  // Python SAST does not substitute for a secrets or dependency scan; see
  // `ToolRunner.complementary`.
  complementary: true,
  // A repo with no Python is told `NOTHING_TO_SCAN` once, about itself, rather
  // than once per package; see `ToolRunner.languages`.
  languages: ['python'],
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: BANDIT_CONFIG_FILES,
      distribution: BANDIT_DISTRIBUTION,
      sections: BANDIT_SECTIONS,
    }),
  run: runBandit,
}

async function runBandit(ctx: RunContext): Promise<ToolResult> {
  const sources = ctx.files.filter((file) => languageOf(file) === 'python')
  if (sources.length === 0) {
    return { state: 'not-available', findings: [], rawFiles: [], reason: NOTHING_TO_SCAN }
  }

  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : uvxCommand(BANDIT_DISTRIBUTION, [])

  // An explicit file list rather than `-r <root>` with `-x` exclusions: the
  // list is already gitignore-true and free of virtualenvs, so the exclusion
  // patterns bandit would need cannot be got wrong (spec §7). bandit analyzes
  // each file on its own, so batching changes nothing about the result.
  const batches = batchFiles(sources.map((file) => join(ctx.repoRoot, file)))
  const rawFiles: string[] = []
  const issues: BanditIssue[] = []

  for (const [index, batch] of batches.entries()) {
    const suffix = batches.length === 1 ? '' : `.${index + 1}`
    // Sequential by design: the orchestrator supplies the parallelism.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(
      { ...command, args: [...command.args, ...INVOCATION_ARGS, ...batch] },
      { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs },
    )

    // Sanitized before it is staged, never after: `raw/` is copied into the run
    // directory verbatim, so this is the only place the excerpts can be dropped.
    // eslint-disable-next-line no-await-in-loop
    const staged = await writeScratchRaw(
      ctx.scratch,
      `bandit${suffix}.json`,
      sanitizeRawJson(execution.stdout),
    )
    rawFiles.push(staged)
    if (execution.stderr.trim().length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const stderr = await writeScratchRaw(
        ctx.scratch,
        `bandit${suffix}.stderr.txt`,
        execution.stderr,
      )
      rawFiles.push(stderr)
    }

    if (execution.failure !== undefined) {
      return {
        state: execution.failure.state,
        findings: [],
        rawFiles,
        reason: execution.failure.reason,
      }
    }
    if (execution.exitCode === undefined || !EXPECTED_EXIT_CODES.has(execution.exitCode)) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `bandit failed (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
      }
    }

    try {
      issues.push(...parseBanditJson(execution.stdout, ctx.repoRoot))
    } catch (error) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason: `could not parse bandit output: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(issues, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    toolVersion: pinnedPythonVersion(BANDIT_DISTRIBUTION),
    rawFiles,
  }
}

/**
 * Flags shared by every invocation. `-q` suppresses the progress chatter that
 * would otherwise land in stdout alongside the JSON; bandit has no cache and no
 * writing mode, so zero footprint needs nothing else.
 */
const INVOCATION_ARGS: readonly string[] = ['--format', 'json', '-q']

/** One bandit result, in the fields we report on. */
export interface BanditIssue {
  /** Test id, e.g. `B602`. */
  readonly testId: string
  readonly testName: string
  readonly file: string
  readonly line: number
  readonly endLine: number
  readonly column: number
  readonly endColumn: number
  readonly message: string
  /** `HIGH`, `MEDIUM`, `LOW`, `UNDEFINED`. */
  readonly severity: string
  readonly confidence: string
  /** bandit's documentation link for the test. */
  readonly moreInfo: string
}

/**
 * Parses `bandit --format json`. Exported so a format shift fails a test
 * instead of reporting a repo with no security problems (plan M6 checks).
 *
 * @throws {Error} when the payload is not bandit's result envelope
 */
export function parseBanditJson(stdout: string, repoRoot = ''): BanditIssue[] {
  if (stdout.trim().length === 0) return []
  const document = asRecord(JSON.parse(stdout))
  const results = asArray(document?.['results'])
  if (results === undefined) throw new Error('bandit output has no results array')

  return results.flatMap((entry) => {
    const issue = asRecord(entry)
    const testId = asString(issue?.['test_id'])
    const file = asString(issue?.['filename'])
    if (testId === undefined || file === undefined) return []

    const line = asNumber(issue?.['line_number']) ?? 1
    const range = asArray(issue?.['line_range']) ?? []
    const column = (asNumber(issue?.['col_offset']) ?? 0) + 1
    return [
      {
        testId,
        testName: asString(issue?.['test_name']) ?? '',
        file: repoRelative(file, repoRoot),
        line,
        endLine: asNumber(range.at(-1)) ?? line,
        column,
        endColumn: (asNumber(issue?.['end_col_offset']) ?? 0) + 1,
        message: asString(issue?.['issue_text']) ?? '',
        severity: asString(issue?.['issue_severity']) ?? 'UNDEFINED',
        confidence: asString(issue?.['issue_confidence']) ?? 'UNDEFINED',
        moreInfo: asString(issue?.['more_info']) ?? '',
      } satisfies BanditIssue,
    ]
  })
}

/**
 * bandit issues → the core's vocabulary, with the severity tiers of the file
 * comment applied through `gradeScope`. On the repo's own bandit config every
 * finding is graded: they selected these tests and are failing them.
 */
export function toPendingFindings(
  issues: readonly BanditIssue[],
  repoConfig: boolean,
): PendingFinding[] {
  return issues
    .map((issue) => {
      const severity =
        issue.severity === 'HIGH'
          ? issue.confidence === 'HIGH'
            ? ('error' as const)
            : ('warning' as const)
          : (SEVERITIES[issue.severity] ?? ('info' as const))
      return {
        category: 'security' as const,
        tool: BANDIT_TOOL,
        rule: issue.testId,
        severity,
        file: issue.file,
        range: {
          startLine: issue.line,
          startCol: issue.column,
          endLine: issue.endLine,
          endCol: issue.endColumn,
        },
        message: `${redactSecret(issue.testId, issue.message)} (${issue.severity.toLowerCase()} severity, ${issue.confidence.toLowerCase()} confidence)`,
        provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
        gradeScope: repoConfig || GRADED_SEVERITIES.has(severity),
        ...(issue.moreInfo === '' ? {} : { fixHint: `see ${issue.moreInfo}` }),
      }
    })
    .toSorted(byLocation)
}

/**
 * The message with its quoted literal removed, for the tests that quote a
 * secret ({@link SECRET_TEST_IDS}).
 */
function redactSecret(testId: string, message: string): string {
  return SECRET_TEST_IDS.has(testId)
    ? message.replaceAll(QUOTED_LITERAL, (match) => `${match[0]}${REDACTED}${match[0]}`)
    : message
}

/**
 * bandit's raw JSON with every `code` excerpt replaced — bandit reports a
 * window of the flagged file around each finding, and a hardcoded credential
 * (its own `B105`, or one two lines from an unrelated `B602`) would otherwise
 * be copied into the run directory in full. See {@link sanitizeRawResults}.
 */
export function sanitizeRawJson(stdout: string): string {
  return sanitizeRawResults(stdout, 'results', (issue) =>
    issue['code'] === undefined ? issue : { ...issue, code: OMITTED },
  )
}
