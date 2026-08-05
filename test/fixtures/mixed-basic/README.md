# mixed-basic fixture

A repo with both languages in it, which is what spec §3's mixed-language rule is
about: one grade per category over the combined findings, plus a per-language
breakdown in the report.

Planted so that both languages land in the same categories:

| Category | Language | Where             | What                                   |
|----------|----------|-------------------|----------------------------------------|
| lint     | JS       | `dupe-keys.js`    | `no-dupe-keys` (oxlint)                |
| lint     | Python   | `app.py`          | `F821` undefined name (ruff)           |
| format   | JS       | `unformatted.js`  | does not match prettier's defaults     |
| format   | Python   | `unformatted.py`  | does not match ruff's default format   |
| types    | Python   | `app.py`          | ty `unresolved-reference`              |

`index.js` is the entry point named by `package.json#main` and imports both
other modules; `main.py` calls both Python modules. Nothing is dead, nothing is
complex, and the two `unformatted` files are the only formatting failures — so
the format grade is 2 failures over the *six* source files of both languages,
not over whichever language happens to be bigger.
