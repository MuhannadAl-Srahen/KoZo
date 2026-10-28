'use strict'

// Covers for games that aren't on Steam (League of Legends, Xbox/Epic
// exclusives…) from SteamGridDB, the community art site Playnite and Steam ROM
// Manager use. Needs the user's free API key (Settings → Steam → Covers,
// stored as `steamgriddb_key`). Without a key everything here is a no-op and
// cards fall back to KoZo's generated cover.

const path = require('path')
const logger = require('../logger')

const API = 'https://www.steamgriddb.com/api/v2'

function getKey() {
  try { return (require('../db/queries/settings').getSetting('steamgriddb_key') || '').trim() } catch { return '' }
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

async function testKey(key) {
  try {
    await call('/search/autocomplete/portal', String(key || '').trim())
    return { valid: true }
  } catch (e) {
    return { valid: false, message: e.message === 'invalid_key' ? 'SteamGridDB rejected this key.' : e.message }
  }
}

// [{ id, name, year }] best matches first.
async function searchGame(name) {
  const term = String(name || '').trim()
  if (!term) return []
  const data = await call(`/search/autocomplete/${encodeURIComponent(term)}`)
  return data.map(g => ({
    id: g.id,
    name: g.name,
    year: g.release_date ? new Date(g.release_date * 1000).getFullYear() : null,
    verified: !!g.verified,
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

// Download a chosen cover (and optionally a hero) for a library game.
async function applyArt(gameId, coverUrl, heroUrl) {
  const steamApi = require('./steamApi')
  const db = require('../db/database').getDb()
  const dir = steamApi.getBannersDir()
  if (coverUrl) {
    const dest = path.join(dir, `${gameId}.jpg`)
    await steamApi.downloadFile(coverUrl, dest)
    db.prepare('UPDATE games SET banner_local_path = ?, banner_url = NULL, banner_rev = COALESCE(banner_rev, 0) + 1 WHERE id = ?').run(dest, gameId)
  }
  if (heroUrl) {
    const dest = path.join(dir, `${gameId}_hero.jpg`)
    try {
      await steamApi.downloadFile(heroUrl, dest)
      db.prepare('UPDATE games SET hero_local_path = ? WHERE id = ?').run(dest, gameId)
    } catch (e) { logger.warn('steamGridDb: hero download failed', { gameId, message: e.message }) }
  }
  return db.prepare('SELECT * FROM games WHERE id = ?').get(gameId)
}

// Best-effort automatic art for a game with no Steam appid and no cover yet.
// Returns true when a cover was applied.
async function autoArt(game) {
  if (!getKey() || !game?.id || game.steam_app_id) return false
  if (game.banner_local_path) {
    try { if (require('fs').existsSync(game.banner_local_path)) return false } catch {}
  }
  try {
    const [match] = await searchGame(game.name)
    if (!match) return false
    const [cover] = await grids(match.id)
    if (!cover) return false
    const [hero] = await heroes(match.id).catch(() => [])
    await applyArt(game.id, cover.url, game.hero_local_path ? null : hero?.url)
    logger.info(`steamGridDb: cover applied for "${game.name}" (matched "${match.name}")`)
    return true
  } catch (e) {
    if (e.message !== 'no_key') logger.warn(`steamGridDb: auto art failed for "${game.name}"`, { message: e.message })
    return false
  }
}

// Every non-Steam library game without a cover (first key save, or Refresh images).
async function autoArtAll() {
  if (!getKey()) return 0
  const db = require('../db/database').getDb()
  const rows = db.prepare('SELECT * FROM games WHERE steam_app_id IS NULL').all()
  let applied = 0
  for (const g of rows) {
    if (await autoArt(g)) applied++
    await new Promise(r => setTimeout(r, 300))
  }
  return applied
}

module.exports = { getKey, testKey, searchGame, grids, heroes, applyArt, autoArt, autoArtAll }
