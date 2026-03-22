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
// Returns the (possibly freshly-fetched) local achievement rows.
async function ensureSchema(gameId) {
  const { getDb }     = require('../db/database')
  const settingsQ     = require('../db/queries/settings')
  const achievementsQ = require('../db/queries/achievements')

  let local = achievementsQ.listAchievementsForGame(gameId)
  if (local.length > 0) return local

  const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
  if (!game?.steam_app_id || isForeignLauncher(game)) return local
  const apiKey = settingsQ.getSetting('steam_api_key')
  if (!apiKey) return local

  try {
    const { getSchemaForGame, getGlobalAchievementPercentages } = require('./steamApi')
    const [schema, pcts] = await Promise.all([
      getSchemaForGame(game.steam_app_id, apiKey),
      getGlobalAchievementPercentages(game.steam_app_id).catch(() => ({})),
    ])
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
    }
  } catch (e) {
    logger.warn(`ensureSchema failed for game ${gameId}`, { message: e.message })
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
  if (!apiKey) throw new Error('Add your Steam Web API key in Settings → Steam first.')

  const [schema, pcts] = await Promise.all([
    getSchemaForGame(appid, apiKey),
    getGlobalAchievementPercentages(appid).catch(() => ({})),
  ])
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
async function autoImportSchemaByName(gameId) {
  const { getDb }     = require('../db/database')
  const settingsQ     = require('../db/queries/settings')
  const achievementsQ = require('../db/queries/achievements')

  const game = getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
  if (!game) return { count: 0, reason: 'no_game' }
  if (achievementsQ.listAchievementsForGame(gameId).length > 0) return { count: 0, reason: 'already' }

  const apiKey = settingsQ.getSetting('steam_api_key')
  if (!apiKey) return { count: 0, reason: 'no_key' }

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
    if (!apiKey || !steamId) return

    const result = await getPlayerAchievements(game.steam_app_id, apiKey, steamId)
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

    if (newUnlocks.length > 0) {
      try { require('./autoBackup').markDirty() } catch {}
      const payload = { gameId, achievements: newUnlocks, gameName: game.name }
      broadcastToRenderers('achievement:unlocked', payload)
      broadcastToRenderers('game:updated', gameId)
      // Also send to the game overlay window so it shows over the running game
      try { require('../overlayWindow').sendAchievements(payload) } catch {}
      try {
        require('./notifications').notifyAchievements({ gameName: game.name, achievements: newUnlocks })
      } catch {}
    }

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
  if (!apiKey)  return { added: 0, total: 0, reason: 'no_api_key' }
  if (!steamId) return { added: 0, total: 0, reason: 'no_steam_id' }

  const result = await getPlayerAchievements(game.steam_app_id, apiKey, steamId)
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

  if (added > 0) {
    try { require('./autoBackup').markDirty() } catch {}
    broadcastToRenderers('game:updated', gameId)
    if (!global.__kozoSilenceAchNotify) {
      const payload = { gameId, achievements: newUnlocks, gameName: game.name }
      broadcastToRenderers('achievement:unlocked', payload)
      // Show over the running game in the overlay window
      try { require('../overlayWindow').sendAchievements(payload) } catch {}
      try {
        require('./notifications').notifyAchievements({ gameName: game.name, achievements: newUnlocks })
      } catch {}
    }
  }
  return { added, total: steamUnlocks.length, newUnlocks }
}

module.exports = { fetchAndStoreAchievements, syncAfterSession, syncPlayerUnlocks, ensureSchema, importSchemaFromAppId, autoImportSchemaByName }
