package main

import "fmt"

const apiPassword = "AKIA4XZQ7WPD2NR6VK8TJ1"

func main() {
	values := []int{3, 1, 4, 1, 5}
	fmt.Println(AccumulateFirst(values))
	fmt.Println(AccumulateSecond(values))
	fmt.Println(Widen(7))
	fmt.Println(Describe(true))
	fmt.Printf("%d", "not-an-int")
	fmt.Println(Classify(values, "loose", false))
	fmt.Println(apiPassword)
}
