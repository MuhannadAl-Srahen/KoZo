'use strict'

// Automatic backup — keeps a JSON dump of everything (games, sessions,
// achievements, game list, categories, settings) in sync with any change.
//
// Triggers:
//   • markDirty()  — debounced 8s after the last data change (games added, a
//     session ends, an achievement unlocks, list edits, etc.)
//   • a periodic safety-net flush (every 5 min) so nothing is ever stale
//   • flush() on app quit
// All gated behind the user enabling it and choosing a folder in Settings → Data.

const fs   = require('fs')
const path = require('path')
const logger = require('../logger')

const TABLES = ['games', 'sessions', 'achievements', 'achievement_unlocks', 'game_list', 'categories', 'settings']

let debounceTimer = null
let periodicTimer = null

function getConfig() {
  try {
    const settingsQ = require('../db/queries/settings')
    return {
      enabled: settingsQ.getSetting('auto_backup_enabled') === '1',
      dir:     settingsQ.getSetting('auto_backup_dir') || null,
    }
  } catch {
    return { enabled: false, dir: null }
  }
}

function buildPayload() {
  const db = require('../db/database').getDb()
  const payload = { version: 1, app: 'kozo', exported_at: new Date().toISOString(), auto: true }
  for (const t of TABLES) {
    try { payload[t] = db.prepare(`SELECT * FROM ${t}`).all() } catch { payload[t] = [] }
  }
  return payload
}

function writeNow() {
  const { enabled, dir } = getConfig()
  if (!enabled || !dir) return false
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'kozo-autobackup.json')
    fs.writeFileSync(file, JSON.stringify(buildPayload(), null, 2), 'utf8')
    logger.info(`autoBackup: saved ${file}`)
    return true
  } catch (e) {
    logger.warn('autoBackup: write failed', { message: e.message })
    return false
  }
}

function markDirty() {
  if (!getConfig().enabled) return
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(writeNow, 8000)
}

function flush() {
  clearTimeout(debounceTimer)
  writeNow()
}

function startPeriodic() {
  if (periodicTimer) return
  periodicTimer = setInterval(() => {
    if (getConfig().enabled) writeNow()
  }, 5 * 60 * 1000)
}

module.exports = { markDirty, flush, writeNow, getConfig, startPeriodic }
