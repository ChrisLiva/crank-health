import type { Category, Finding, Severity } from '../src/core/types.ts'

/** A minimal valid finding; override only what the assertion is about. */
export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'deadbeefdeadbeef',
    category: 'lint',
    tool: 'oxlint',
    rule: 'no-unused-vars',
    severity: 'warning',
    file: 'src/a.ts',
    range: { startLine: 1, startCol: 1, endLine: 1, endCol: 2 },
    message: 'unused variable',
    provenance: 'default-config',
    gradeScope: true,
    ...overrides,
  }
}

/** `count` identical findings — for driving density and count bands. */
export function makeFindings(
  count: number,
  severity: Severity,
  category: Category = 'lint',
  overrides: Partial<Finding> = {},
): Finding[] {
  return Array.from({ length: count }, (_, index) =>
    makeFinding({ severity, category, file: `src/f${index}.ts`, ...overrides }),
  )
}
