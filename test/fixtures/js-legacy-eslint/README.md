# js-legacy-eslint fixture

A repo that owns ESLint on paper only: `package.json` declares it as a
devDependency and `.eslintrc.json` — the sole ESLint config here — configures it
in the eslintrc format the pinned ESLint no longer reads. There is no
`node_modules`, so the repo's own ESLint cannot be run either, and the runner
reports `not-available` rather than a grade it could not earn.

Planted:

| Category | Where           | What                                                   |
|----------|-----------------|--------------------------------------------------------|
| lint     | `src/index.js`  | `no-const-assign`, caught by the promoted oxlint standby |

Everything else is deliberately clean; a finding elsewhere is a false positive.
`src/index.js` is byte-identical to `js-basic/src/const-assign.js`, whose README
and golden record that the pinned oxlint's default config catches this on its
own — so the lint grade here comes from the standby that was promoted when
ESLint stood mute, not from the repo's config.
