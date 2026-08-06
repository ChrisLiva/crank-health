# mono-mixed fixture

Folder-per-service, and **undeclared**: nothing at the root says these are
workspaces — there is no root manifest at all — so the project list comes from
the file partition alone. The root holds no source, so it is a workspace shell
with an empty `declaredBy`.

| Project        | Language | Manifest                      |
|----------------|----------|-------------------------------|
| `services/api` | Python   | `services/api/pyproject.toml` |
| `services/web` | JS       | `services/web/package.json`   |

Planted so that each service fails a category the other does not:

| Category | Project        | Where                             | What                                    |
|----------|----------------|-----------------------------------|-----------------------------------------|
| lint     | `services/api` | `greet.py`                        | `F821` undefined name (ruff)            |
| types    | `services/api` | `greet.py`                        | ty `unresolved-reference` on the same name |
| lint     | `services/web` | `src/dupe-keys.js`                | `no-dupe-keys` (oxlint)                 |

Neither service owns any tooling, so every finding is `default-config` and each
project is graded by the bundled defaults for **its own** language: the Python
service never sees oxlint, the JS service never sees ruff.

`main.py` imports `greet.py` and `src/index.js` imports `dupe-keys.js`, so
nothing here is dead.

One tool cannot answer in a layout like this, and says so rather than pretending:
knip resolves a repo's entry points from a root `package.json`, and this repo has
none, so its record is `error` with knip's own message in it. The dead-code
category is still graded, from fallow's verdict.
