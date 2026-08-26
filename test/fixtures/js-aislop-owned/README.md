# js-aislop-owned fixture

A repo that owns aislop: `.aislop/config.yml` plus a `devDependencies` entry,
neither of them installed, so a scan lifts the config's `rules` and `exclude`
and runs the pinned 0.14.1 ephemerally.

Planted, as aislop 0.14.1's `ai-slop` engine reports them:

| Category | Where                    | What                                              |
|----------|--------------------------|---------------------------------------------------|
| lint     | `src/index.js:2`         | `ai-slop/duplicate-import`, warning: `node:fs` imported twice |
| lint     | `src/index.js:3`         | `ai-slop/hallucinated-import`, error: `definitely-not-a-declared-package` is in no dependency block |
| lint     | `src/index.js:5`         | `ai-slop/todo-stub`, info: a `// TODO` comment, turned off by the repo's config |
| lint     | `src/index.js:9`         | `ai-slop/swallowed-exception`, error: `catch (error) {}` |
| lint     | `src/excluded.js:4`      | `ai-slop/swallowed-exception`, error: excluded by the repo's config |

The config turns `ai-slop/todo-stub` off and excludes `src/excluded.js`, so a
scan of this fixture reports three of the five rows. `test/captured/aislop-0.14.1.json`
was taken over the same two files under the generated config with neither lift
applied, so the capture holds all five and the parse tests see every severity
tier.

Everything else is deliberately clean; a finding elsewhere is a false positive.
