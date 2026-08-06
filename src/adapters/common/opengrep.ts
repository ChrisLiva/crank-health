import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { languageOf } from '../../core/discover.ts'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  RunContext,
  Severity,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { verifiedVersion } from '../../manifest.ts'
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
import { OPENGREP_RULES } from './opengrep-rules.ts'
import type { SystemToolSpec } from './system-tool.ts'
import { explainMissing, systemToolVersion } from './system-tool.ts'

/**
 * opengrep — the SAST engine (spec "Categories and tools"), running
 * crank-health's own offline ruleset and nothing else.
 *
 * **The license rule, in code.** The plan's retiring check for "semgrep rules
 * license" is that no default invocation fetches registry packs. That is not a
 * policy here, it is the only reachable behaviour: {@link invocationArgs} always
 * passes `--config <scratch>/crank-health-rules.yaml`, the ruleset is a string
 * constant compiled into the binary, and there is no code path — and no CLI flag
 * on crank-health's own surface — that can put `auto`, a `p/…` pack or a URL
 * into that argument. Registry packs are deferred to a post-v1 opt-in.
 *
 * **Rule ids.** opengrep namespaces every `check_id` with the path of the file
 * the rule came from, and that path is the scratch dir — a different string on
 * every run and every machine. {@link ruleOf} strips it, which is what keeps
 * finding ids reproducible (spec §6).
 */

export const OPENGREP_TOOL = 'opengrep'

export const OPENGREP: SystemToolSpec = {
  binary: 'opengrep',
  versionArgs: ['--version'],
  install: 'brew install opengrep, or see https://github.com/opengrep/opengrep#installation',
}

/** Where the bundled ruleset is materialized, under the scratch dir. */
const RULES_DIRECTORY = 'opengrep'
const RULES_FILE = 'crank-health-rules.yaml'

/**
 * opengrep's severities, mapped to ours (spec §2). `critical` is never produced
 * here: it is reserved for leaked secrets, which are gitleaks' department, and
 * spec §3 turns a single one of those into an F.
 */
const SEVERITIES: Readonly<Record<string, Severity>> = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
}

export const opengrepRunner: ToolRunner = {
  tool: OPENGREP_TOOL,
  category: 'security',
  // Not a pin crank-health can enforce; see `SYSTEM_TOOL_MANIFEST`.
  pinnedVersion: verifiedVersion('opengrep'),
  // A SAST engine, a secrets scanner and a dependency scanner do not substitute
  // for one another; see `ToolRunner.complementary`.
  complementary: true,
  // Always our ruleset, so always `default-config`. A repo that carries its own
  // semgrep/opengrep rules keeps running them itself — adopting them here would
  // mean grading a repo against rules crank-health never validated, and is the
  // deferred half of the registry-pack question.
  detect: (): Promise<Detection | null> => Promise.resolve(null),
  run: runOpengrep,
}

async function runOpengrep(ctx: RunContext): Promise<ToolResult> {
  const sources = ctx.files.filter((file) => languageOf(file) !== undefined)
  if (sources.length === 0) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      // See `bandit.ts`'s `NOTHING_TO_SCAN`: nothing scanned is not a clean bill.
      reason: 'no JavaScript, TypeScript or Python files, so opengrep assessed nothing',
    }
  }

  const rules = await materializeRules(ctx.scratch)
  const batches = batchFiles(sources.map((file) => join(ctx.repoRoot, file)))
  const rawFiles: string[] = []
  const results: OpengrepResult[] = []

  for (const [index, batch] of batches.entries()) {
    const suffix = batches.length === 1 ? '' : `.${index + 1}`
    // Sequential by design: the orchestrator supplies the parallelism, and the
    // batches share the raw-output namespace.
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(
      systemCommand(OPENGREP.binary, invocationArgs(rules, batch)),
      // opengrep writes nothing but its report, and that goes to stdout; the
      // scratch cwd is the standing guarantee that it could not write into the
      // repo even if that changed.
      { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs },
    )

    // Nothing is staged for a process that never started: an empty
    // `opengrep.json` next to the report would read as "scanned, found
    // nothing", which is the opposite of `not-available`.
    if (execution.stdout.trim().length > 0) {
      // Sanitized before it is staged; see {@link sanitizeRawJson}.
      // eslint-disable-next-line no-await-in-loop
      const staged = await writeScratchRaw(
        ctx.scratch,
        `opengrep${suffix}.json`,
        sanitizeRawJson(execution.stdout),
      )
      rawFiles.push(staged)
    }
    if (execution.stderr.trim().length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const stderr = await writeScratchRaw(
        ctx.scratch,
        `opengrep${suffix}.stderr.txt`,
        execution.stderr,
      )
      rawFiles.push(stderr)
    }

    if (execution.failure !== undefined) {
      const failure = explainMissing(OPENGREP, execution.failure)
      return { state: failure.state, findings: [], rawFiles, reason: failure.reason }
    }

    try {
      results.push(...parseOpengrepJson(execution.stdout))
    } catch (error) {
      return {
        state: 'error',
        findings: [],
        rawFiles,
        reason:
          `could not parse opengrep output (exit ${execution.exitCode ?? 'signal'}): ` +
          `${error instanceof Error ? error.message : String(error)}${
            execution.stderr.trim().length === 0 ? '' : ` — ${firstLine(execution.stderr)}`
          }`,
      }
    }
  }

  const analyzed = new Set(ctx.files)
  const version = await systemToolVersion(OPENGREP, ctx.scratch, ctx.timeoutMs)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(results, ctx.repoRoot).filter((finding) => analyzed.has(finding.file)),
    ),
    ...(version === undefined ? {} : { toolVersion: version }),
    rawFiles,
  }
}

/**
 * The command line, exported so the license check can read it without running
 * anything: `--config` is the only rule source, and it is always a local file.
 *
 * `--disable-version-check` stops the phone-home on startup. opengrep has no
 * metrics flag to turn off because, unlike semgrep, it collects none —
 * verified against `opengrep scan --help` for the version in the manifest.
 */
export function invocationArgs(rulesFile: string, targets: readonly string[]): string[] {
  return ['scan', '--config', rulesFile, '--json', '--disable-version-check', '--quiet', ...targets]
}

/** Writes the bundled ruleset into scratch and returns its path. */
export async function materializeRules(scratch: string): Promise<string> {
  const directory = join(scratch, RULES_DIRECTORY)
  await mkdir(directory, { recursive: true })
  const target = join(directory, RULES_FILE)
  await writeFile(target, OPENGREP_RULES, 'utf8')
  return target
}

/** One opengrep match, in the fields we report on. */
export interface OpengrepResult {
  /** Rule id with opengrep's path prefix already stripped; see {@link ruleOf}. */
  readonly rule: string
  readonly file: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
  readonly message: string
  /** `ERROR`, `WARNING` or `INFO`, as opengrep spells it. */
  readonly severity: string
}

/**
 * Parses `opengrep scan --json`. Exported so a format shift fails a test
 * instead of reporting a repo with no security findings (plan M6 checks).
 *
 * @throws {Error} when the payload is not opengrep's result envelope
 */
export function parseOpengrepJson(stdout: string): OpengrepResult[] {
  if (stdout.trim().length === 0) return []
  const document = asRecord(JSON.parse(stdout))
  const results = asArray(document?.['results'])
  if (results === undefined) throw new Error('opengrep output has no results array')

  return results.flatMap((entry) => {
    const result = asRecord(entry)
    const checkId = asString(result?.['check_id'])
    const file = asString(result?.['path'])
    if (checkId === undefined || file === undefined) return []

    const start = asRecord(result?.['start'])
    const end = asRecord(result?.['end'])
    const extra = asRecord(result?.['extra'])
    const startLine = asNumber(start?.['line']) ?? 1
    const startCol = asNumber(start?.['col']) ?? 1
    return [
      {
        rule: ruleOf(checkId),
        file,
        startLine,
        startCol,
        endLine: asNumber(end?.['line']) ?? startLine,
        endCol: asNumber(end?.['col']) ?? startCol,
        message: (asString(extra?.['message']) ?? '').trim(),
        severity: asString(extra?.['severity']) ?? 'INFO',
      } satisfies OpengrepResult,
    ]
  })
}

/**
 * opengrep's raw JSON with every `extra.lines` source excerpt replaced —
 * opengrep quotes the line it matched, and a security scanner's matched line is
 * exactly the one worth not copying into the run directory. See
 * {@link sanitizeRawResults}.
 */
export function sanitizeRawJson(stdout: string): string {
  return sanitizeRawResults(stdout, (result) => {
    const extra = asRecord(result['extra'])
    return extra === undefined || extra['lines'] === undefined
      ? result
      : { ...result, extra: { ...extra, lines: OMITTED } }
  })
}

/**
 * The rule id, with opengrep's file-path namespace removed.
 *
 * A rule loaded from `/tmp/crank-health-xyz/opengrep/rules.yaml` comes back as
 * `tmp.crank-health-xyz.opengrep.rules.js-eval-call`. The scratch dir is
 * different on every run, so leaving that prefix in place would make finding
 * ids differ between two scans of the same commit — the one thing spec §6
 * forbids. Rule ids in the bundled set contain no dot, which is what makes the
 * last segment the whole id; `opengrep-rules.ts` documents that constraint and
 * a test enforces it.
 */
export function ruleOf(checkId: string): string {
  return checkId.slice(checkId.lastIndexOf('.') + 1)
}

/**
 * Matches → the core's vocabulary. Every finding is graded: this ruleset was
 * written to contain only patterns that are wrong on their own terms, so there
 * is no style tier to hold back (spec §1's "only correctness-class rules count
 * on a default config" is satisfied by the ruleset, not by a filter).
 *
 * Provenance is always `default-config` — these are crank-health's rules, not
 * the repo's, and the report says so.
 */
export function toPendingFindings(
  results: readonly OpengrepResult[],
  repoRoot = '',
): PendingFinding[] {
  return results
    .map((result) => ({
      category: 'security' as const,
      tool: OPENGREP_TOOL,
      rule: result.rule,
      severity: SEVERITIES[result.severity] ?? ('info' as const),
      file: repoRelative(result.file, repoRoot),
      range: {
        startLine: result.startLine,
        startCol: result.startCol,
        endLine: result.endLine,
        endCol: result.endCol,
      },
      message: result.message,
      provenance: 'default-config' as const,
      gradeScope: true,
    }))
    .toSorted(byLocation)
}
