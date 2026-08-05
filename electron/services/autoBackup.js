'use strict'

// Automatic backup — keeps a JSON dump of everything (games, sessions,
// achievements, game list, categories, settings) in sync with any change.
//
// Triggers:
//   • markDirty()  — debounced after the last data change (games added, a
//     session ends, an achievement unlocks, list edits, etc.)
//   • a periodic safety-net flush (every 5 min) so nothing is ever stale
//   • flush() on app quit
// All gated behind the user enabling it and choosing a folder in Settings → Data.
//
// PERF: the dump is a real cost — nine full table reads, a pretty-printed
// JSON.stringify of the whole database (~800 KB for a mature library) and a
// write to whatever disk the user picked. It used to run on a SYNCHRONOUS
// writeFileSync every 5 minutes and 8 seconds after any change, which meant it
// fired repeatedly in the middle of a play session (an achievement burst could
// trigger three of them in half a minute). Now:
//   • the write is async and atomic (tmp file + rename), so it never blocks the
//     main process and a crash mid-write can't truncate the backup;
//   • while a game is running it is skipped entirely and re-queued for the
//     moment the session ends — nothing is lost, the backup is just not written
//     while the machine is busy running a game.

const fs   = require('fs')
const path = require('path')
const logger = require('../logger')

const TABLES = ['games', 'sessions', 'achievements', 'achievement_unlocks', 'game_list', 'categories', 'custom_lists', 'custom_list_games', 'settings']

// 30s (was 8s): a burst of unlocks or a bulk import shouldn't each cost a full
// dump. Nothing here is time-critical — this is a safety copy, not a journal.
const DEBOUNCE_MS = 30 * 1000
const PERIODIC_MS = 5 * 60 * 1000

let debounceTimer = null
let periodicTimer = null
let writing = false          // single-flight — never overlap two dumps
let pendingWhileWriting = false

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

function sessionActive() {
  try { return require('./processWatcher').isSessionActive() } catch { return false }
}

// Write the dump. `force` bypasses the is-a-game-running gate (quit / explicit
// flush — correctness beats smoothness when the app is going away).
async function writeNow({ force = false } = {}) {
  const { enabled, dir } = getConfig()
  if (!enabled || !dir) return false

  if (!force && sessionActive()) {
    // Re-queue for the end of the session instead of writing over a running game.
    try {
      require('./processWatcher').runWhenIdle('autoBackup', () => { writeNow().catch(() => {}) })
    } catch {}
    return false
  }

  if (writing) { pendingWhileWriting = true; return false }
  writing = true
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'kozo-autobackup.json')
    const tmp  = `${file}.tmp`
    // Atomic replace: a half-written temp file can never become the backup.
    await fs.promises.writeFile(tmp, JSON.stringify(buildPayload(), null, 2), 'utf8')
    await fs.promises.rename(tmp, file)
    logger.info(`autoBackup: saved ${file}`)
    return true
  } catch (e) {
    logger.warn('autoBackup: write failed', { message: e.message })
    return false
  } finally {
    writing = false
    if (pendingWhileWriting) {
      pendingWhileWriting = false
      setTimeout(() => { writeNow().catch(() => {}) }, 1000)
    }
  }
}

function markDirty() {
  if (!getConfig().enabled) return
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => { writeNow().catch(() => {}) }, DEBOUNCE_MS)
}

// Synchronous-ish flush for app quit: `will-quit` doesn't await promises, so
// fall back to a blocking write there — it's a one-off, not a hot path.
function flush() {
  clearTimeout(debounceTimer)
  const { enabled, dir } = getConfig()
  if (!enabled || !dir) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'kozo-autobackup.json')
    const tmp  = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(buildPayload(), null, 2), 'utf8')
    fs.renameSync(tmp, file)
    logger.info(`autoBackup: saved ${file} (flush)`)
    return true
  } catch (e) {
    logger.warn('autoBackup: flush failed', { message: e.message })
    return false
  }
}

function startPeriodic() {
  if (periodicTimer) return
  periodicTimer = setInterval(() => {
    // writeNow's own gate defers this to the end of the session.
    if (getConfig().enabled) writeNow().catch(() => {})
  }, PERIODIC_MS)
}

module.exports = { markDirty, flush, writeNow, getConfig, startPeriodic, buildPayload }
