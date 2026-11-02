// "Picked for you" on Upcoming: how well an upcoming game matches what your
// Game List says you like (steamApi.getTasteProfile in main). Pure, so
// scripts/test-parsers.js can check it.
//
// profile = { tagWeights: { tagId: -1..1 }, sources: [{ name, appid, weight, tags }], tagNames }
// game tags = Steam tag ids, most voted first (steamApi.getAppAssets).

// The best a game could score: the profile's strongest tags in the best order.
function ceiling(profile) {
  if (profile._ceiling != null) return profile._ceiling
  const top = Object.values(profile.tagWeights || {}).filter(w => w > 0).sort((a, b) => b - a).slice(0, 10)
  let c = 0
  top.forEach((w, i) => { c += w * (1 - i * 0.06) })
  Object.defineProperty(profile, '_ceiling', { value: c || 1, enumerable: false })
  return profile._ceiling
}

// 0..100. A game sharing your top few tags lands around 70 to 95; one that
// shares nothing, or leans on tags of games you dropped, lands near 0.
export function matchScore(tags, profile) {
  if (!profile || !tags?.length) return 0
  const w = profile.tagWeights || {}
  let raw = 0
  tags.slice(0, 12).forEach((t, i) => { raw += (w[t] || 0) * (1 - i * 0.06) })
  if (raw <= 0) return 0
  return Math.max(0, Math.min(99, Math.round((raw / ceiling(profile)) * 115)))
}

// The Game List game this one is most like: the source sharing the most
// heavily weighted tags. { name, shared: ['Metroidvania', 'Souls-like'] } or null.
export function matchReason(tags, profile) {
  if (!profile?.sources?.length || !tags?.length) return null
  const mine = new Set(tags.slice(0, 12).map(String))
  let best = null, bestScore = 0
  for (const src of profile.sources) {
    if (!(src.weight > 0)) continue
    const shared = src.tags.filter(t => mine.has(String(t)))
    if (shared.length < 2) continue
    const score = shared.reduce((a, t) => a + Math.max(0, profile.tagWeights?.[t] || 0), 0) * Math.sqrt(src.weight)
    if (score > bestScore) { bestScore = score; best = { src, shared } }
  }
  if (!best) return null
  const names = profile.tagNames || {}
  const shared = best.shared
    .sort((a, b) => (profile.tagWeights?.[b] || 0) - (profile.tagWeights?.[a] || 0))
    .map(t => names[t]).filter(Boolean).slice(0, 2)
  return { name: best.src.name, appid: best.src.appid, shared }
}

export const MATCH_MIN = 35   // "Picked for you" keeps games at or above this

export function matchTone(pct) {
  if (pct >= 70) return 'high'
  if (pct >= 50) return 'mid'
  return 'low'
}
