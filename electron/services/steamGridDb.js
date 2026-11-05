'use strict'

// Covers for games that aren't on Steam (League of Legends, Xbox/Epic
// exclusives…) from SteamGridDB, the community art site Playnite and Steam ROM
// Manager use. Needs the user's free API key (Settings → Steam → Covers,
// stored as `steamgriddb_key`). Without a key everything here is a no-op and
// cards fall back to KoZo's generated cover.

const path = require('path')
const logger = require('../logger')

const API = 'https://www.steamgriddb.com/api/v2'

// The user's own key, else KoZo's built-in one (electron/defaults.js).
function getKey() {
  let own = ''
  try { own = (require('../db/queries/settings').getSetting('steamgriddb_key') || '').trim() } catch {}
  return own || require('../defaults').STEAMGRIDDB_KEY || ''
}

async function call(pathname, key = getKey(), params = {}) {
  if (!key) throw new Error('no_key')
  const axios = require('axios')
  const res = await axios.get(API + pathname, {
    params,
    timeout: 15000,
    headers: { Authorization: `Bearer ${key}` },
    validateStatus: () => true,
  })
  if (res.status === 401 || res.status === 403) throw new Error('invalid_key')
  if (res.status === 404) return []
  if (res.status !== 200 || !res.data?.success) throw new Error(`SteamGridDB responded ${res.status}`)
  return res.data.data || []
}

// The request must reach SteamGridDB itself: Cloudflare answers popular requests
// (/search/autocomplete/portal, /grids/steam/400) from its cache with a 200 for
// ANY key, so a wrong key was reported as saved and then rejected by every real
// request. A search term nobody has asked for before can't be cached.
async function testKey(key) {
  try {
    const term = `kozo-key-check-${require('crypto').randomBytes(8).toString('hex')}`
    await call(`/search/autocomplete/${term}`, String(key || '').trim())
    return { valid: true }
  } catch (e) {
    return e.message === 'invalid_key'
      ? { valid: false, rejected: true, message: 'SteamGridDB rejected this key. A key has 32 characters: copy the whole key from your SteamGridDB API page.' }
      : { valid: false, message: e.message }
  }
}

// [{ id, name, year }] best matches first.
async function searchGame(name) {
  let term = String(name || '').trim()
  // A name taken from a folder ("Command-and-Conquer-Generals-Zero-Hour") has no
  // spaces: search for the words instead.
  if (!/\s/.test(term)) term = term.replace(/[-_.]+/g, ' ').trim()
  if (!term) return []
  const data = await call(`/search/autocomplete/${encodeURIComponent(term)}`)
  return data.map(g => ({
    id: g.id,
    name: g.name,
    year: g.release_date ? new Date(g.release_date * 1000).getFullYear() : null,
    verified: !!g.verified,
  }))
}

// Pure: how well a search hit fits a name, 0 to 1, by the words they share. The first hit
// isn't good enough: "Command and Conquer Generals Zero Hour" answers with the 1995 game.
const NAME_NOISE = new Set(['and', 'the', 'of', 'a', 'an'])
function nameWords(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(' ').filter(w => w && !NAME_NOISE.has(w))
}
function matchScore(name, hit) {
  const a = new Set(nameWords(name)), b = new Set(nameWords(hit))
  if (!a.size || !b.size) return 0
  let same = 0
  for (const w of a) if (b.has(w)) same++
  return same / Math.max(a.size, b.size)
}
// Pure: the same words make the same game: "Command and Conquer Generals Zero Hour" and
// "Command & Conquer: Generals - Zero Hour".
function nameKey(name) {
  return [...new Set(nameWords(name))].sort().join(' ')
}
// Pure: the game's real name when the search is sure of it, written the way KoZo writes names.
function officialName(match) {
  return match && match.score >= 0.7 ? match.name.replace(/\s*[–—]\s*/g, ' - ') : null
}
const GOOD_MATCH = 0.6
function bestMatch(name, hits) {
  let best = null
  for (const h of hits || []) {
    const score = matchScore(name, h.name)
    if (score > (best?.score ?? 0)) best = { ...h, score }
  }
  return best && best.score >= GOOD_MATCH ? best : null
}
// The game a name means, or null: a wrong cover is worse than the generated one. The search
// can miss a game by its full name and find it by the last words ("Generals Zero Hour").
async function matchGame(name) {
  const term = String(name || '').trim()
  if (!term) return null
  const hits = await searchGame(term)
  const hit = bestMatch(term, hits)
  if (hit) return hit
  const words = term.split(/\s+/)
  for (let i = 1; i <= 3 && words.length - i >= 2; i++) {
    const found = bestMatch(term, await searchGame(words.slice(i).join(' ')))
    if (found) return found
  }
  return null
}

// Search results with a cover each, for Add Game's "Not on Steam" section.
// [] without a key, so callers can always ask.
async function searchWithCovers(name, limit = 6) {
  if (!getKey()) return []
  const hits = (await searchGame(name).catch(() => [])).slice(0, limit)
  return Promise.all(hits.map(async (h) => {
    const [g] = await grids(h.id).catch(() => [])
    return { sgdb_id: h.id, name: h.name, year: h.year, cover: g?.url || null, thumb: g?.thumb || null }
  }))
}

// Portrait covers (600x900 / 342x482), static images only, best scored first.
async function grids(sgdbGameId) {
  const data = await call(`/grids/game/${sgdbGameId}`, getKey(), { dimensions: '600x900,342x482,660x930', types: 'static', nsfw: 'false' })
  return data.map(g => ({ id: g.id, url: g.url, thumb: g.thumb || g.url, width: g.width, height: g.height, score: g.score || 0 }))
}

async function heroes(sgdbGameId) {
  const data = await call(`/heroes/game/${sgdbGameId}`, getKey(), { types: 'static', nsfw: 'false' })
  return data.map(h => ({ id: h.id, url: h.url, thumb: h.thumb || h.url }))
}

// Download a chosen cover (and optionally a hero) for a library game. A new file each time:
// a page keeps showing the picture it already loaded from a path, and over a dozen places show
// these files. The file it replaces goes.
async function applyArt(gameId, coverUrl, heroUrl) {
  const steamApi = require('./steamApi')
  const db = require('../db/database').getDb()
  const dir = steamApi.getBannersDir()
  const stamp = Date.now()
  const old = db.prepare('SELECT banner_local_path, hero_local_path FROM games WHERE id = ?').get(gameId) || {}
  const removeOld = (file, dest) => {
    if (file && file !== dest && /[\\/]banners[\\/]/i.test(file)) { try { require('fs').unlinkSync(file) } catch {} }
  }
  if (coverUrl) {
    const dest = path.join(dir, `${gameId}-${stamp}.jpg`)
    await steamApi.downloadFile(coverUrl, dest)
    steamApi.shrinkCover(dest)
    db.prepare('UPDATE games SET banner_local_path = ?, banner_url = NULL, banner_rev = COALESCE(banner_rev, 0) + 1 WHERE id = ?').run(dest, gameId)
    // Game List cards load remote art only: give the linked list row the cover too.
    db.prepare('UPDATE game_list SET banner_url = ?, banner_rev = COALESCE(banner_rev, 0) + 1 WHERE game_id = ?').run(coverUrl, gameId)
    removeOld(old.banner_local_path, dest)
  }
  if (heroUrl) {
    const dest = path.join(dir, `${gameId}-${stamp}_hero.jpg`)
    try {
      await steamApi.downloadFile(heroUrl, dest)
      db.prepare('UPDATE games SET hero_local_path = ?, banner_rev = COALESCE(banner_rev, 0) + 1 WHERE id = ?').run(dest, gameId)
      removeOld(old.hero_local_path, dest)
    } catch (e) { logger.warn('steamGridDb: hero download failed', { gameId, message: e.message }) }
  }
  return db.prepare('SELECT * FROM games WHERE id = ?').get(gameId)
}

// SteamGridDB also knows most Steam games by appid, which covers the ones Steam
// itself serves no art for. 404 → [].
async function gridsForSteam(appId) {
  const data = await call(`/grids/steam/${appId}`, getKey(), { dimensions: '600x900,342x482,660x930', types: 'static', nsfw: 'false' })
  return data.map(g => ({ id: g.id, url: g.url, thumb: g.thumb || g.url }))
}
async function heroesForSteam(appId) {
  const data = await call(`/heroes/steam/${appId}`, getKey(), { types: 'static', nsfw: 'false' })
  return data.map(h => ({ id: h.id, url: h.url, thumb: h.thumb || h.url }))
}

function hasFile(p) {
  try { return !!p && require('fs').existsSync(p) } catch { return false }
}

// Best-effort automatic art for a game with no cover yet: by Steam appid when
// it has one, else by name. Returns true when a cover was applied.
// force: replace a cover that's there, with the game `match` if it's already known.
// onCover: the cover is in; the big picture behind it, which can be 8 MB, comes after.
async function autoArt(game, { force = false, match: known = null, onCover = null } = {}) {
  if (!getKey() || !game?.id) return false
  if (!force && hasFile(game.banner_local_path)) return false
  try {
    let cover = null, findHero = null, label = ''
    if (game.steam_app_id) {
      ;[cover] = await gridsForSteam(game.steam_app_id).catch(() => [])
      if (cover) { findHero = () => heroesForSteam(game.steam_app_id); label = `appid ${game.steam_app_id}` }
    }
    if (!cover) {
      const name = String(game.name || '').replace(/[\s:]*\b(demo|playtest|prologue)\b\s*$/i, '').trim()
      const match = known || await matchGame(name)
      if (!match) return false
      ;[cover] = await grids(match.id)
      if (!cover) return false
      findHero = () => heroes(match.id)
      label = `"${match.name}"`
    }
    await applyArt(game.id, cover.url, null)
    onCover?.()
    if (force || !hasFile(game.hero_local_path)) {
      const [hero] = await findHero().catch(() => [])
      if (hero) await applyArt(game.id, null, hero.url)
    }
    logger.info(`steamGridDb: cover applied for "${game.name}" (matched ${label})`)
    return true
  } catch (e) {
    if (e.message !== 'no_key') logger.warn(`steamGridDb: auto art failed for "${game.name}"`, { message: e.message })
    return false
  }
}

// Every library game still without a cover file (key saved, Refresh images,
// startup art pass).
async function autoArtAll() {
  if (!getKey()) return 0
  const db = require('../db/database').getDb()
  const rows = db.prepare('SELECT * FROM games').all().filter(g => !hasFile(g.banner_local_path))
  let applied = 0
  for (const g of rows) {
    if (await autoArt(g)) applied++
    await new Promise(r => setTimeout(r, 300))
  }
  return applied
}

module.exports = { getKey, testKey, searchGame, searchWithCovers, grids, heroes, applyArt, autoArt, autoArtAll, matchGame, bestMatch, matchScore, nameKey, officialName }
