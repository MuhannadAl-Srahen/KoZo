const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

let db = null

const DEFAULT_SETTINGS = [
  ['accent_color', '#a78bfa'],
  ['launch_on_startup', 'false'],
  ['start_minimized', 'false'],
  ['detection_sensitivity_seconds', '15'],
  ['keep_history_when_uninstalled', 'true'],
  ['show_playtime_format', 'hm'],
  ['show_achievement_rarity', 'true'],
  ['animated_live_indicator', 'true'],
  ['auto_detect_steam', 'true'],
  ['auto_detect_epic', 'true'],
  ['auto_detect_gog', 'false'],
  ['steam_api_key', ''],
  ['steam_user_id', ''],
  ['idle_pause_min', '5'],
]

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

function initDatabase() {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'kozo.db')
  const backupPath = path.join(userDataPath, 'kozo.db.bak')

  try {
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    db.exec(schema)

    // Additive migrations — safe to run on every startup
    try { db.exec('ALTER TABLE games ADD COLUMN hero_local_path TEXT') } catch (_) {}
    try { db.exec('ALTER TABLE games ADD COLUMN last_steam_sync_at TIMESTAMP') } catch (_) {}
    try { db.exec('ALTER TABLE games ADD COLUMN steam_playtime_min INTEGER DEFAULT 0') } catch (_) {}
    try { db.exec('ALTER TABLE games ADD COLUMN is_cracked INTEGER DEFAULT 0') } catch (_) {}
    try { db.exec('ALTER TABLE games ADD COLUMN is_favorite INTEGER DEFAULT 0') } catch (_) {}
    try { db.exec('ALTER TABLE game_list ADD COLUMN is_favorite INTEGER DEFAULT 0') } catch (_) {}
    // Completion status (Beaten / 100% etc.) + the Steam appid used for a manual
    // achievement-list import (so foreign-launcher games can show + hand-tick achievements).
    try { db.exec('ALTER TABLE games ADD COLUMN completion_status TEXT') } catch (_) {}
    try { db.exec('ALTER TABLE games ADD COLUMN manual_appid INTEGER') } catch (_) {}
    // Hidden-from-library flag (playtime/achievements/XP still count) + timestamp of the
    // last status change (feeds the Recent XP history for finished games).
    try { db.exec('ALTER TABLE games ADD COLUMN is_hidden INTEGER DEFAULT 0') } catch (_) {}
    try { db.exec('ALTER TABLE games ADD COLUMN completion_status_at TIMESTAMP') } catch (_) {}
    // Steam store genres, stored as a JSON array string ('["Roguelike","Action"]').
    try { db.exec('ALTER TABLE games ADD COLUMN genres TEXT') } catch (_) {}
    try { db.exec('ALTER TABLE game_list ADD COLUMN genres TEXT') } catch (_) {}

    migrateCategoriesToCustomLists()
    seedDefaults()
    fixOrphanedSessions()

    return db
  } catch (err) {
    // Corrupted DB: backup and start fresh
    if (fs.existsSync(dbPath)) {
      try { fs.renameSync(dbPath, backupPath) } catch (_) {}
    }
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    db.exec(schema)
    seedDefaults()

    return db
  }
}

function seedDefaults() {
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  )
  const seedSettings = db.transaction(() => {
    for (const [key, value] of DEFAULT_SETTINGS) {
      insertSetting.run(key, value)
    }
  })
  seedSettings()
}

// One-time migration: categories were replaced by Steam genres + custom lists.
// Every category that actually has games assigned becomes a custom list with the
// same games; empty categories (including the old seeded defaults) are dropped
// silently. Guarded by a settings flag so it never runs twice.
function migrateCategoriesToCustomLists() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'categories_migrated_v1'").get()
  if (done) return

  const migrate = db.transaction(() => {
    const cats = db.prepare(`
      SELECT c.id, c.name, c.emoji, c.display_order
      FROM categories c
      WHERE EXISTS (SELECT 1 FROM game_list gl WHERE gl.category_id = c.id)
      ORDER BY c.display_order
    `).all()

    const insertList = db.prepare(
      'INSERT INTO custom_lists (name, emoji, display_order) VALUES (?, ?, ?)'
    )
    const insertJunction = db.prepare(
      'INSERT OR IGNORE INTO custom_list_games (list_id, item_id) VALUES (?, ?)'
    )
    const itemsForCat = db.prepare('SELECT id FROM game_list WHERE category_id = ?')

    for (const cat of cats) {
      const listId = insertList.run(cat.name, cat.emoji, cat.display_order).lastInsertRowid
      for (const item of itemsForCat.all(cat.id)) {
        insertJunction.run(listId, item.id)
      }
    }

    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('categories_migrated_v1', 'true')").run()
  })
  migrate()
}

// Close sessions left open from a previous crash. We don't know exactly when
// the game stopped, so we estimate: use the game's last_played_at (the watcher
// heartbeat keeps this fresh while a session is active) if available, then cap
// at started_at + 4h to keep crash-day inflation bounded.
function fixOrphanedSessions() {
  const orphans = db.prepare(`
    SELECT s.id, s.started_at, g.last_played_at, s.game_id
    FROM sessions s
    LEFT JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NULL
  `).all()

  const closeOrphan = db.prepare(`
    UPDATE sessions
    SET ended_at = ?,
        duration_seconds = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400 AS INTEGER))
    WHERE id = ?
  `)
  const addPlaytime = db.prepare(`
    UPDATE games
    SET total_playtime_seconds = total_playtime_seconds +
        MAX(0, CAST((julianday(?) - julianday(?)) * 86400 AS INTEGER))
    WHERE id = ?
  `)
  // last_played_at on the game gets touched on every heartbeat; if the watcher
  // updated it after the session started but never wrote `ended_at`, that
  // timestamp is a much better end-of-play estimate than "now".
  const CAP_MS = 4 * 60 * 60 * 1000
  const fix = db.transaction(() => {
    for (const s of orphans) {
      const startedMs   = new Date(s.started_at).getTime()
      const heartbeatMs = s.last_played_at ? new Date(s.last_played_at).getTime() : null
      let estimatedEndMs = Date.now()
      if (heartbeatMs && heartbeatMs > startedMs) estimatedEndMs = heartbeatMs
      const cappedMs = Math.min(estimatedEndMs, startedMs + CAP_MS)
      const cappedEnd = new Date(cappedMs).toISOString()
      closeOrphan.run(cappedEnd, cappedEnd, s.id)
      // The forced end recovers playtime that processWatcher.endSession would
      // have added if the watcher had run to completion.
      addPlaytime.run(cappedEnd, s.started_at, s.game_id)
    }
  })

  fix()
}

module.exports = { initDatabase, getDb }
