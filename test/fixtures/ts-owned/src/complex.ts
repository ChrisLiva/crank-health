export function classify(a: number, b: number, c: number, d: number): number {
  let score = 0
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        score += 1
      } else if (d > 0) {
        score += 2
      } else {
        score += 3
      }
    } else {
      for (const x of [1, 2, 3]) {
        if (x > a && b < c) {
          score += x
        }
      }
    }
  } else if (b > 0) {
    while (score < 10) {
      score += 1
      if (score === 5) {
        break
      }
    }
  } else {
    switch (c) {
      case 1:
        score = 1
        break
      case 2:
        score = 2
        break
      default:
        score = 3
    }
  }
  return score > 0 && b > 0 ? score : a || b || c || d
}
