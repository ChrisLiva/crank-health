# js-basic fixture

An untooled JS repo: no linter, formatter, type-checker or dead-code config of
its own, so every runner falls back to crank-health's bundled defaults and every
finding is tagged `default-config`.

Planted, one per category the JS/TS adapter can reach without a repo config:

| Category  | Where                  | What                                            |
|-----------|------------------------|-------------------------------------------------|
| lint      | `src/accumulate.js`    | `no-accumulating-spread` (perf → advisory)      |
| lint      | `src/const-assign.js`  | `no-const-assign`                               |
| lint      | `src/dupe-keys.js`     | `no-dupe-keys`                                  |
| lint      | `src/unreachable.js`   | `no-unreachable` · also aislop's `ai-slop/unreachable-code` (same statement, second tool) |
| format    | `src/unformatted.js`   | does not match prettier's defaults              |
| dead-code | `src/clean.js`         | `subtract` is exported and never imported (fallow and knip both see it; the report keeps one finding) |
| complexity| `src/complex.js`       | `classify` is over cognitive complexity 15      |

Everything else is deliberately clean; a finding elsewhere is a false positive.
`src/index.js` is the entry point named by `package.json#main`, which is what
lets the dead-code tools tell "unreachable" from "nothing reaches anything".
