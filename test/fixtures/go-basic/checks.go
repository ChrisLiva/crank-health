package main

// Describe says how loudly a run should announce itself.
func Describe(verbose bool) string {
	if verbose == true {
		return "verbose"
	}
	return "quiet"
}

// unusedHelper is called from nowhere: the dead-code plant.
func unusedHelper() int {
	return 41
}
