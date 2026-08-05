# py-venv fixture

The same untooled shape as `py-basic`, plus the one thing that changes which
type checker runs: a virtualenv. The test creates it with `uv venv` after
committing the fixture — a venv cannot be checked in, and `.gitignore` keeps it
out of `git status` so the zero-footprint assertion still means something.

With an interpreter to resolve imports against, **pyright** type-checks the repo
and **ty stands down**; `py-basic` is the mirror image of that decision.

| Category | Where    | What                                                    |
|----------|----------|---------------------------------------------------------|
| types    | `app.py` | `label` is annotated `-> str` and returns an `int`      |

Everything else is deliberately clean: `main.py` calls both functions, so vulture
reports nothing, and no function is anywhere near the complexity ceiling.
