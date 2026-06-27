const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const logger = require('../logger')

let _axios = null
function getAxios() {
  if (!_axios) _axios = require('axios')
  return _axios
}

function getBannersDir() {
  const dir = path.join(app.getPath('userData'), 'banners')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
// Uses axios for automatic gzip decompression and redirect following

async function getJSON(url, params = {}) {
  const axios = getAxios()
  const res = await axios.get(url, {
    params,
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  })
  return res.data
}

async function downloadFile(url, destPath) {
  const axios = getAxios()
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)

  const file = fs.createWriteStream(destPath)
  return new Promise((resolve, reject) => {
    res.data.pipe(file)
    file.on('finish', () => file.close(resolve))
    file.on('error', (e) => { try { fs.unlinkSync(destPath) } catch {} ; reject(e) })
    res.data.on('error', (e) => { try { fs.unlinkSync(destPath) } catch {} ; reject(e) })
  })
}

// Extract Steam App ID from a Steam CDN logo URL
function extractAppId(logoUrl) {
  const m = logoUrl?.match(/steam\/apps\/(\d+)\//)
  return m ? parseInt(m[1]) : null
}

// ── Public API ────────────────────────────────────────────────────────────────

async function testApiKey(key) {
  if (!key || typeof key !== 'string' || key.trim().length === 0) {
    return { valid: false, message: 'No key provided' }
  }
  try {
    const data = await getJSON(
      'https://api.steampowered.com/ISteamWebAPIUtil/GetSupportedAPIList/v0001/',
      { key: key.trim() }
    )
    if (data?.apilist?.interfaces?.length > 0) {
      return { valid: true, message: 'API key is valid' }
    }
    return { valid: false, message: 'Key rejected by Steam' }
  } catch (e) {
    logger.warn('testApiKey failed', { message: e.message })
    return { valid: false, message: e.message }
  }
}

// Search uses Steam Store search API — works without any API key
async function searchGames(query) {
  if (!query || query.trim().length < 2) return []
  try {
    const data = await getJSON('https://store.steampowered.com/search/results/', {
      term: query.trim(),
      json: 1,
      count: 20,
      // category1=998 restricts results to "Games" only — Steam otherwise returns
      // DLC, soundtracks, armor packs, demos, tools, etc. (e.g. searching "witcher"
      // would list "Blood and Wine", "...Soundtrack", "Temerian Armor Set"). The
      // user adds playable games, not their add-ons, so filter those out at source.
      category1: 998,
    })
    const items = data?.items ?? []
    return items
      .map(item => {
        const steam_app_id = extractAppId(item.logo)
        // Primary = the classic appid header.jpg (sharp, exists for virtually
        // all released games — the look from the old Add Game search).
        // Fallback = the search `logo` (a hashed capsule) which is the only art
        // newer/unreleased titles have. The renderer walks header → capsule.
        return {
          steam_app_id,
          name: item.name,
          header_image: steam_app_id
            ? `https://cdn.akamai.steamstatic.com/steam/apps/${steam_app_id}/header.jpg`
            : null,
          // Upgrade the tiny 120px search logo to the 231px capsule (same hash)
          // so the fallback for new titles isn't pixelated.
          capsule: item.logo ? item.logo.replace(/capsule_sm_120\.jpg/i, 'capsule_231x87.jpg') : null,
        }
      })
      .filter(g => g.steam_app_id != null)
      .slice(0, 20)
  } catch (e) {
    logger.warn('searchGames failed', { message: e.message })
    return []
  }
}

// Best-effort match of a (cleaned) folder name to a real Steam title, so
// cracked games found on disk can borrow Steam's name + cover art. Returns
// null unless there's a confident match (avoids attaching the wrong game).
async function findAppByName(name) {
  const results = await searchGames(name)
  if (!results.length) return null
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const q = norm(name)
  if (q.length < 2) return null
  let best = null, bestScore = 0
  for (const r of results.slice(0, 10)) {
    const rn = norm(r.name)
    if (!rn) continue
    let score = 0
    if (rn === q) score = 1
    else if (rn.startsWith(q) || q.startsWith(rn)) score = Math.min(rn.length, q.length) / Math.max(rn.length, q.length)
    else if (rn.includes(q) || q.includes(rn)) score = 0.6 * (Math.min(rn.length, q.length) / Math.max(rn.length, q.length))
    if (score > bestScore) { bestScore = score; best = r }
  }
  return (best && bestScore >= 0.72) ? best : null
}

async function getSchemaForGame(appId, apiKey) {
  // Many games simply have no achievement schema (unreleased/early-access titles,
  // or non-achievement apps). Steam answers those with 400/403 — that's "no
  // achievements", NOT an error worth surfacing. Return [] so callers treat it as
  // a zero-achievement game instead of throwing a scary "status code 403".
  try {
    const data = await getJSON(
      'https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/',
      { key: apiKey, appid: appId, l: 'english' }
    )
    return data?.game?.availableGameStats?.achievements ?? []
  } catch (e) {
    const status = e.response?.status
    if (status === 400 || status === 403) return []
    throw e   // genuine network/key failure — let the caller know
  }
}

async function getGlobalAchievementPercentages(appId) {
  try {
    const data = await getJSON(
      'https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/',
      { gameid: appId }
    )
    const list = data?.achievementpercentages?.achievements ?? []
    return Object.fromEntries(list.map(a => [a.name, a.percent]))
  } catch {
    return {}   // games with no achievements 400 here too — harmless
  }
}

// Resolve the REAL (correctly-hashed) art URLs for a game via the store
// appdetails API. Newer titles serve art only from hashed `store_item_assets`
// paths whose hash can't be guessed — this is the authoritative source.
async function getStoreArt(appId) {
  try {
    const data = await getJSON('https://store.steampowered.com/api/appdetails', { appids: appId, l: 'en' })
    const d = data?.[appId]?.data
    if (!d) return null
    // header_image is the sharp 460×215 cover (correct hash); capsule_image is
    // the 231×87 fallback. Larger sizes live under different hashes we can't
    // derive, so these two are the reliable authoritative URLs.
    return {
      header_image: d.header_image || null,
      capsule_image: d.capsule_image || null,
      genres: (d.genres || []).map(g => g.description).filter(Boolean),
    }
  } catch (e) {
    logger.warn(`getStoreArt failed for ${appId}`, { message: e.message })
    return null
  }
}

// Returns the best WORKING remote cover URL for a 2:3 card without downloading:
// the true portrait when it exists, else the real (hashed) header, else the
// 231px capsule. Used for remote-only surfaces like the Game List.
async function resolveBannerUrl(appId) {
  const portrait = `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900_2x.jpg`
  try {
    const r = await getAxios().head(portrait, { timeout: 8000 })
    if (r.status === 200) return portrait
  } catch { /* no portrait — resolve real art below */ }
  const art = await getStoreArt(appId)
  return art?.header_image || art?.capsule_image || portrait
}

async function downloadBanner(appId, gameId, extraUrls = []) {
  const destPath = path.join(getBannersDir(), `${gameId}.jpg`)
  // Try the appid-path images first — fast, and they exist for the vast majority
  // of released games (true 600×900 portrait is best for the 2:3 library card).
  const urls = [
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900_2x.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`,
  ]
  for (const url of urls) {
    try {
      await downloadFile(url, destPath)
      logger.info(`Banner downloaded for ${appId} from ${url}`)
      return destPath
    } catch { /* try next */ }
  }

  // Appid-path art 404'd (newer/unreleased title). Resolve the real hashed URLs
  // from appdetails so we still get a SHARP cover (header/capsule_616), not a
  // pixelated 120px capsule.
  const art = await getStoreArt(appId)
  const hashed = [art?.header_image, art?.capsule_image,
                  ...(Array.isArray(extraUrls) ? extraUrls : [])].filter(Boolean)
  for (const url of hashed) {
    try {
      await downloadFile(url, destPath)
      logger.info(`Banner downloaded for ${appId} from ${url}`)
      return destPath
    } catch { /* try next */ }
  }
  throw new Error(`No banner found for appId ${appId}`)
}

async function refreshGameData(gameId) {
  const { getDb } = require('../db/database')
  const settingsQ = require('../db/queries/settings')
  const achievementsQ = require('../db/queries/achievements')

  const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
  if (!game?.steam_app_id) return null

  const apiKey = settingsQ.getSetting('steam_api_key')
  if (!apiKey) throw new Error('Steam API key not set')

  const [schema, pcts] = await Promise.all([
    getSchemaForGame(game.steam_app_id, apiKey),
    getGlobalAchievementPercentages(game.steam_app_id),
  ])

  const achievements = schema.map(a => ({
    steam_api_name: a.name,
    display_name: a.displayName || a.name,
    description: a.description || null,
    icon_url: a.icon || null,
    icon_locked_url: a.icongray || null,
    global_unlock_percent: pcts[a.name] ?? null,
    is_hidden: a.hidden === 1 ? 1 : 0,
  }))

  if (achievements.length > 0) {
    achievementsQ.bulkUpsertAchievements(gameId, achievements)
  }

  // Portrait banner (library card)
  try {
    const bannerPath = await downloadBanner(game.steam_app_id, gameId)
    getDb().prepare('UPDATE games SET banner_local_path = ? WHERE id = ?').run(bannerPath, gameId)
  } catch (e) {
    logger.warn(`Banner download failed for game ${gameId}`, { message: e.message })
  }

  // Hero banner (wide landscape, used in GameDetail)
  try {
    const heroPath = path.join(getBannersDir(), `${gameId}_hero.jpg`)
    await downloadFile(
      `https://cdn.akamai.steamstatic.com/steam/apps/${game.steam_app_id}/library_hero.jpg`,
      heroPath
    )
    getDb().prepare('UPDATE games SET hero_local_path = ? WHERE id = ?').run(heroPath, gameId)
    logger.info(`Hero banner downloaded for game ${gameId}`)
  } catch (e) {
    logger.warn(`Hero banner download failed for game ${gameId}`, { message: e.message })
  }

  // Steam store genres (auto-grouping) — refresh fills them for older rows too.
  try {
    const art = await getStoreArt(game.steam_app_id)
    if (art?.genres?.length) {
      getDb().prepare('UPDATE games SET genres = ? WHERE id = ?').run(JSON.stringify(art.genres), gameId)
    }
  } catch (e) {
    logger.warn(`Genre fetch failed for game ${gameId}`, { message: e.message })
  }

  logger.info(`Refreshed game ${gameId}: ${achievements.length} achievements`)
  return { achievementCount: achievements.length }
}

// Downloads only portrait + hero banners for a game (no achievements).
// Used by "Refresh Images" to update GameDetail hero and Library card portrait.
async function refreshBanners(gameId) {
  const { getDb } = require('../db/database')
  const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
  if (!game?.steam_app_id) return

  // Portrait banner (library card)
  try {
    const bannerPath = await downloadBanner(game.steam_app_id, gameId)
    getDb().prepare('UPDATE games SET banner_local_path = ? WHERE id = ?').run(bannerPath, gameId)
  } catch (e) {
    logger.warn(`Portrait banner failed for game ${gameId}`, { message: e.message })
  }

  // Hero banner (game detail page wide banner)
  try {
    const heroPath = path.join(getBannersDir(), `${gameId}_hero.jpg`)
    await downloadFile(
      `https://cdn.akamai.steamstatic.com/steam/apps/${game.steam_app_id}/library_hero.jpg`,
      heroPath
    )
    getDb().prepare('UPDATE games SET hero_local_path = ? WHERE id = ?').run(heroPath, gameId)
  } catch (e) {
    logger.warn(`Hero banner failed for game ${gameId}`, { message: e.message })
  }
}

// Returns { unlocks: [...], error: 'private' | 'no_stats' | string | null }
// We surface the failure reason because the user needs to know why nothing
// synced — Steam silently returning "not public" is the #1 confusing case.
async function getPlayerAchievements(appId, apiKey, steamId) {
  try {
    const data = await getJSON(
      'https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/',
      { key: apiKey, steamid: steamId, appid: appId, l: 'english' }
    )
    const stats = data?.playerstats
    if (!stats) return { unlocks: [], error: 'no_response' }
    if (stats.success === false) {
      const msg = (stats.error || '').toLowerCase()
      if (msg.includes('not public') || msg.includes('private')) return { unlocks: [], error: 'private' }
      if (msg.includes('requested app has no stats')) return { unlocks: [], error: 'no_stats_for_game' }
      return { unlocks: [], error: stats.error || 'steam_error' }
    }
    const list = stats.achievements ?? []
    const unlocks = list
      .filter(a => a.achieved === 1)
      .map(a => ({ name: a.apiname, unlocktime: a.unlocktime || 0 }))
    return { unlocks, error: null }
  } catch (e) {
    const status = e.response?.status
    // 403 / 401 = Steam rejected the request because the profile is private or
    // the API key doesn't have access to this player's data.
    if (status === 403 || status === 401) return { unlocks: [], error: 'private' }
    // 400 = this app has no achievement stats at all (unreleased / non-achievement
    // game). That's expected, not a real failure — report it cleanly.
    if (status === 400) return { unlocks: [], error: 'no_stats_for_game' }
    logger.warn('getPlayerAchievements failed', { message: e.message, appId })
    return { unlocks: [], error: e.message || 'network_error' }
  }
}

// Returns the Steam profile (persona name, avatar, profile URL) for a Steam ID.
// Used in Settings so the user can visually confirm they entered the right ID.
async function getPlayerSummary(apiKey, steamId) {
  if (!apiKey || !steamId) return null
  try {
    const data = await getJSON(
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/',
      { key: apiKey, steamids: steamId }
    )
    const player = data?.response?.players?.[0]
    if (!player) return null
    return {
      steam_id: player.steamid,
      persona_name: player.personaname,
      avatar: player.avatarmedium || player.avatar,
      avatar_full: player.avatarfull,
      profile_url: player.profileurl,
      country: player.loccountrycode || null,
    }
  } catch (e) {
    logger.warn('getPlayerSummary failed', { message: e.message })
    return null
  }
}

// Returns the user's owned Steam games (requires profile to be public).
// Each item: { appid, name, playtime_forever, img_icon_url }
async function getOwnedGames(apiKey, steamId) {
  if (!apiKey || !steamId) return []
  try {
    const data = await getJSON(
      'https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/',
      { key: apiKey, steamid: steamId, include_appinfo: 1, include_played_free_games: 1, format: 'json' }
    )
    return data?.response?.games ?? []
  } catch (e) {
    logger.warn('getOwnedGames failed', { message: e.message })
    return []
  }
}

// Turn whatever the user pasted — a SteamID64, a full profile URL, or a custom
// vanity name — into a canonical SteamID64. No third-party sites: profile URLs
// with the numeric ID are parsed locally, and custom names are resolved through
// Steam's own ResolveVanityURL API. Returns { steamId } or { error }.
async function resolveSteamId(input, apiKey) {
  const raw = (input || '').trim()
  if (!raw) return { error: 'empty' }

  // steamcommunity.com/profiles/<64-bit id>
  let m = raw.match(/profiles\/(\d{17})/)
  if (m) return { steamId: m[1] }

  // A bare 17-digit SteamID64
  if (/^\d{17}$/.test(raw)) return { steamId: raw }

  // steamcommunity.com/id/<vanity>  → or treat a plain word as a vanity name
  m = raw.match(/\/id\/([^/?#]+)/)
  let vanity = m ? m[1] : (/^[A-Za-z0-9_.-]+$/.test(raw) ? raw : null)
  if (!vanity) return { error: 'unrecognized' }
  if (!apiKey) return { error: 'no_api_key' }

  try {
    const data = await getJSON(
      'https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/',
      { key: apiKey, vanityurl: vanity }
    )
    if (data?.response?.success === 1 && data.response.steamid) {
      return { steamId: data.response.steamid }
    }
    return { error: 'not_found' }
  } catch (e) {
    logger.warn('resolveSteamId failed', { message: e.message })
    return { error: e.message || 'network_error' }
  }
}

module.exports = {
  testApiKey, searchGames, findAppByName, refreshGameData, refreshBanners, downloadBanner,
  getStoreArt, resolveBannerUrl, resolveSteamId,
  getSchemaForGame, getGlobalAchievementPercentages, getPlayerAchievements,
  getPlayerSummary, getOwnedGames,
}
