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

Everything else is deliberately clean. `src/index.js` is each package's entry
point (`package.json#main`), which is what keeps the dead-code tools from
calling the other modules unreachable.

`node_modules` is gitignored here because the hoisted-install test plants one:
crank-health must run the binary the workspace root installed rather than its own
pinned copy, and the only honest way to assert that is a real installed binary.
