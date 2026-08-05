# js-multi-tool fixture

A repo that owns *two* linters — a flat `eslint.config.js` and a `biome.json` —
plus Biome's formatter. Spec §1: "multiple tools detected for one category →
run all, merge findings … grade on the union", and equally: a category the repo
already owns does not also get crank-health's default imposed on it, so oxlint
and prettier stand down here.

Planted:

| Category | Where                | What                                                    |
|----------|----------------------|---------------------------------------------------------|
| lint     | `src/both.js`        | one `==`, reported by ESLint *and* Biome, both tagged `repo-config` |
| format   | `src/unformatted.js` | does not match Biome's formatter                        |

Everything else matches Biome's default formatting, so a format finding on any
other file is a false positive.
