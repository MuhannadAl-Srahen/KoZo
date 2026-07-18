const logger = require('../logger')

// Send a renderer event to ALL windows. getAllWindows()[0] alone is unsafe:
// after the app minimizes to tray and recreates its window, [0] can be the
// overlay window, so the main window would miss live achievement:unlocked /
// game:updated events (achievements then wouldn't refresh until a manual reload).
function broadcastToRenderers(channel, payload) {
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  } catch {}
}

// One shared "new unlocks landed" pipeline: backup flag, renderer broadcasts,
// overlay toast, OS notification (no-op), XP check. Every unlock source (Steam
// Web API, crack files, local Steam stats) funnels through this so behavior
// stays identical — this block used to be copy-pasted per source.
function emitNewUnlocks(game, newUnlocks) {
  if (!game || !newUnlocks?.length) return
  try { require('./autoBackup').markDirty() } catch {}
  broadcastToRenderers('game:updated', game.id)
  if (global.__kozoSilenceAchNotify) return
  // Game cover for the overlay toasts. Some callers pass a partial game object —
  // look the art up from the DB when the fields aren't present.
  let artPath = game.banner_local_path ?? null
  let artUrl  = game.banner_url ?? null
  if (game.banner_local_path === undefined && game.banner_url === undefined) {
    try {
      const row = require('../db/database').getDb()
        .prepare('SELECT banner_local_path, banner_url FROM games WHERE id = ?').get(game.id)
      artPath = row?.banner_local_path ?? null
      artUrl  = row?.banner_url ?? null
    } catch {}
  }
  const payload = { gameId: game.id, achievements: newUnlocks, gameName: game.name, artPath, artUrl }
  broadcastToRenderers('achievement:unlocked', payload)
  // Show over the running game in the overlay window
  try { require('../overlayWindow').sendAchievements(payload) } catch {}
  try { require('./notifications').notifyAchievements({ gameName: game.name, achievements: newUnlocks }) } catch {}
  // Unlocks earn XP — check for a level-up right away.
  try { require('./xpTracker').check({ reason: 'achievement', gameName: game.name, artPath, artUrl }) } catch {}
}

// Last Steam-sync failure per game (privacy-class errors only) so the UI can
// show "your profile is private" inline instead of silently syncing nothing.
const lastSyncErrors = new Map()
function recordSyncError(gameId, error) {
  if (error === 'private_profile' || error === 'private' || error === 'profile_not_found') {
    lastSyncErrors.set(gameId, error)
  } else {
    lastSyncErrors.delete(gameId)
  }
}
function getLastSyncError(gameId) {
  return lastSyncErrors.get(gameId) || null
}

// Foreign-launcher games (Xbox/Epic/GOG/EA/Ubisoft) have no Steam-readable
// achievements. Even if one carries a stray steam_app_id, we must never hit the
// Steam API for it — that produced confusing 400/403 errors. Cracked games are
// exempt (they legitimately use the Steam schema for names/icons).
const FOREIGN_LAUNCHERS = new Set(['epic', 'gog', 'xbox', 'ea', 'ubisoft'])
function isForeignLauncher(game) {
  return game?.is_cracked !== 1 && FOREIGN_LAUNCHERS.has(game?.source)
}

// Make sure the game's achievement SCHEMA (names/icons/descriptions) is present.
// Without it, sync can't match Steam's unlocked api-names to local rows, so NO
// unlocks ever get recorded — the #1 cause of "I unlocked it but nothing shows".
// Keyless users get the ownership-independent global fallback (getSchemaKeyless)
// — the profile XML feed only works for games the user owns, which a cracked
// game by definition isn't. Failed fetches back off 10 min (keyed on appid so a
// corrected manual_appid retries immediately); force=true (the manual "Check
// achievements" button) bypasses the backoff.
// Returns the (possibly freshly-fetched) local achievement rows.
const SCHEMA_RETRY_MS = 10 * 60_000
const schemaFailAt = new Map()   // `${gameId}:${appid}` → last failed fetch ms

async function ensureSchema(gameId, { force = false } = {}) {
  const { getDb }     = require('../db/database')
  const settingsQ     = require('../db/queries/settings')
  const achievementsQ = require('../db/queries/achievements')

  let local = achievementsQ.listAchievementsForGame(gameId)
  if (local.length > 0) return local

  const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
  // Cracked/unzipped games often carry only a name-matched manual_appid — use it
  // so their schema still auto-loads (otherwise no unlock can ever be recorded).
  const appid = game?.steam_app_id || game?.manual_appid
  if (!appid || isForeignLauncher(game)) return local

  const bk = `${gameId}:${appid}`
  if (!force && Date.now() - (schemaFailAt.get(bk) || 0) < SCHEMA_RETRY_MS) return local

  const apiKey = settingsQ.getSetting('steam_api_key')
  const steamId = settingsQ.getSetting('steam_user_id')

  try {
    const { getSchemaForGame, getSchemaKeyless, getGlobalAchievementPercentages, getPlayerAchievementsXml } = require('./steamApi')
    let schema
    if (apiKey) {
      schema = await getSchemaForGame(appid, apiKey)
    } else if (steamId) {
      // Keyless: the community XML feed carries names/descriptions/icons too —
      // but only for games this profile owns.
      const xml = await getPlayerAchievementsXml(appid, steamId)
      schema = xml.error ? [] : xml.schema
    }
    if (!schema || !schema.length) {
      // No key, or the user doesn't own the game on Steam (every cracked game):
      // build the schema from Steam's keyless global endpoints instead.
      schema = await getSchemaKeyless(appid)
    }
    const pcts = await getGlobalAchievementPercentages(appid).catch(() => ({}))
    const achievements = (schema || []).map(a => ({
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
      logger.info(`ensureSchema: fetched ${achievements.length} achievements for "${game.name}"`)
      local = achievementsQ.listAchievementsForGame(gameId)
      schemaFailAt.delete(bk)
    } else {
      schemaFailAt.set(bk, Date.now())
    }
  } catch (e) {
    logger.warn(`ensureSchema failed for game ${gameId}`, { message: e.message })
    schemaFailAt.set(bk, Date.now())
  }
  return local
}

// Manually import an achievement LIST (schema only — no unlocks) from any Steam
// appid, for games KoZo can't auto-track (Xbox/Epic/GOG/EA/Ubisoft/manual). The
// user supplies the appid (their game's Steam equivalent); we pull names, icons,
// descriptions and global rarity %, store them, and remember the appid so it can
// be re-imported. Unlocks are then hand-ticked in the UI. Deliberately bypasses
// the foreign-launcher guard because this is an explicit user action — but it
// NEVER fetches player unlocks, so no 400/403 from private/owned-only endpoints.
async function importSchemaFromAppId(gameId, appId) {
  const { getDb }     = require('../db/database')
  const settingsQ     = require('../db/queries/settings')
  const achievementsQ = require('../db/queries/achievements')
  const { getSchemaForGame, getGlobalAchievementPercentages } = require('./steamApi')

  const appid = parseInt(appId, 10)
  if (!appid || appid < 1) throw new Error('Enter a valid Steam App ID.')
  const apiKey = settingsQ.getSetting('steam_api_key')
  const steamId = settingsQ.getSetting('steam_user_id')

  let schema
  if (apiKey) {
    schema = await getSchemaForGame(appid, apiKey).catch(() => [])
  }
  if ((!schema || !schema.length) && steamId) {
    // The community XML feed has the full list + icons — but only for games
    // this profile owns.
    const { getPlayerAchievementsXml } = require('./steamApi')
    const xml = await getPlayerAchievementsXml(appid, steamId).catch(() => ({ error: 'xml_failed' }))
    if (!xml.error) schema = xml.schema
  }
  if (!schema || !schema.length) {
    // Ownership-independent keyless fallback — works with no key and no account.
    const { getSchemaKeyless } = require('./steamApi')
    schema = await getSchemaKeyless(appid)
  }
  const pcts = await getGlobalAchievementPercentages(appid).catch(() => ({}))
  const achievements = (schema || []).map(a => ({
    steam_api_name: a.name,
    display_name: a.displayName || a.name,
    description: a.description || null,
    icon_url: a.icon || null,
    icon_locked_url: a.icongray || null,
    global_unlock_percent: pcts[a.name] ?? null,
    is_hidden: a.hidden === 1 ? 1 : 0,
  }))
  if (achievements.length === 0) {
    return { count: 0, reason: 'no_schema' }
  }
  achievementsQ.bulkUpsertAchievements(gameId, achievements)
  // Remember the appid for re-import (does NOT touch steam_app_id, so a foreign
  // launcher stays non-Steam-tracked and auto-sync is never enabled).
  try { getDb().prepare('UPDATE games SET manual_appid = ? WHERE id = ?').run(appid, gameId) } catch {}

  broadcastToRenderers('game:updated', gameId)
  logger.info(`importSchemaFromAppId: stored ${achievements.length} achievements for game ${gameId} from appid ${appid}`)
  return { count: achievements.length }
}

// Automatically resolve a Steam appid by the game's NAME and import its
// achievement list — no App ID typing required. Used on add (scan / manual) and
// from the GameDetail "Import achievements" action for games KoZo can't auto-track
// (Xbox/Epic/GOG/etc.). Skips if the game already has achievements. Returns a
// structured result so the UI can explain what happened.
async function autoImportSchemaByName(gameId, { force = false } = {}) {
  const { getDb }     = require('../db/database')
  const achievementsQ = require('../db/queries/achievements')

  const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
  if (!game) return { count: 0, reason: 'no_game' }
  // force = explicit "Re-import" from the UI: refresh names/icons/rarity even
  // when the list already exists (upsert keyed on api name — unlocks survive).
  if (!force && achievementsQ.listAchievementsForGame(gameId).length > 0) return { count: 0, reason: 'already' }
  // No API key needed: name matching uses the keyless store search, and
  // importSchemaFromAppId has keyless fallbacks all the way down.

  // Prefer an appid we already know; otherwise match by name (confident matches only).
  let appId = game.manual_appid || game.steam_app_id
  if (!appId) {
    try {
      const { findAppByName } = require('./steamApi')
      const match = await findAppByName(game.name)
      if (!match?.steam_app_id) return { count: 0, reason: 'no_match' }
      appId = match.steam_app_id
    } catch (e) {
      return { count: 0, reason: 'no_match' }
    }
  }
  try {
    return await importSchemaFromAppId(gameId, appId)
  } catch (e) {
    logger.warn(`autoImportSchemaByName failed for game ${gameId}`, { message: e.message })
    return { count: 0, reason: 'error', error: e.message }
  }
}

// Called once after a game is added to fetch schema + banners AND import any
// already-unlocked achievements, so a game you've played shows its unlocks the
// moment it's added (via single Add, PC scan, or Steam import).
async function fetchAndStoreAchievements(gameId) {
  try {
    const { refreshGameData } = require('./steamApi')
    const result = await refreshGameData(gameId)
    if (result) {
      logger.info(`achievementSync: initial fetch done for game ${gameId}, ${result.achievementCount} achievements`)
    }

    // Pull existing unlocks. Silence notifications — a freshly added game can have
    // dozens of unlocks and we don't want a toast storm just for adding it.
    const { getDb } = require('../db/database')
    const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
    const prevSilent = global.__kozoSilenceAchNotify
    global.__kozoSilenceAchNotify = true
    try {
      if (game?.is_cracked) {
        const { scanGameForCrackAchievements } = require('./crackWatcher')
        const r = await scanGameForCrackAchievements(gameId).catch(() => ({ added: 0 }))
        if (r?.added) logger.info(`achievementSync: imported ${r.added} crack unlock(s) on add for game ${gameId}`)
      } else {
        const r = await syncPlayerUnlocks(gameId).catch(() => ({ added: 0 }))
        if (r?.added) logger.info(`achievementSync: imported ${r.added} Steam unlock(s) on add for game ${gameId}`)
      }
    } finally {
      global.__kozoSilenceAchNotify = prevSilent
    }

    broadcastToRenderers('game:updated', gameId)
  } catch (e) {
    logger.warn(`achievementSync: fetchAndStoreAchievements failed for game ${gameId}`, { message: e.message })
  }
}

// Called after every session ends to diff Steam unlocks against our DB.
async function syncAfterSession(gameId, sessionId) {
  try {
    const { getDb }        = require('../db/database')
    const settingsQ        = require('../db/queries/settings')
    const achievementsQ    = require('../db/queries/achievements')
    const { getPlayerAchievements } = require('./steamApi')

    const game    = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
    if (!game?.steam_app_id || isForeignLauncher(game)) return

    const apiKey  = settingsQ.getSetting('steam_api_key')
    const steamId = settingsQ.getSetting('steam_user_id')
    if (!steamId) return

    // Keyless fallback: the public community XML feed needs no API key.
    const result = apiKey
      ? await getPlayerAchievements(game.steam_app_id, apiKey, steamId)
      : await require('./steamApi').getPlayerAchievementsXml(game.steam_app_id, steamId)
    recordSyncError(gameId, result.error)
    if (result.error) {
      logger.warn(`syncAfterSession: ${result.error} for ${game.name}`)
      return
    }
    const steamUnlocks = result.unlocks
    if (!steamUnlocks.length) return

    const localAchs = await ensureSchema(gameId)
    const nameToAch = {}
    const alreadyUnlocked = new Set()
    for (const a of localAchs) {
      nameToAch[a.steam_api_name] = a
      if (a.unlocked_at) alreadyUnlocked.add(a.id)
    }

    const newUnlocks = []
    for (const su of steamUnlocks) {
      const ach = nameToAch[su.name]
      if (!ach) continue
      if (alreadyUnlocked.has(ach.id)) continue

      const unlockedAt = su.unlocktime > 0
        ? new Date(su.unlocktime * 1000).toISOString()
        : null   // no timestamp from Steam — don't lie with today's date

      achievementsQ.addUnlock({
        achievement_id: ach.id,
        session_id: sessionId ?? null,
        unlocked_at: unlockedAt,
        source: 'steam_api',
      })

      newUnlocks.push({ ...ach, unlocked_at: unlockedAt })
      logger.info(`Achievement unlocked: ${ach.display_name} for ${game.name}`)
    }

    emitNewUnlocks(game, newUnlocks)

  } catch (e) {
    logger.warn(`achievementSync: syncAfterSession failed for game ${gameId}`, { message: e.message })
  }
}

// Manual sync — pulls the player's current Steam unlocks for one game and stores
// any that aren't already unlocked locally. Returns { added, total } counts.
// Called by the GameDetail "Refresh achievements" menu and the Settings
// "Sync all from Steam" button.
async function syncPlayerUnlocks(gameId) {
  const { getDb }                 = require('../db/database')
  const settingsQ                 = require('../db/queries/settings')
  const achievementsQ             = require('../db/queries/achievements')
  const { getPlayerAchievements } = require('./steamApi')

  const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
  if (!game?.steam_app_id) return { added: 0, total: 0, reason: 'no_steam_app_id' }
  if (isForeignLauncher(game)) return { added: 0, total: 0, reason: 'foreign_launcher' }

  const apiKey  = settingsQ.getSetting('steam_api_key')
  const steamId = settingsQ.getSetting('steam_user_id')
  if (!steamId) return { added: 0, total: 0, reason: 'no_steam_id' }

  // Keyless fallback: public profiles work with no API key at all.
  const result = apiKey
    ? await getPlayerAchievements(game.steam_app_id, apiKey, steamId)
    : await require('./steamApi').getPlayerAchievementsXml(game.steam_app_id, steamId)
  recordSyncError(gameId, result.error)
  if (result.error) {
    return { added: 0, total: 0, reason: result.error }
  }
  const steamUnlocks = result.unlocks
  // Ensure the schema exists, otherwise nothing can be matched.
  const localAchs = await ensureSchema(gameId)
  const nameToAch = {}
  const alreadyUnlocked = new Set()
  for (const a of localAchs) {
    nameToAch[a.steam_api_name] = a
    if (a.unlocked_at) alreadyUnlocked.add(a.id)
  }

  let added = 0
  const newUnlocks = []
  for (const su of steamUnlocks) {
    const ach = nameToAch[su.name]
    if (!ach || alreadyUnlocked.has(ach.id)) continue
    const unlockedAt = su.unlocktime > 0
      ? new Date(su.unlocktime * 1000).toISOString()
      : new Date().toISOString()
    achievementsQ.addUnlock({
      achievement_id: ach.id,
      session_id: null,
      unlocked_at: unlockedAt,
      source: 'steam_api',
    })
    newUnlocks.push({ ...ach, unlocked_at: unlockedAt })
    added++
  }

  if (added > 0) emitNewUnlocks(game, newUnlocks)
  return { added, total: steamUnlocks.length, newUnlocks }
}

module.exports = { fetchAndStoreAchievements, syncAfterSession, syncPlayerUnlocks, ensureSchema, importSchemaFromAppId, autoImportSchemaByName, emitNewUnlocks, isForeignLauncher, getLastSyncError }
