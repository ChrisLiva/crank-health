import { join } from 'node:path'
import { execTool, systemCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  Detection,
  PendingFinding,
  RepoContext,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { verifiedVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  identify,
  readJson,
  repoRelative,
} from '../support.ts'
import type { SystemToolSpec } from './system-tool.ts'
import { systemToolFailure, systemToolVersion } from './system-tool.ts'

/**
 * gitleaks — the secrets scanner (spec "Categories and tools").
 *
 * **A secret is an F.** Spec §3's absolute security shape says "any secret or
 * critical → F", so every gitleaks finding is `critical` and every one of them
 * is graded. There is no advisory tier here and there should not be: a
 * credential in the working tree is either committed or one `git add` away from
 * it, and the only remedy is to rotate it.
 *
 * **crank-health never handles the secret.** gitleaks runs under
 * {@link REDACT_ARG}, so the value never leaves its process — not into our
 * memory, not into `raw/gitleaks.json`, not into a finding. The anchor is the
 * rule id, the message names the rule, and a reader is told where to look
 * rather than what was found. Redaction is also what keeps the run directory
 * safe to attach to a ticket.
 */

export const GITLEAKS_TOOL = 'gitleaks'

export const GITLEAKS: SystemToolSpec = {
  binary: 'gitleaks',
  versionArgs: ['version'],
  install: 'brew install gitleaks, or see https://github.com/gitleaks/gitleaks#installing',
}

/** The repo's own rules and allowlists, when it has them (spec §1). */
export const GITLEAKS_CONFIG_FILES: readonly string[] = ['.gitleaks.toml']

/**
 * Redaction, at 100%. gitleaks replaces both `Secret` and `Match` with
 * `REDACTED` before it writes anything, which is the property this whole runner
 * is built around — see the file comment.
 */
const REDACT_ARG = '--redact=100'

/** Where gitleaks writes its report, under the scratch dir. */
const REPORT_FILE = 'gitleaks.json'

export const gitleaksRunner: ToolRunner = {
  tool: GITLEAKS_TOOL,
  category: 'security',
  // Not a pin crank-health can enforce; see `SYSTEM_TOOL_MANIFEST`.
  pinnedVersion: verifiedVersion('gitleaks'),
  // Secrets are nobody else's job: no other security runner looks for them, so
  // a repo owning bandit or osv-scanner must not stand this one down.
  complementary: true,
  detect: detectGitleaks,
  run: runGitleaks,
}

/**
 * Repo-owned when `.gitleaks.toml` is present — gitleaks picks that file up on
 * its own, so ownership here is a provenance tag rather than a different
 * command line. There is no dependency half to this check: gitleaks is a binary
 * no manifest declares.
 */
function detectGitleaks(repo: RepoContext): Promise<Detection | null> {
  const configFiles = GITLEAKS_CONFIG_FILES.filter((file) => repo.files.all.includes(file))
  return Promise.resolve(
    configFiles.length === 0 ? null : { reason: 'config', configFiles, installed: true },
  )
}

async function runGitleaks(ctx: RunContext): Promise<ToolResult> {
  const report = join(ctx.scratch, REPORT_FILE)
  const execution = await execTool(
    systemCommand(GITLEAKS.binary, invocationArgs(ctx.repoRoot, report)),
    // Nothing gitleaks writes is relative to its cwd, but starting it outside
    // the repo means a future flag we get wrong cannot land inside one.
    { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles: string[] = []
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'gitleaks.stderr.txt', execution.stderr))
  }
  if (execution.failure !== undefined) {
    return systemToolFailure(GITLEAKS, { ...execution, failure: execution.failure }, rawFiles)
  }

  const document = await readJson(report)
  if (document === undefined) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `gitleaks wrote no report (exit ${execution.exitCode ?? 'signal'})`,
    }
  }
  rawFiles.unshift(
    await writeScratchRaw(ctx.scratch, REPORT_FILE, `${JSON.stringify(document, null, 2)}\n`),
  )

  let leaks: GitleaksLeak[]
  try {
    leaks = parseGitleaksReport(document, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse gitleaks output: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Discovery's file set, and only it: a leak in a gitignored file is a real
  // leak, but it is not in the codebase crank-health is grading, and every
  // other runner draws the line in the same place (spec §7). Consistency here
  // is worth more than one extra finding — an inconsistent inventory would make
  // the delta and the per-language breakdown disagree with themselves.
  const analyzed = new Set(ctx.files)
  const version = await systemToolVersion(GITLEAKS, ctx.scratch, ctx.timeoutMs)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(leaks, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    ...(version === undefined ? {} : { toolVersion: version }),
    rawFiles,
  }
}

/**
 * The command line, exported so tests can assert its shape without running
 * gitleaks. `dir` is the working-tree scan (the repo's history is out of scope
 * for a health report on a commit), `--exit-code 0` keeps "found a secret" from
 * looking like "gitleaks failed", and {@link REDACT_ARG} is the one flag this
 * runner cannot be correct without.
 *
 * The repo's `.gitleaks.toml` is not passed: gitleaks reads
 * `(target path)/.gitleaks.toml` itself, so the repo's rules apply when it has
 * them and the built-in rules apply when it does not.
 */
export function invocationArgs(repoRoot: string, report: string): string[] {
  return [
    'dir',
    '--no-banner',
    REDACT_ARG,
    '--report-format',
    'json',
    '--report-path',
    report,
    '--exit-code',
    '0',
    repoRoot,
  ]
}

/** One leak, as gitleaks reports it — with the secret already redacted. */
export interface GitleaksLeak {
  readonly ruleId: string
  readonly description: string
  readonly file: string
  readonly startLine: number
  readonly startColumn: number
  readonly endLine: number
  readonly endColumn: number
}

/**
 * Parses `gitleaks --report-format json`. Exported so a format shift fails a
 * test instead of reporting a repo with no secrets in it (plan M6 checks).
 *
 * The `Secret`, `Match` and `Entropy` fields are deliberately not read: under
 * {@link REDACT_ARG} the first two say `REDACTED`, and none of the three has any
 * business in a `Finding`.
 *
 * @throws {Error} when the payload is not gitleaks' array of leaks
 */
export function parseGitleaksReport(document: unknown, repoRoot = ''): GitleaksLeak[] {
  // gitleaks writes a bare `null` for a clean scan in some versions.
  if (document === null) return []
  const entries = asArray(document)
  if (entries === undefined) throw new Error('gitleaks output is not an array of leaks')

  return entries.flatMap((entry) => {
    const leak = asRecord(entry)
    const ruleId = asString(leak?.['RuleID'])
    const file = asString(leak?.['File'])
    if (ruleId === undefined || file === undefined) return []
    const startLine = asNumber(leak?.['StartLine']) ?? 1
    const startColumn = asNumber(leak?.['StartColumn']) ?? 1
    return [
      {
        ruleId,
        description: asString(leak?.['Description']) ?? '',
        file: repoRelative(file, repoRoot),
        startLine,
        startColumn,
        endLine: asNumber(leak?.['EndLine']) ?? startLine,
        endColumn: asNumber(leak?.['EndColumn']) ?? startColumn,
      } satisfies GitleaksLeak,
    ]
  })
}

/**
 * Leaks → the core's vocabulary. `critical` and graded, always: spec §3 makes a
 * secret an F on its own, under anybody's config.
 *
 * The anchor is the rule id, never the flagged source line — which is the line
 * *containing the secret*, and would put it into the fingerprint material and
 * from there into every report. Anchoring on the rule keeps identity stable
 * when the secret moves down the file, and a second leak of the same kind in
 * the same file becomes a second occurrence.
 */
export function toPendingFindings(
  leaks: readonly GitleaksLeak[],
  repoConfig: boolean,
): PendingFinding[] {
  return leaks
    .map((leak) => ({
      category: 'security' as const,
      tool: GITLEAKS_TOOL,
      rule: leak.ruleId,
      severity: 'critical' as const,
      file: leak.file,
      range: {
        startLine: leak.startLine,
        startCol: leak.startColumn,
        endLine: leak.endLine,
        endCol: leak.endColumn,
      },
      message:
        `Possible ${leak.ruleId.replaceAll('-', ' ')} committed to the repository` +
        `${leak.description === '' ? '' : ` — ${leak.description}`}`,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: true,
      anchor: leak.ruleId,
      fixHint:
        'Rotate the credential first, then remove it from the file and from git history ' +
        '(the value is redacted here on purpose — read it from the flagged line)',
    }))
    .toSorted(byLocation)
}
