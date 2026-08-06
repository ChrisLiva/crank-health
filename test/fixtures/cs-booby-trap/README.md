# cs-booby-trap fixture

The quick profile's "never executes repo code" proof for C# (criterion 5). The
`App.csproj` hooks a `Trap` target before `Restore` and `CoreCompile`: any
MSBuild evaluation of the project writes `evaluated.txt` into the repo.

A quick scan must complete with `evaluated.txt` absent and `git status`
clean — `dotnet format whitespace --folder` treats the tree as plain files and
never loads the project. Only `--deep` may trip this trap, and the deep build
runner runs against a copy, never the target.
