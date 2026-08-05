export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-')
}

export function unusedHelper(value: string): string {
  return value.padStart(8, '.')
}
