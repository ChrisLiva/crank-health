# mono-mixed fixture

Folder-per-service, and **undeclared**: nothing at the root says these are
workspaces — there is no root manifest at all — so the project list comes from
the file partition alone. The root holds no source, so it is a workspace shell
with an empty `declaredBy`.

| Project        | Language | Manifest                      |
|----------------|----------|-------------------------------|
| `services/api` | Python   | `services/api/pyproject.toml` |
| `services/web` | JS       | `services/web/package.json`   |

`services/go-api` is a third service and *not* a third project: it is a
`go.mod` and nothing else — no Go source, so no file partitions to it and it
stays a shell. It is here for the one row it earns, govulncheck's, which is
repo-scoped and owned via `services/go-api/go.mod`. Having no package to
analyze it is also the only row whose live state is `error` rather than a
finding — the honest answer for a scan that measured nothing — and the empty
vulnerability database the suite pins (`test/support/vulndb`) is what keeps
that row from ever acquiring an advisory as the public database grows.

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

knip resolves a repo's entry points from the `package.json` in the directory it
runs from and never looks upward for one, so in a layout with no root manifest
it runs from `services/web` — the nearest package that names its entry points —
and its paths come back under `services/web/`. Run from the repo root instead
it would find no manifest and exit on that, which is the row this fixture
guards against.
