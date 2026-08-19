# go-basic fixture

An untooled Go repo: one root module (`go.mod`, `module example.com/go-basic`)
with no `staticcheck.conf`, no `.golangci.*` and no `.gremlins.*`, so every
runner works from the machine's Go toolchain and crank-health's own defaults.
`main.go` calls every other function, which is what keeps a dead-code plant
from drowning in honestly-unreferenced exported symbols.

Planted, one per category the Go adapter reaches:

| Category    | Where                     | What                                                                 |
| ----------- | ------------------------- | -------------------------------------------------------------------- |
| format      | `unformatted.go`          | spacing and indentation `gofmt` rewrites → one `gofmt/unformatted` finding |
| duplication | `dupe_a.go` / `dupe_b.go` | the same 18-line accumulator body under two names → nonzero `duplicationPercent` |

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
