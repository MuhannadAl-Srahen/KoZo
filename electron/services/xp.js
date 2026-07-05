// ── XP / Level system ─────────────────────────────────────────────────────────
// One source of truth for the player's "career" progression. XP is earned from
// three pillars so it rewards both grinders and achievement hunters:
//   • Playtime   — 60 XP per hour played (an hour ≈ a solid achievement)
//   • Unlocks    — 30 XP base + a rarity bonus (rarer = more, up to ~+50)
//   • Streaks    — 50 XP per day in your longest play streak
// Balanced so all three pillars contribute meaningfully (a grinder, a hunter,
// and a daily player all level up). Levels use a gently-rising triangular curve:
// reaching level L costs 50*(L-1)*L cumulative XP, so each level needs 100 more.
// XP is always recomputed from the raw tables — never stored — so it can't
// drift. Extracted verbatim from the stats:xp IPC handler.
const XP_PER_HOUR = 60
const XP_PER_UNLOCK = 30
const XP_PER_STREAK_DAY = 50
const XP_PER_FINISH = 250   // completing a game is a big, deliberate milestone

function levelForXp(totalXp) {
  // Largest L with 50*(L-1)*L <= totalXp.
  let level = 1
  while (50 * level * (level + 1) <= totalXp) level++
  const curBase = 50 * (level - 1) * level
  const nextBase = 50 * level * (level + 1)
  return {
    level,
    intoLevel: totalXp - curBase,         // XP earned inside the current level
    levelSpan: nextBase - curBase,        // XP the current level spans
    nextLevelTotal: nextBase,
  }
}

// Creative tier names by level band — flair shown next to the level number.
const TIER_BANDS = [
  { level: 3,  name: 'Apprentice' },
  { level: 7,  name: 'Adept' },
  { level: 12, name: 'Seasoned' },
  { level: 18, name: 'Veteran' },
  { level: 25, name: 'Master' },
  { level: 35, name: 'Legend' },
  { level: 45, name: 'Grandmaster' },
  { level: 60, name: 'Mythic' },
]

function tierForLevel(level) {
  let name = 'Rookie'
  for (const b of TIER_BANDS) { if (level >= b.level) name = b.name }
  return name
}

// The next tier the user will unlock — drives the "X levels to <Tier>" hook.
function nextTierInfo(level) {
  for (const b of TIER_BANDS) { if (level < b.level) return { name: b.name, level: b.level } }
  return null   // already Mythic
}

function computeXp() {
  const db = require('../db/database').getDb()

  // Ended sessions plus time elapsed in currently-running ones — so periodic
  // in-session XP checks can cross a level boundary while you play (orphaned
  // rows from crashes are closed at boot by fixOrphanedSessions, so any
  // ended_at IS NULL row here really is live).
  const endedSec = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM sessions WHERE ended_at IS NOT NULL
  `).get().s || 0
  const liveSec = db.prepare(`
    SELECT COALESCE(SUM(MAX(0, (julianday('now') - julianday(started_at)) * 86400)), 0) AS s
    FROM sessions WHERE ended_at IS NULL
  `).get().s || 0
  const playSec = Math.round(endedSec + liveSec)

  // Rarity-weighted unlock XP. global_unlock_percent is 0–100 (NULL when unknown).
  // Bonus = round((100 - pct)/2), so a 2%-rare unlock is worth ~+49, a 90%-common ~+5.
  const unlockRows = db.prepare(`
    SELECT a.global_unlock_percent AS pct
    FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
  `).all()
  const unlockCount = unlockRows.length
  let unlockXp = 0
  for (const r of unlockRows) {
    const pct = (r.pct == null) ? 50 : Math.max(0, Math.min(100, r.pct))
    unlockXp += XP_PER_UNLOCK + Math.round((100 - pct) / 2)
  }

  // Distinct local play days → current + longest streak.
  const dayRows = db.prepare(`
    SELECT DISTINCT DATE(started_at, 'localtime') AS d
    FROM sessions WHERE ended_at IS NOT NULL ORDER BY d ASC
  `).all().map(r => r.d).filter(Boolean)

  const daySet = new Set(dayRows)
  const dayMs = 86400000
  const toUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  let longestStreak = 0, run = 0, prev = null
  for (const d of dayRows) {
    if (prev != null && toUTC(d) - prev === dayMs) run++
    else run = 1
    if (run > longestStreak) longestStreak = run
    prev = toUTC(d)
  }
  // Current streak: count back from today (or yesterday) while days are present.
  const todayStr = new Date().toLocaleDateString('en-CA')   // YYYY-MM-DD local
  let currentStreak = 0
  let cursor = toUTC(todayStr)
  if (!daySet.has(todayStr)) cursor -= dayMs   // a gap today is OK if you played yesterday
  while (true) {
    const key = new Date(cursor).toISOString().slice(0, 10)
    if (daySet.has(key)) { currentStreak++; cursor -= dayMs } else break
  }

  // Finished games — a deliberate milestone. Two places can mark a game finished:
  //   • the library (games.completion_status = 'finished'), and
  //   • the Game List page (game_list.status = 'finished').
  // statusSync keeps linked pairs consistent, so a list row describing the same
  // game as a finished library entry must not count twice. List rows are created
  // with game_id = NULL, so dedupe matches by game_id, steam_app_id, or name —
  // the same linkage rules statusSync uses.
  const finishedCount = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM games WHERE completion_status = 'finished')
      +
      (SELECT COUNT(*) FROM game_list gl
         WHERE gl.status = 'finished'
           AND NOT EXISTS (
             SELECT 1 FROM games g
             WHERE g.completion_status = 'finished'
               AND (g.id = gl.game_id
                    OR (gl.steam_app_id IS NOT NULL AND g.steam_app_id = gl.steam_app_id)
                    OR lower(g.name) = lower(gl.name))
           ))
      AS c
  `).get().c || 0

  const playtimeXp = Math.round((playSec / 3600) * XP_PER_HOUR)
  const streakXp = longestStreak * XP_PER_STREAK_DAY
  const finishedXp = finishedCount * XP_PER_FINISH
  const totalXp = playtimeXp + unlockXp + streakXp + finishedXp

  const lv = levelForXp(totalXp)
  const nextTier = nextTierInfo(lv.level)
  return {
    totalXp,
    level: lv.level,
    tier: tierForLevel(lv.level),
    nextTier,                              // { name, level } or null at the top
    intoLevel: lv.intoLevel,
    levelSpan: lv.levelSpan,
    nextLevelTotal: lv.nextLevelTotal,
    toNextLevel: Math.max(0, lv.levelSpan - lv.intoLevel),
    progress: lv.levelSpan ? Math.min(100, (lv.intoLevel / lv.levelSpan) * 100) : 100,
    breakdown: { playtime: playtimeXp, achievements: unlockXp, streak: streakXp, finished: finishedXp },
    currentStreak,
    longestStreak,
    playDays: dayRows.length,
    unlockCount,
    finishedCount,
  }
}

// Recent XP events — derived from the same tables the XP formula reads, so the
// history always matches the totals (no separate ledger to drift out of sync).
// Returns [{ type: 'session'|'achievement'|'finished', ts, xp, label, detail }].
function xpHistory(limit = 25) {
  const db = require('../db/database').getDb()
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT 'session' AS type, s.ended_at AS ts,
             CAST(ROUND(s.duration_seconds / 3600.0 * ${XP_PER_HOUR}) AS INTEGER) AS xp,
             g.name AS label,
             s.duration_seconds AS detail
      FROM sessions s JOIN games g ON g.id = s.game_id
      WHERE s.ended_at IS NOT NULL AND s.duration_seconds > 0

      UNION ALL

      SELECT 'achievement' AS type, au.unlocked_at AS ts,
             ${XP_PER_UNLOCK} + CAST(ROUND((100 - COALESCE(a.global_unlock_percent, 50)) / 2.0) AS INTEGER) AS xp,
             a.display_name AS label,
             NULL AS detail
      FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
      WHERE au.unlocked_at IS NOT NULL

      UNION ALL

      SELECT 'finished' AS type, g.completion_status_at AS ts,
             ${XP_PER_FINISH} AS xp,
             g.name AS label,
             NULL AS detail
      FROM games g
      WHERE g.completion_status = 'finished' AND g.completion_status_at IS NOT NULL
    )
    WHERE ts IS NOT NULL
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit)
  // Sessions shorter than 30 min round to 0 XP — drop those noise rows.
  return rows.filter(r => r.xp > 0)
}

module.exports = { computeXp, xpHistory, levelForXp, tierForLevel, nextTierInfo }
