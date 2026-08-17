import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { GoVulnerability } from '../src/adapters/common/govulncheck.ts'
import {
  GOVULNCHECK_TOOL,
  GO_ABSENT_REASON,
  NO_GO_MODULES_REASON,
  goEnv,
  govulncheckRunner,
  invocationArgs,
  mergeReachability,
  parseGovulncheckStream,
  toPendingFindings,
} from '../src/adapters/common/govulncheck.ts'
import { commonAdapter } from '../src/adapters/common/index.ts'
import { OSV_PACKAGE_RULE, OSV_SCANNER_TOOL } from '../src/adapters/common/osv-scanner.ts'
import { inventoryOf, repoProject } from '../src/core/discover.ts'
import type { Finding, RunContext, ToolResult, ToolRunner } from '../src/core/types.ts'
import { scanTree } from '../src/run.ts'
import { makeFinding } from './factories.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'
import { pathFarm } from './support/path-farm.ts'

const REPO = '/repo'

/** A run context over a file list, as the orchestrator hands one to a runner. */
function runContext(files: readonly string[], scratch: string): RunContext {
  return {
    repoRoot: REPO,
    project: repoProject(inventoryOf(files)),
    files,
    scratch,
    runScratch: scratch,
    detection: null,
    timeoutMs: 30_000,
    deep: false,
  }
}

/**
 * govulncheck — the Go reachability analyzer.
 *
 * The captured stream is a real `go run golang.org/x/vuln/cmd/govulncheck@v1.7.0
 * -json ./...` against a Go service, sanitized: the local module path was
 * rewritten to `example.com/app/api`, and the 207 `osv` records were trimmed to
 * the 17 the findings reference plus two the findings do not (GO-2021-0067 and
 * GO-2021-0069), which is what proves an unreferenced advisory produces no
 * finding. Every `finding` record is kept.
 */

const CAPTURED = fileURLToPath(new URL('./captured/govulncheck-1.7.0.json', import.meta.url))

const capturedStream = async (): Promise<string> => readFile(CAPTURED, 'utf8')

describe('parseGovulncheckStream', () => {
  it('takes the deepest trace granularity per advisory — go-jose is symbol-reachable', async () => {
    const vulnerabilities = parseGovulncheckStream(await capturedStream())

    const goJose = vulnerabilities.find((entry) => entry.osv === 'GO-2026-4945')
    expect(goJose).toMatchObject({
      osv: 'GO-2026-4945',
      module: 'github.com/go-jose/go-jose/v3',
      version: 'v3.0.4',
      fixedIn: 'v3.0.5',
      reachability: 'symbol-reachable',
    })
    expect(goJose?.aliases).toEqual(['CVE-2026-34986', 'GHSA-78h2-9frx-2jm8'])
    expect(goJose?.summary).toContain('go-jose')
  })

  it('leaves a module-only advisory at not-imported — every x/crypto one', async () => {
    const vulnerabilities = parseGovulncheckStream(await capturedStream())

    const crypto = vulnerabilities.filter((entry) => entry.module === 'golang.org/x/crypto')
    expect(crypto).toHaveLength(16)
    expect(new Set(crypto.map((entry) => entry.reachability))).toEqual(new Set(['not-imported']))
    expect(crypto.every((entry) => entry.version === 'v0.43.0')).toBe(true)
  })

  it('reports one vulnerability per advisory id, sorted, and only the ones found', async () => {
    const vulnerabilities = parseGovulncheckStream(await capturedStream())

    expect(vulnerabilities).toHaveLength(17)
    const ids = vulnerabilities.map((entry) => entry.osv)
    expect(ids).toEqual(ids.toSorted())
    // Present in the stream as `osv` records, referenced by no finding.
    expect(vulnerabilities.map((entry) => entry.osv)).not.toContain('GO-2021-0067')
    expect(vulnerabilities.map((entry) => entry.osv)).not.toContain('GO-2021-0069')
  })

  it('records a missing fix as no fix, and an advisory with no aliases as none', async () => {
    const vulnerabilities = parseGovulncheckStream(await capturedStream())

    const unmaintained = vulnerabilities.find((entry) => entry.osv === 'GO-2026-5932')
    expect(unmaintained?.fixedIn).toBeUndefined()
    expect(unmaintained?.aliases).toEqual([])
  })

  it('reads an empty stream, a blank stream and a finding with no trace as nothing', () => {
    expect(parseGovulncheckStream('')).toEqual([])
    expect(parseGovulncheckStream('   \n\n ')).toEqual([])
    expect(
      parseGovulncheckStream('{"finding": {"osv": "GO-1", "fixed_version": "v1.0.0"}}'),
    ).toEqual([])
    expect(parseGovulncheckStream('{"finding": {"osv": "GO-1", "trace": []}}')).toEqual([])
  })

  it('classifies a package-level trace as imported-no-call', () => {
    const stream = [
      '{"osv": {"id": "GO-1", "summary": "s", "aliases": ["CVE-1"]}}',
      '{"finding": {"osv": "GO-1", "fixed_version": "v1.2.0",',
      '  "trace": [{"module": "example.com/m", "version": "v1.0.0", "package": "example.com/m/pkg"}]}}',
    ].join('\n')

    expect(parseGovulncheckStream(stream)).toEqual([
      {
        osv: 'GO-1',
        aliases: ['CVE-1'],
        summary: 's',
        module: 'example.com/m',
        version: 'v1.0.0',
        fixedIn: 'v1.2.0',
        reachability: 'imported-no-call',
      },
    ])
  })

  it('ignores anything that is not a brace-balanced object stream', () => {
    expect(parseGovulncheckStream('not json at all')).toEqual([])
    expect(parseGovulncheckStream('{"finding": {"osv": "GO-1", "trace": [{"module": "m"}')).toEqual(
      [],
    )
  })

  it('keeps a brace inside a string from ending an object', () => {
    const stream =
      '{"osv": {"id": "GO-1", "summary": "a } brace \\" and quote", "aliases": []}}\n' +
      '{"finding": {"osv": "GO-1", "trace": [{"module": "m", "version": "v1"}]}}'

    expect(parseGovulncheckStream(stream)[0]?.summary).toBe('a } brace " and quote')
  })
})

/** One parsed advisory; override only what the assertion is about. */
function vulnerability(overrides: Partial<GoVulnerability> = {}): GoVulnerability {
  return {
    osv: 'GO-1',
    aliases: ['CVE-1'],
    summary: 'a vulnerability',
    module: 'example.com/m',
    version: 'v1.0.0',
    fixedIn: 'v1.2.0',
    reachability: 'symbol-reachable',
    ...overrides,
  }
}

describe('toPendingFindings', () => {
  it('reports one finding per vulnerable module, with the verdict on each advisory', async () => {
    const findings = toPendingFindings(parseGovulncheckStream(await capturedStream()), 'api/go.mod')

    expect(findings).toHaveLength(2)
    const [goJose, crypto] = findings
    expect(goJose).toMatchObject({
      category: 'security',
      tool: GOVULNCHECK_TOOL,
      rule: OSV_PACKAGE_RULE,
      file: 'api/go.mod',
      anchor: 'github.com/go-jose/go-jose/v3@v3.0.4',
      package: {
        name: 'github.com/go-jose/go-jose/v3',
        version: 'v3.0.4',
        ecosystem: 'Go',
      },
    })
    expect(goJose?.packageAdvisories).toEqual([
      {
        id: 'GO-2026-4945',
        aliases: ['CVE-2026-34986', 'GHSA-78h2-9frx-2jm8'],
        severity: 'info',
        summary: expect.stringContaining('go-jose'),
        fixedIn: 'v3.0.5',
        reachability: 'symbol-reachable',
      },
    ])
    expect(crypto?.packageAdvisories).toHaveLength(16)
    expect(crypto?.packageAdvisories?.map((advisory) => advisory.id)).toEqual(
      [...(crypto?.packageAdvisories ?? [])].map((advisory) => advisory.id).toSorted(),
    )
  })

  it('grades a reachable symbol and demotes a module nothing imports', async () => {
    const findings = toPendingFindings(parseGovulncheckStream(await capturedStream()), 'go.mod')

    const goJose = findings.find((finding) => finding.package?.name.includes('go-jose'))
    const crypto = findings.find((finding) => finding.package?.name === 'golang.org/x/crypto')
    expect(goJose?.gradeScope).toBe(true)
    expect(goJose?.message).not.toContain('advisory only')
    expect(crypto?.gradeScope).toBe(false)
    expect(crypto?.message).toContain('advisory only: not-imported')
  })

  it('grades a reachable symbol whose advisory has a published fix', () => {
    const [finding] = toPendingFindings(
      [vulnerability({ reachability: 'symbol-reachable' })],
      'go.mod',
    )

    expect(finding?.gradeScope).toBe(true)
  })

  it('demotes a package that is imported but never called', () => {
    const [finding] = toPendingFindings(
      [vulnerability({ reachability: 'imported-no-call' })],
      'go.mod',
    )

    expect(finding?.gradeScope).toBe(false)
    expect(finding?.message).toContain('advisory only: imported-no-call')
  })

  it('demotes a reachable advisory that has no published fix, and says so', () => {
    const [finding] = toPendingFindings([vulnerability({ fixedIn: undefined })], 'go.mod')

    expect(finding?.gradeScope).toBe(false)
    expect(finding?.message).toContain('no fixed version available')
    expect(finding?.message).not.toContain('advisory only')
  })

  it('names the deepest verdict when a demoted module carries several', () => {
    const [finding] = toPendingFindings(
      [
        vulnerability({ osv: 'GO-1', reachability: 'not-imported' }),
        vulnerability({ osv: 'GO-2', reachability: 'imported-no-call' }),
      ],
      'go.mod',
    )

    expect(finding?.gradeScope).toBe(false)
    expect(finding?.message).toContain('advisory only: imported-no-call')
  })

  it('reports nothing for no vulnerabilities', () => {
    expect(toPendingFindings([], 'go.mod')).toEqual([])
  })
})

/** An osv-scanner package finding, as `toPendingFindings` there builds one. */
function packageFinding(overrides: Partial<Finding> = {}): Finding {
  return makeFinding({
    category: 'security',
    tool: OSV_SCANNER_TOOL,
    rule: OSV_PACKAGE_RULE,
    severity: 'error',
    file: 'go.mod',
    message: 'example.com/m@1.0.0 (Go): 1 advisory; fix: upgrade to ≥1.2.0',
    package: { name: 'example.com/m', version: '1.0.0', ecosystem: 'Go' },
    packageAdvisories: [
      {
        id: 'GHSA-aaaa',
        aliases: ['CVE-1', 'GO-1'],
        severity: 'error',
        summary: 'the advisory',
        fixedIn: '1.2.0',
      },
    ],
    ...overrides,
  })
}

/** The govulncheck half of the same dependency. */
function goFinding(vulnerabilities: readonly GoVulnerability[] = [vulnerability()]): Finding {
  const [pending] = toPendingFindings(vulnerabilities, 'go.mod')
  if (pending === undefined) throw new Error('no finding built')
  const { anchor: _anchor, ...rest } = pending
  return { id: 'govulncheckfinding', ...rest }
}

describe('mergeReachability', () => {
  it('annotates the osv-scanner advisory an alias joins it to, and drops its own row', () => {
    const merged = mergeReachability([packageFinding(), goFinding()])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe('deadbeefdeadbeef')
    expect(merged[0]?.tool).toBe(OSV_SCANNER_TOOL)
    expect(merged[0]?.severity).toBe('error')
    expect(merged[0]?.packageAdvisories).toEqual([
      {
        id: 'GHSA-aaaa',
        aliases: ['CVE-1', 'GO-1'],
        severity: 'error',
        summary: 'the advisory',
        fixedIn: '1.2.0',
        reachability: 'symbol-reachable',
      },
    ])
  })

  it('joins across the `v` prefix Go uses and osv-scanner strips', () => {
    const merged = mergeReachability([
      packageFinding({ package: { name: 'example.com/m', version: '1.0.0', ecosystem: 'Go' } }),
      goFinding([vulnerability({ version: 'v1.0.0' })]),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.packageAdvisories?.[0]?.reachability).toBe('symbol-reachable')
  })

  it('appends an advisory only govulncheck knows, still sorted by id', () => {
    const merged = mergeReachability([
      packageFinding(),
      goFinding([
        vulnerability({ osv: 'GO-1', aliases: [] }),
        vulnerability({ osv: 'GO-0', aliases: [], summary: 'go only', fixedIn: '1.9.0' }),
      ]),
    ])

    expect(merged[0]?.packageAdvisories?.map((advisory) => advisory.id)).toEqual([
      'GHSA-aaaa',
      'GO-0',
    ])
    expect(merged[0]?.packageAdvisories?.[1]).toMatchObject({
      id: 'GO-0',
      severity: 'info',
      summary: 'go only',
      fixedIn: '1.9.0',
      reachability: 'symbol-reachable',
    })
    // The count and the fix are re-derived, never patched.
    expect(merged[0]?.message).toContain('2 advisories')
    expect(merged[0]?.message).toContain('fix: upgrade to ≥1.9.0')
  })

  it('demotes a merged finding whose every advisory is unreachable', () => {
    const merged = mergeReachability([
      packageFinding(),
      goFinding([vulnerability({ reachability: 'not-imported' })]),
    ])

    expect(merged[0]?.gradeScope).toBe(false)
    expect(merged[0]?.message).toContain('advisory only: not-imported')
  })

  it('keeps a merged finding graded when one advisory has no verdict', () => {
    const merged = mergeReachability([
      packageFinding({
        packageAdvisories: [
          {
            id: 'GHSA-aaaa',
            aliases: ['GO-1'],
            severity: 'error',
            summary: 'joined',
            fixedIn: '1.2.0',
          },
          {
            id: 'GHSA-bbbb',
            aliases: [],
            severity: 'error',
            summary: 'govulncheck never saw this one',
            fixedIn: '1.1.0',
          },
        ],
      }),
      goFinding([vulnerability({ reachability: 'not-imported' })]),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.gradeScope).toBe(true)
    expect(merged[0]?.message).not.toContain('advisory only')
  })

  it('leaves a govulncheck finding no lockfile audit matched standing on its own', () => {
    const merged = mergeReachability([
      packageFinding({ package: { name: 'example.com/other', version: '1.0.0', ecosystem: 'Go' } }),
      goFinding(),
    ])

    expect(merged.map((finding) => finding.tool)).toEqual([OSV_SCANNER_TOOL, GOVULNCHECK_TOOL])
  })

  it('leaves every other finding exactly as it was', () => {
    const lint = makeFinding()
    const npm = packageFinding({
      package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' },
    })

    expect(mergeReachability([lint, npm])).toEqual([lint, npm])
  })

  it('keeps the findings in the order it was given them', () => {
    const first = packageFinding({ file: 'a/go.mod' })
    const second = packageFinding({
      file: 'b/go.mod',
      package: { name: 'example.com/second', version: '2.0.0', ecosystem: 'Go' },
    })
    const merged = mergeReachability([first, goFinding(), second])

    expect(merged.map((finding) => finding.file)).toEqual(['a/go.mod', 'b/go.mod'])
  })
})

/**
 * The merge is a property of a whole scan and not of one runner, so the wiring
 * is asserted where it lives: two stand-in runners in one adapter, the same Go
 * dependency reported by each, and one row in the graded result.
 */
const emitting = (tool: string, findings: readonly Finding[]): ToolRunner => ({
  tool,
  category: 'security',
  pinnedVersion: '0.0.0',
  complementary: true,
  detect: () => Promise.resolve(null),
  run: () => Promise.resolve({ state: 'ok', findings, rawFiles: [] }),
})

describe('the scan pipeline', () => {
  let fixture: FixtureRepo
  let scratch: string

  beforeAll(async () => {
    fixture = await createFixtureRepo('js-basic')
    scratch = await mkdtemp(join(tmpdir(), 'crank-govulncheck-'))
  })

  afterAll(async () => {
    await fixture.remove()
    await rm(scratch, { recursive: true, force: true })
  })

  it('merges govulncheck onto the lockfile audit before anything is graded', async () => {
    const tree = await scanTree({
      repoRoot: fixture.root,
      scratch,
      only: ['security'],
      adapters: [
        {
          language: 'common',
          detect: () => Promise.resolve(true),
          runners: [
            emitting(OSV_SCANNER_TOOL, [packageFinding()]),
            emitting(GOVULNCHECK_TOOL, [
              goFinding([vulnerability({ reachability: 'not-imported' })]),
            ]),
          ],
        },
      ],
    })

    expect(tree.scan.findings).toHaveLength(1)
    expect(tree.scan.findings[0]?.tool).toBe(OSV_SCANNER_TOOL)
    expect(tree.scan.findings[0]?.packageAdvisories?.[0]?.reachability).toBe('not-imported')
    // Demoted by the verdict, so the security grade is not counting it.
    expect(tree.scan.findings[0]?.gradeScope).toBe(false)
    expect(tree.gradeBasis.security).toMatchObject({ value: 0 })
  })
})

describe('the govulncheck runner', () => {
  it('is a complementary, repo-scoped security runner on the pinned analyzer', () => {
    expect(govulncheckRunner).toMatchObject({
      tool: GOVULNCHECK_TOOL,
      category: 'security',
      complementary: true,
      repoScoped: true,
      pinnedVersion: 'v1.7.0',
    })
    expect(commonAdapter.runners).toContain(govulncheckRunner)
  })

  it('is owned by any go.mod in the inventory, and by nothing else', async () => {
    const files = inventoryOf(['README.md', 'services/api/go.mod', 'services/api/main.go'])

    expect(
      await govulncheckRunner.detect({ repoRoot: REPO, project: repoProject(files), files }),
    ).toEqual({
      reason: 'dependency',
      configFiles: [],
      ownedVia: 'services/api/go.mod',
      installed: false,
    })
    const none = inventoryOf(['README.md', 'src/a.ts'])
    expect(
      await govulncheckRunner.detect({ repoRoot: REPO, project: repoProject(none), files: none }),
    ).toBeNull()
  })

  it('runs the exact pin and no go subcommand that could write', () => {
    expect(invocationArgs()).toEqual([
      'run',
      'golang.org/x/vuln/cmd/govulncheck@v1.7.0',
      '-json',
      './...',
    ])
    for (const mutating of ['get', 'install', 'mod', 'tidy', 'vendor', 'generate', 'work']) {
      expect(invocationArgs()).not.toContain(mutating)
    }
    expect(invocationArgs().some((arg) => arg.includes('@latest'))).toBe(false)
  })

  it('pins the module cache outside any repo and forbids go.mod rewrites', () => {
    expect(goEnv()).toEqual({
      GOFLAGS: '-mod=readonly',
      GOMODCACHE: join(homedir(), 'go', 'pkg', 'mod'),
    })
    expect(isAbsolute(goEnv()['GOMODCACHE'] ?? '')).toBe(true)
  })

  it('assesses nothing, and says so, in a repo with no Go module', async () => {
    const result = await govulncheckRunner.run(runContext(['src/a.ts'], '/scratch'))

    expect(result.state).toBe('not-available')
    expect(result.reason).toBe(NO_GO_MODULES_REASON)
    expect(result.findings).toEqual([])
  })
})

describe('the govulncheck runner against a farmed PATH', () => {
  let scratch: string
  let root: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'crank-govulncheck-run-'))
    root = await mkdtemp(join(tmpdir(), 'crank-govulncheck-repo-'))
    await writeFile(join(root, 'go.mod'), 'module example.com/app\n\ngo 1.26\n', 'utf8')
  })

  afterAll(async () => {
    await Promise.all([
      rm(scratch, { recursive: true, force: true }),
      rm(root, { recursive: true, force: true }),
    ])
  })

  /**
   * The machine that runs this suite may or may not have `go`, and the answer
   * must not change the test. So the real subprocess goes out under a farmed
   * `PATH` holding exactly what the test planted — the same seam
   * `dotnet-format.test.ts` uses for the SDK — and `process.env.PATH` is put
   * back afterwards, because `execTool` inherits it.
   */
  async function runUnder(
    extras: Readonly<Record<string, string>> | undefined,
    files: readonly string[],
    timeoutMs?: number,
  ): Promise<ToolResult> {
    const farm = await pathFarm(extras)
    const original = process.env['PATH']
    process.env['PATH'] = farm.path
    try {
      const ctx = { ...runContext(files, scratch), repoRoot: root }
      return await govulncheckRunner.run(timeoutMs === undefined ? ctx : { ...ctx, timeoutMs })
    } finally {
      process.env['PATH'] = original
      await farm.remove()
    }
  }

  it('degrades to not-available with the Go-toolchain reason when go is absent', async () => {
    const result = await runUnder(undefined, ['go.mod', 'main.go'])

    expect(result.state).toBe('not-available')
    expect(result.reason).toBe(GO_ABSENT_REASON)
    expect(result.findings).toEqual([])
  })

  it('parses the stream a real run produces, and stages it as evidence', async () => {
    const result = await runUnder({ go: `#!/bin/sh\ncat ${CAPTURED}` }, ['go.mod', 'main.go'])

    expect(result.state).toBe('ok')
    expect(result.configOwned).toBe(false)
    // `go run <path>@v1.7.0` is an exact spec, so what ran is the pin.
    expect(result.toolVersion).toBe(govulncheckRunner.pinnedVersion)
    expect(result.findings.map((finding) => finding.package?.name)).toEqual([
      'github.com/go-jose/go-jose/v3',
      'golang.org/x/crypto',
    ])
    expect(result.findings[0]?.gradeScope).toBe(true)
    expect(result.findings[1]?.gradeScope).toBe(false)
    expect(result.rawFiles.map((file) => basename(file))).toEqual(['govulncheck.json'])
  })

  /**
   * `execTool` deliberately does not call a non-zero exit a failure — most
   * analyzers exit non-zero when they find something — so a runner that only
   * reads `execution.failure` reports a module that never built as a clean
   * scan. `go run` exits non-zero for the ordinary cases (the module does not
   * compile, the analyzer cannot be fetched on a cold cache, an unsupported
   * `go` directive), and writes `config` and `progress` records to stdout
   * before it gives up — so "nothing parsed" is not "nothing to find".
   */
  it('calls a module that exited non-zero with nothing parsed an error, not a clean scan', async () => {
    const result = await runUnder(
      {
        go: [
          '#!/bin/sh',
          'printf \'{"config": {"scanner_name": "govulncheck"}}\\n\'',
          'echo "go: updates to go.mod needed; to update it: go mod tidy" >&2',
          'exit 1',
        ].join('\n'),
      },
      ['go.mod', 'main.go'],
    )

    expect(result.state).toBe('error')
    expect(result.findings).toEqual([])
    expect(result.reason).toContain('exit 1')
    expect(result.reason).toContain('go: updates to go.mod needed')
  })

  /** The failing run is the one whose evidence a reader most needs. */
  it('stages stderr, so a failed module leaves evidence behind', async () => {
    const result = await runUnder({ go: '#!/bin/sh\necho "go: build failed" >&2\nexit 1' }, [
      'go.mod',
      'main.go',
    ])

    expect(result.rawFiles.map((file) => basename(file))).toEqual(['govulncheck.stderr.txt'])
    expect(await readFile(result.rawFiles[0] ?? '', 'utf8')).toContain('go: build failed')
  })

  /** A tool that found something still reports it, whatever its exit code. */
  it('keeps the findings of a module that exited non-zero after reporting them', async () => {
    const result = await runUnder({ go: `#!/bin/sh\ncat ${CAPTURED}\nexit 3` }, [
      'go.mod',
      'main.go',
    ])

    expect(result.state).toBe('ok')
    expect(result.findings).toHaveLength(2)
  })
})
