export function merge(rows) {
  let out = []
  for (const row of rows) {
    out = [...out, row]
  }
  return out
}
