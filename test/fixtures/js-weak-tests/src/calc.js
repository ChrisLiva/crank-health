export function add(a, b) {
  return a + b
}

export function classify(n) {
  if (n > 10) {
    return 'big'
  }
  if (n > 0) {
    return 'small'
  }
  return 'none'
}

export function discount(total, member) {
  if (member && total > 100) {
    return total * 0.9
  }
  return total
}
