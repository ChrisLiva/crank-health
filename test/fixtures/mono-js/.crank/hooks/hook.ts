// Tooling scope, not source: a hook this fixture's "repo" runs, under a hidden
// directory. It is deliberately broken twice over — `payload` is implicitly
// `any` (TS7006) and `label` is an unused local (no-unused-vars) — so any scan
// that reached it would say so, loudly, in two categories.
export function hook(payload) {
  const label = payload.name
  return payload
}
