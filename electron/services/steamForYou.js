'use strict'

// "For you on Steam" on Upcoming: the upcoming games Steam would pick for this person,
// from the Steam account KoZo is already connected to (Settings > Connections > Steam).
// No store sign-in: the maker didn't want a second Steam login, and Steam's own Personal
// Calendar only answers a signed-in store session. It is built from what that calendar
// uses, the person's wishlist and playtime:
//   - the Steam wishlist (IWishlistService/GetWishlist, no key; empty when private),
//     first, in the wishlist's own order;
//   - Steam's "More like this > Coming soon" list for the games played most on Steam
//     (GetOwnedGames with the saved key; recent play counts extra), scored like
//     "Like my games" (steamApi.scorePicks: a game several of them agree on wins).
// Names, dates and art come from GetItems like the rest of the calendar, which also
// drops what is already out. Cached 6 hours (memory and userData/steam-foryou.json);
// an older answer shows at once and is refreshed in the background.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const TTL = 6 * 60 * 60 * 1000
const MAX_SOURCES = 12

let cache = null   // { at, steamId, data }
let running = null
let diskRead = false

function file() { return path.join(require('electron').app.getPath('userData'), 'steam-foryou.json') }
function readDisk() {
  if (diskRead) return
  diskRead = true
  try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); if (d?.data?.items) cache = d } catch {}
}

// Pure: owned games ({ appid, name, playtime_forever, playtime_2weeks } in minutes) ->
// the ones to ask Steam about: played in the last two weeks first, then most played.
function playedSources(owned, max = MAX_SOURCES) {
  return (owned || [])
    .map(g => ({ appid: Number(g.appid), name: String(g.name || `App ${g.appid}`).trim(), hours: (g.playtime_forever || 0) / 60, recent: (g.playtime_2weeks || 0) / 60 }))
    .filter(g => g.appid > 0 && g.hours >= 1)
    .sort((a, b) => ((b.recent > 0) - (a.recent > 0)) || (b.recent - a.recent) || (b.hours - a.hours))
    .slice(0, max)
    .map(g => ({ appid: g.appid, name: g.name, weight: 1 + Math.log1p(g.hours) * 0.5 + (g.recent > 0 ? 1 : 0) }))
}

// Pure: wishlist [{ appid, priority, added }] + scored picks { appid: { pct, because } }
// -> [{ appid, wishlist, because, pct }]: the wishlist first (ranked ones by rank, then
// newest added), then the picks best first. Owned games never.
function forYouItems(wishlist, picks, owned = new Set()) {
  const out = [], seen = new Set()
  const wl = [...(wishlist || [])].sort((a, b) =>
    ((a.priority || 1e9) - (b.priority || 1e9)) || ((b.added || 0) - (a.added || 0)))
  for (const w of wl) {
    const id = Number(w.appid)
    if (!(id > 0) || seen.has(id) || owned.has(id)) continue
    seen.add(id); out.push({ appid: id, wishlist: true, because: null, pct: null })
  }
  const scored = Object.entries(picks || {}).map(([id, p]) => ({ appid: Number(id), ...p })).sort((a, b) => b.pct - a.pct)
  for (const p of scored) {
    if (!(p.appid > 0) || seen.has(p.appid) || owned.has(p.appid)) continue
    seen.add(p.appid); out.push({ appid: p.appid, wishlist: false, because: p.because || [], pct: p.pct })
  }
  return out
}

async function compute(steamId, apiKey) {
  const steamApi = require('./steamApi')
  const [wishlist, owned] = await Promise.all([
    steamApi.getWishlist(steamId).catch(() => []),
    apiKey ? steamApi.getOwnedGames(apiKey, steamId).catch(() => []) : [],
  ])
  // Only games: Wallpaper Engine is often the most used thing on Steam, and its More like
  // this is more wallpaper apps. GetItems' type 0 is a game; an unknown type stays.
  let sources = playedSources(owned, MAX_SOURCES * 2)
  try {
    const facts = await steamApi.getGameFacts(sources.map(s => s.appid))
    sources = sources.filter(s => { const t = facts.get(s.appid)?.type; return t == null || t === 0 })
  } catch {}
  sources = sources.slice(0, MAX_SOURCES)
  const found = []
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < sources.length) {
      const src = sources[next++]
      try { found.push({ ...src, ids: await steamApi.moreLikeComingSoon(src.appid) }) } catch {}
    }
  }))
  const ownedIds = new Set(owned.map(g => Number(g.appid)))
  const items = forYouItems(wishlist, steamApi.scorePicks(found), ownedIds)
  logger.info('steamForYou: built', { wishlist: wishlist.length, played: sources.length, items: items.length })
  const data = { items, wishlist: wishlist.length, played: found.map(s => s.name) }
  cache = { at: Date.now(), steamId, data }
  try { fs.writeFileSync(file(), JSON.stringify(cache)) } catch {}
  return data
}

// null when no Steam account is connected.
async function forYou() {
  const settingsQ = require('../db/queries/settings')
  const steamId = settingsQ.getSetting('steam_user_id')
  if (!steamId) return null
  const apiKey = settingsQ.getSetting('steam_api_key')
  readDisk()
  const mine = cache && cache.steamId === steamId ? cache : null
  const start = () => { if (!running) running = compute(steamId, apiKey).finally(() => { running = null }) ; return running }
  if (mine) {
    if (Date.now() - mine.at > TTL) start().catch(() => {})
    return mine.data
  }
  return start()
}

// The store sign-in this replaced kept its own storage; nothing reads it any more.
let cleared = false
function clearOldStoreLogin() {
  if (cleared) return
  cleared = true
  try { require('electron').session.fromPartition('persist:steamstore').clearStorageData().catch(() => {}) } catch {}
}

module.exports = { forYou, compute, playedSources, forYouItems, clearOldStoreLogin }
