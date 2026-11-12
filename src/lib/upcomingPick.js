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

// How wanted a game is, lower first: its rank on Steam's calendar (wishlists and your taste),
// else its place in the most wishlisted or popular coming soon feed.
export function popRank(g) {
  return Math.min(g?.calOrder ?? 1e4, g?.wishRank ?? 1e4, g?.popRank ?? 1e4)
}

// What a day shows before "+N more": the 5 best matches for games like yours; your Steam picks
// in Steam's order; Other games and All show every game, most wanted first (the maker: "if I
// press All not all the games show", it showed 8 a day).
export function pickDay(list, mode) {
  if (mode === 'steam') return [...list].sort((a, b) => (a.steamRank ?? 1e4) - (b.steamRank ?? 1e4))
  if (mode === 'like') return [...list].sort((a, b) => (b.match || 0) - (a.match || 0) || popRank(a) - popRank(b)).slice(0, 5)
  return [...list].sort((a, b) => popRank(a) - popRank(b))
}

// ── Steam layout, built on Steam's own store index (electron/services/steamCalendar.js) ──
// The controls on Steam's calendar: how many games (10 to 500, or 0 = All, every game with a
// date), wishlisted games Show / Hide / Only, one tag, no Early Access, nothing you own. Items
// come ranked (order 1 = first). Your wishlist and your Game List are always kept unless hidden,
// like on Steam.
export const CALENDAR_COUNTS = [10, 25, 50, 100, 250, 500, 0]
export function calendarShown(items, { count = 100, wish = 'show', tag = null, hideEarly = false, hideOwned = false } = {}) {
  const flagged = (g) => g.onWishlist || g.onList
  let list = (items || []).filter(g =>
    (!hideEarly || (!g.early && !g.v1)) &&
    (!hideOwned || !g.owned) &&
    (!tag || (g.tagIds || []).includes(Number(tag))))
  if (wish === 'only') return list.filter(flagged)
  if (wish === 'hide') list = list.filter(g => !flagged(g))
  const keep = wish === 'show' ? list.filter(flagged) : []
  const ranked = list.filter(g => !(wish === 'show' && flagged(g))).sort((a, b) => (a.order || 0) - (b.order || 0))
  const rest = count > 0 ? ranked.slice(0, count) : ranked
  return [...keep, ...rest]
}

// One day's games: wishlisted and listed first, then by rank (Steam's own order on its calendar).
export function calendarDay(list) {
  return [...(list || [])].sort((a, b) =>
    ((b.onWishlist || b.onList) ? 1 : 0) - ((a.onWishlist || a.onList) ? 1 : 0) || (a.order || 0) - (b.order || 0))
}
