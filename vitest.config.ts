import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: {
      // govulncheck's public vulnerability database gains advisories
      // continuously, so a suite that reads it grades the same commit
      // differently in a month. Every run therefore reads a checked-in
      // snapshot instead — `test/support/vulndb`, whose `index/` is empty by
      // construction and so cannot report an advisory against anything.
      //
      // Resolved against this file's own URL, not `process.cwd()`, so a run
      // started from a subdirectory still finds it. No trailing slash:
      // govulncheck's `-db file://<dir>` names the directory that *holds*
      // `index/`. The `??` is what lets an explicitly set value — an
      // air-gapped mirror, or a deliberate check against the live database —
      // win over the default.
      CRANK_GOVULNCHECK_DB:
        process.env['CRANK_GOVULNCHECK_DB'] ??
        new URL('./test/support/vulndb', import.meta.url).href,
    },
  },
})
