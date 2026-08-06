import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MUTANT_TIMEOUT_SECONDS,
  buildCosmicRayConfig,
  cosmicRayCounts,
  cosmicRayRunner,
  mutationScope,
  mutationTargets,
  parseCosmicRayDump,
  toPendingFindings,
} from '../src/adapters/python/cosmic-ray.ts'
import type { RunContext } from '../src/core/types.ts'
import { makeProject } from './factories.ts'

/**
 * cosmic-ray wrapper: the captured `cosmic-ray dump` a real 8.4.6 session
 * produced (13 killed, 14 survived over a deliberately weak suite), the TOML
 * config crank-health generates, and the PR scoping expressed in the two
 * settings cosmic-ray has.
 */

const CAPTURED = fileURLToPath(new URL('./captured/cosmic-ray-8.4.6.jsonl', import.meta.url))

const CONTEXT: RunContext = {
  repoRoot: '/repo',
  project: makeProject([
    'pkg/__init__.py',
    'pkg/calc.py',
    'pkg/util.py',
    'tests/test_calc.py',
    'test_top.py',
  ]),
  files: ['pkg/__init__.py', 'pkg/calc.py', 'pkg/util.py', 'tests/test_calc.py', 'test_top.py'],
  scratch: '/scratch',
  detection: {
    reason: 'dependency',
    configFiles: [],
    installed: true,
    binPath: '/venv/bin/cosmic-ray',
  },
  timeoutMs: 1_000,
  deep: true,
}

describe('parsing a session dump', () => {
  it('reads every mutant with its operator, definition and position', async () => {
    const mutants = parseCosmicRayDump(await readFile(CAPTURED, 'utf8'))

    expect(mutants).toHaveLength(27)
    expect(mutants[0]).toEqual({
      file: 'calcpkg/calc.py',
      operator: 'core/ReplaceBinaryOperator_Add_Sub',
      definition: 'add',
      // `[2, 13]` in the dump: a 1-based line and a 0-based column.
      startLine: 2,
      startCol: 14,
      endLine: 2,
      endCol: 15,
      testOutcome: expect.any(String) as unknown as string,
      workerOutcome: 'normal',
    })
  })

  it('counts the captured session as 13 detected and 14 undetected', async () => {
    expect(cosmicRayCounts(parseCosmicRayDump(await readFile(CAPTURED, 'utf8')))).toEqual({
      detected: 13,
      undetected: 14,
    })
  })

  it('treats a worker timeout as detected and an incompetent mutant as neither', () => {
    const dump = [
      line('killed', 'normal'),
      line('survived', 'normal'),
      line(undefined, 'timeout'),
      line('incompetent', 'normal'),
    ].join('\n')
    expect(cosmicRayCounts(parseCosmicRayDump(dump))).toEqual({ detected: 2, undetected: 1 })
  })

  it('rejects output that is not a session dump', () => {
    expect(() => parseCosmicRayDump('not json at all')).toThrow(/work items/)
  })

  it('reads an empty session as no mutants rather than as an error', () => {
    expect(parseCosmicRayDump('')).toEqual([])
  })
})

describe('surviving mutants as findings', () => {
  it('reports only the survivors, graded, with the operator and function named', async () => {
    const findings = toPendingFindings(parseCosmicRayDump(await readFile(CAPTURED, 'utf8')))

    expect(findings).toHaveLength(14)
    expect(findings[0]).toMatchObject({
      category: 'test-quality',
      tool: 'cosmic-ray',
      rule: 'cosmic-ray/survived-mutant',
      severity: 'warning',
      file: 'calcpkg/calc.py',
      provenance: 'repo-config',
      gradeScope: true,
    })
    expect(findings[0]?.message).toMatch(/^Mutant survived: core\/\w+ in `\w+` — every test/)
  })
})

describe('the generated config', () => {
  it('names the virtualenv interpreter absolutely and keeps state out of the repo', () => {
    const config = buildCosmicRayConfig({
      modulePath: '/repo/pkg',
      excludedModules: ['pkg/util.py'],
      interpreter: '/repo/.venv/bin/python',
    })

    expect(config).toContain('module-path = "/repo/pkg"')
    expect(config).toContain('excluded-modules = ["pkg/util.py"]')
    expect(config).toContain('test-command = "/repo/.venv/bin/python -m pytest')
    expect(config).toContain('-p no:cacheprovider')
    expect(config).toContain(`timeout = ${MUTANT_TIMEOUT_SECONDS.toFixed(1)}`)
    expect(config).toContain('name = "local"')
  })
})

describe('scoping', () => {
  it('mutates the source files and not the tests', () => {
    expect(mutationTargets(CONTEXT)).toEqual(['pkg/__init__.py', 'pkg/calc.py', 'pkg/util.py'])
  })

  it('narrows to the changed files in a PR', () => {
    expect(
      mutationTargets({ ...CONTEXT, changedFiles: ['pkg/calc.py', 'tests/test_calc.py'] }),
    ).toEqual(['pkg/calc.py'])
  })

  it('uses a single changed file as the module path, with nothing excluded', () => {
    expect(mutationScope(['pkg/calc.py'], CONTEXT.files)).toEqual({
      modulePath: 'pkg/calc.py',
      excluded: [],
    })
  })

  it('uses the containing directory and excludes everything else under it', () => {
    expect(mutationScope(['pkg/calc.py', 'pkg/__init__.py'], CONTEXT.files)).toEqual({
      modulePath: 'pkg',
      excluded: ['pkg/util.py'],
    })
  })

  it('falls back to the repo root when the targets share no directory', () => {
    expect(mutationScope(['a/one.py', 'b/two.py'], ['a/one.py', 'b/two.py', 'c/three.py'])).toEqual(
      {
        modulePath: '.',
        excluded: ['c/three.py'],
      },
    )
  })
})

describe('the runner’s posture', () => {
  it('is deep-only, and never runs on a project that has not adopted it', () => {
    expect(cosmicRayRunner).toMatchObject({
      category: 'test-quality',
      deepOnly: true,
      repoOwnedOnly: true,
      complementary: true,
    })
  })

  it('declines in the quick profile instead of executing repo code', async () => {
    const result = await cosmicRayRunner.run({ ...CONTEXT, deep: false })
    expect(result).toMatchObject({ state: 'not-available' })
    expect(result.reason).toContain('--deep')
  })

  it('explains the in-place mutation posture when the project has not installed it', async () => {
    const result = await cosmicRayRunner.run({
      ...CONTEXT,
      detection: { reason: 'dependency', configFiles: [], installed: false },
    })
    expect(result).toMatchObject({ state: 'not-available' })
    expect(result.reason).toContain('mutates files in place')
  })
})

/** One `cosmic-ray dump` line, with the outcome fields a test is about. */
function line(testOutcome: string | undefined, workerOutcome: string): string {
  return JSON.stringify([
    {
      job_id: 'x',
      mutations: [
        {
          module_path: 'pkg/calc.py',
          operator_name: 'core/ReplaceBinaryOperator_Add_Sub',
          start_pos: [1, 0],
          end_pos: [1, 1],
          definition_name: 'add',
        },
      ],
    },
    {
      worker_outcome: workerOutcome,
      ...(testOutcome === undefined ? {} : { test_outcome: testOutcome }),
    },
  ])
}
