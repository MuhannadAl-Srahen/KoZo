'use strict'

// Watches the Game List's "upcoming" entries and tells the user the moment a
// tracked game's release date passes: a native Windows notification (once per
// game, flagged via release_notified) + a game:updated broadcast so the
// Upcoming tab regroups it under "Out now". Checked at startup and every 6h.

const logger = require('../logger')

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
let _timer = null

// Only PRECISE dates count — a year-only "2026" must not fire mid-year.
function releasedTs(str) {
  if (!str) return null
  const trimmed = str.trim()
  if (/^\d{4}$/.test(trimmed)) return null
  const t = Date.parse(trimmed)
  return Number.isFinite(t) ? t : null
}

function check() {
  try {
    const db = require('../db/database').getDb()
    const rows = db.prepare(`
      SELECT id, name, release_date FROM game_list
      WHERE status = 'upcoming' AND release_date IS NOT NULL
        AND (release_notified IS NULL OR release_notified = 0)
    `).all()

    const released = rows.filter(r => {
      const ts = releasedTs(r.release_date)
      return ts != null && ts <= Date.now()
    })
    if (!released.length) return

    const mark = db.prepare('UPDATE game_list SET release_notified = 1 WHERE id = ?')
    for (const r of released) mark.run(r.id)

    try {
      const { Notification, BrowserWindow } = require('electron')
      if (Notification.isSupported()) {
        const title = released.length === 1
          ? `${released[0].name} is out now! 🎉`
          : `${released.length} games you're waiting for are out now! 🎉`
        const body = released.length === 1
          ? `Released ${released[0].release_date} — open KoZo's Upcoming tab to update its status.`
          : released.map(r => r.name).slice(0, 4).join(', ')
        const n = new Notification({ title, body })
        n.on('click', () => {
          const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
          if (win) { win.show(); win.focus() }
        })
        n.show()
      }
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('game:updated', null)
      }
    } catch (e) {
      logger.warn('releaseWatch: notification failed', { message: e.message })
    }
    logger.info(`releaseWatch: ${released.length} upcoming game(s) reached release`)
  } catch (e) {
    logger.warn('releaseWatch: check failed', { message: e.message })
  }
}

function start() {
  if (_timer) return
  setTimeout(check, 12000)             // once shortly after startup
  _timer = setInterval(check, CHECK_EVERY_MS)
}

module.exports = { start, check }
