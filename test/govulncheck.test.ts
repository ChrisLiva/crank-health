import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseGovulncheckStream } from '../src/adapters/common/govulncheck.ts'

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
    expect(vulnerabilities.map((entry) => entry.osv)).toEqual(
      [...vulnerabilities.map((entry) => entry.osv)].toSorted(),
    )
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
