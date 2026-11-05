'use strict'
// Steam wishlist into the Game List. Only when the user asks, and they tick what
// comes in, so a game they took off the list doesn't creep back by itself.

// Pure: the wishlist games that aren't on the Game List or owned yet, newest first.
function wishlistNew(items, listIds, ownedIds) {
  const list = new Set([...listIds].map(Number))
  const owned = new Set([...ownedIds].map(Number))
  const seen = new Set()
  return (items || [])
    .filter((i) => {
      const id = Number(i?.appid)
      if (!(id > 0) || list.has(id) || owned.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => (Number(b.added) || 0) - (Number(a.added) || 0))
}

// Pure: not out yet = Upcoming (which also tracks its release), else Want to play.
function wishlistStatus(facts, now = Date.now()) {
  const r = facts?.release
  if (r?.soon) return 'upcoming'
  const ts = facts?.releasedAt ?? r?.ts ?? null
  return ts != null && ts > now ? 'upcoming' : 'want_to_play'
}

// The date as the rest of the Game List keeps it (see releaseWatch: only a precise
// date may ever count as released, so anything vague stays text).
function releaseText(facts) {
  const r = facts?.release
  if (r?.text) return r.text
  const ts = facts?.releasedAt ?? r?.ts ?? null
  if (!ts) return null
  const when = new Date(ts)
  const month = when.toLocaleString('en-US', { month: 'short' })
  if (r?.display === 'date_year') return String(when.getFullYear())
  if (r?.display === 'date_month' || r?.display === 'date_quarter') return `${month} ${when.getFullYear()}`
  return `${month} ${when.getDate()}, ${when.getFullYear()}`
}

function knownIds() {
  const db = require('../db/database').getDb()
  return {
    list: db.prepare('SELECT steam_app_id AS id FROM game_list WHERE steam_app_id IS NOT NULL').all().map(r => Number(r.id)),
    owned: db.prepare('SELECT steam_app_id AS id FROM games WHERE steam_app_id IS NOT NULL').all().map(r => Number(r.id)),
  }
}

async function preview() {
  const steamId = require('../db/queries/settings').getSetting('steam_user_id')
  if (!steamId) return { state: 'not_connected', items: [] }
  const steam = require('./steamApi')
  let items
  try { items = await steam.getWishlist(steamId) }
  catch (e) { return { state: 'failed', error: e.message, items: [] } }
  if (!items.length) return { state: 'empty', items: [] }   // empty, or set to private: Steam answers the same

  const { list, owned } = knownIds()
  const fresh = wishlistNew(items, list, owned)
  const facts = await steam.getGameFacts(fresh.map(i => i.appid))
  const rows = []
  for (const i of fresh) {
    const f = facts.get(i.appid)
    if (!f?.name) continue   // Steam no longer has a page for it
    rows.push({
      appid: i.appid, name: f.name, status: wishlistStatus(f),
      art: f.portrait || f.header || f.capsule || null, wide: f.header || f.capsule || null,
      release: releaseText(f),
    })
  }
  return { state: rows.length ? 'ok' : 'nothing_new', total: items.length, items: rows }
}

// No per-game network calls here (gameList:add makes two per game), so a long
// wishlist comes in at once. Genres arrive with the existing backfill.
async function importGames(appids) {
  const gameListQ = require('../db/queries/gameList')
  const steam = require('./steamApi')
  const ids = [...new Set((appids || []).map(Number).filter(n => n > 0))]
  const { list, owned } = knownIds()
  const wanted = wishlistNew(ids.map(appid => ({ appid })), list, owned).map(i => i.appid)
  const facts = await steam.getGameFacts(wanted)
  let added = 0
  for (const id of wanted) {
    const f = facts.get(id)
    if (!f?.name) continue
    try {
      gameListQ.addGameListItem({
        steam_app_id: id, name: f.name, banner_url: f.portrait || f.header || f.capsule || null,
        status: wishlistStatus(f), release_date: releaseText(f),
      })
      added++
    } catch { /* same name already on the list */ }
  }
  if (added) {
    try { require('./autoBackup').markDirty() } catch {}
    try {
      require('./processWatcher').runWhenIdle('wishlistGenres', () => { steam.runGenreBackfill().catch(() => {}) })
    } catch {}
  }
  return { added }
}

module.exports = { preview, importGames, wishlistNew, wishlistStatus, releaseText }
