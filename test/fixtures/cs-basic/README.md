# cs-basic fixture

An untooled C#-only repo: one root `App.csproj` with a bare `PackageReference`
— no `.editorconfig`, no `.globalconfig`, no solution file — so every runner
works from the machine's SDK and its defaults.

Planted, one per category the C# adapter reaches (the complexity and lint
plants are dormant until the deep-only build and analyzer runners land):

| Category    | Where                     | What                                                                       |
| ----------- | ------------------------- | -------------------------------------------------------------------------- |
| format      | `unformatted.cs`          | misindented lines and missing operator spacing → one dotnet-format finding |
| duplication | `dupe-a.cs` / `dupe-b.cs` | identical `Accumulate` method (28 lines) → nonzero `duplicationPercent`    |
| complexity  | `complex.cs`              | `Classify` has cyclomatic complexity 17 by hand-count (1 + if ×6, `&&`, `else if`, `\|\|`, `for`, `case` ×4, `while`, ternary), ceiling 15 — dormant until the deep build runner lands |
| lint        | `warnings.cs`             | unused private field `unusedCount` → CA1823 under the injected `.globalconfig` — dormant until the deep build runner lands |

The fixture's own `.gitignore` keeps `bin/`/`obj/` out of the fixture commit:
an editor's design-time build may drop MSBuild output here, and the commit sha
must depend only on the planted files.

`clean.cs` is deliberately clean — and deliberately well-formatted and
non-duplicating, so it stays out of every denominator's numerator; a finding
there is a false positive. `test/cs-scan.test.ts` carries the machine-readable
half of this table (`PLANTED`); keep the two in step.
