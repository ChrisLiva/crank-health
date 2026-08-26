import type { ToolFailure } from '../../core/exec.ts'
import type { PendingFinding, Severity } from '../../core/types.ts'
import type { PinnedTool } from '../../manifest.ts'
import { asArray, asNumber, asRecord, asString, byLocation, repoRelative } from '../support.ts'

/**
 * aislop — the `ai-slop` engine of the `aislop` CLI, read as lint findings.
 *
 * aislop ships six engines; five of them re-run what crank-health already runs
 * (format, lint, code-quality, security, architecture), so the generated config
 * turns those off and this runner reads `ai-slop` alone. That engine flags the
 * shapes LLM-written code arrives in — a duplicate import, a swallowed
 * exception, a package that was never declared — which no other analyzer here
 * measures.
 *
 * The parser is exported so a format shift fails a test instead of corrupting a
 * report, the way `react-doctor.ts` and `zizmor.ts` are.
 */

export const AISLOP_TOOL = 'aislop' satisfies PinnedTool

/** The only engine this runner reads; the other five are off in the config. */
const AISLOP_ENGINE = 'ai-slop'

/** One entry of aislop's top-level `diagnostics[]`, narrowed to what we map. */
export interface AislopDiagnostic {
  readonly filePath: string
  readonly engine: string
  readonly rule: string
  /** aislop's enum is `error`, `warning`, `info`; anything else maps to `info`. */
  readonly severity: string
  readonly message: string
  readonly help?: string
  readonly line: number
  readonly column: number
}

/** The fields of `aislop scan --json` this runner reads. */
export interface AislopPayload {
  /** `''` when the payload carries no `schemaVersion`; see {@link payloadFailure}. */
  readonly schemaVersion: string
  readonly version?: string
  readonly engines: Readonly<Record<string, { readonly skipped: boolean }>>
  /** `summary.files`, 0 when the payload carries no count. */
  readonly filesScanned: number
  readonly diagnostics: readonly AislopDiagnostic[]
}

/**
 * Parses `aislop scan --json` output.
 *
 * Empty stdout throws here, where zizmor's and opengrep's parsers read it as a
 * clean run: aislop prints its envelope whatever it found, so nothing on stdout
 * means the process died before it printed one, and reporting that as zero
 * findings would grade a repo on a scan that never happened.
 *
 * A diagnostic missing any field a finding needs is dropped rather than
 * defaulted (the `react-doctor.ts` rule): a partial payload loses those rows and
 * nothing else.
 *
 * @throws {Error} when stdout is not an aislop payload, or aislop reported an error
 */
export function parseAislopJson(stdout: string): AislopPayload {
  const record = stdout.trim().length === 0 ? undefined : asRecord(JSON.parse(stdout))
  if (record === undefined) throw new Error('aislop printed no JSON object')

  const error = asString(record['error'])
  if (error !== undefined) throw new Error(`aislop reported an error: ${error}`)

  const entries = asArray(record['diagnostics'])
  if (entries === undefined) throw new Error('aislop output has no diagnostics array')

  const diagnostics = entries.flatMap((entry) => {
    const row = asRecord(entry)
    const filePath = asString(row?.['filePath'])
    const engine = asString(row?.['engine'])
    const rule = asString(row?.['rule'])
    const severity = asString(row?.['severity'])
    const message = asString(row?.['message'])
    const line = asNumber(row?.['line'])
    const column = asNumber(row?.['column'])
    if (
      filePath === undefined ||
      engine === undefined ||
      rule === undefined ||
      severity === undefined ||
      message === undefined ||
      line === undefined ||
      column === undefined
    ) {
      return []
    }
    const help = asString(row?.['help'])
    return [
      {
        filePath,
        engine,
        rule,
        severity,
        message,
        ...(help === undefined ? {} : { help }),
        line,
        column,
      } satisfies AislopDiagnostic,
    ]
  })

  const engines = Object.fromEntries(
    Object.entries(asRecord(record['engines']) ?? {}).map(([name, value]) => [
      name,
      { skipped: asRecord(value)?.['skipped'] === true },
    ]),
  )
  const version = asString(record['version'])
  return {
    schemaVersion: asString(record['schemaVersion']) ?? '',
    ...(version === undefined ? {} : { version }),
    engines,
    filesScanned: asNumber(asRecord(record['summary'])?.['files']) ?? 0,
    diagnostics,
  }
}

/**
 * The payload guards, in order, returning the first that applies.
 *
 * Each one names a way the run can look successful and be worthless: a moved
 * JSON contract, a config aislop did not honor, an engine that stood itself
 * down, and a scan whose directory policy skipped every file. A category is
 * graded the moment a runner returns `ok`, so each of these has to be a failure
 * rather than zero findings.
 *
 * @param scannableCount how many files of this project the inventory offered
 */
export function payloadFailure(
  payload: AislopPayload,
  scannableCount: number,
): ToolFailure | undefined {
  if (payload.schemaVersion !== '1') {
    return {
      state: 'error',
      reason: `aislop printed schemaVersion "${payload.schemaVersion}", not "1"; its JSON contract moved`,
    }
  }
  const engines = Object.keys(payload.engines)
  if (engines.length !== 1 || engines[0] !== AISLOP_ENGINE) {
    return {
      state: 'error',
      reason: 'aislop ran engines beyond ai-slop; its config was not honored',
    }
  }
  if (payload.engines[AISLOP_ENGINE]?.skipped === true) {
    return {
      state: 'error',
      reason: 'aislop skipped its ai-slop engine and its JSON gives no reason',
    }
  }
  if (payload.filesScanned === 0 && scannableCount > 0) {
    return {
      state: 'not-available',
      reason: "aislop's directory policy excluded every file of this project",
    }
  }
  return undefined
}

/**
 * aislop's own severity enum (`src/engines/types.ts`), mapped to ours. The
 * fallback covers a release that adds a fourth level: an unknown level is
 * advisory-weight, not silently graded as an error.
 */
const SEVERITIES: Readonly<Record<string, Severity>> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
}

/**
 * Rules whose message interpolates an import specifier, which can carry
 * `user:password@` userinfo. `duplicate-import` quotes the raw specifier;
 * `hallucinated-import` quotes only the package name today, and is listed so a
 * change upstream cannot leak a credential into the run dir.
 */
const REDACTED_RULES: ReadonlySet<string> = new Set([
  'ai-slop/duplicate-import',
  'ai-slop/hallucinated-import',
])

/**
 * Diagnostics → the core's vocabulary, graded as lint findings.
 *
 * The inventory, not aislop, decides what is in the report: aislop walks the
 * mirror directory, so only a diagnostic about a file crank-health handed it
 * survives. Rule ids keep their `ai-slop/` prefix, which is what tells a reader
 * of the report which engine spoke. No explicit anchor: identity is the trimmed
 * source line, like every other line-attached diagnostic.
 *
 * @param scannable repo-relative posix paths of this project's inventory
 */
export function toPendingFindings(
  payload: AislopPayload,
  repoConfig: boolean,
  scannable: ReadonlySet<string>,
): PendingFinding[] {
  return payload.diagnostics
    .flatMap((diagnostic) => {
      const file = repoRelative(diagnostic.filePath)
      if (diagnostic.engine !== AISLOP_ENGINE || !scannable.has(file)) return []
      // aislop reports column 0 for a whole-line diagnostic; a `Range` is
      // one-based on both axes.
      const column = Math.max(1, diagnostic.column)
      return [
        {
          category: 'lint' as const,
          tool: AISLOP_TOOL,
          rule: diagnostic.rule,
          severity: SEVERITIES[diagnostic.severity] ?? ('info' as const),
          file,
          range: {
            startLine: diagnostic.line,
            startCol: column,
            endLine: diagnostic.line,
            endCol: column,
          },
          message: REDACTED_RULES.has(diagnostic.rule)
            ? redactUserinfo(diagnostic.message)
            : diagnostic.message,
          provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
          gradeScope: true,
          ...(diagnostic.help === undefined ? {} : { fixHint: diagnostic.help }),
        } satisfies PendingFinding,
      ]
    })
    .toSorted(byLocation)
}

/**
 * `https://user:pass@host/m.js` → `https://<redacted>@host/m.js`. The class
 * stops at a quote, a slash or whitespace, so an address later in the sentence
 * is left alone.
 */
function redactUserinfo(message: string): string {
  return message.replaceAll(/:\/\/[^@\s"'/]+@/g, '://<redacted>@')
}
