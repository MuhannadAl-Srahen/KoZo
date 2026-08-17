'use strict'

// Builds the "achievement list" overlay payload shown on the Alt+J global
// hotkey — a READ-ONLY glance at the current game's achievement list while
// playing. This intentionally does NOT let you mark anything unlocked from
// here: an earlier manual-marking overlay panel (bound to Alt+J) was built
// then removed because unlocks must only ever be detected automatically —
// this is a display-only successor, same hotkey, different job.

function buildPayload() {
  const watcher = require('./processWatcher')
  const achievementsQ = require('../db/queries/achievements')
  const gamesQ = require('../db/queries/games')

  // Same "which game" choice as statusFlash: the most recently active session.
  const sessions = [...watcher.getActiveSessions().values()]
  if (!sessions.length) return { idle: true }

  const sess = sessions[sessions.length - 1]
  const game = gamesQ.getGame(sess.game_id)

  let achievements = []
  try { achievements = achievementsQ.listAchievementsForGame(sess.game_id) || [] } catch {}

  const total = achievements.length
  // unlock_id decides unlocked/locked everywhere below: unlocked_at is NULL for
  // an unlock Steam reported with no date, which is display-only ("no date").
  const unlocked = achievements.filter(a => a.unlock_id != null).length

  const shape = (a) => ({
    name: a.display_name || a.steam_api_name,
    description: a.description || null,
    icon_url: a.icon_url || null,
    // 0–100, null when Steam never reported a global rate.
    rarity: typeof a.global_unlock_percent === 'number' ? a.global_unlock_percent : null,
  })

  // "What's left", not a dump of the whole list. A 9-second toast can't be read
  // end to end, so it shows only LOCKED achievements, rarest first — the ones
  // worth knowing about while you're still in the game. Unknown rarity sorts
  // last (it's usually a brand-new or unlisted game), original list order breaks
  // ties so the toast is stable between presses.
  const rank = (a) => (typeof a.global_unlock_percent === 'number' ? a.global_unlock_percent : 1e9)
  const remaining = achievements
    .map((a, i) => ({ ...a, _i: i }))
    .filter(a => a.unlock_id == null)
    .sort((a, b) => (rank(a) - rank(b)) || (a._i - b._i))
    .map(shape)

  // A short "you just got these" strip, newest first. Rows with no timestamp
  // (Steam returned unlocktime 0) sort last rather than pretending to be recent.
  const recent = achievements
    .filter(a => a.unlock_id != null)
    .sort((a, b) => new Date(b.unlocked_at || 0) - new Date(a.unlocked_at || 0))
    .slice(0, 3)
    .map(shape)

  return {
    gameName: sess.game_name || game?.name || 'Now Playing',
    unlocked,
    total,
    percent: total > 0 ? Math.round((unlocked / total) * 100) : 0,
    remaining,
    recent,
  }
}

// ── Open/closed state + scroll hotkeys ───────────────────────────────────────
// The overlay is click-through and never takes keyboard focus (showInactive +
// setIgnoreMouseEvents), and a fullscreen game captures the cursor — so the
// mouse can never scroll this list while you're actually playing, which is the
// only time it matters. Global shortcuts are the one input channel that still
// reaches KoZo, so scrolling is driven by Alt+Down / Alt+Up.
//
// Those two combos are registered ONLY while the list is on screen. Holding
// them for the whole app lifetime would hijack two very common keys system-wide,
// which is not acceptable for something that lives in the tray.

const SCROLL_KEYS = { 'Alt+Down': 90, 'Alt+Up': -90 }   // px per press (~2 rows)
let listOpen = false

function logger() { return require('../logger') }

function registerScrollKeys() {
  const { globalShortcut } = require('electron')
  for (const [accel, delta] of Object.entries(SCROLL_KEYS)) {
    try {
      const ok = globalShortcut.register(accel, () => {
        try { require('../overlayWindow').sendAchListControl({ action: 'scroll', delta }) } catch {}
      })
      if (!ok) logger().warn(`achievementListFlash: ${accel} unavailable (in use by another app)`)
    } catch (e) {
      logger().warn(`achievementListFlash: ${accel} registration error: ${e.message}`)
    }
  }
}

function unregisterScrollKeys() {
  const { globalShortcut } = require('electron')
  for (const accel of Object.keys(SCROLL_KEYS)) {
    try { globalShortcut.unregister(accel) } catch {}
  }
}

// Called when the toast goes away by ANY route — the safety timeout, a click,
// or the X. Without this the scroll keys would stay bound after the list is
// gone and swallow Alt+Down everywhere.
function markClosed() {
  if (!listOpen) return
  listOpen = false
  unregisterScrollKeys()
}

// Alt+J toggles: open the list and leave it up, or close it if it's already up.
function flash() {
  try {
    const overlay = require('../overlayWindow')
    if (listOpen) {
      overlay.sendAchListControl({ action: 'close' })
      markClosed()
      return
    }
    overlay.sendAchievementListFlash(buildPayload())
    listOpen = true
    registerScrollKeys()
  } catch (e) {
    try { logger().warn('achievementListFlash.flash: ' + e.message) } catch {}
    markClosed()
  }
}

module.exports = { flash, buildPayload, markClosed }
