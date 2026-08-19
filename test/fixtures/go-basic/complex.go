package main

// Classify folds a slice into one label through a nest of conditions: the
// complexity plant, scored over the ceiling by gocognit.
func Classify(values []int, mode string, strict bool) string {
	label := "none"
	for _, value := range values {
		if value < 0 {
			if strict {
				label = "negative-strict"
			} else if mode == "loose" {
				label = "negative-loose"
			} else {
				label = "negative"
			}
		} else if value == 0 {
			for step := 0; step < 3; step++ {
				if step%2 == 0 && strict {
					label = "zero-even"
				} else if mode == "strict" || len(mode) > 3 {
					label = "zero-odd"
				}
			}
		} else {
			switch {
			case value > 100:
				if strict {
					label = "big-strict"
				}
			case value > 10:
				label = "medium"
			default:
				label = "small"
			}
		}
	}
	return label
}
