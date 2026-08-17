'use strict'

// Watches the Game List's "upcoming" entries and tells the user the moment a
// tracked game's release date passes: an overlay toast (once per game, flagged
// via release_notified) + a game:updated broadcast so the Upcoming tab regroups
// it under "Out now". Checked at startup and every 6h.
//
// The overlay is the app's only notification surface (§6) — a native
// Notification here would show as "electron.app.Electron" in dev and can be
// suppressed by Focus Assist during fullscreen play, which is exactly why OS
// notifications were removed. Don't reintroduce one.

const logger = require('../logger')

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
let _timer = null

// Only PRECISE dates count — a year-only "2026" must not fire mid-year.
// Vague Steam dates ("2026", "June 2026") must never count as released — the
// notification fires once and sets release_notified, so a false positive on the
// 1st of the month is unrecoverable.
function releasedTs(str) {
  if (!str) return null
  const trimmed = str.trim()
  if (/^\d{4}$/.test(trimmed)) return null
  if (/^[A-Za-z]{3,9},?\s+\d{4}$/.test(trimmed)) return null
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
      require('../overlayWindow').sendReleaseFlash({
        games: released.map(r => ({ name: r.name, release_date: r.release_date })),
      })
    } catch (e) {
      logger.warn('releaseWatch: overlay notify failed', { message: e.message })
    }

    try {
      const { BrowserWindow } = require('electron')
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('game:updated', null)
      }
    } catch (e) {
      logger.warn('releaseWatch: broadcast failed', { message: e.message })
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
