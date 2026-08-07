# cs-multi-target fixture

A `<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` project (criterion 15):
the deep build compiles once per TFM, each compilation writes its own
`<sarif base>.<tfm>.sarif`, and every diagnostic therefore arrives twice in the
merged log. The parser's dedupe must collapse the copies — the planted
diagnostics each appear **exactly once** in the report:

| Rule   | Where                        | What                                       |
| ------ | ---------------------------- | ------------------------------------------ |
| CS0219 | `Sensor.cs` (`unused` local) | compiler warning → one `types` finding     |
| CS0414 | `Sensor.cs` (`unusedReading`)| compiler warning → one `types` finding     |
| CA1823 | `Sensor.cs` (`unusedReading`)| injected analyzer → one `lint` finding     |

`test/deep-csharp-e2e.test.ts` asserts the once-per-rule counts.

The fixture's own `.gitignore` keeps `bin/`/`obj/` out of the fixture commit:
an editor's design-time build may drop MSBuild output here, and the commit sha
must depend only on the planted files.
