# mixed-cs fixture

A two-project repo mixing JS/TS and C#: the root is a JS project, and `dotnet/`
holds **two manifests** — `App.csproj` *and* a `package.json` — with only C#
source beside them. That is criterion 4's two-manifest case: the manifest alone
declares `js-ts` into the dotnet project's `languages` (canonical order
`['js-ts', 'csharp']`), while the JS/TS adapter, which detects on files, has
nothing to run there — so the dotnet entry's deep categories keep the quick
profile's deferral reason instead of picking up an empty JS grade.

Planted so both projects land findings in the rollup's combined categories:

| Category    | Language | Where                                   | What                                    |
|-------------|----------|-----------------------------------------|-----------------------------------------|
| lint        | JS       | `dupe-keys.js`                          | `no-dupe-keys` (oxlint)                 |
| format      | JS       | `unformatted.js`                        | does not match prettier's defaults      |
| format      | C#       | `dotnet/unformatted.cs`                 | misindented lines and missing operator spacing → one dotnet-format finding |
| duplication | C#       | `dotnet/dupe-a.cs` / `dotnet/dupe-b.cs` | identical `Accumulate` method, kept within the C# project |

`index.js` is the entry point named by `package.json#main` and imports all
three sibling modules; `greet.ts` is the one TypeScript source, there so tsc
owns the types category (no `tsconfig.json` — it runs under the materialized
default config) and the root project's `types` is *graded*, the standing guard
that the scan-wide `--deep` deferral never leaks into a project whose own
runners answered. `index.js`, `greet.ts` and `dotnet/clean.cs` are deliberately
clean and well-formatted — a finding in any of them is a false positive — so
each project's format grade stays hand-checked at 1 failing file of 4, and the
rollup's at 2 of the combined 8.

`dotnet/.gitignore` keeps `bin/`/`obj/` out of the fixture commit: an editor's
design-time build may drop MSBuild output there, and the commit sha must depend
only on the planted files. `test/cs-scan.test.ts` carries the machine-readable
half of this table (`MIXED_CS_PLANTED`); keep the two in step.
