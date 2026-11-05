// The Upcoming top bar: which games the calendar shows. Pure.
//   like   = games Steam rates as similar to yours (they have a match %), nothing else
//   others = every release without a match
//   all    = every release

export function readPickMode(stored) {
  if (stored === 'like' || stored === 'others' || stored === 'all') return stored
  return stored === 'picked' ? 'like' : null   // 'picked' = this button's old name
}

// No choice made yet: games like yours once there are any, so someone new doesn't
// open Upcoming on an empty calendar.
export function defaultPickMode(picks) {
  return Object.keys(picks?.picks || {}).length ? 'like' : 'all'
}

// The same buckets, holding only the games this choice shows. A day or month left
// with nothing is dropped, so no empty day is drawn.
export function filterBuckets(buckets, mode) {
  if (mode !== 'like' && mode !== 'others') return buckets
  const keep = (g) => (mode === 'like') === (Number(g.match) > 0)
  const narrow = (map) => {
    const out = new Map()
    for (const [key, list] of map) {
      const kept = list.filter(keep)
      if (kept.length) out.set(key, kept)
    }
    return out
  }
  return { byDay: narrow(buckets.byDay), byMonth: narrow(buckets.byMonth), later: buckets.later.filter(keep), all: buckets.all.filter(keep) }
}

// What a day shows before "+N more": best match first for games like yours, most
// popular first otherwise.
export function pickDay(list, mode) {
  const pop = (g) => Math.min(g.wishRank ?? 1e4, g.popRank ?? 1e4)
  if (mode === 'like') return [...list].sort((a, b) => (b.match || 0) - (a.match || 0) || pop(a) - pop(b)).slice(0, 5)
  return [...list].sort((a, b) => pop(a) - pop(b)).slice(0, 8)
}
