# py-weak-tests fixture

The Python half of the deep tier (`--deep`, plan M9): a package with a real but
deliberately weak pytest suite, for cosmic-ray (mutation) and coverage.py.

**The layout is deliberate.** The test file sits at the repo root rather than in
`tests/`, because pytest's default import mode puts the test file's directory on
`sys.path` — from the root, `import pkg` resolves without an installed package
or a `conftest.py`.

**The planted gaps.** `test_calc.py` asserts `add(1, 2) == 3` and
`classify(50) == "big"`: `classify`'s second branch is never exercised and
`shipping` is never called, so roughly half the mutants survive and several
lines are uncovered.

The virtualenv this fixture needs is built by the test on demand (`uv venv` plus
`uv pip install`) and is git-ignored; nothing is checked in.
