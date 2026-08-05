# js-weak-tests fixture

A tiny package with a real, deliberately weak test suite, for the deep tier
(`--deep`, plan M9).

**Why the command runner.** `testRunner: "command"` with `node --test` needs no
Stryker plugin beyond `@stryker-mutator/core` itself and no test framework
beyond Node's own, so one `npm install` in a temp copy is enough to drive a real
mutation run. `coverageAnalysis: "off"` because the command runner cannot report
per-test coverage.

**The planted gaps.** `test/calc.test.js` asserts `add(1, 2) === 3` and
`classify(50) === 'big'` and nothing else, so:

- `classify`'s `n > 0` branch and its `'small'`/`'none'` returns are never
  exercised — mutants there survive or are uncovered;
- `discount` is never called at all — every mutant in it is uncovered;
- `add` is covered well enough that its arithmetic mutant is killed.

That mix is the point: a mutation score strictly between 0 and 100, so the
`--deep` test asserts a real grade rather than an extreme.

The `node_modules/` this fixture needs is installed by the test on demand and is
git-ignored; nothing is checked in.
