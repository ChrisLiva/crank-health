# go-owned fixture

A Go repo that owns its own linter: one module (`go.mod`), one source file, and
a `.golangci.yml` written in golangci-lint's v2 dialect (`version: "2"`, the
`standard` linter set). That config is the whole point of the tree — it is what
makes `golangci-lint` a `repoOwnedOnly` owner of `lint`, which claims the
category without suppressing crank-health's own Go linters until it has
actually graded it.

Planted in `main.go`, both reported by the default linter set:

| Linter        | Where                    | What                                                       |
| ------------- | ------------------------ | ---------------------------------------------------------- |
| `staticcheck` | `main.go`, `Describe`    | `if verbose == true` → `S1002: should omit comparison …`    |
| `unused`      | `main.go`, `unusedHelper` | a function called from nowhere → `func unusedHelper is unused` |

`test/captured/golangci-lint-2.12.2.json` is a real
`go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 run
--output.json.path stdout` over a throwaway copy of this tree; re-capture it the
same way when either the pin or this file's plants change. Those bytes carry no
absolute path — v2.12.2 reports `Pos.Filename` relative to the directory it ran
in — so there was nothing to sanitize.

`test/golangci-lint.test.ts` carries the machine-readable half of the table
above; keep the two in step.
