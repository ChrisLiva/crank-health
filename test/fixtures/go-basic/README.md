# go-basic fixture

An untooled Go repo: a root module (`go.mod`, `module example.com/go-basic`)
and a nested one (`brokenpkg/go.mod`), with no `staticcheck.conf`, no
`.golangci.*` and no `.gremlins.*`, so every runner works from the machine's Go
toolchain and crank-health's own defaults. `main.go` calls every other root
function, which is what keeps the dead-code plant from drowning in honestly
unreferenced exported symbols.

Planted, one per category the Go adapter reaches:

| Category    | Where                     | What                                                                 |
| ----------- | ------------------------- | -------------------------------------------------------------------- |
| format      | `unformatted.go`          | spacing and indentation `gofmt` rewrites → one `gofmt/unformatted` finding |
| duplication | `dupe_a.go` / `dupe_b.go` | the same 18-line accumulator body under two names → nonzero `duplicationPercent` |
| lint        | `checks.go`               | `if verbose == true` → one staticcheck `S1002` |
| dead-code   | `checks.go`               | `unusedHelper`, called from nowhere → one staticcheck `U1000` |
| types       | `brokenpkg/broken.go`     | a `string` returned where the signature promises `int` → one staticcheck `compile` |

## The `brokenpkg/` module

`brokenpkg` carries its own `go.mod`, so it is a project of its own and
`./...` in the root module stops at its boundary. That is what lets one fixture
hold a compile error *and* a real completed analysis: a type error puts the
tools that load the package graph into `error` for the project that holds it,
and here that project is `brokenpkg` alone.

## The `vendor/` tree

`vendor/example.com/dep/` holds a copied dependency: `dep.go` is unformatted
*and* carries a third copy of the accumulator body, and `vendor/modules.txt`
and the vendored `go.mod` are the bookkeeping `go mod vendor` writes. None of
it is the repo's own source, so it must produce no finding, add no KLOC and
make no project of its own — while `vendor/modules.txt` (not Go source) stays
in the file inventory, because a scan that pretended a file did not exist would
be lying about the tree it read.

The `require example.com/dep v1.0.0` in `go.mod` is what makes the vendored
copy a real dependency rather than a stray directory; nothing imports it, so
the module still builds with `GOFLAGS=-mod=readonly` and needs no `go.sum`.

`test/go-scan.test.ts` carries the machine-readable half of the table above
(`PLANTED`); keep the two in step.
