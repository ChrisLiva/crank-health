# mono-py-web fixture

A Python repo with a JS app in a subdirectory — the layout every tool that
takes its cwd as its project root gets wrong. The root owns no JS tooling and
has no `package.json`; `web/` has both, so the JS tools' answers must come
from running *there*, and reach the report under `web/`-prefixed paths.

| Project | Language      | Manifest           | Owns                     |
|---------|---------------|--------------------|--------------------------|
| `.`     | Python + JS   | `pyproject.toml`   | nothing (all defaults)   |
| `web`   | JS            | `web/package.json` | Biome, via `web/biome.json` |

`scripts/hook.js` is the one JS file that partitions to the root: no ancestor
of the root has a `package.json`, so knip has no entry points to resolve there
and its row is `not-available`, saying so. Every other JS tool grades that
file from the bundled defaults.

Planted in `web`:

| Category  | Where                 | What                                            |
|-----------|-----------------------|-------------------------------------------------|
| lint      | `web/src/both.js`     | one `==`, reported by Biome, tagged `repo-config` |
| format    | `web/src/unformatted.js` | does not match Biome's formatter             |
| dead code | `web/src/orphan.js`   | `unusedHelper` is exported and never imported (fallow and knip, one row) |
| dead code | `web/src/mode.ts`     | enum member `Slow` is never read — knip's alone, which is what proves knip's paths come back under `web/` |

Biome reads its config from the directory it runs in and refuses a `biome.json`
it meets *below* that directory as a nested root, so run from the repo root
against `web/src/*.js` it exits on the configuration — that is the failure this
fixture keeps fixed. Everything else matches Biome's default formatting, so a
format finding on any other file is a false positive.
