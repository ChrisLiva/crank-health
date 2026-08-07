# cs-custom-targets fixture

A repo that already uses `CustomAfterMicrosoftCommonTargets` — the same MSBuild
hook crank-health's deep build injects its analyzer assets through (criterion
22). The build passes its own targets path as a global `-p:` property, which
takes precedence for the graded build; what this fixture proves is that a repo
already occupying the hook does not break the run: the deep scan completes, no
`dotnet-build` record errors, and the tree stays clean.

`repo-hook.targets` is deliberately benign (a `Message` task): the fixture is
about property collision, not about what the repo's hook does.

The fixture's own `.gitignore` keeps `bin/`/`obj/` out of the fixture commit:
an editor's design-time build may drop MSBuild output here, and the commit sha
must depend only on the planted files.
