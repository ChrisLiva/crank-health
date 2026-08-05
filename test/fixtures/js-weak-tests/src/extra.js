// Never imported by the tests: every mutant here survives, which is what the
// PR-scoped run must stop mutating when this file is not in the diff.
export function shippingCost(weight, express) {
  if (weight > 20) {
    return express ? 40 : 25
  }
  return express ? 15 : 5
}
