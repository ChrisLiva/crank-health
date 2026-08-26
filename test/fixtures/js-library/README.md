# js-library fixture

A published JS package: `package.json` declares `exports` and `types`, which is
what makes this repo a library rather than an application — its consumers live
outside the tree, so "nothing here imports it" is not evidence an export is
dead. `private: true` does not veto that; packages published from a private
manifest by a release pipeline are common.

Planted:

| Category  | Where          | What                                                                              |
|-----------|----------------|-----------------------------------------------------------------------------------|
| dead-code | `src/util.js`  | `subtract` is exported and never imported; the repo is a library, so the finding is advisory |

Everything else is deliberately clean; a finding elsewhere is a false positive.
`src/util.js` is byte-identical to `js-basic/src/clean.js`, whose README records
that both fallow and knip catch `subtract` — the same planted shape, graded
differently because of the manifest.
`run` in `src/index.js` returns `0 + add(a, b)` rather than `add(a, b)` so aislop's
`thin-wrapper` stays quiet; `src/util.js` is untouched.
