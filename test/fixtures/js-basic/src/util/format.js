export function titleCase(word) {
  if (word.length === 0) {
    return word
  }
  return word[0].toUpperCase() + word.slice(1)
}
