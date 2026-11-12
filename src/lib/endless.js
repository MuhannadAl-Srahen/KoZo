// Endless lists (Games like, Discounts). Pure, no imports: scripts/test-parsers.js loads it as text.

// The cards already on screen keep their places when more arrive: those of `next` that were
// shown, in the order shown, then the rest of `next` in its own order. Without it a later batch
// sorted by match or by discount could land above what the user was looking at.
export function keepShown(prevKeys, next, keyOf = (g) => g.appid) {
  const list = next || []
  if (!prevKeys || !prevKeys.length) return list
  const byKey = new Map(list.map(g => [keyOf(g), g]))
  const head = []
  const seen = new Set()
  for (const k of prevKeys) {
    const g = byKey.get(k)
    if (g && !seen.has(k)) { head.push(g); seen.add(k) }
  }
  return [...head, ...list.filter(g => !seen.has(keyOf(g)))]
}
