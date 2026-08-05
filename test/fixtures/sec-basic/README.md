# sec-basic fixture

An untooled mixed JS + Python repo whose defects are all security or
duplication, so it exercises the `common` adapter. No `[tool.*]` section, no
declared tooling, no security config — every runner falls back to crank-health's
bundled defaults and every finding is tagged `default-config`.

Planted, one per common-adapter runner:

| Category    | Tool         | Where                       | What                                                        |
|-------------|--------------|-----------------------------|-------------------------------------------------------------|
| security    | gitleaks     | `src/config.py:8`           | fake AWS access key id → `critical` → grade F               |
| security    | opengrep     | `src/config.py:13`          | `js-eval`'s Python twin: `subprocess(…, shell=True)`        |
| security    | opengrep     | `src/handler.js:2`          | `eval(userInput)`                                            |
| security    | bandit       | `src/config.py:13`          | `B602` subprocess with `shell=True` — HIGH → graded          |
| security    | bandit       | `src/config.py:3`           | `B404` `import subprocess` — LOW → advisory                  |
| security    | zizmor       | `.github/workflows/ci.yml`  | `pull_request_target` + checkout of the PR head, unpinned    |
| security    | osv-scanner  | `package-lock.json`         | `lodash@4.17.15`, several known advisories                   |
| duplication | jscpd        | `src/handler.js`/`report.js`| `summarize` copied verbatim between two files                |
| lint        | oxlint       | `src/handler.js:2`          | `no-eval` — the same `eval` a linter also objects to         |

`src/index.js` and `src/main.py` exist to keep everything else reachable, so
the fixture has no incidental dead code and no formatting failures. Two advisory
`fallow/complexity` notes on the duplicated function are unavoidable — they are
`gradeScope: false` and move no grade.

**The secret is fake.** The value in `src/config.py` is random characters in
AWS's access-key-id shape. It matches gitleaks' default `aws-access-token` rule,
which is the point, and it has never been a credential for anything. AWS's own
documentation key (the one ending `EXAMPLE`) is on gitleaks' allowlist and would
not have fired. It is deliberately not repeated here: this README is a scanned
file too, and one planted secret means one finding.

**Which tools actually run here.** bandit, zizmor and jscpd are fetched by `uvx`
and `npx` and run everywhere. gitleaks, opengrep and osv-scanner are release
binaries with no npm or PyPI distribution — on a machine without them the
scan reports `not-available` with an install hint, and the tests that depend on
them skip themselves rather than fail (see `test/sec-scan.test.ts`). Their
parsers are covered unconditionally by `test/captured/`.

`.github/workflows/ci.yml` is deliberately a bad workflow, not a working one.
`package-lock.json` pins one old dependency and nothing is installed from it.
