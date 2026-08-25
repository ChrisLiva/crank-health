import { join } from 'node:path'
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
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'

/**
 * zizmor — the GitHub Actions auditor (spec "Categories and tools").
 *
 * **When there is nothing to audit.** Most repos have no workflows at all, and
 * zizmor then reports `not-available` rather than `ok` with no findings — see
 * `bandit.ts`'s `NOTHING_TO_SCAN`. "There were no GitHub Actions to get wrong"
 * is not evidence about a repo's security, and a category is graded the moment
 * one of its runners returns `ok`.
 */

const ZIZMOR_TOOL = 'zizmor'

/** PyPI distribution; zizmor's command and distribution names coincide. */
const ZIZMOR_DISTRIBUTION = 'zizmor'

/** Config artifacts that make zizmor repo-owned (spec §1, first check). */
const ZIZMOR_CONFIG_FILES: readonly string[] = ['.github/zizmor.yml', 'zizmor.yml']

/** `pyproject.toml` sections that make zizmor repo-owned. */
const ZIZMOR_SECTIONS: readonly string[] = ['tool.zizmor']

/**
 * The inputs zizmor audits: workflow definitions and composite actions. Handing
 * it the discovered paths — rather than the repo root — is what keeps a
 * gitignored or vendored workflow out of the report (spec §7).
 *
 * `.github/workflows/` is matched at any depth, the way discovery exempts
 * `.github` at any depth (`core/discover.ts`): a monorepo package's
 * `packages/web/.github/workflows/x.yml` is a workflow file GitHub happens not
 * to run from there, and auditing it beats waiting for the repo split that
 * moves it up. `workflows/` must still be `.github`'s own, and the file must
 * sit directly in it — `.github/workflows/nested/ci.yml` is not a workflow.
 */
const WORKFLOW_PATTERN = /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/
const ACTION_PATTERN = /(?:^|\/)action\.ya?ml$/

/**
 * zizmor's severity levels, mapped to ours (spec §2). `critical` is reserved
 * for leaked secrets (spec §3), so `High` — the worst zizmor reports — maps to
 * `error`, which spec §3's absolute shape already caps the category at D.
 *
 * Except for hygiene: see {@link HYGIENE_IDENTS}.
 */
const SEVERITIES: Readonly<Record<string, Severity>> = {
  High: 'error',
  Medium: 'warning',
  Low: 'info',
  Informational: 'info',
  Unknown: 'info',
}

/** Levels that count toward the grade; the rest are advisory (spec §1). */
const GRADED_SEVERITIES: ReadonlySet<Severity> = new Set(['error', 'warning'])

/**
 * Audits that are pure hygiene, demoted to `warning` whatever severity zizmor
 * gives them.
 *
 * zizmor rates both of these `High`, and on its own terms that is right: an
 * unpinned action or container image is a supply-chain risk if its publisher is
 * ever compromised. But the finding is a chore — pin the digest — not a
 * weakness someone can reach today, and `error` is the tier that says "a
 * specific thing here is exploitable". Since almost no repo hash-pins every
 * `uses:`, leaving these at `error` capped nearly every workflow-bearing repo
 * at security D and left the grade unable to tell a careless repo from a
 * careful one — the calibration finding recorded on `GRADE_TABLE.security` in
 * `core/grade.ts`, which names this severity mapping as the lever rather than
 * the band constants. `warning` keeps them graded: enough of them still costs a
 * B, and three costs a C.
 */
const HYGIENE_IDENTS: ReadonlySet<string> = new Set(['unpinned-uses', 'unpinned-images'])

export const zizmorRunner: ToolRunner = {
  tool: ZIZMOR_TOOL,
  category: 'security',
  pinnedVersion: pinnedPythonVersion(ZIZMOR_DISTRIBUTION),
  // Workflow security is nobody else's job; see `ToolRunner.complementary`.
  complementary: true,
  // Workflows live at the repo root and act on the whole repo, so they are
  // audited once, not once per project.
  repoScoped: true,
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectPythonTool(ctx, {
      configFiles: ZIZMOR_CONFIG_FILES,
      distribution: ZIZMOR_DISTRIBUTION,
      sections: ZIZMOR_SECTIONS,
    }),
  run: runZizmor,
}

async function runZizmor(ctx: RunContext): Promise<ToolResult> {
  const inputs = ctx.files.filter(isAuditable)
  if (inputs.length === 0) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'no GitHub Actions workflows or composite actions, so zizmor assessed nothing',
    }
  }

  const command =
    ctx.detection?.installed === true && ctx.detection.binPath !== undefined
      ? repoCommand(ctx.detection.binPath, [])
      : uvxCommand(ZIZMOR_DISTRIBUTION, [])

  const execution = await execTool(
    {
      ...command,
      args: [
        ...command.args,
        ...INVOCATION_ARGS,
        ...inputs.map((file) => join(ctx.repoRoot, file)),
      ],
    },
    { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs },
  )

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'zizmor.json', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'zizmor.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return {
      state: execution.failure.state,
      findings: [],
      rawFiles,
      reason: execution.failure.reason,
    }
  }

  let results: ZizmorFinding[]
  try {
    results = parseZizmorJson(execution.stdout, ctx.repoRoot)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason:
        `could not parse zizmor output (exit ${execution.exitCode ?? 'signal'}): ` +
        `${error instanceof Error ? error.message : String(error)}${
          execution.stderr.trim().length === 0 ? '' : ` — ${firstLine(execution.stderr)}`
        }`,
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(results, ctx.detection !== null).filter((finding) =>
        analyzed.has(finding.file),
      ),
    ),
    toolVersion: pinnedPythonVersion(ZIZMOR_DISTRIBUTION),
    rawFiles,
  }
}

/**
 * Flags shared by every invocation.
 *
 * `--offline` is what keeps a security scan from depending on GitHub's API
 * being reachable — the online audits resolve action refs against the network,
 * and a scan whose findings change with connectivity is not the deterministic
 * one spec §6 promises. `--no-exit-codes` makes "found something" exit 0, so a
 * non-zero exit means zizmor itself failed. `json-v1` is the versioned format
 * name, which is what a pinned parser should ask for.
 */
const INVOCATION_ARGS: readonly string[] = [
  '--format',
  'json-v1',
  '--offline',
  '--no-exit-codes',
  '--no-progress',
  '--',
]

/** Workflow definitions and composite actions, by path. */
export function isAuditable(file: string): boolean {
  return WORKFLOW_PATTERN.test(file) || ACTION_PATTERN.test(file)
}

/** One zizmor finding, in the fields we report on. */
export interface ZizmorFinding {
  /** The audit that produced it, e.g. `dangerous-triggers`. */
  readonly ident: string
  readonly description: string
  readonly url: string
  /** `High`, `Medium`, `Low`, `Informational`. */
  readonly severity: string
  readonly confidence: string
  readonly file: string
  readonly startLine: number
  readonly startCol: number
  readonly endLine: number
  readonly endCol: number
  /** zizmor's note about the specific location, e.g. "this job". */
  readonly annotation: string
  /**
   * The path through the workflow document the finding sits at, dotted:
   * `jobs.build.steps.0`. Line-independent, which is what makes it the anchor.
   */
  readonly route: string
}

/**
 * Parses `zizmor --format json-v1`. Exported so a format shift fails a test
 * instead of reporting a repo with no workflow problems (plan M6 checks).
 *
 * zizmor reports several locations per finding and tags one `Primary`; that is
 * the one a reader should look at, so it is the one we report. Line and column
 * are zero-based in the JSON and one-based in a `Finding`.
 *
 * @throws {Error} when the payload is not zizmor's array of findings
 */
export function parseZizmorJson(stdout: string, repoRoot = ''): ZizmorFinding[] {
  if (stdout.trim().length === 0) return []
  const entries = asArray(JSON.parse(stdout))
  if (entries === undefined) throw new Error('zizmor output is not an array of findings')

  return entries.flatMap((entry) => {
    const finding = asRecord(entry)
    const ident = asString(finding?.['ident'])
    const locations = asArray(finding?.['locations']) ?? []
    const location = asRecord(primaryLocation(locations))
    const symbolic = asRecord(location?.['symbolic'])
    const file = asString(asRecord(asRecord(symbolic?.['key'])?.['Local'])?.['verbatim_path'])
    if (ident === undefined || file === undefined) return []

    const determinations = asRecord(finding?.['determinations'])
    const concrete = asRecord(asRecord(location?.['concrete'])?.['location'])
    const start = asRecord(concrete?.['start_point'])
    const end = asRecord(concrete?.['end_point'])
    const startLine = (asNumber(start?.['row']) ?? 0) + 1
    const startCol = (asNumber(start?.['column']) ?? 0) + 1
    return [
      {
        ident,
        description: asString(finding?.['desc']) ?? '',
        url: asString(finding?.['url']) ?? '',
        severity: asString(determinations?.['severity']) ?? 'Unknown',
        confidence: asString(determinations?.['confidence']) ?? 'Unknown',
        file: repoRelative(file, repoRoot),
        startLine,
        startCol,
        endLine: (asNumber(end?.['row']) ?? asNumber(start?.['row']) ?? 0) + 1,
        endCol: (asNumber(end?.['column']) ?? asNumber(start?.['column']) ?? 0) + 1,
        annotation: asString(symbolic?.['annotation']) ?? '',
        route: routeOf(symbolic?.['route']),
      } satisfies ZizmorFinding,
    ]
  })
}

/** The `Primary` location if the finding has one, else the first. */
function primaryLocation(locations: readonly unknown[]): unknown {
  const primary = locations.find(
    (location) => asString(asRecord(asRecord(location)?.['symbolic'])?.['kind']) === 'Primary',
  )
  return primary ?? locations[0]
}

/** `{route:[{Key:'jobs'},{Key:'build'},{Index:0}]}` → `jobs.build.0`. */
function routeOf(route: unknown): string {
  const steps = asArray(asRecord(route)?.['route']) ?? []
  return steps
    .map((step) => {
      const record = asRecord(step)
      return asString(record?.['Key']) ?? String(asNumber(record?.['Index']) ?? '')
    })
    .filter((step) => step.length > 0)
    .join('.')
}

/**
 * zizmor findings → the core's vocabulary.
 *
 * The anchor is the document route (`jobs.build.steps.0`), not the flagged
 * line: a workflow finding is about a step, and adding a job above it must not
 * churn its identity across a PR delta (spec §2).
 *
 * `Low`/`Informational` findings stay advisory. zizmor's own confidence and
 * severity are independent, and its low-severity audits are hygiene notes — a
 * repo that never opted into zizmor should not be graded down for them.
 */
export function toPendingFindings(
  results: readonly ZizmorFinding[],
  repoConfig: boolean,
): PendingFinding[] {
  return results
    .map((result) => {
      const severity = HYGIENE_IDENTS.has(result.ident)
        ? ('warning' as const)
        : (SEVERITIES[result.severity] ?? ('info' as const))
      return {
        category: 'security' as const,
        tool: ZIZMOR_TOOL,
        rule: result.ident,
        severity,
        file: result.file,
        range: {
          startLine: result.startLine,
          startCol: result.startCol,
          endLine: result.endLine,
          endCol: result.endCol,
        },
        message:
          `${sentenceCase(result.description)}${result.annotation === '' ? '' : ` — ${result.annotation}`}` +
          ` (${result.severity.toLowerCase()} severity, ${result.confidence.toLowerCase()} confidence)`,
        provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
        gradeScope: repoConfig || GRADED_SEVERITIES.has(severity),
        anchor: result.route,
        ...(result.url === '' ? {} : { fixHint: `see ${result.url}` }),
      }
    })
    .toSorted(byLocation)
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`
}
