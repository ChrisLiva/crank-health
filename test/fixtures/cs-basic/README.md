# cs-basic fixture

An untooled C#-only repo: one root `App.csproj` with a bare `PackageReference`
— no `.editorconfig`, no `.globalconfig`, no solution file — so every runner
works from the machine's SDK and its defaults. It is a small executable:
`main.cs` holds the entry point and references every other class, so the only
symbols with zero references are the two planted ones — in a library every
public type is honestly unreferenced, and the dead-code plant would drown in
that noise.

Planted, one per category the C# adapter reaches. The format and duplication
plants fire in the quick tier; the complexity, lint and dead-code plants are
deep-tier — their runners are `deepOnly`, so they fire under `--deep`
(`test/deep-csharp-e2e.test.ts`):

| Category    | Where                     | What                                                                       |
| ----------- | ------------------------- | -------------------------------------------------------------------------- |
| format      | `unformatted.cs`          | misindented lines and missing operator spacing → one dotnet-format finding |
| duplication | `dupe-a.cs` / `dupe-b.cs` | identical `Accumulate` method (28 lines) → nonzero `duplicationPercent`    |
| complexity  | `complex.cs`              | `Classify` is over the ceiling of 15: 17 by hand-count (1 + if ×6, `&&`, `else if`, `\|\|`, `for`, `case` ×4, `while`, ternary), and 18 as CA1502 reports it (Roslyn's count includes one branch the hand-count's convention does not) — both agree it is over |
| lint        | `warnings.cs`             | unused private field `unusedCount` → CA1823 under the injected `.globalconfig` |
| dead-code   | `dead.cs`                 | unreferenced public method `NeverCalled` (line 10) → roslynator `unused-method`; the unused field above doubles as its `unused-field` companion in `warnings.cs` |

The fixture's own `.gitignore` keeps `bin/`/`obj/` out of the fixture commit:
an editor's design-time build may drop MSBuild output here, and the commit sha
must depend only on the planted files.

`clean.cs` is deliberately clean — and deliberately well-formatted and
non-duplicating, so it stays out of every denominator's numerator; a finding
there is a false positive. `main.cs` and `dead.cs` hold the same line: both
are well-formatted and non-duplicating, so the format grade stays hand-checked
at 1 failing file of 8. `test/cs-scan.test.ts` carries the machine-readable
half of this table (`PLANTED`); keep the two in step.
