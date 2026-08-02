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
  const unlocked = achievements.filter(a => a.unlocked_at).length

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
    .filter(a => !a.unlocked_at)
    .sort((a, b) => (rank(a) - rank(b)) || (a._i - b._i))
    .map(shape)

  // A short "you just got these" strip, newest first. Rows with no timestamp
  // (Steam returned unlocktime 0) sort last rather than pretending to be recent.
  const recent = achievements
    .filter(a => a.unlocked_at)
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

function flash() {
  try {
    const payload = buildPayload()
    require('../overlayWindow').sendAchievementListFlash(payload)
  } catch (e) {
    try { require('../logger').warn('achievementListFlash.flash: ' + e.message) } catch {}
  }
}

module.exports = { flash, buildPayload }
