'use strict'

// Automatic game-save backups — the save-file equivalent of autoBackup.js (which
// backs up KoZo's own data). When enabled (Settings → Backups → Game Save Files),
// each game's save folder is snapshotted into "Documents/KoZo Saves" right after a
// play session ends, so your in-game progress is versioned without any manual step.
//
// Locating the save folder uses the same accuracy-first finder as the manual UI.
// saveBackup.autoBackupGame dedupes (skips if nothing changed) and prunes old
// auto snapshots, so this is safe to call after every session.

const logger = require('../logger')

function isEnabled() {
  try { return require('../db/queries/settings').getSetting('auto_save_backup_enabled') === '1' }
  catch { return false }
}

// Snapshots that are queued but haven't been taken yet (gameId → games row). The
// idle gate can hold one for as long as ANY other game keeps playing, and neither
// processWatcher.stop() nor quitting drains that queue — so the pending set is
// also flushed from will-quit. Dropping a save snapshot silently is worse than a
// short copy at exit.
const pending = new Map()

function snapshot(game) {
  try {
    const { findSaveLocations } = require('./saveFinder')
    const { autoBackupGame }    = require('./saveBackup')
    const locs = findSaveLocations(game) || []
    if (!locs.length) { logger.debug(`autoSaveBackup: no save folder found for "${game.name}"`); return }
    const r = autoBackupGame(game.name, locs[0].path)
    if (r?.skipped) logger.debug(`autoSaveBackup: "${game.name}" — ${r.skipped}`)
    else logger.info(`autoSaveBackup: snapshotted "${game.name}" saves (${r?.files ?? '?'} files)`)
  } catch (e) {
    logger.warn(`autoSaveBackup failed for "${game?.name}"`, { message: e.message })
  }
}

// Back up one game's saves now (no-op unless the feature is enabled). `game` is a
// full games row. Runs off the main path via setImmediate; never throws.
//
// The sweep + recursive copy are synchronous main-thread work, so they go through
// the idle gate: sessions can overlap, and this one ending doesn't mean another
// game isn't still running (see processWatcher isSessionActive). Keyed per game so
// two games ending during a third's session don't coalesce into one backup.
function backupGameAfterSession(game) {
  if (!isEnabled() || !game) return
  pending.set(game.id, game)
  const run = () => setImmediate(() => {
    if (!pending.delete(game.id)) return   // flushPending() already took it
    snapshot(game)
  })
  try { require('./processWatcher').runWhenIdle(`autoSaveBackup:${game.id}`, run) } catch { run() }
}

// Take every still-queued snapshot right now, inline. Called from main.js's
// will-quit next to autoBackup.flush(): a job parked behind the idle gate would
// otherwise be lost, and merely rescheduling it there wouldn't help — Electron
// tears the environment down straight after will-quit, so a pending setImmediate
// is not guaranteed to run. Only these save-file jobs are flushed; the other
// deferred work (crack deep scans, install checks) is disk sweeping that must
// stay behind the idle gate.
function flushPending() {
  if (!pending.size) return 0
  const games = [...pending.values()]
  pending.clear()
  logger.info(`autoSaveBackup: taking ${games.length} pending save snapshot(s) before quit`)
  for (const g of games) snapshot(g)
  return games.length
}

module.exports = { isEnabled, backupGameAfterSession, flushPending }
