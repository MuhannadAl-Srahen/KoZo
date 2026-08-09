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
  // Tag each unlock with the XP it just earned. Unlocks are by far the most
  // frequent XP event — showing the number on the toast is what makes the XP
  // system visible day to day, instead of only at a level-up tens of hours apart.
  let withXp = newUnlocks
  try {
    const { xpForUnlock } = require('./xp')
    withXp = newUnlocks.map(a => ({ ...a, xp: xpForUnlock(a.global_unlock_percent) }))
  } catch {}
  const payload = { gameId: game.id, achievements: withXp, gameName: game.name, artPath, artUrl }
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

// The same state, PERSISTED and library-wide. A private profile isn't a
// per-game problem — it blocks Web-API unlock sync for every Steam game the
// user owns — and the in-memory map above only tells the UI about it after a
// sync has already failed in the current run, which is exactly when nobody is
// looking. Persisting it lets Settings → Steam show the one thing that fixes
// the whole library. Cleared automatically the moment any sync succeeds.
const PRIVACY_ERRORS = new Set(['private_profile', 'private', 'profile_not_found'])
function setProfilePrivateFlag(error) {
  try {
    const settingsQ = require('../db/queries/settings')
    const current = settingsQ.getSetting('steam_profile_private') || ''
    const next = error && PRIVACY_ERRORS.has(error) ? error : ''
    if (current !== next) {
      settingsQ.setSetting('steam_profile_private', next)
      broadcastToRenderers('steam:privacy-changed', next || null)
    }
  } catch {}
}

// IMPORTANT: "Profile is not public" is NOT a reliable statement about the
// profile. Steam returns it for any app it won't discuss for this account —
// including, very commonly, a game the user simply DOESN'T OWN on Steam. On a
// library full of cracked copies marked as Steam games, most titles answer that
// way while the account is perfectly public. Setting an account-wide flag from
// one game's refusal produced a permanent, wrong "your profile is private"
// warning. So a single failure is recorded per-GAME only; the account-level
// verdict comes from revalidateProfilePrivacy(), which requires EVERY game it
// tries to refuse before it will believe it.
let _revalidateAt = 0
const REVALIDATE_EVERY_MS = 60 * 60_000

function recordSyncError(gameId, error) {
  if (PRIVACY_ERRORS.has(error)) {
    lastSyncErrors.set(gameId, error)
    // Ask the account-level question, at most hourly — never conclude from here.
    if (Date.now() - _revalidateAt > REVALIDATE_EVERY_MS) {
      _revalidateAt = Date.now()
      setTimeout(() => { revalidateProfilePrivacy().catch(() => {}) }, 2000)
    }
  } else {
    lastSyncErrors.delete(gameId)
    // A clean read is proof the account is readable, whatever any other game says.
    if (!error) setProfilePrivateFlag(null)
  }
}
function getLastSyncError(gameId) {
  return lastSyncErrors.get(gameId) || null
}

/**
 * Decide, at the ACCOUNT level, whether Steam will serve unlocks — and correct
 * the stored flag either way.
 *
 * Two separate bugs made this necessary:
 *   1. The flag was write-mostly. It got set the moment any sync hit "private",
 *      but only a later CLEAN sync cleared it — and a failing game's in-session
 *      poll parks itself after the first permanent failure, so no such sync ever
 *      came. Setting Game details back to Public left the warning up forever.
 *   2. Worse, the conclusion itself was wrong. Steam answers "Profile is not
 *      public" for any app it won't discuss, very much including games the user
 *      doesn't OWN. A library of cracked copies tagged as Steam games therefore
 *      looked like a private profile even when it was fully public.
 *
 * So: try several games, prefer ones Steam has demonstrably served before (they
 * carry steam_api unlocks, which proves ownership), and only conclude "private"
 * if every one of them refuses. One success anywhere means the account is fine.
 */
const REVALIDATE_SAMPLE = 5

async function revalidateProfilePrivacy() {
  const settingsQ = require('../db/queries/settings')
  const steamId = settingsQ.getSetting('steam_user_id')
  if (!steamId) return { checked: false, reason: 'no_steam_id' }

  let games = []
  try {
    games = require('../db/database').getDb().prepare(`
      SELECT g.steam_app_id, g.name,
             (SELECT COUNT(*) FROM achievement_unlocks au
                JOIN achievements a ON a.id = au.achievement_id
               WHERE a.game_id = g.id AND au.source = 'steam_api') AS served,
             (SELECT COUNT(*) FROM achievements a WHERE a.game_id = g.id) AS total
      FROM games g
      WHERE g.steam_app_id IS NOT NULL AND IFNULL(g.is_cracked,0) != 1
        AND IFNULL(g.source,'') NOT IN ('epic','gog','xbox','ea','ubisoft')
      ORDER BY served DESC, total DESC
      LIMIT ?
    `).all(REVALIDATE_SAMPLE)
  } catch {}
  if (!games.length) return { checked: false, reason: 'no_steam_game' }

  const apiKey = settingsQ.getSetting('steam_api_key')
  const { getPlayerAchievements, getPlayerAchievementsXml } = require('./steamApi')
  const was = settingsQ.getSetting('steam_profile_private') || ''
  const refused = []

  // Steam answered ABOUT this account (vs. we never reached Steam at all). The
  // fetchers don't throw on network trouble, they return an error string — so
  // "no error" alone can't be read as proof the profile is public.
  const CONCLUSIVE_ERRORS = new Set([undefined, null, '', 'no_stats', 'no_stats_for_game', 'steam_error'])

  let unreachable = 0

  for (const g of games) {
    let result
    try {
      result = apiKey
        ? await getPlayerAchievements(g.steam_app_id, apiKey, steamId)
        : await getPlayerAchievementsXml(g.steam_app_id, steamId)
    } catch {
      unreachable++                         // network blip proves nothing either way
      continue
    }
    if (PRIVACY_ERRORS.has(result.error)) { refused.push(g.name); continue }
    if (!CONCLUSIVE_ERRORS.has(result.error)) { unreachable++; continue }   // timeout/5xx — no verdict

    // Steam talked to us about this account. Whatever the other games say,
    // they're saying it about ownership, not privacy.
    setProfilePrivateFlag(null)
    if (was) logger.info(`Steam profile is readable (confirmed via "${g.name}") — clearing the private-profile warning`)
    return { checked: true, private: false, changed: !!was, via: g.name }
  }

  if (!refused.length) return { checked: false, reason: 'no_conclusive_answer' }
  // "Private" is only honest when EVERY sampled game refused. If some requests
  // never reached Steam, the sample is incomplete — leave the stored flag alone
  // rather than raising a warning banner off a flaky connection.
  if (unreachable) return { checked: false, reason: 'incomplete_sample', refused: refused.length, unreachable }
  setProfilePrivateFlag('private')
  return { checked: true, private: true, tried: refused }
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

// Some appids simply have no achievement schema at all — an unreleased title, a
// demo, or a game that never shipped any. Steam answers those with 403/an empty
// list, and the in-memory backoff above resets on every restart, so KoZo asked
// again on every single launch: one guaranteed-failing request and a WARN in the
// log, forever. Persist "this appid has nothing" and back off for a week, so a
// game that later adds achievements is still picked up without the noise.
const NO_SCHEMA_RETRY_MS = 7 * 24 * 60 * 60_000
const NO_SCHEMA_SETTING = 'schema_empty_appids'   // { appid: lastCheckedMs }
let _noSchema = null

function noSchemaMap() {
  if (_noSchema) return _noSchema
  try {
    const raw = require('../db/queries/settings').getSetting(NO_SCHEMA_SETTING)
    _noSchema = raw ? JSON.parse(raw) : {}
  } catch { _noSchema = {} }
  return _noSchema
}

function isKnownEmptySchema(appid) {
  const at = noSchemaMap()[String(appid)]
  return !!at && Date.now() - at < NO_SCHEMA_RETRY_MS
}

function markEmptySchema(appid) {
  try {
    const m = noSchemaMap()
    m[String(appid)] = Date.now()
    require('../db/queries/settings').setSetting(NO_SCHEMA_SETTING, JSON.stringify(m))
  } catch {}
}

function clearEmptySchema(appid) {
  try {
    const m = noSchemaMap()
    if (m[String(appid)] === undefined) return
    delete m[String(appid)]
    require('../db/queries/settings').setSetting(NO_SCHEMA_SETTING, JSON.stringify(m))
  } catch {}
}

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
  // Persisted across restarts — this appid has no schema to fetch.
  if (!force && isKnownEmptySchema(appid)) return local

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
      clearEmptySchema(appid)
    } else {
      // Steam has nothing for this appid — remember it so we don't ask again on
      // every launch (see NO_SCHEMA_RETRY_MS).
      schemaFailAt.set(bk, Date.now())
      markEmptySchema(appid)
      logger.info(`ensureSchema: no achievements published for "${game.name}" (appid ${appid}) — not retrying for 7 days`)
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
    // Isolated: the unlock import below must still run when Steam is unreachable
    // (a cracked game's unlocks are read straight off disk and need no network).
    try {
      const { refreshGameData } = require('./steamApi')
      const result = await refreshGameData(gameId)
      if (result) {
        logger.info(`achievementSync: initial fetch done for game ${gameId}, ${result.achievementCount} achievements`)
      }
    } catch (e) {
      logger.warn(`achievementSync: initial Steam fetch failed for game ${gameId}`, { message: e.message })
    }

    // Keyless users get their schema here: refreshGameData only fetches one when
    // an API key exists, and ensureSchema owns the keyless ladder. No-op once the
    // game already has achievements.
    await ensureSchema(gameId).catch(() => {})

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
      // Unlocked = an unlock row exists. unlocked_at is nullable (Steam reports
      // no date for some unlocks), so keying on it re-detected those every pass.
      if (a.unlock_id != null) alreadyUnlocked.add(a.id)
    }

    const newUnlocks = []
    for (const su of steamUnlocks) {
      const ach = nameToAch[su.name]
      if (!ach) continue
      if (alreadyUnlocked.has(ach.id)) continue

      const unlockedAt = su.unlocktime > 0
        ? new Date(su.unlocktime * 1000).toISOString()
        : null   // no timestamp from Steam — don't lie with today's date

      const inserted = achievementsQ.addUnlock({
        achievement_id: ach.id,
        session_id: sessionId ?? null,
        unlocked_at: unlockedAt,
        source: 'steam_api',
      })
      if (!inserted) continue

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
    if (a.unlock_id != null) alreadyUnlocked.add(a.id)
  }

  let added = 0
  const newUnlocks = []
  for (const su of steamUnlocks) {
    const ach = nameToAch[su.name]
    if (!ach || alreadyUnlocked.has(ach.id)) continue
    const unlockedAt = su.unlocktime > 0
      ? new Date(su.unlocktime * 1000).toISOString()
      : null   // no timestamp from Steam — the UI shows "no date", never a fake one
    const inserted = achievementsQ.addUnlock({
      achievement_id: ach.id,
      session_id: null,
      unlocked_at: unlockedAt,
      source: 'steam_api',
    })
    if (!inserted) continue
    newUnlocks.push({ ...ach, unlocked_at: unlockedAt })
    added++
  }

  if (added > 0) emitNewUnlocks(game, newUnlocks)
  return { added, total: steamUnlocks.length, newUnlocks }
}

module.exports = { fetchAndStoreAchievements, syncAfterSession, syncPlayerUnlocks, ensureSchema, importSchemaFromAppId, autoImportSchemaByName, emitNewUnlocks, isForeignLauncher, getLastSyncError, revalidateProfilePrivacy }
