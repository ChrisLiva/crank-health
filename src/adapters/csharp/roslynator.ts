import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readSources } from '../../core/discover.ts'
import { dnxCommand, execTool, writeScratchRaw } from '../../core/exec.ts'
import type { ToolFailure } from '../../core/exec.ts'
import type { PendingFinding, RunContext, ToolResult, ToolRunner } from '../../core/types.ts'
import { pinnedDotnetSpec, pinnedDotnetVersion } from '../../manifest.ts'
import { byLocation, firstLine, identify } from '../support.ts'
import { dotnetExecOptions, sdkGate } from './dotnet-project.ts'

/**
 * roslynator — the C# dead-code detector (spec "Categories and tools").
 *
 * `find-symbol --unused` loads the project through MSBuild and reports every
 * symbol with zero references in the compilation — public API included, which
 * is what puts it at knip/vulture parity and why it beat reading the private-
 * only RCS1213 out of the shared build: grading C# dead code on a strictly
 * narrower question would make the same letter mean two different things.
 *
 * Two probed facts (0.13.1 on SDK 10.0.203) shape the wrapper:
 *
 * - The output is plain text with **no locations at any verbosity** (confirmed
 *   against `FindSymbolCommand`'s source: it prints kind + display name only).
 *   So placement is a declaration search over the analyzed sources — sound
 *   because an unreferenced symbol's only occurrence *is* its declaration.
 * - Loading a project is a design-time MSBuild evaluation, so the run is
 *   `deepOnly` (criterion 5) and every output path MSBuild would write is
 *   redirected into scratch through `--properties` (zero footprint). The
 *   mutating `--remove` mode is never built.
 */

const ROSLYNATOR_TOOL = 'roslynator'

/** NuGet tool-package id, pinned in the dotnet manifest. */
const ROSLYNATOR_PACKAGE = 'roslynator.dotnet.cli'

/**
 * The tool-argument tail handed to `dnxCommand` (which owns `-y`, the exact
 * pin, the nuget.org `--source` and the `--`). `--properties` is roslynator's
 * MSBuild-property flag (spelling surveyed via `find-symbol --help`); the
 * trailing separators match `buildInvocationArgs`' redirects.
 *
 * @param projectPath absolute path to the `.csproj` to load
 * @param scratch absolute scratch directory the design-time build may write to
 */
export function roslynatorInvocationArgs(projectPath: string, scratch: string): readonly string[] {
  return [
    'find-symbol',
    projectPath,
    '--unused',
    '--properties',
    `BaseIntermediateOutputPath=${join(scratch, 'obj')}/`,
    `BaseOutputPath=${join(scratch, 'bin')}/`,
    `MSBuildProjectExtensionsPath=${join(scratch, 'obj')}/`,
  ]
}

/** One symbol line of `find-symbol` output, split into what placement needs. */
export interface RoslynatorSymbol {
  /** The reported kind, lowercased by the tool: `method`, `field`, `class`, … */
  readonly kind: string
  /** The full display string, e.g. `Cap.Dead.NeverCalled(int value)`. */
  readonly display: string
  /** The symbol's own name, e.g. `NeverCalled`. */
  readonly name: string
  /** The immediately containing segment — the declaring type for members. */
  readonly container: string
}

/**
 * The kinds `find-symbol` can report (its `SymbolGroup`, lowercased) — the
 * gate that keeps loader lines, counters and summaries out of the parse. An
 * output-format shift therefore fails the capture test instead of reading as a
 * repo with no dead code.
 */
const SYMBOL_KINDS: ReadonlySet<string> = new Set([
  'class',
  'const',
  'delegate',
  'enum',
  'enumfield',
  'event',
  'field',
  'indexer',
  'interface',
  'method',
  'property',
  'struct',
])

/** `<kind> <qualified display>`, the one shape a symbol line has. */
const SYMBOL_LINE = /^(?<kind>[a-z]+) +(?<display>[A-Za-z_@].*)$/

/**
 * The symbol lines of one `find-symbol --unused` run. Everything else — loader
 * chatter, `N <kind> symbols` counters, the `N symbols found` summary, blank
 * lines — is skipped, as is any line whose leading word is not a symbol kind.
 */
export function parseRoslynatorSymbols(stdout: string): RoslynatorSymbol[] {
  return stdout.split('\n').flatMap((raw) => {
    const groups = SYMBOL_LINE.exec(raw.trimEnd())?.groups
    const kind = groups?.['kind']
    const display = groups?.['display']
    if (kind === undefined || display === undefined || !SYMBOL_KINDS.has(kind)) return []
    const segments = qualifiedName(display).split('.')
    const name = segments.at(-1)
    if (name === undefined || name.length === 0) return []
    return [{ kind, display, name, container: segments.at(-2) ?? '' }]
  })
}

/** The dotted name alone: signature and generic arguments stripped. */
function qualifiedName(display: string): string {
  const cuts = [display.indexOf('('), display.indexOf('[')].filter((index) => index >= 0)
  let base = display.slice(0, Math.min(...cuts, display.length))
  let previous
  do {
    previous = base
    base = base.replace(/<[^<>]*>/g, '')
  } while (base !== previous)
  return base
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Kinds declared by a type keyword rather than by their bare name. */
const TYPE_KINDS: ReadonlySet<string> = new Set([
  'class',
  'delegate',
  'enum',
  'interface',
  'struct',
])

/** A line that declares a type of this name (`record` covers record types). */
const typeDeclaration = (name: string): RegExp =>
  new RegExp(`\\b(?:class|interface|struct|enum|record|delegate)\\s+${escapeRegExp(name)}\\b`)

/** What a declaration of this symbol looks like, per reported kind. */
function declarationPattern(symbol: RoslynatorSymbol): RegExp {
  if (TYPE_KINDS.has(symbol.kind)) return typeDeclaration(symbol.name)
  if (symbol.kind === 'indexer') return /\bthis\s*\[/
  if (symbol.kind === 'method') {
    return new RegExp(`\\b${escapeRegExp(symbol.name)}\\s*(?:<[^<>]*>)?\\s*\\(`)
  }
  return new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`)
}

/**
 * Reported symbols → `dead-code` findings placed at their declarations.
 *
 * The tool prints no locations (module comment), so each symbol is searched
 * for in the analyzed sources: files declaring the symbol's containing type
 * are preferred (two same-named private fields in two classes land in the
 * right one), and within a file the first line matching the kind's declaration
 * shape wins — for a symbol with zero references that line is the declaration,
 * because there is no call site to collide with. A symbol found in no source
 * (generated code outside the inventory) yields nothing; identity anchors on
 * the symbol name, so findings survive edits above them (spec §2).
 *
 * @param sources repo-relative posix path → file contents, in stable order
 */
export function symbolFindings(
  symbols: readonly RoslynatorSymbol[],
  sources: ReadonlyMap<string, string>,
): PendingFinding[] {
  return symbols
    .flatMap((symbol) => {
      const location = locate(symbol, sources)
      if (location === undefined) return []
      return [
        {
          category: 'dead-code' as const,
          tool: ROSLYNATOR_TOOL,
          rule: `unused-${symbol.kind}`,
          severity: 'warning' as const,
          file: location.file,
          range: location.range,
          message: `Unused ${symbol.kind} \`${symbol.display}\` (zero references)`,
          provenance: 'default-config' as const,
          gradeScope: true,
          anchor: symbol.name,
        },
      ]
    })
    .toSorted(byLocation)
}

interface SymbolLocation {
  readonly file: string
  readonly range: { startLine: number; startCol: number; endLine: number; endCol: number }
}

function locate(
  symbol: RoslynatorSymbol,
  sources: ReadonlyMap<string, string>,
): SymbolLocation | undefined {
  const entries = [...sources]
  const declaring =
    symbol.container === ''
      ? []
      : entries.filter(([, content]) => typeDeclaration(symbol.container).test(content))
  const pattern = declarationPattern(symbol)

  for (const candidates of declaring.length > 0 ? [declaring, entries] : [entries]) {
    for (const [file, content] of candidates) {
      const lines = content.split('\n')
      for (const [index, line] of lines.entries()) {
        const match = pattern.exec(line)
        if (match !== null) {
          const startCol = match.index + 1
          return {
            file,
            range: {
              startLine: index + 1,
              startCol,
              endLine: index + 1,
              endCol: startCol + match[0].length,
            },
          }
        }
      }
    }
  }
  return undefined
}

/**
 * dnx's own unresolvable-pin wording (captured on SDK 10.0.203, and
 * deliberately *not* an offline marker in `core/exec.ts`): a pin the feed does
 * not have must be loud, never empty stdout read as zero dead code.
 */
const UNRESOLVED_PIN = /is not found in NuGet feeds/

/** The slice of a `ToolExecution` the outcome ladder classifies. */
export interface RoslynatorExecution {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | undefined
  readonly failure?: ToolFailure
}

/**
 * Branches 3–5 of the runner's outcome ladder, pure over one execution:
 * process-level failures pass through already classified (dnx-missing and
 * offline arrive here from `execTool`), an unresolvable pin is an `error`
 * quoting the pin, and any other non-zero exit is an `error` quoting the exit
 * code — so no failure mode leaves `dead-code` looking measured and clean.
 *
 * @returns `undefined` when the run is usable
 */
export function roslynatorFailure(execution: RoslynatorExecution): ToolFailure | undefined {
  if (execution.failure !== undefined) return execution.failure
  if (UNRESOLVED_PIN.test(execution.stderr)) {
    return {
      state: 'error',
      reason:
        `the pinned tool ${pinnedDotnetSpec(ROSLYNATOR_PACKAGE)} did not resolve: ` +
        `${firstLine(execution.stderr)} — refusing to read that as zero dead code`,
    }
  }
  if (execution.exitCode !== 0) {
    return {
      state: 'error',
      reason:
        `roslynator find-symbol failed (exit ${execution.exitCode ?? 'signal'}): ` +
        (firstLine(execution.stderr) || firstLine(execution.stdout)),
    }
  }
  return undefined
}

/**
 * The C# dead-code runner. Not `repoOwnedOnly`: the ephemeral pinned run needs
 * no repo test suite and is deterministic, so it is a default like vulture —
 * and `deepOnly`, because loading a project evaluates the repo's MSBuild code.
 */
export const roslynatorRunner: ToolRunner = {
  tool: ROSLYNATOR_TOOL,
  category: 'dead-code',
  pinnedVersion: pinnedDotnetVersion(ROSLYNATOR_PACKAGE),
  deepOnly: true,
  detect: () => Promise.resolve(null),
  run: runRoslynator,
}

async function runRoslynator(ctx: RunContext): Promise<ToolResult> {
  if (ctx.files.length === 0) {
    return { state: 'ok', findings: [], rawFiles: [], reason: 'no C# files' }
  }
  const projectFiles = ctx.project.manifests.filter((manifest) =>
    manifest.toLowerCase().endsWith('.csproj'),
  )
  if (projectFiles.length === 0) {
    return {
      state: 'not-available',
      findings: [],
      rawFiles: [],
      reason: 'this project has no .csproj for roslynator to load',
    }
  }

  const scratch = join(ctx.scratch, ROSLYNATOR_TOOL)
  await mkdir(scratch, { recursive: true })
  // Built once and passed to both the gate and the real command, so the gate
  // answers for the directory the run uses (see `dotnet-project.ts`).
  const options = dotnetExecOptions(ctx, scratch)
  const gate = await sdkGate(options)
  if (gate !== undefined)
    return { state: gate.state, findings: [], rawFiles: [], reason: gate.reason }

  // One run per project file, sequentially: a directory holding several
  // `.csproj`s is one project to discovery, and skipping any of them would
  // silently under-report.
  const stdouts: string[] = []
  const stderrs: string[] = []
  let failure: ToolFailure | undefined
  for (const projectFile of projectFiles) {
    const command = dnxCommand(
      ROSLYNATOR_PACKAGE,
      roslynatorInvocationArgs(join(ctx.repoRoot, projectFile), scratch),
    )
    // eslint-disable-next-line no-await-in-loop
    const execution = await execTool(command, options)
    stdouts.push(execution.stdout)
    if (execution.stderr.trim().length > 0) stderrs.push(execution.stderr)
    failure = roslynatorFailure(execution)
    if (failure !== undefined) break
  }

  const rawFiles = [await writeScratchRaw(ctx.scratch, 'roslynator.txt', stdouts.join(''))]
  if (stderrs.length > 0) {
    rawFiles.push(await writeScratchRaw(ctx.scratch, 'roslynator.stderr.txt', stderrs.join('')))
  }
  if (failure !== undefined) {
    return { state: failure.state, findings: [], rawFiles, reason: failure.reason }
  }

  const sources = await readSources(ctx.repoRoot, ctx.files)
  const analyzed = new Set(ctx.files)
  const pending = symbolFindings(
    stdouts.flatMap((stdout) => parseRoslynatorSymbols(stdout)),
    sources,
  ).filter((finding) => analyzed.has(finding.file))
  return {
    state: 'ok',
    findings: await identify(ctx.repoRoot, pending),
    toolVersion: pinnedDotnetVersion(ROSLYNATOR_PACKAGE),
    rawFiles,
  }
}
