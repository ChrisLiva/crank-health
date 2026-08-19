package main

import "fmt"

func main() {
	values := []int{3, 1, 4, 1, 5}
	fmt.Println(AccumulateFirst(values))
	fmt.Println(AccumulateSecond(values))
	fmt.Println(Widen(7))
}
