package main

import "fmt"

func main() {
	fmt.Println(Describe(true))
}

// Describe says how loudly a run should announce itself. The `== true` is one
// lint plant: golangci-lint's default staticcheck suite reports it as S1002.
func Describe(verbose bool) string {
	if verbose == true {
		return "verbose"
	}
	return "quiet"
}

// unusedHelper is called from nowhere: the second lint plant, reported by the
// default `unused` linter.
func unusedHelper() int {
	return 41
}
