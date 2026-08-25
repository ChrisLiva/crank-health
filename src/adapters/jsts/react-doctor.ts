import { join, resolve } from 'node:path'
import { ephemeralCommand, execTool, repoCommand, writeScratchRaw } from '../../core/exec.ts'
import type {
  DetectContext,
  Detection,
  PendingFinding,
  RunContext,
  ToolResult,
  ToolRunner,
} from '../../core/types.ts'
import { pinnedVersion } from '../../manifest.ts'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  byLocation,
  errorMessage,
  failed,
  firstLine,
  identify,
  repoRelative,
} from '../support.ts'
import { declaresDependency, detectNodeTool } from './node-package.ts'

/**
 * react-doctor — a React-practices signal inside the lint category, and an
 * **advisory one only**.
 *
 * Spec §3 grades lint on finding density under the repo's linter (or our
 * bundled oxlint default). react-doctor measures a different axis — React
 * correctness, accessibility and re-render habits — with an opinionated
 * ruleset that ships on a daily release cadence. Grading on it would
 * double-count files the linters already graded and make the lint grade churn
 * with every rules release, so every finding carries `gradeScope: false` and
 * this runner reports no metrics. It is `complementary` for the same reason in
 * the other direction: it measures what no lint alternative measures, so a
 * repo that owns ESLint or Biome keeps it, and owning react-doctor stands no
 * default linter down.
 */

const REACT_DOCTOR_TOOL = 'react-doctor'

const REACT_DOCTOR_CONFIG_FILES: readonly string[] = [
  'doctor.config.ts',
  'doctor.config.js',
  'doctor.config.mjs',
  'doctor.config.json',
]

export const reactDoctorRunner: ToolRunner = {
  tool: REACT_DOCTOR_TOOL,
  category: 'lint',
  complementary: true,
  pinnedVersion: pinnedVersion(REACT_DOCTOR_TOOL),
  detect: (ctx: DetectContext): Promise<Detection | null> =>
    detectNodeTool(ctx, {
      // No `manifestKeys`: a `reactDoctor` block in a package.json must not
      // confer ownership. Config inherits from ancestors, the default.
      configFiles: REACT_DOCTOR_CONFIG_FILES,
      packageName: REACT_DOCTOR_TOOL,
      binName: REACT_DOCTOR_TOOL,
    }),
  run: runReactDoctor,
}

async function runReactDoctor(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no JavaScript or TypeScript files' }
  }
  // A React-practices scan of a project without React would be noise; the gate
  // answers from the manifests — the project's or any ancestor's — before any
  // spawn. An unreadable manifest reads as "no React", never a throw.
  if (!(await declaresDependency(ctx.repoRoot, ctx.project.path, 'react'))) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'no React dependency detected',
    }
  }

  const detection = ctx.detection
  // react-doctor takes a project directory and walks it itself, so it is given
  // this project's, not the repo's. Results are filtered to discovered paths
  // below, so nothing gitignored or vendored can reach a report.
  const scanRoot = resolve(ctx.repoRoot, ctx.project.path)
  const args = invocationArgs(scanRoot, join(ctx.scratch, REACT_DOCTOR_TOOL))
  const command =
    detection?.installed === true && detection.binPath !== undefined
      ? repoCommand(detection.binPath, args)
      : ephemeralCommand(REACT_DOCTOR_TOOL, args)

  // cwd is the scratch dir: any file the tool drops beside its cwd lands
  // outside the repo (zero footprint, spec §7).
  const execution = await execTool(command, { cwd: ctx.scratch, timeoutMs: ctx.timeoutMs })

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'react-doctor.json', execution.stdout)]
  if (execution.stderr.trim().length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'react-doctor.stderr.txt', execution.stderr))
  }

  if (execution.failure !== undefined) {
    return failed(execution.failure, rawFiles)
  }
  if (execution.stdout.trim().length === 0) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `react-doctor produced no output (exit ${execution.exitCode ?? 'signal'}): ${firstLine(execution.stderr)}`,
    }
  }

  let payload: ReactDoctorPayload
  try {
    payload = parseReactDoctorJson(execution.stdout)
  } catch (error) {
    return {
      state: 'error',
      findings: [],
      rawFiles,
      reason: `could not parse react-doctor output: ${errorMessage(error)}`,
    }
  }

  // The tool's own verdict outranks the manifest gate: react declared, but no
  // scannable React project at this directory.
  if (!payload.reactDetected) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles,
      reason: 'react-doctor found no React in this project',
    }
  }

  const analyzed = new Set(ctx.files)
  return {
    state: 'ok',
    findings: await identify(
      ctx.repoRoot,
      toPendingFindings(payload.diagnostics, detection !== null, scanRoot, ctx.repoRoot).filter(
        (finding) => analyzed.has(finding.file),
      ),
    ),
    ...(detection?.version === undefined
      ? { toolVersion: pinnedVersion(REACT_DOCTOR_TOOL) }
      : { toolVersion: detection.version }),
    rawFiles,
  }
}

/** One entry of react-doctor's top-level `diagnostics[]`, narrowed to what we map. */
export interface ReactDoctorDiagnostic {
  readonly filePath: string
  readonly rule: string
  /** The tool documents `error` and `warning`; anything else maps to `info`. */
  readonly severity: string
  readonly title: string
  readonly help?: string
  readonly line?: number
  readonly column?: number
  readonly endLine?: number
}

/** The fields of `react-doctor --json` this runner reads. */
export interface ReactDoctorPayload {
  readonly reactDetected: boolean
  readonly diagnostics: readonly ReactDoctorDiagnostic[]
}

/**
 * Parses `react-doctor --json` output. Exported so a format shift fails a test
 * instead of corrupting a report.
 *
 * @throws {Error} when the payload is not an object or has no `diagnostics` array
 */
export function parseReactDoctorJson(stdout: string): ReactDoctorPayload {
  const record = asRecord(JSON.parse(stdout))
  if (record === undefined) throw new Error('react-doctor output is not an object')
  const entries = asArray(record['diagnostics'])
  if (entries === undefined) throw new Error('react-doctor output has no diagnostics array')

  // A row without a file or a rule cannot become a finding; a partial payload
  // loses those rows and nothing else.
  const diagnostics = entries.flatMap((entry) => {
    const row = asRecord(entry)
    const filePath = asString(row?.['filePath'])
    const rule = asString(row?.['rule'])
    if (row === undefined || filePath === undefined || rule === undefined) return []
    const help = asString(row['help'])
    const line = asNumber(row['line'])
    const column = asNumber(row['column'])
    const endLine = asNumber(row['endLine'])
    return [
      {
        filePath,
        rule,
        severity: asString(row['severity']) ?? '',
        title: asString(row['title']) ?? '',
        ...(help === undefined ? {} : { help }),
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column }),
        ...(endLine === undefined ? {} : { endLine }),
      } satisfies ReactDoctorDiagnostic,
    ]
  })
  return { reactDetected: record['reactDetected'] === true, diagnostics }
}

/**
 * Diagnostics → the core's vocabulary. Advisory by construction (see the file
 * comment): `gradeScope` is always `false`. No explicit anchor — identity is
 * the trimmed source line, like every line-attached diagnostic.
 */
export function toPendingFindings(
  diagnostics: readonly ReactDoctorDiagnostic[],
  repoConfig: boolean,
  /** Absolute directory the tool was pointed at; relative `filePath`s anchor here. */
  scanRoot: string,
  repoRoot: string,
): PendingFinding[] {
  return diagnostics
    .map((diagnostic) => ({
      category: 'lint' as const,
      tool: REACT_DOCTOR_TOOL,
      rule: `${REACT_DOCTOR_TOOL}/${diagnostic.rule}`,
      severity: toSeverity(diagnostic.severity),
      // Anchor at the scanned directory, then relativize against the repo: the
      // tool reports project-relative paths, and absolute ones resolve to
      // themselves either way.
      file: repoRelative(resolve(scanRoot, diagnostic.filePath), repoRoot),
      range: {
        startLine: axis(diagnostic.line),
        startCol: axis(diagnostic.column),
        endLine: axis(diagnostic.endLine),
        endCol: 1,
      },
      message: diagnostic.title,
      provenance: repoConfig ? ('repo-config' as const) : ('default-config' as const),
      gradeScope: false,
      ...(diagnostic.help === undefined ? {} : { fixHint: diagnostic.help }),
    }))
    .toSorted(byLocation)
}

/**
 * The hermetic command line, every flag unconditional: `--no-telemetry` (no
 * phone-home), `--no-supply-chain` (no registry queries about the repo's
 * dependencies), `--no-dead-code` (that check executes module graphs and the
 * category belongs to knip/fallow anyway), `--blocking none` (advisory tools do
 * not gate on exit codes), and `--output-dir` pointing every write the tool
 * wants to make into the scratch dir (zero footprint, spec §7).
 */
export function invocationArgs(projectDir: string, outputDir: string): string[] {
  return [
    projectDir,
    '--json',
    '--no-telemetry',
    '--no-supply-chain',
    '--no-dead-code',
    '--blocking',
    'none',
    '--output-dir',
    outputDir,
  ]
}

/** The tool documents `error` and `warning`; an unknown severity floors at `info`. */
function toSeverity(severity: string): 'error' | 'warning' | 'info' {
  if (severity === 'error') return 'error'
  if (severity === 'warning') return 'warning'
  return 'info'
}

/** Positions are 1-based when present; missing, non-numeric or non-positive → 1. */
function axis(value: number | undefined): number {
  const numeric = asNumber(value)
  return numeric !== undefined && numeric >= 1 ? numeric : 1
}
