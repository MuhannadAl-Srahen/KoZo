'use strict'

// Upcoming, Steam layout: the games Steam's own calendar is built from (pages Upcoming,
// components/SteamCalendar.jsx SteamWeeks).
//
// Steam's calendar (store.steampowered.com/personalcalendar) answers only a signed-in store
// session ("Not logged in" otherwise), and the maker turned that sign-in down. What it shows is,
// in Steam's own words, the games on your wishlist plus what players like you wishlisted, only
// games with an exact release date, over 8 weeks. KoZo's old Steam view read two search feeds
// instead (popular coming soon, most wishlisted), which stop after about three weeks and never
// list Early Access 1.0 launches, so its days and games looked nothing like Steam's.
//
// Here: Steam's store index (IStoreQueryService/Query, keyless, the call Steam's own store makes
// for "Top wishlisted"), sorted by wishlists, every exact-dated game in the window plus Early
// Access games that set a 1.0 date; then your Steam wishlist and your KoZo Game List are marked
// and always kept, and the rest is ranked by popularity and by how close each game is to what
// you play (deals.tasteVector: the Steam tags of your most played and best rated games).

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const DAY = 86400000
const FRESH_MS = 6 * 3600000
const STALE_MS = 7 * DAY
const SPAN_DAYS = 14

// ── Pure ─────────────────────────────────────────────────────────────────────

const localDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
const addDays = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime() }

// The queries for a window of local days [from, to). Steam puts every game dated only "2026" or
// "Q4" on the last day of the period, and month-only games on the month's last day (Dec 31 held
// 4,318 games and 4 real ones), so each month's last day is asked for on its own with room for
// 500; other spans are at most 14 days, 300 each.
function calendarRanges(fromMs, toMs) {
  const out = []
  let a = localDay(fromMs)
  const end = localDay(toMs)
  while (a < end) {
    const d = new Date(a)
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime()   // last day, local
    if (a === monthEnd) { out.push({ from: a, to: addDays(a, 1), count: 500 }); a = addDays(a, 1); continue }
    const b = Math.min(addDays(a, SPAN_DAYS), monthEnd, end)
    out.push({ from: a, to: b, count: 300 })
    a = b
  }
  return out
}

// One store item as a calendar game, or null when it has no exact day (or isn't a game).
// rank = its place in its query's wishlist order, out of size.
function calendarItem(it, { ea = false, rank = 0, size = 1, assetBase = '' } = {}) {
  if (!it || !it.appid || (it.type != null && it.type !== 0)) return null
  const r = it.release || {}
  let day = null
  if (ea) {
    if (!(Number(r.release_from_early_access_date) > 0)) return null
    day = Number(r.release_from_early_access_date) * 1000
  } else {
    const ts = Number(r.steam_release_date) > 0 ? Number(r.steam_release_date) * 1000 : null
    const display = r.coming_soon_display || (ts ? 'date_full' : null)
    if (!ts || display !== 'date_full') return null
    day = ts
  }
  const a = it.assets || {}
  const url = (...keys) => {
    if (!a.asset_url_format) return null
    for (const k of keys) if (a[k]) return assetBase + a.asset_url_format.replace('${FILENAME}', a[k])
    return null
  }
  return {
    appid: Number(it.appid),
    name: it.name || '',
    day,
    rank, size,
    early: !!it.is_early_access && !ea,
    v1: ea,
    tags: (it.tags || []).slice(0, 10).map(t => ({ id: t.tagid, w: t.weight || 0 })),
    release: ea
      ? { ts: day, display: 'date_full', soon: true, text: null }
      : { ts: day, display: 'date_full', soon: !!r.is_coming_soon, text: r.custom_release_date_message || null },
    art: {
      heroCapsule: url('hero_capsule', 'hero_capsule_2x'),
      capsule: url('main_capsule', 'main_capsule_2x'),
      header: url('header', 'header_2x'),
      portrait: url('library_capsule', 'library_capsule_2x'),
      hero: url('library_hero', 'library_hero_2x'),
    },
  }
}

// Order for the calendar: popularity on Steam (wishlists) and closeness to your taste, plus
// Steam's "More like this" picks for your games. Your wishlist and your Game List are kept
// whatever their rank. taste(tags) -> 0..1, picks: { appid: { pct } }.
function rankCalendar(items, { taste = null, picks = {} } = {}) {
  const fits = items.map(it => (taste ? taste(it.tags) : 0))
  const maxFit = Math.max(0, ...fits) || 1
  const scored = items.map((it, i) => {
    const pop = 1 - Math.log(1 + (it.rank || 0)) / Math.log(1 + Math.max(2, it.size || 1))
    const fit = taste ? fits[i] / maxFit : 0
    const p = picks?.[it.appid]?.pct
    const like = p ? Math.max(0, Math.min(1, (p - 45) / 54)) : 0
    const score = taste ? 0.45 * pop + 0.40 * fit + 0.15 * like : 0.85 * pop + 0.15 * like
    return { ...it, score }
  })
  scored.sort((a, b) => b.score - a.score || (a.rank || 0) - (b.rank || 0))
  scored.forEach((it, i) => { it.order = i + 1 })
  return scored
}

// ── Steam ────────────────────────────────────────────────────────────────────

const steam = () => require('./steamApi')
const settings = () => require('../db/queries/settings')
function showAdult() { try { return settings().getSetting('show_adult_games') === '1' } catch { return false } }

async function query({ from, to, count, ea = false }) {
  const filters = { type_filters: { include_games: true } }
  filters.release_date_filter = { release_date_type: ea ? 3 : 1, start_date: Math.floor(from / 1000), end_date: Math.floor(to / 1000) }
  if (!showAdult()) filters.content_descriptors_excluded = [3, 4]
  const input = {
    query: { start: 0, count, sort: 23, filters },
    context: { language: 'english', country_code: 'US' },
    data_request: { include_assets: true, include_release: true, include_tag_count: 10 },
  }
  const data = await steam().queryStore(input)
  return data?.response?.store_items || []
}

// ── Cache: memory and userData/steam-calendar.json, parsed fields only ──────

let mem = null   // { spans: { key: { at, items } } }
const file = () => path.join(require('electron').app.getPath('userData'), 'steam-calendar.json')
function load() {
  if (mem) return mem
  mem = { spans: {} }
  try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); if (d?.spans) mem.spans = d.spans } catch {}
  return mem
}
let saveTimer = null
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const now = Date.now()
      for (const [k, v] of Object.entries(mem.spans)) if (now - v.at > STALE_MS) delete mem.spans[k]
      fs.writeFileSync(file(), JSON.stringify(mem))
    } catch {}
  }, 500)
}
const spanKey = (r, ea) => `${ea ? 'ea' : 'd'}:${new Date(r.from).toISOString().slice(0, 10)}:${new Date(r.to).toISOString().slice(0, 10)}:${showAdult() ? 'adult' : 'safe'}`

const running = new Map()
async function span(r, ea = false) {
  const key = spanKey(r, ea)
  const c = load()
  const hit = c.spans[key]
  const fetchIt = () => {
    if (!running.has(key)) {
      running.set(key, query({ ...r, ea }).then(raw => {
        const base = steam().ASSET_BASE || ''
        const items = raw.map((it, i) => calendarItem(it, { ea, rank: i, size: raw.length, assetBase: base })).filter(Boolean)
        c.spans[key] = { at: Date.now(), items }
        save()
        return items
      }).finally(() => running.delete(key)))
    }
    return running.get(key)
  }
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.items
  if (hit && Date.now() - hit.at < STALE_MS) { fetchIt().catch(() => {}); return hit.items }
  return fetchIt()
}

// ── Flags: your Steam wishlist, your Game List, what you own ────────────────

let wishMemo = null   // { at, steamId, ids: Set, ok }
async function wishlist() {
  const steamId = String(settings().getSetting('steam_user_id') || '').trim()
  if (!steamId) return { ids: new Set(), state: 'none' }
  if (wishMemo && wishMemo.steamId === steamId && Date.now() - wishMemo.at < FRESH_MS) return wishMemo
  try {
    const items = await steam().getWishlist(steamId)
    wishMemo = { at: Date.now(), steamId, ids: new Set(items.map(i => Number(i.appid))), state: items.length ? 'ok' : 'empty' }
  } catch {
    wishMemo = { at: Date.now() - FRESH_MS + 10 * 60000, steamId, ids: wishMemo?.ids || new Set(), state: wishMemo?.state || 'empty' }
  }
  return wishMemo
}

function yours() {
  const db = require('../db/database').getDb()
  const listed = new Set(), owned = new Set()
  try {
    for (const r of db.prepare(`SELECT steam_app_id AS id FROM game_list WHERE steam_app_id IS NOT NULL
      AND (status IN ('upcoming','want_to_play') OR IFNULL(release_watch,0) = 1)`).all()) listed.add(Number(r.id))
  } catch {}
  try { for (const r of db.prepare('SELECT steam_app_id AS id FROM games WHERE steam_app_id IS NOT NULL').all()) owned.add(Number(r.id)) } catch {}
  return { listed, owned }
}

// ── The calendar ─────────────────────────────────────────────────────────────

// Monday of this week; on a Saturday or Sunday, the Monday after (what Steam's grid starts on).
function startMonday(now = Date.now()) {
  const d = new Date(now)
  const dow = d.getDay()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (dow === 6 ? 2 : dow === 0 ? 1 : 1 - dow)).getTime()
}

async function get({ from, to } = {}) {
  const start = Number(from) || startMonday()
  const end = Number(to) || addDays(start, 56)
  const ranges = calendarRanges(start, end)
  let failed = 0
  const soft = (p) => p.catch((e) => { failed++; logger.warn('steamCalendar: a query failed', { message: e.message }); return [] })
  const [lists, eaList, wish, picks, tasteVec] = await Promise.all([
    Promise.all(ranges.map(r => soft(span(r)))),
    soft(span({ from: start, to: end, count: 200 }, true)),
    wishlist(),
    Promise.race([steam().getPicks().catch(() => null), new Promise(r => setTimeout(() => r(null), 3000))]),
    require('./deals').tasteVector().catch(() => null),
  ])
  if (failed && failed === ranges.length + 1) throw new Error('Steam did not answer. Try again in a moment.')
  // The same game in two lists: its own release date wins over an Early Access 1.0 date.
  const byId = new Map()
  for (const it of [...lists.flat(), ...eaList]) {
    if (it.day < start || it.day >= end) continue
    if (!byId.has(it.appid)) byId.set(it.appid, it)
  }
  const { listed, owned } = yours()
  const deals = require('./deals')
  const ranked = rankCalendar([...byId.values()], {
    taste: tasteVec ? (tags) => deals.tasteMatch(tasteVec, tags) : null,
    picks: picks?.picks || {},
  }).map(it => ({
    ...it,
    onWishlist: wish.ids.has(it.appid),
    onList: listed.has(it.appid),
    owned: owned.has(it.appid),
    match: picks?.picks?.[it.appid]?.pct || 0,
    because: picks?.picks?.[it.appid]?.because || null,
  }))
  // Tag names for the Tag filter: the tags these games carry, most common first.
  const names = await steam().getTagNames().catch(() => new Map())
  const counts = new Map()
  for (const it of ranked) for (const t of it.tags.slice(0, 5)) counts.set(t.id, (counts.get(t.id) || 0) + 1)
  const tagNames = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80)
    .map(([id]) => ({ id, name: names.get(id) })).filter(t => t.name)
  const tasteTags = tasteVec ? [...tasteVec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id) : []
  return {
    from: start, to: end,
    items: ranked.map(({ tags, score, rank, size, ...rest }) => ({ ...rest, tagIds: tags.map(t => t.id) })),
    tagNames, tasteTags,
    wishlist: { state: wish.state, count: wish.ids.size },
    partial: failed > 0,
  }
}

// After start, when idle: the first 8 weeks, so Upcoming opens at once.
function warm() { return get().catch(() => {}) }

module.exports = { calendarRanges, calendarItem, rankCalendar, startMonday, get, warm }
