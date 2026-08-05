# ts-owned fixture

A repo that owns its toolchain: `tsconfig.json`, a flat `eslint.config.js` and a
`.prettierrc.json`, with all three declared in `devDependencies` but never
installed — so every runner honours the repo's config while executing the
manifest-pinned binary ephemerally, and every finding is tagged `repo-config`.

Planted:

| Category   | Where                | What                                             |
|------------|----------------------|--------------------------------------------------|
| types      | `src/types.ts`       | `TS2322`, a string assigned to a `number`         |
| lint       | `src/lint.js`        | `no-unused-vars` (error) and `eqeqeq` (warning)   |
| format     | `src/unformatted.ts` | does not match this repo's prettier settings      |
| dead-code  | `src/util.ts`        | `unusedHelper` is exported and never imported     |
| complexity | `src/complex.ts`     | `classify` is over cognitive complexity 15        |

The ESLint config deliberately scopes itself to `**/*.js`: ESLint's own parser
cannot read TypeScript, so a repo that lints TS installs a parser we must not
assume is there. `src/lint.js` is therefore also the one file no entry point
imports.
