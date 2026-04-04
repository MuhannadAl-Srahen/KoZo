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

// Back up one game's saves now (no-op unless the feature is enabled). `game` is a
// full games row. Runs off the main path via setImmediate; never throws.
function backupGameAfterSession(game) {
  if (!isEnabled() || !game) return
  setImmediate(() => {
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
  })
}

module.exports = { isEnabled, backupGameAfterSession }
