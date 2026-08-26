# py-basic fixture

An untooled Python repo: `pyproject.toml` carries project metadata and nothing
else — no `[tool.*]` section, no declared tooling — so every runner falls back to
crank-health's bundled defaults and every finding is tagged `default-config`.

Planted, one per category the Python adapter can reach without a repo config:

| Category   | Where                | What                                                   |
|------------|----------------------|--------------------------------------------------------|
| lint       | `undefined_name.py`  | `F821` undefined name (pyflakes → graded)              |
| lint       | `dead.py`            | `F401` unused import (pyflakes → graded); also aislop's `ai-slop/unused-import` on the same line |
| types      | `undefined_name.py`  | ty `unresolved-reference` on the same name             |
| format     | `unformatted.py`     | does not match ruff's default formatting               |
| dead-code  | `dead.py`            | unused `import os` — vulture 90% → graded              |
| dead-code  | `dead.py`            | unused function `never_called` — vulture 60% → advisory |
| complexity | `complex.py`         | `classify` has cognitive complexity 38, ceiling 15     |

`main.py` imports and calls every other module, which is what keeps vulture from
reporting the deliberately-live functions as dead. `clean.py` is deliberately
clean; a finding there is a false positive.

There is no virtualenv here, so ty type-checks the repo and pyright stands down
(spec: "ty (beta) → pyright when venv exists").
