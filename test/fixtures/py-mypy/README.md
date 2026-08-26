# py-mypy fixture

The same two files as `py-venv`, plus the one thing that changes which type
checker crank-health defers to: this repo owns **mypy**. It says so twice — a
`[tool.mypy]` section *and* a `mypy` entry in the `dev` dependency group — so
detection reports `config+dependency`, owned via `pyproject.toml`.

No virtualenv is checked in (a venv cannot be), so as committed this fixture is
the honest-degradation case: mypy is declared but has no environment to resolve
imports against, reports `not-available`, and the standby it claimed the
category from — **ty** — grades types instead and the report carries a warning
saying so. `.gitignore` keeps a venv created by a test out of `git status`, so
the zero-footprint assertion still means something.

| Category | Where    | What                                                                                       |
|----------|----------|--------------------------------------------------------------------------------------------|
| types    | `app.py` | `label` is annotated `-> str` and returns an `int` (mypy `return-value`; ty sees it too when promoted) |

Everything else is deliberately clean: `main.py` calls both functions, so vulture
reports nothing, and no function is anywhere near the complexity ceiling.
`total` returns `0 + sum(values)` rather than `sum(values)` so aislop's
`thin-wrapper` stays quiet; `label` stays on lines 5 and 6.
