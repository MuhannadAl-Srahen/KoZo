'use strict'

// Builds the "status flash" payload shown when the user presses the global
// hotkey (Alt+K) mid-game: the current session's elapsed time plus, when the
// game has a known achievement list, its unlock progress. If no game is being
// tracked right now we still flash a small "nothing playing" card so the user
// gets feedback that the hotkey works.

function buildPayload() {
  const watcher = require('./processWatcher')
  const achievementsQ = require('../db/queries/achievements')

  const sessions = [...watcher.getActiveSessions().values()]
  const now = Date.now()

  const cards = sessions.map((sess) => {
    const started = new Date(sess.started_at).getTime()
    const idle = Number(sess.idle_seconds) || 0
    const elapsedSec = Math.max(0, Math.floor((now - started) / 1000) - idle)

    let total = 0, unlocked = 0
    try {
      const achs = achievementsQ.listAchievementsForGame(sess.game_id) || []
      total = achs.length
      unlocked = achs.filter(a => a.unlocked_at).length
    } catch { /* no achievements is fine */ }

    return {
      gameName: sess.game_name || 'Now Playing',
      elapsedSec,
      unlocked,
      total,
    }
  })

  return { cards }
}

// Gather + push to the overlay window. Never throws (it's wired to a hotkey).
function flash() {
  try {
    const payload = buildPayload()
    require('../overlayWindow').sendStatusFlash(payload)
  } catch (e) {
    try { require('../logger').warn('statusFlash.flash: ' + e.message) } catch {}
  }
}

module.exports = { flash, buildPayload }
