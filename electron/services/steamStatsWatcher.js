const fs = require('fs')
const path = require('path')
const logger = require('../logger')

// ── Instant Steam achievement detection ───────────────────────────────────────
// The Steam Web API caches GetPlayerAchievements server-side, so a fresh unlock
// can take minutes to appear there. The Steam CLIENT, however, writes the unlock
// to a local stats file within moments:
//   <Steam>\appcache\stats\UserGameStats_<accountid>_<appid>.bin
// This service watches that file during a session and parses it (binary
// KeyValues, see binaryKV.js) together with the schema file in the same folder
// (UserGameStatsSchema_<appid>.bin) to detect newly-unlocked api-names — so the
// overlay/toast fires within ~1-2 seconds of the in-game unlock.
//
// The Web API sync (10s in-session poll + post-session retries) stays untouched
// as reconciliation: it backfills real unlock timestamps and anything the local
// parse missed. If parsing fails (format quirk), we fall back to a Web API
// sync burst instead.

const STEAMID64_BASE = 76561197960265728n

// gameId → { watcher, statsFile, schemaFile, sessionId }
const watchers = new Map()
// gameId → per-game scan debounce timer
const scanDebounce = new Map()

let cachedSteamPath // undefined = not probed, null = not found

function getSteamPath() {
  if (cachedSteamPath !== undefined) return cachedSteamPath
  const { execSync } = require('child_process')
  const tryReg = (cmd, valueName) => {
    try {
      const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' })
      const m = out.match(new RegExp(`${valueName}\\s+REG_SZ\\s+(.+)`, 'i'))
      if (m) {
        const p = m[1].trim().replace(/\//g, '\\')
        if (fs.existsSync(p)) return p
      }
    } catch {}
    return null
  }
  cachedSteamPath =
    tryReg('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', 'SteamPath') ||
    tryReg('reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath', 'InstallPath') ||
    (fs.existsSync('C:\\Program Files (x86)\\Steam') ? 'C:\\Program Files (x86)\\Steam' : null)
  if (!cachedSteamPath) logger.debug('steamStatsWatcher: Steam install path not found')
  return cachedSteamPath
}

// SteamID64 (stored in settings) → account id used in the stats filename.
function getAccountId() {
  try {
    const raw = require('../db/queries/settings').getSetting('steam_user_id')
    if (!raw || !/^\d+$/.test(String(raw).trim())) return null
    const id64 = BigInt(String(raw).trim())
    if (id64 <= STEAMID64_BASE) return null
    return (id64 - STEAMID64_BASE).toString()
  } catch { return null }
}

function statsFilesFor(appid) {
  const steam = getSteamPath()
  const acct = getAccountId()
  if (!steam || !acct) return null
  const dir = path.join(steam, 'appcache', 'stats')
  return {
    statsFile: path.join(dir, `UserGameStats_${acct}_${appid}.bin`),
    schemaFile: path.join(dir, `UserGameStatsSchema_${appid}.bin`),
  }
}

// Parse both files → Set of unlocked api-names, or null if either file is
// missing/unparseable (caller decides on the Web API fallback).
function readUnlockedSet(files) {
  const { parseBinaryKV, unlockedApiNames } = require('./binaryKV')
  let statsBuf, schemaBuf
  try {
    statsBuf = fs.readFileSync(files.statsFile)
    schemaBuf = fs.readFileSync(files.schemaFile)
  } catch { return null }
  const statsRoot = parseBinaryKV(statsBuf)
  const schemaRoot = parseBinaryKV(schemaBuf)
  if (!statsRoot || !schemaRoot) return null
  return unlockedApiNames(schemaRoot, statsRoot)
}

// Web API fallback when the local parse fails: sync now, then a short burst —
// the API cache usually clears within a couple of minutes.
const burstScheduled = new Set()
function webApiBurst(gameId) {
  if (burstScheduled.has(gameId)) return
  burstScheduled.add(gameId)
  const run = () => {
    require('./achievementSync').syncPlayerUnlocks(gameId).catch(() => {})
  }
  setImmediate(run)
  for (const sec of [20, 45, 90]) setTimeout(run, sec * 1000)
  setTimeout(() => burstScheduled.delete(gameId), 120 * 1000)
}

async function scanGame(gameId) {
  const entry = watchers.get(gameId)
  if (!entry) return { added: 0 }
  const gamesQ = require('../db/queries/games')
  const achievementsQ = require('../db/queries/achievements')

  const game = gamesQ.getGame(gameId)
  if (!game) return { added: 0 }

  const unlockedSet = readUnlockedSet(entry)
  if (unlockedSet === null) {
    logger.debug(`steamStatsWatcher: local parse unavailable for "${game.name}" — Web API burst fallback`)
    webApiBurst(gameId)
    return { added: 0, fallback: true }
  }

  // Make sure the schema rows exist so api-names can be matched to local rows.
  let localAchs = achievementsQ.listAchievementsForGame(gameId)
  if (!localAchs.length) {
    try { localAchs = await require('./achievementSync').ensureSchema(gameId) } catch {}
  }

  let added = 0
  const newUnlocks = []
  const now = new Date().toISOString()
  for (const ach of localAchs) {
    if (ach.unlocked_at) continue
    if (!ach.steam_api_name || !unlockedSet.has(ach.steam_api_name)) continue
    try {
      achievementsQ.addUnlock({
        achievement_id: ach.id,
        session_id: entry.sessionId ?? null,
        // The file just changed, so "now" is accurate for live unlocks; older
        // unlocks caught on the initial scan get corrected later by the Web
        // API reconciliation (which carries Steam's real unlock timestamps).
        unlocked_at: now,
        source: 'steam_stats',
      })
      newUnlocks.push({ ...ach, unlocked_at: now })
      added++
    } catch {}
  }

  if (added > 0) {
    logger.info(`steamStatsWatcher: ${added} instant unlock(s) for "${game.name}" from local Steam stats`)
    require('./achievementSync').emitNewUnlocks(game, newUnlocks)
  }
  return { added }
}

function scheduleScan(gameId) {
  clearTimeout(scanDebounce.get(gameId))
  scanDebounce.set(gameId, setTimeout(() => {
    scanDebounce.delete(gameId)
    scanGame(gameId).catch(e =>
      logger.warn(`steamStatsWatcher: scan failed for game ${gameId}`, { message: e.message }))
  }, 300))
}

/**
 * Start watching the local Steam stats file for one game's session. No-op for
 * cracked games (crackWatcher covers those), foreign launchers, or games
 * without a steam_app_id.
 */
function watchGame(gameId, sessionId) {
  if (watchers.has(gameId)) return
  let game
  try { game = require('../db/queries/games').getGame(gameId) } catch { return }
  if (!game || !game.steam_app_id || game.is_cracked === 1) return
  try {
    if (require('./achievementSync').isForeignLauncher(game)) return
  } catch { return }

  const files = statsFilesFor(game.steam_app_id)
  if (!files) return

  let chokidar
  try { chokidar = require('chokidar') } catch { return }

  let watcher
  try {
    // Watch the exact file (chokidar handles it appearing later). Steam rewrites
    // it atomically on unlock, so awaitWriteFinish avoids reading a half-write.
    watcher = chokidar.watch(files.statsFile, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    })
  } catch (e) {
    logger.warn(`steamStatsWatcher: failed to watch for game ${gameId}`, { message: e.message })
    return
  }

  watcher.on('add',    () => scheduleScan(gameId))
  watcher.on('change', () => scheduleScan(gameId))
  watcher.on('error', (e) => logger.debug('steamStatsWatcher: watch error', { message: e.message }))

  watchers.set(gameId, { watcher, ...files, sessionId: sessionId ?? null })
  logger.info(`steamStatsWatcher: watching local Steam stats for "${game.name}"`, { file: files.statsFile })

  // Initial scan — catches unlocks that landed before the watcher started
  // (e.g. earned at the very start of the session, or while KoZo was closed).
  scheduleScan(gameId)
}

function unwatchGame(gameId) {
  const entry = watchers.get(gameId)
  if (!entry) return
  watchers.delete(gameId)
  clearTimeout(scanDebounce.get(gameId))
  scanDebounce.delete(gameId)
  try { entry.watcher.close() } catch {}
}

function unwatchAll() {
  for (const gameId of [...watchers.keys()]) unwatchGame(gameId)
}

// Read the logged-in Steam account (SteamID64 + persona name) from Steam's
// local loginusers.vdf — picks the MostRecent account, falling back to the
// newest Timestamp. Used for silent auto-setup so nobody types their ID.
function detectLoggedInUser() {
  const steamPath = getSteamPath()
  if (!steamPath) return { error: 'steam_not_found' }
  const vdfPath = path.join(steamPath, 'config', 'loginusers.vdf')
  if (!fs.existsSync(vdfPath)) return { error: 'no_users' }
  try {
    const raw = fs.readFileSync(vdfPath, 'utf8')
    const users = []
    for (const m of raw.matchAll(/"(7656\d{13})"\s*\{([^}]*)\}/g)) {
      const body = m[2]
      users.push({
        steamId: m[1],
        personaName: body.match(/"PersonaName"\s*"([^"]*)"/i)?.[1] || '',
        mostRecent: /"MostRecent"\s*"1"/i.test(body),
        timestamp: parseInt(body.match(/"Timestamp"\s*"(\d+)"/i)?.[1] || '0', 10),
      })
    }
    if (!users.length) return { error: 'no_users' }
    const pick = users.find(u => u.mostRecent)
      || users.slice().sort((a, b) => b.timestamp - a.timestamp)[0]
    return { steamId: pick.steamId, personaName: pick.personaName }
  } catch (e) {
    logger.warn('detectLoggedInUser failed', { message: e.message })
    return { error: 'parse_failed' }
  }
}

module.exports = { watchGame, unwatchGame, unwatchAll, scanGame, getSteamPath, detectLoggedInUser }
