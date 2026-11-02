'use strict'

// Automatic game-save backups (Settings → Backups → Game saves), stored by
// saveVault.js. A game is backed up only from its CONFIRMED save locations
// (games.save_paths): either the user confirmed them, or the Ludusavi manifest
// knew them exactly (saveManifest.js). The old way, taking the first folder a
// name search turned up after every session, could back up the wrong folder
// and never the real save.
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

// Confirmed paths, or the manifest's exact ones (saved as confirmed the first
// time they're used, so the user sees them in the Saves panel).
function resolvePaths(game) {
  const confirmed = getSavePaths(game)
  if (confirmed.length) return confirmed
  try {
    const known = require('./saveManifest').pathsFor(game).map(h => h.path)
    if (known.length) {
      setSavePaths(game.id, known)
      logger.info(`autoSaveBackup: using the known save location for "${game.name}"`, { paths: known })
      return known
    }
  } catch {}
  return []
}

const pending = new Map()

function take(game, reason, opts) {
  try {
    const fresh = require('../db/queries/games').getGame(game.id) || game
    const paths = resolvePaths(fresh)
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
function beforePlay(game) {
  if (!isEnabled() || !game) return null
  return take(game, 'before-play', { maxMs: 4000 })
}

function backupGameAfterSession(game) {
  if (!isEnabled() || !game) return
  pending.set(game.id, game)
  const run = () => setImmediate(() => {
    if (!pending.delete(game.id)) return
    take(game, 'after-play')
    try {
      const games = require('../db/database').getDb().prepare('SELECT id, name FROM games WHERE save_paths IS NOT NULL').all()
      require('./saveVault').enforceCap(games)
    } catch {}
  })
  try { require('./processWatcher').runWhenIdle(`autoSaveBackup:${game.id}`, run) } catch { run() }
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
