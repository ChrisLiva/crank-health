package dep

// Name is deliberately unformatted and deliberately duplicated from
// `dupe_a.go`: nothing under `vendor/` is the repo's own source, so no runner
// may report it and no KLOC denominator may count it.
func Name(  ) string {
return "dep"
}

func AccumulateVendored(values []int) int {
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
