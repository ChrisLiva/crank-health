# mono-js fixture

A declared npm workspace: the root `package.json` has a `workspaces` field and no
source of its own, so the root is a **workspace shell** and the projects are the
two packages under `packages/`.

The two packages are deliberately tooled differently, which is what the
per-project dimension is for:

| Project        | Owns                        | Via                              |
|----------------|-----------------------------|----------------------------------|
| `packages/web` | ESLint (its own flat config) | `packages/web/eslint.config.js`  |
| `packages/api` | nothing of its own           | —                                |
| both           | prettier                     | the **root** `package.json` — a hoisted declaration inherited by every package |

Planted, one per thing a monorepo scan has to get right:

| Category    | Where                                | What                                                        |
|-------------|--------------------------------------|-------------------------------------------------------------|
| lint        | `packages/web/src/lint.js`           | `no-unused-vars`, reported by the package's **own ESLint**   |
| lint        | `packages/api/src/const-assign.js`   | `no-const-assign`, reported by **oxlint** — the default that stood down in `web` |
| format      | `packages/api/src/unformatted.js`    | does not match prettier's defaults; `web` has no format failure, so the two packages' format grades differ |
| duplication | `packages/{api,web}/src/shared.js`   | byte-identical modules: a clone **between** packages, which is in neither package's own measurement and only in the rollup's |
| complexity  | `packages/web/src/tokens.js`         | scores over fta's file threshold — and no function in it is anywhere near the **cognitive** ceiling the grade uses, so complexity stays A and every finding is advisory. It is also the file that proves fta's paths are rebased: a score reported as `src/tokens.js` has to arrive as `packages/web/src/tokens.js`, in `packages/web` |

Two files exist for what must **not** be reported. `packages/api/src/cross.js`
is imported only by `packages/web/src/index.js`, so it is reachable only from
the other package: a dead-code walk scoped to `packages/api` calls it an unused
file, and reachability is not a question one package can answer — the walk is
the repo's. `packages/web/src/tokens.js` exports five lookups and
`packages/web/src/index.js` uses all five, so nothing there is unused either.

Everything else is deliberately clean. `src/index.js` is each package's entry
point (`package.json#main`), which is what keeps the dead-code tools from
calling the other modules unreachable.

`.crank/hooks/hook.ts` is tooling scope under a hidden directory, and it is
broken twice over — an implicitly-`any` parameter and an unused local — so a
scan that reached it would report a types finding and a lint finding. Nothing
in any artifact names it, which is what makes the scan-scope rule an assertion
rather than an empty promise.

`node_modules` is gitignored here because the hoisted-install test plants one:
crank-health must run the binary the workspace root installed rather than its own
pinned copy, and the only honest way to assert that is a real installed binary.
