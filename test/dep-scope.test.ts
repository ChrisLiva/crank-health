import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OSV_PACKAGE_RULE, OSV_SCANNER_TOOL } from '../src/adapters/common/osv-scanner.ts'
import type { DependencyScope } from '../src/core/dep-scope.ts'
import {
  NPM_LOCK,
  PNPM_LOCK,
  applyDependencyScopes,
  classifyLockfile,
  scopeIn,
} from '../src/core/dep-scope.ts'
import type { Finding, ToolRunner } from '../src/core/types.ts'
import { scanTree } from '../src/run.ts'
import { buildReport } from '../src/render/json.ts'
import { makeFinding, makeReportInput } from './factories.ts'
import type { FixtureRepo } from './support/fixture.ts'
import { createFixtureRepo } from './support/fixture.ts'

/**
 * Dependency scope — which half of a `package.json` pulls a vulnerable package
 * in.
 *
 * The pnpm fixture is a verbatim copy of a real three-importer workspace's
 * `pnpm-lock.yaml` (`/Users/chris/GitHub/brew-pg`, lockfileVersion 9.0), kept
 * whole so the prod closure is walked over the shape pnpm actually writes:
 * scoped names, peer-suffixed snapshot keys, `link:` workspace references and
 * all. The `package-lock.json` fixture is hand-built, because npm's inline
 * flags are the whole of what has to be read and a real tree's copy would be
 * noise around them.
 */

const PNPM_FIXTURE = fileURLToPath(new URL('./captured/pnpm-lock-9.0.yaml', import.meta.url))
const NPM_FIXTURE = fileURLToPath(new URL('./captured/package-lock-3.json', import.meta.url))

const pnpmLock = async (): Promise<string> => readFile(PNPM_FIXTURE, 'utf8')
const npmLock = async (): Promise<string> => readFile(NPM_FIXTURE, 'utf8')

/** How many packages a classification put in each scope. */
function tally(scopes: ReadonlyMap<string, DependencyScope>): Record<DependencyScope, number> {
  const counts: Record<DependencyScope, number> = { prod: 0, dev: 0, unknown: 0 }
  for (const scope of scopes.values()) counts[scope] += 1
  return counts
}

describe('classifyLockfile over pnpm-lock.yaml', () => {
  it('splits the workspace into a prod closure and everything only a dev root reaches', async () => {
    const { packages, notes } = classifyLockfile(PNPM_LOCK, await pnpmLock())

    // The fixture's 1150 snapshot keys are 1149 distinct `name@version`
    // packages (one package is stored under two peer resolutions). Walking the
    // three importers' runtime roots reaches 791 of them; the other 358 are
    // reachable only from a `devDependency`. Cross-checked by walking the dev
    // roots separately: that closure is 582 packages, 224 of which the runtime
    // closure also reaches, and 791 + 358 accounts for every package — no entry
    // is called dev-only merely because nothing referenced it.
    expect(packages.size).toBe(1149)
    expect(tally(packages)).toEqual({ prod: 791, dev: 358, unknown: 0 })
    expect(notes).toEqual([])
  })

  it('reaches a package only a peer-suffixed snapshot key names', async () => {
    const scopes = classifyLockfile(PNPM_LOCK, await pnpmLock())

    // `@base-ui/react` is stored as
    // `@base-ui/react@1.6.0(@types/react@19.2.17)(react-dom@…)(react@19.2.7)`;
    // a reader that split the key on `@` or ignored the suffix misses it.
    expect(scopeIn(scopes, '@base-ui/react', '1.6.0')).toBe('prod')
    expect(scopeIn(scopes, 'react', '19.2.7')).toBe('prod')
  })

  it('calls the toolchain only devDependencies pull in dev', async () => {
    const scopes = classifyLockfile(PNPM_LOCK, await pnpmLock())

    expect(scopeIn(scopes, '@biomejs/biome', '2.4.5')).toBe('dev')
    expect(scopeIn(scopes, 'vitest', '4.1.10')).toBe('dev')
    expect(scopeIn(scopes, 'jsdom', '28.1.0')).toBe('dev')
    expect(scopeIn(scopes, '@stryker-mutator/vitest-runner', '9.6.1')).toBe('dev')
    expect(scopeIn(scopes, '@testing-library/dom', '10.4.1')).toBe('dev')
  })

  it('ships a package a runtime dependency lists as an optional peer', async () => {
    const scopes = classifyLockfile(PNPM_LOCK, await pnpmLock())

    // `typescript` is a devDependency of two importers *and* the optional peer
    // of `cosmiconfig`, which `shadcn` — a runtime dependency of `web` —
    // depends on. pnpm records a resolved optional peer under a snapshot's
    // `optionalDependencies`, so the runtime closure reaches it, and reaching
    // it at all is what keeps the finding graded.
    expect(scopeIn(scopes, 'typescript', '6.0.3')).toBe('prod')
  })

  it('resolves an aliased install under the name it is published as', async () => {
    const scopes = classifyLockfile(PNPM_LOCK, await pnpmLock())

    // Depended on as `h3-v2: h3@2.0.1-rc.20`; the snapshot is `h3@2.0.1-rc.20`.
    expect(scopeIn(scopes, 'h3', '2.0.1-rc.20')).toBe('prod')
    expect(scopeIn(scopes, 'h3-v2', 'h3@2.0.1-rc.20')).toBe('unknown')
  })

  it('walks a dependency cycle once instead of forever', () => {
    const scopes = classifyLockfile(
      PNPM_LOCK,
      [
        'lockfileVersion: 9.0',
        'importers:',
        '  .:',
        '    dependencies:',
        '      a:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        'snapshots:',
        "  'a@1.0.0':",
        '    dependencies:',
        '      b: 2.0.0',
        "  'b@2.0.0':",
        '    dependencies:',
        '      a: 1.0.0',
        '',
      ].join('\n'),
    )

    expect(tally(scopes.packages)).toEqual({ prod: 2, dev: 0, unknown: 0 })
  })

  it('treats an importer’s own optional dependency as shipped', () => {
    const scopes = classifyLockfile(
      PNPM_LOCK,
      [
        'lockfileVersion: 9.0',
        'importers:',
        '  .:',
        '    optionalDependencies:',
        '      fsevents:',
        '        specifier: ^2.3.3',
        '        version: 2.3.3',
        'snapshots:',
        "  'fsevents@2.3.3': {}",
        '',
      ].join('\n'),
    )

    expect(scopeIn(scopes, 'fsevents', '2.3.3')).toBe('prod')
  })

  it('leaves a reference with no snapshot entry unknown, and says so once', () => {
    const scopes = classifyLockfile(
      PNPM_LOCK,
      [
        'lockfileVersion: 9.0',
        'importers:',
        '  .:',
        '    dependencies:',
        '      ghost:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        '      other:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        'snapshots:',
        "  'kept@1.0.0': {}",
        '',
      ].join('\n'),
    )

    expect(scopeIn(scopes, 'ghost', '1.0.0')).toBe('unknown')
    expect(scopeIn(scopes, 'other', '1.0.0')).toBe('unknown')
    expect(scopes.notes).toHaveLength(1)
    expect(scopes.notes[0]).toMatch(/2 packages/)
  })

  it('ignores a workspace link, which is a directory rather than a package', () => {
    const scopes = classifyLockfile(
      PNPM_LOCK,
      [
        'lockfileVersion: 9.0',
        'importers:',
        '  .:',
        '    dependencies:',
        '      local:',
        '        specifier: workspace:*',
        '        version: link:../local',
        'snapshots: {}',
        '',
      ].join('\n'),
    )

    expect(scopes.packages.size).toBe(0)
    expect(scopes.notes).toEqual([])
  })

  it('reads an empty lockfile as nothing at all', () => {
    expect(classifyLockfile(PNPM_LOCK, '').packages.size).toBe(0)
  })
})

describe('classifyLockfile over package-lock.json', () => {
  it('reads npm’s inline dev flags, prod closure and all', async () => {
    const { packages } = classifyLockfile(NPM_LOCK, await npmLock())

    expect(tally(packages)).toEqual({ prod: 6, dev: 3, unknown: 0 })
  })

  it('calls a runtime dependency and everything under it prod', async () => {
    const scopes = classifyLockfile(NPM_LOCK, await npmLock())

    expect(scopeIn(scopes, '@scope/runtime', '1.0.0')).toBe('prod')
    expect(scopeIn(scopes, 'minimist', '1.2.5')).toBe('prod')
    expect(scopeIn(scopes, 'semver', '7.7.1')).toBe('prod')
  })

  it('calls a dev-flagged package and its own nested tree dev', async () => {
    const scopes = classifyLockfile(NPM_LOCK, await npmLock())

    expect(scopeIn(scopes, 'typescript', '5.9.2')).toBe('dev')
    expect(scopeIn(scopes, 'semver', '6.3.1')).toBe('dev')
  })

  it('resolves an aliased install under the name the advisory database uses', async () => {
    const scopes = classifyLockfile(NPM_LOCK, await npmLock())

    // Installed at `node_modules/uglify`, published as `uglify-js`.
    expect(scopeIn(scopes, 'uglify-js', '3.19.3')).toBe('dev')
    expect(scopeIn(scopes, 'uglify', '3.19.3')).toBe('unknown')
  })

  it('keeps an optional and a devOptional dependency in the shipped set', async () => {
    const scopes = classifyLockfile(NPM_LOCK, await npmLock())

    expect(scopeIn(scopes, 'fsevents', '2.3.3')).toBe('prod')
    expect(scopeIn(scopes, 'graceful-fs', '4.2.11')).toBe('prod')
  })

  it('keeps a package installed twice prod when either copy ships', async () => {
    const scopes = classifyLockfile(NPM_LOCK, await npmLock())

    // `tslib@2.8.1` is under `@scope/runtime` and, dev-flagged, under typescript.
    expect(scopeIn(scopes, 'tslib', '2.8.1')).toBe('prod')
  })
})

describe('classifyLockfile when it cannot answer', () => {
  it('reads a malformed pnpm lockfile as nothing classified', () => {
    const scopes = classifyLockfile(PNPM_LOCK, 'importers:\n  .:\n   - broken: [oops\n')

    expect(scopes.packages.size).toBe(0)
    expect(scopes.notes).toHaveLength(1)
    expect(scopes.notes[0]).toMatch(/could not be read/)
  })

  it('declines an npm 6 lockfile, which carries no packages map', () => {
    const scopes = classifyLockfile(
      NPM_LOCK,
      JSON.stringify({ lockfileVersion: 1, dependencies: { lodash: { version: '4.17.15' } } }),
    )

    expect(scopes.packages.size).toBe(0)
    expect(scopes.notes).toHaveLength(1)
  })

  it('classifies nothing from a lockfile format it does not read', () => {
    const scopes = classifyLockfile('yarn.lock', 'lodash@^4.17.15:\n  version "4.17.15"\n')

    expect(scopes.packages.size).toBe(0)
    // Not a failure: yarn.lock is simply outside what this reads, and every
    // package in it stays graded.
    expect(scopes.notes).toEqual([])
  })
})

/** An osv-scanner-shaped npm dependency finding, as the runner emits one. */
function packageFinding(overrides: Partial<Finding> = {}): Finding {
  return makeFinding({
    category: 'security',
    tool: OSV_SCANNER_TOOL,
    rule: OSV_PACKAGE_RULE,
    severity: 'error',
    file: 'package-lock.json',
    message: 'typescript@5.9.2 (npm): 1 advisory; fix: upgrade to ≥5.9.3',
    package: { name: 'typescript', version: '5.9.2', ecosystem: 'npm' },
    packageAdvisories: [
      {
        id: 'GHSA-aaaa',
        aliases: ['CVE-1'],
        severity: 'error',
        summary: 'the advisory',
        fixedIn: '5.9.3',
      },
    ],
    fixHint: 'Upgrade typescript to ≥5.9.3; see https://osv.dev/vulnerability/GHSA-aaaa',
    ...overrides,
  })
}

describe('applyDependencyScopes', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-dep-scope-'))
    await writeFile(join(root, 'package-lock.json'), await npmLock())
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('demotes a package only a devDependency pulls in, and says why', async () => {
    const { findings } = await applyDependencyScopes(root, [packageFinding()])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.gradeScope).toBe(false)
    expect(findings[0]?.packageAdvisories?.[0]?.scope).toBe('dev')
    expect(findings[0]?.message).toContain('advisory only: dev')
  })

  it('keeps a runtime dependency graded, and records the scope that says so', async () => {
    const { findings } = await applyDependencyScopes(root, [
      packageFinding({ package: { name: 'minimist', version: '1.2.5', ecosystem: 'npm' } }),
    ])

    expect(findings[0]?.gradeScope).toBe(true)
    expect(findings[0]?.packageAdvisories?.[0]?.scope).toBe('prod')
  })

  it('leaves a package the lockfile never mentions graded and unscoped', async () => {
    const { findings } = await applyDependencyScopes(root, [
      packageFinding({ package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' } }),
    ])

    expect(findings[0]?.gradeScope).toBe(true)
    expect(findings[0]?.packageAdvisories?.[0]?.scope).toBeUndefined()
  })

  it('leaves every finding that is not an npm dependency exactly as it was', async () => {
    const given = [
      makeFinding(),
      packageFinding({
        package: { name: 'requests', version: '2.0.0', ecosystem: 'PyPI' },
        file: 'poetry.lock',
      }),
    ]
    const { findings } = await applyDependencyScopes(root, given)

    expect(findings).toEqual(given)
  })

  it('grades a package whose lockfile is absent, and does not say it is dev', async () => {
    const { findings, warnings } = await applyDependencyScopes(root, [
      packageFinding({ file: 'web/package-lock.json' }),
    ])

    expect(findings[0]?.gradeScope).toBe(true)
    expect(findings[0]?.packageAdvisories?.[0]?.scope).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('grades every package of a lockfile it could not parse, and warns once', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'crank-dep-scope-broken-'))
    await writeFile(join(broken, 'package-lock.json'), '{ "packages": ')
    try {
      const { findings, warnings } = await applyDependencyScopes(broken, [
        packageFinding(),
        packageFinding({ package: { name: 'minimist', version: '1.2.5', ecosystem: 'npm' } }),
      ])

      expect(findings.every((finding) => finding.gradeScope)).toBe(true)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('package-lock.json')
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
  })
})

describe('the report a dev-scoped advisory lands in', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'crank-dep-scope-report-'))
    await writeFile(join(root, 'package-lock.json'), await npmLock())
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('puts it in advisories[] with its scope, and leaves the prod one graded', async () => {
    const { findings } = await applyDependencyScopes(root, [
      packageFinding(),
      packageFinding({
        id: 'cafebabecafebabe',
        package: { name: 'minimist', version: '1.2.5', ecosystem: 'npm' },
      }),
    ])
    const report = buildReport(makeReportInput({ findings }))

    expect(report.advisories.map((row) => row.package?.name)).toEqual(['typescript'])
    expect(report.advisories[0]?.packageAdvisories?.[0]?.scope).toBe('dev')
    expect(report.findings.map((row) => row.package?.name)).toEqual(['minimist'])
    expect(report.findings[0]?.packageAdvisories?.[0]?.scope).toBe('prod')
  })
})

/** A stand-in runner that reports what the test hands it, and nothing else. */
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
    fixture = await createFixtureRepo('sec-basic')
    scratch = await mkdtemp(join(tmpdir(), 'crank-dep-scope-scan-'))
  })

  afterAll(async () => {
    await fixture.remove()
    await rm(scratch, { recursive: true, force: true })
  })

  it('scopes a dependency finding against the repo’s own lockfile before grading', async () => {
    const tree = await scanTree({
      repoRoot: fixture.root,
      scratch,
      only: ['security'],
      adapters: [
        {
          language: 'common',
          detect: () => Promise.resolve(true),
          runners: [
            emitting(OSV_SCANNER_TOOL, [
              packageFinding({ package: { name: 'lodash', version: '4.17.15', ecosystem: 'npm' } }),
            ]),
          ],
        },
      ],
    })

    // sec-basic's lockfile pins lodash as a runtime dependency, so the finding
    // is graded and the report says which scope decided that.
    expect(tree.scan.findings).toHaveLength(1)
    expect(tree.scan.findings[0]?.gradeScope).toBe(true)
    expect(tree.scan.findings[0]?.packageAdvisories?.[0]?.scope).toBe('prod')
    expect(await fixture.status()).toBe('')
  })
})
