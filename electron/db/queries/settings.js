const { getDb } = require('../database')

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : null
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value))
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all()
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

module.exports = { getSetting, setSetting, getAllSettings }
