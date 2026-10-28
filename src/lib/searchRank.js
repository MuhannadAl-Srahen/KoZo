// Add Game / Add to Game List search: Steam hits and SteamGridDB ("not on
// Steam") hits in ONE list, best name match first. Searching "League of
// Legends" used to list ten unrelated Steam titles above the exact match.
//
// Returns [{ kind: 'steam', game } | { kind: 'sgdb', hit }].

export const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// 4 exact, 3 starts with the query, 2 contains it, 1 shares the first word, 0 other.
export function matchScore(query, name) {
  const q = normName(query), n = normName(name)
  if (!q || !n) return 0
  if (n === q) return 4
  if (n.startsWith(q)) return 3
  if (n.includes(q)) return 2
  const firstWord = String(query).trim().toLowerCase().split(/\s+/)[0]
  if (firstWord && String(name).toLowerCase().includes(firstWord)) return 1
  return 0
}

export function rankResults(query, steam = [], sgdb = []) {
  const onSteam = new Set(steam.map(g => normName(g.name)))
  const rows = [
    ...steam.map((game, i) => ({ kind: 'steam', game, score: matchScore(query, game.name), order: i })),
    ...sgdb.filter(h => !onSteam.has(normName(h.name)))
      .map((hit, i) => ({ kind: 'sgdb', hit, score: matchScore(query, hit.name), order: 100 + i })),
  ]
  // Higher score first; on a tie Steam keeps its place ahead of SteamGridDB.
  return rows.sort((a, b) => b.score - a.score || a.order - b.order)
}
