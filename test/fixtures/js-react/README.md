# js-react fixture

An untooled React app: `react` is a declared dependency, the sources are `.jsx`,
and there is no linter, formatter, type-checker or `tsconfig.json` of its own —
so react-doctor runs on crank-health's pinned ephemeral copy, tsc reports
`not-available`, and the fixture needs no install.

Planted, six findings and no more:

| Category | Tool         | Where               | What                                                        |
|----------|--------------|---------------------|-------------------------------------------------------------|
| lint     | react-doctor | `src/Counter.jsx:4` | `rerender-state-only-in-handlers` (Performance → advisory)   |
| lint     | react-doctor | `src/Counter.jsx:16`| `control-has-associated-label` (Accessibility → advisory)    |
| lint     | react-doctor | `src/List.jsx:5`    | `no-array-index-as-key` (Bugs → advisory)                    |
| format   | prettier     | `src/Counter.jsx:1` | does not match prettier's defaults                           |
| format   | prettier     | `src/List.jsx:1`    | does not match prettier's defaults                           |
| format   | prettier     | `src/index.jsx:1`   | does not match prettier's defaults                           |

The three format findings are deliberate: the source is written without
semicolons and with single quotes, and prettier's defaults want semicolons and
double-quoted strings, so every source file is unformatted and `format` grades F
here. Do not reformat this tree — the line/column values above are what the
parse and scan tests assert.

Everything else is deliberately clean; anything else is a false positive.
`src/index.jsx` is the entry point named by `package.json#main`, which is what
keeps the dead-code tools quiet.
