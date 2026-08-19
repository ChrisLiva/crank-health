package main

// AccumulateSecond sums, counts and bounds a slice in one pass.
func AccumulateSecond(values []int) int {
	total := 0
	count := 0
	minimum := 1 << 30
	maximum := -(1 << 30)
	for _, value := range values {
		total += value
		count += 1
		if value < minimum {
			minimum = value
		}
		if value > maximum {
			maximum = value
		}
	}
	if count == 0 {
		return 0
	}
	return total + minimum + maximum
}
