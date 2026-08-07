# cs-booby-trap fixture

The quick profile's "never executes repo code" proof for C# (criterion 5). The
`App.csproj` hooks a `Trap` target before `Restore` and `CoreCompile`: any
MSBuild evaluation of the project writes `evaluated.txt` into the repo.

A quick scan must complete with `evaluated.txt` absent and `git status`
clean — `dotnet format whitespace --folder` treats the tree as plain files and
never loads the project. Only `--deep` may trip this trap: the deep build
runner evaluates the target's own project files, with every output redirected
into scratch.

The fixture's own `.gitignore` keeps `bin/`/`obj/` out of the fixture commit:
an editor's design-time build may drop MSBuild output here, and the commit sha
must depend only on the planted files. `evaluated.txt` is deliberately *not*
ignored — a scan that trips the trap must also fail the `git status` check.
