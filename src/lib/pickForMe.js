// "Pick for me": choose the next game from Up next, weighted by taste.
//
// weight = 1
//        + 3 x (sum of your taste weights for the game's genres)   steam:tasteProfile, 0..1 each
//        + 1 when it's in your Library and installed (playable right now)
//        + 0.5 when it's a favourite
//
// Pure functions, so scripts/test-parsers.js can check them with a fixed rand.

function genresOf(item) {
  if (Array.isArray(item.genres)) return item.genres
  try { const g = JSON.parse(item.genres || '[]'); return Array.isArray(g) ? g : [] } catch { return [] }
}

export function scoreCandidates(items, weights = {}, { playableIds = new Set() } = {}) {
  return items.map(item => {
    const genres = genresOf(item)
    const matched = genres
      .map(g => ({ name: g, w: weights[String(g).toLowerCase()] || 0 }))
      .filter(m => m.w > 0)
      .sort((a, b) => b.w - a.w)
    const taste = matched.reduce((sum, m) => sum + m.w, 0)
    const playable = !!(item.game_id && playableIds.has(item.game_id))
    const weight = 1 + 3 * taste + (playable ? 1 : 0) + (item.is_favorite ? 0.5 : 0)
    return { item, weight, playable, because: matched.slice(0, 2).map(m => m.name) }
  })
}

// Weighted random choice; `avoidId` (the last pick) is skipped when there is
// anything else to choose, so Roll again always changes the answer.
export function pickWeighted(scored, rand = Math.random, avoidId = null) {
  const pool = scored.length > 1 && avoidId != null ? scored.filter(s => s.item.id !== avoidId) : scored
  if (!pool.length) return null
  const total = pool.reduce((sum, s) => sum + s.weight, 0)
  let r = rand() * total
  for (const s of pool) {
    r -= s.weight
    if (r < 0) return s
  }
  return pool[pool.length - 1]
}
