import assert from 'node:assert/strict'
import test from 'node:test'
import { add, classify } from '../src/calc.js'

test('adds two numbers', () => {
  assert.equal(add(1, 2), 3)
})

// Deliberately weak: only the first branch is asserted, and `discount` is never
// called at all. Both gaps are what the mutation run is meant to find.
test('classifies a big number', () => {
  assert.equal(classify(50), 'big')
})
