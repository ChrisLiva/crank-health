import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { banditRunner } from '../src/adapters/common/bandit.ts'
import { gitleaksRunner, invocationArgs as gitleaksArgs } from '../src/adapters/common/gitleaks.ts'
import { invocationArgs as jscpdArgs, jscpdRunner } from '../src/adapters/common/jscpd.ts'
import { commonAdapter } from '../src/adapters/common/index.ts'
import {
  invocationArgs as opengrepArgs,
  materializeRules,
  opengrepRunner,
} from '../src/adapters/common/opengrep.ts'
import { OPENGREP_RULES } from '../src/adapters/common/opengrep-rules.ts'
import {
  isDatabaseUnreachable,
  invocationArgs as osvArgs,
  osvScannerRunner,
} from '../src/adapters/common/osv-scanner.ts'
import { zizmorRunner } from '../src/adapters/common/zizmor.ts'
import { ADAPTERS } from '../src/adapters/index.ts'

/**
 * The command lines, asserted without running anything.
 *
 * Two spec promises are decided entirely by how these arguments are built, and
 * neither shows up in a parse test: the license rule (plan's retiring check —
 * "no default invocation fetches registry packs") and zero footprint (spec §7 —
 * every tool writes into the scratch dir, and no repo-mutating subcommand is
 * reachable).
 */

const SCRATCH = '/scratch'
const REPO = '/repo'

describe('the license rule', () => {
  /**
   * Plan risk table: "Semgrep rules license → offline LGPL snapshot by default;
   * M6 test asserts no default registry fetch."
   */
  it('never puts a registry pack, `auto` or a URL into opengrep’s --config', () => {
    const args = opengrepArgs(join(SCRATCH, 'opengrep', 'crank-health-rules.yaml'), ['/repo/a.js'])
    const config = args[args.indexOf('--config') + 1]
    expect(config).toBe('/scratch/opengrep/crank-health-rules.yaml')
    expect(args).not.toContain('auto')
    expect(args.some((arg) => arg.startsWith('p/'))).toBe(false)
    expect(args.some((arg) => /^https?:\/\//.test(arg))).toBe(false)
    expect(args.some((arg) => arg.includes('semgrep.dev'))).toBe(false)
  })

  it('disables opengrep’s version phone-home', () => {
    expect(opengrepArgs('/scratch/rules.yaml', [])).toContain('--disable-version-check')
  })

  /** The rules that make the grade have to be ours, and local. */
  it('materializes the bundled ruleset into scratch, byte for byte', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'crank-rules-'))
    try {
      const path = await materializeRules(scratch)
      expect(path.startsWith(scratch)).toBe(true)
      expect(await readFile(path, 'utf8')).toBe(OPENGREP_RULES)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe('zero footprint, in the arguments', () => {
  /** jscpd's default reporter writes `report/` into the working directory. */
  it('redirects jscpd’s report into the scratch dir', () => {
    const args = jscpdArgs(REPO, join(SCRATCH, 'jscpd'))
    expect(args[args.indexOf('--output') + 1]).toBe('/scratch/jscpd')
    expect(args).toContain('--reporters')
    expect(args.at(-1)).toBe(REPO)
  })

  it('keeps jscpd out of .git and dependency directories', () => {
    const args = jscpdArgs(REPO, SCRATCH)
    const ignore = args[args.indexOf('--ignore') + 1] ?? ''
    for (const excluded of ['.git', 'node_modules', '.venv', '__pycache__']) {
      expect(ignore).toContain(excluded)
    }
  })

  it('writes gitleaks’ report into the scratch dir, redacted', () => {
    const args = gitleaksArgs(REPO, join(SCRATCH, 'gitleaks.json'))
    expect(args[0]).toBe('dir')
    expect(args).toContain('--redact=100')
    expect(args[args.indexOf('--report-path') + 1]).toBe('/scratch/gitleaks.json')
    // "Found a secret" must not read as "gitleaks failed".
    expect(args[args.indexOf('--exit-code') + 1]).toBe('0')
  })

  /** Spec §7's block-list names `osv-scanner fix` explicitly. */
  it('never builds a mutating osv-scanner subcommand', () => {
    const args = osvArgs(REPO, join(SCRATCH, 'osv-scanner.json'))
    expect(args.slice(0, 2)).toEqual(['scan', 'source'])
    expect(args).not.toContain('fix')
    expect(args[args.indexOf('--output-file') + 1]).toBe('/scratch/osv-scanner.json')
  })
})

describe('osv-scanner degradation', () => {
  /**
   * Spec §8: a scan that could not reach the advisory database must say so, not
   * report a clean dependency tree it never checked.
   */
  it.each([
    'failed to get vulnerabilities: dial tcp: lookup api.osv.dev: no such host',
    'Get "https://api.deps.dev/v3alpha": context deadline exceeded',
    'error: net/http: TLS handshake timeout',
    'connection refused',
  ])('recognizes an unreachable database in %s', (stderr) => {
    expect(isDatabaseUnreachable(stderr)).toBe(true)
  })

  it('does not mistake an ordinary failure for a network problem', () => {
    expect(isDatabaseUnreachable('No package sources found, --help for usage information.')).toBe(
      false,
    )
    expect(isDatabaseUnreachable('')).toBe(false)
  })
})

describe('the common adapter', () => {
  it('is registered, after the two language adapters', () => {
    expect(ADAPTERS.at(-1)).toBe(commonAdapter)
    expect(commonAdapter.language).toBe('common')
  })

  /**
   * Spec "Categories and tools" lists security as a union of complementary
   * scanners, so none of them may stand another down (see
   * `ToolRunner.complementary` and the orchestrator test).
   */
  it('marks every security runner complementary', () => {
    const security = commonAdapter.runners.filter((runner) => runner.category === 'security')
    expect(security.map((runner) => runner.tool).toSorted()).toEqual([
      'bandit',
      'gitleaks',
      'opengrep',
      'osv-scanner',
      'zizmor',
    ])
    expect(security.every((runner) => runner.complementary === true)).toBe(true)
  })

  /** Duplication has exactly one tool, so it needs no such exemption. */
  it('leaves jscpd as an ordinary default', () => {
    expect(jscpdRunner.category).toBe('duplication')
    expect(jscpdRunner.complementary).toBeUndefined()
  })

  it('records a version for every runner', () => {
    for (const runner of [
      gitleaksRunner,
      opengrepRunner,
      zizmorRunner,
      banditRunner,
      osvScannerRunner,
      jscpdRunner,
    ]) {
      expect(runner.pinnedVersion).toMatch(/^\d+\.\d+/)
    }
  })
})
