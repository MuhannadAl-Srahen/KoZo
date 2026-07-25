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

  // Locked-first (what you'd actually check the overlay to see), each keeping
  // its original list position as a stable tiebreaker.
  const ordered = achievements
    .map((a, i) => ({ ...a, _i: i }))
    .sort((a, b) => (!!a.unlocked_at - !!b.unlocked_at) || (a._i - b._i))

  return {
    gameName: sess.game_name || game?.name || 'Now Playing',
    unlocked,
    total,
    achievements: ordered.map(a => ({
      name: a.display_name || a.steam_api_name,
      description: a.description || null,
      icon_url: a.icon_url || null,
      unlocked: !!a.unlocked_at,
    })),
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
