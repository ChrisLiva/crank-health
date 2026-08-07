# cs-ca1502-suppressed fixture

A repo whose own `.globalconfig` (default `global_level` 100) turns CA1502 off,
outranking the injected config's `global_level = 0` (criterion 17). The deep
build succeeds, `Quiet.cs` holds real methods, and yet the SARIF carries zero
CA1502 records — which crank-health must read as
`complexity: not-assessed(CA1502 suppressed by the repo's analyzer config)`,
never as a flattering "no complex functions" A.

The same build still grades the other two compiled categories: `unusedTally`
plants CS0414 (`types`) and CA1823 (`lint`).

The fixture's own `.gitignore` keeps `bin/`/`obj/` out of the fixture commit:
an editor's design-time build may drop MSBuild output here, and the commit sha
must depend only on the planted files.
