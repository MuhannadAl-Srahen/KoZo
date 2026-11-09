// The Upcoming top bar: which games the calendar shows. Pure.
//   steam  = For you on Steam: the Steam wishlist and games like the ones played most on
//            Steam (electron/services/steamForYou.js)
//   like   = games Steam rates as similar to yours (they have a match %), nothing else
//   others = every release without a match
//   all    = every release

export function readPickMode(stored) {
  if (stored === 'steam' || stored === 'like' || stored === 'others' || stored === 'all') return stored
  return stored === 'picked' ? 'like' : null   // 'picked' = this button's old name
}

// No choice made yet: Steam's picks when signed in to the store, else games like
// yours once there are any, so someone new doesn't open Upcoming on an empty calendar.
export function defaultPickMode(picks, steamSignedIn = false) {
  if (steamSignedIn) return 'steam'
  return Object.keys(picks?.picks || {}).length ? 'like' : 'all'
}

// The same buckets, holding only the given app ids (Steam's picks).
export function onlyIds(buckets, ids) {
  const keep = (g) => ids.has(Number(g.appid))
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

const dayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d) }

// Steam's calendar: Monday to Friday, one row per week from this week (from next
// week on a weekend, like Steam's), up to lastKey. A Saturday or Sunday release
// shows on the Monday after, as Steam does. byDay: Map("YYYY-MM-DD" -> games).
export function weekRows(byDay, todayKey, lastKey) {
  const moved = new Map()
  const put = (k, list) => moved.set(k, [...(moved.get(k) || []), ...list])
  for (const [k, list] of byDay) {
    const d = dayOf(k)
    const dow = d.getDay()
    if (dow === 6 || dow === 0) {
      const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (dow === 6 ? 2 : 1))
      put(dayKeyOf(mon), list)
    } else put(k, list)
  }
  const today = dayOf(todayKey)
  const dow = today.getDay()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (dow === 6 ? 2 : dow === 0 ? 1 : 1 - dow))
  // To the last day with games, a weekend release's Monday included.
  const endKey = [todayKey, lastKey || todayKey, ...moved.keys()].sort().pop()
  const end = dayOf(endKey)
  const rows = []
  for (let w = start; w <= end || rows.length === 0; w = new Date(w.getFullYear(), w.getMonth(), w.getDate() + 7)) {
    const cells = []
    for (let i = 0; i < 5; i++) {
      const d = new Date(w.getFullYear(), w.getMonth(), w.getDate() + i)
      const k = dayKeyOf(d)
      cells.push({ key: k, date: d, list: moved.get(k) || [], past: k < todayKey })
    }
    rows.push({ key: dayKeyOf(w), cells })
    if (rows.length > 60) break
  }
  return rows
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
  if (mode === 'steam') return [...list].sort((a, b) => (a.steamRank ?? 1e4) - (b.steamRank ?? 1e4)).slice(0, 8)
  if (mode === 'like') return [...list].sort((a, b) => (b.match || 0) - (a.match || 0) || pop(a) - pop(b)).slice(0, 5)
  return [...list].sort((a, b) => pop(a) - pop(b)).slice(0, 8)
}
