'use strict'

// Automatic game-save backups (Settings → Backups), stored by saveVault.js.
// A game is backed up only from its CONFIRMED save locations (games.save_paths),
// which saveDetect.js fills in on its own: the Ludusavi manifest, emulator
// folders, Steam Cloud, and the folders a game wrote to while it was played.
// The old way, taking the first folder a name search turned up, could back up
// the wrong folder and never the real save.
//
//   before-play: right before KoZo starts the game, and when a session starts
//                (games started outside KoZo). Unchanged saves cost nothing,
//                and it gives up after a few seconds rather than hold a launch.
//   after-play:  after the session ends, behind the idle gate.

const logger = require('../logger')

function isEnabled() {
  try { return require('../db/queries/settings').getSetting('auto_save_backup_enabled') === '1' }
  catch { return false }
}

function getSavePaths(game) {
  try { const v = JSON.parse(game?.save_paths || '[]'); return Array.isArray(v) ? v.filter(Boolean) : [] } catch { return [] }
}

function setSavePaths(gameId, paths) {
  const db = require('../db/database').getDb()
  const clean = [...new Set((paths || []).map(p => String(p).trim()).filter(Boolean))]
  db.prepare('UPDATE games SET save_paths = ? WHERE id = ?').run(clean.length ? JSON.stringify(clean) : null, gameId)
  return clean
}

// Confirmed paths, or what saveDetect finds now (saved as confirmed, so the
// user sees them in the game's backup window).
function resolvePaths(game) {
  const confirmed = getSavePaths(game)
  if (confirmed.length) return confirmed
  try { return require('./saveDetect').confirmFor(game) } catch { return [] }
}

const pending = new Map()

function take(game, reason, opts = {}) {
  try {
    const fresh = require('../db/queries/games').getGame(game.id) || game
    const paths = opts.confirmedOnly ? getSavePaths(fresh) : resolvePaths(fresh)
    if (!paths.length) { logger.debug(`autoSaveBackup: "${fresh.name}" has no confirmed save location`); return null }
    const r = require('./saveVault').snapshot(fresh, paths, reason, opts)
    if (r?.skipped) logger.debug(`autoSaveBackup: "${fresh.name}" ${reason}: ${r.skipped}`)
    return r
  } catch (e) {
    logger.warn(`autoSaveBackup ${reason} failed for "${game?.name}"`, { message: e.message })
    return null
  }
}

// Right before a launch (and at session start): quick, never blocks long.
// Skipped when a backup was taken in the last 2 minutes (a launch from KoZo
// already took one, then the session start would walk the files again).
// `confirmedOnly` (session start): the game is already running, so back up what
// is known and leave finding new save folders for after it closes.
const lastBefore = new Map()
function beforePlay(game, { confirmedOnly = false } = {}) {
  if (!isEnabled() || !game) return null
  if (Date.now() - (lastBefore.get(game.id) || 0) < 120000) return null
  lastBefore.set(game.id, Date.now())
  return take(game, 'before-play', { maxMs: 4000, fast: true, confirmedOnly })
}

// After a session: learn where the game saved (folders it wrote to while it
// ran), then back up. `session` = { started_at, ended_at }.
function backupGameAfterSession(game, session = null) {
  if (!isEnabled() || !game) return
  pending.set(game.id, game)
  const run = () => setImmediate(() => {
    if (!pending.delete(game.id)) return
    try {
      const fresh = require('../db/queries/games').getGame(game.id) || game
      const learned = session?.started_at ? require('./saveDetect').learnFromSession(fresh, session.started_at, session.ended_at) : []
      require('./saveDetect').confirmFor(fresh, learned)
    } catch (e) { logger.warn('autoSaveBackup: detection failed', { message: e.message }) }
    take(game, 'after-play')
    try { require('./googleDrive').syncSoon() } catch {}
    try { require('./backupCopy').syncSoon() } catch {}
    try {
      const games = require('../db/database').getDb().prepare('SELECT id, name FROM games WHERE save_paths IS NOT NULL').all()
      require('./saveVault').enforceCap(games)
    } catch {}
  })
  // Never in the moment the game closes (it is still writing its saves, and
  // Windows is busy unloading it): queue it for the quiet drain afterwards.
  try {
    const pw = require('./processWatcher')
    if (pw.isSessionActive()) pw.runWhenIdle(`autoSaveBackup:${game.id}`, run)
    else setTimeout(() => (pw.isSessionActive() ? pw.runWhenIdle(`autoSaveBackup:${game.id}`, run) : run()), 30000)
  } catch { run() }
}

// Take every still-queued snapshot now (will-quit).
function flushPending() {
  if (!pending.size) return 0
  const games = [...pending.values()]
  pending.clear()
  logger.info(`autoSaveBackup: taking ${games.length} pending save backup(s) before quit`)
  for (const g of games) take(g, 'after-play')
  return games.length
}

module.exports = { isEnabled, beforePlay, backupGameAfterSession, flushPending, getSavePaths, setSavePaths, resolvePaths }
