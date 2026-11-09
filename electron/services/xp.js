// ── XP / Level system ─────────────────────────────────────────────────────────
// One source of truth for the player's "career" progression. XP comes from:
//   • Playtime     60 XP per hour played
//   • Unlocks      by rarity, in the bands KoZo names everywhere (lib/utils.js rarityLabel):
//                  Common 55, Uncommon 80, Rare 120, Very Rare 250, Ultra Rare 500
//                  (unknown rarity 55). The maker asked for XP that rewards rarity: it was
//                  30 plus up to 50, so the rarest unlock was worth only 2.5 times a common one.
//                  No unlock is worth less than under those old rules (30 + (100 - %)/2, at
//                  most 55 for a Common one), so no level goes down.
//   • 100% a game  10 XP per achievement in it (100 to 1,000), once every one is unlocked
//   • Finished     250 XP per finished game, and 250 per playthrough finished again
//                  (an hour played in it at least; db/queries/playthroughs.js)
//   • Milestones   hours in one game (10h 100, 25h 150, 50h 250, 100h 500), 50 per game
//                  played an hour or more, 100 per game finished in its Play Plan month
//   • Streaks      50 XP per day in your longest play streak
// Levels: reaching level L costs 50*(L-1)*L cumulative XP (each level 100 more than the last).
// XP is always recomputed from the raw tables, never stored, so it can't drift. A change to
// these numbers needs a new XP_RULES: main.js then moves xpTracker's baseline once
// (xpTracker.rebase), or the next session would show the whole difference as gained.
const XP_RULES = 'rarity-v3'
const XP_PER_HOUR = 60
const XP_PER_STREAK_DAY = 50
const XP_PER_FINISH = 250   // completing a game is a big, deliberate milestone
const RARITY_XP = [          // rarest first; `below` = a global unlock rate under this %
  { below: 5,        key: 'ultra',    name: 'Ultra Rare', xp: 500 },
  { below: 15,       key: 'very',     name: 'Very Rare',  xp: 250 },
  { below: 30,       key: 'rare',     name: 'Rare',       xp: 120 },
  { below: 50,       key: 'uncommon', name: 'Uncommon',   xp: 80 },
  { below: Infinity, key: 'common',   name: 'Common',     xp: 55 },
]
const XP_UNKNOWN_RARITY = 55
const PERFECT_PER_ACH = 10, PERFECT_MIN = 100, PERFECT_MAX = 1000
// Ways to earn XP beyond playing and unlocking (the maker: "add new things to get more XP").
const REPLAY_MIN_SEC = 3600            // a finished replay counts once an hour was played in it
const HOUR_MILESTONES = [              // hours in one game
  { hours: 10, xp: 100 },
  { hours: 25, xp: 150 },
  { hours: 50, xp: 250 },
  { hours: 100, xp: 500 },
]
const XP_PER_EXPLORED = 50             // each game played an hour or more
const XP_ON_PLAN = 100                 // a game finished in the month Play Plan had it for

// Every rule, for the Profile's "How XP works" (one place, so the guide can't drift).
const RULES = {
  perHour: XP_PER_HOUR,
  rarity: RARITY_XP.map(b => ({ key: b.key, name: b.name, xp: b.xp, below: b.below === Infinity ? null : b.below })),
  unknownRarity: XP_UNKNOWN_RARITY,
  perfect: { perAchievement: PERFECT_PER_ACH, min: PERFECT_MIN, max: PERFECT_MAX },
  finish: XP_PER_FINISH, replayMinHours: REPLAY_MIN_SEC / 3600,
  hourMilestones: HOUR_MILESTONES, explored: XP_PER_EXPLORED, onPlan: XP_ON_PLAN,
  streakDay: XP_PER_STREAK_DAY,
}

// The rarity band of an unlock rate (0–100), or null when Steam never reported one.
function rarityOf(globalUnlockPercent) {
  if (globalUnlockPercent == null || !Number.isFinite(Number(globalUnlockPercent))) return null
  const pct = Math.max(0, Math.min(100, Number(globalUnlockPercent)))
  return RARITY_XP.find(b => pct < b.below)
}

// XP a single unlock is worth. Exported so the unlock toasts show the exact number the
// profile credits: one formula, one source of truth.
function xpForUnlock(globalUnlockPercent) {
  const band = rarityOf(globalUnlockPercent)
  return band ? band.xp : XP_UNKNOWN_RARITY
}

// The same rule in SQL, for the totals and the Recent XP list (`pct` is an SQL expression).
function unlockXpSql(pct) {
  const p = `MAX(0, MIN(100, ${pct}))`
  return `(CASE WHEN ${pct} IS NULL THEN ${XP_UNKNOWN_RARITY} ` +
    RARITY_XP.filter(b => b.below !== Infinity).map(b => `WHEN ${p} < ${b.below} THEN ${b.xp} `).join('') +
    `ELSE ${RARITY_XP[RARITY_XP.length - 1].xp} END)`
}
function rarityKeySql(pct) {
  const p = `MAX(0, MIN(100, ${pct}))`
  return `(CASE WHEN ${pct} IS NULL THEN 'unknown' ` +
    RARITY_XP.filter(b => b.below !== Infinity).map(b => `WHEN ${p} < ${b.below} THEN '${b.key}' `).join('') +
    `ELSE 'common' END)`
}

// Pure: the bonus for unlocking every achievement in a game that has `total` of them.
function perfectBonus(total) {
  if (!(total > 0)) return 0
  return Math.max(PERFECT_MIN, Math.min(PERFECT_MAX, total * PERFECT_PER_ACH))
}

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

// The local play days (for the streaks) only change when the ended sessions do, but turning
// every session's start into a local date took most of computeXp's time (27 ms at 30,000
// sessions, and it runs after every game update). Kept until the fingerprint changes: how
// many sessions, the newest, their total time and latest end, and the time zone (nothing
// moves an ended session's start; a merge or a removal changes these).
let playDays = { key: null, days: [] }

function computeXp() {
  const db = require('../db/database').getDb()

  // Ended sessions plus time elapsed in currently-running ones — so periodic
  // in-session XP checks can cross a level boundary while you play. An open row
  // is capped at its game's last heartbeat + a heartbeat interval: a live
  // session's last_played_at is at most HEARTBEAT_WRITE_MS old, while a row left
  // open by a crash stops advancing, so this bounds crash inflation to ~a minute
  // instead of crediting every hour since.
  const ended = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS s, COUNT(*) AS n, MAX(id) AS last, MAX(ended_at) AS lastEnd
    FROM sessions WHERE ended_at IS NOT NULL
  `).get()
  const endedSec = ended.s || 0
  // Idle is subtracted here too, exactly as endSession subtracts it from the
  // closed row. Without it a session left running while away kept earning XP
  // (60/hour) and could cross a level boundary — firing a celebration that
  // silently reverted at session end, when the idle time was finally removed.
  const liveSec = db.prepare(`
    SELECT COALESCE(SUM(MAX(0,
      MIN(julianday('now'), julianday(COALESCE(g.last_played_at, s.started_at)) + 60.0 / 86400)
      - julianday(s.started_at)
    ) * 86400 - COALESCE(s.idle_seconds, 0)), 0) AS s
    FROM sessions s LEFT JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NULL
  `).get().s || 0
  const playSec = Math.round(endedSec + liveSec)

  // Unlock XP by rarity band, counted in SQL (one row per band instead of one per unlock).
  const byRarity = { ultra: 0, very: 0, rare: 0, uncommon: 0, common: 0, unknown: 0 }
  let unlockCount = 0, unlockXp = 0
  for (const r of db.prepare(`
    SELECT ${rarityKeySql('a.global_unlock_percent')} AS k, COUNT(*) AS n, SUM(${unlockXpSql('a.global_unlock_percent')}) AS xp
    FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
    GROUP BY k
  `).all()) {
    byRarity[r.k] = r.n
    unlockCount += r.n
    unlockXp += r.xp || 0
  }

  // 100% a game: every achievement it has, unlocked.
  let perfectXp = 0, perfectCount = 0
  for (const g of db.prepare(`
    SELECT COUNT(a.id) AS total, COUNT(au.id) AS got
    FROM achievements a LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
    GROUP BY a.game_id HAVING total > 0 AND got >= total
  `).all()) { perfectXp += perfectBonus(g.total); perfectCount++ }

  // Distinct local play days → current + longest streak.
  const dayKey = [ended.n, ended.last, ended.s, ended.lastEnd, new Date().getTimezoneOffset()].join('|')
  if (playDays.key !== dayKey) {
    playDays = {
      key: dayKey,
      days: db.prepare(`
        SELECT DISTINCT DATE(started_at, 'localtime') AS d
        FROM sessions WHERE ended_at IS NOT NULL ORDER BY d ASC
      `).all().map(r => r.d).filter(Boolean),
    }
  }
  const dayRows = playDays.days

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
  // A game with playthroughs counts through them instead (below), so its first finish still
  // counts while you play it again.
  const finishedCount = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM games WHERE completion_status = 'finished'
         AND id NOT IN (SELECT game_id FROM playthroughs))
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

  // Playthroughs (db/queries/playthroughs.js): the first finish counts as a finished game; a
  // later one is a replay, worth the same once an hour was played in it (a quick
  // "new playthrough, Finished" earns nothing).
  let firstFinishes = 0, replayCount = 0
  try {
    for (const f of require('../db/queries/playthroughs').allFinishes()) {
      if (f.number === 1) firstFinishes++
      else if (f.seconds >= REPLAY_MIN_SEC) replayCount++
    }
  } catch {}

  // Milestones: hours in one game, each game played an hour or more, and a game finished in
  // the month it was planned for (Play Plan).
  const perGame = db.prepare('SELECT total_playtime_seconds AS s FROM games WHERE total_playtime_seconds >= 3600').all()
  let hourMilestones = 0, hourMilestoneXp = 0
  for (const g of perGame) for (const m of HOUR_MILESTONES) if (g.s >= m.hours * 3600) { hourMilestones++; hourMilestoneXp += m.xp }
  const explored = perGame.length
  // By the game's first finish, so playing it again never takes this back.
  const onPlan = db.prepare(`
    SELECT COUNT(*) AS c FROM games g JOIN game_list gl ON gl.game_id = g.id
    WHERE gl.planned_month IS NOT NULL
      AND strftime('%Y-%m', COALESCE(
            (SELECT p.finished_at FROM playthroughs p WHERE p.game_id = g.id AND p.number = 1),
            CASE WHEN g.completion_status = 'finished' AND NOT EXISTS (SELECT 1 FROM playthroughs p2 WHERE p2.game_id = g.id)
                 THEN g.completion_status_at END
          ), 'localtime') = gl.planned_month
  `).get().c || 0
  const milestoneXp = hourMilestoneXp + explored * XP_PER_EXPLORED + onPlan * XP_ON_PLAN

  const playtimeXp = Math.round((playSec / 3600) * XP_PER_HOUR)
  const streakXp = longestStreak * XP_PER_STREAK_DAY
  const finishedXp = (finishedCount + firstFinishes + replayCount) * XP_PER_FINISH
  const totalXp = playtimeXp + unlockXp + streakXp + finishedXp + perfectXp + milestoneXp

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
    breakdown: { playtime: playtimeXp, achievements: unlockXp, streak: streakXp, finished: finishedXp, perfect: perfectXp, milestones: milestoneXp },
    byRarity,                              // unlocks per band: ultra, very, rare, uncommon, common, unknown
    perfectCount,                          // games with every achievement unlocked
    currentStreak,
    longestStreak,
    playDays: dayRows.length,
    unlockCount,
    finishedCount: finishedCount + firstFinishes,
    replayCount,                           // playthroughs finished again
    milestones: { hours: hourMilestones, explored, onPlan },
    rules: RULES,                          // every way to earn XP, for "How XP works"
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
             ${unlockXpSql('a.global_unlock_percent')} AS xp,
             a.display_name AS label,
             ${rarityKeySql('a.global_unlock_percent')} AS detail
      FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
      WHERE au.unlocked_at IS NOT NULL

      UNION ALL

      SELECT 'finished' AS type, g.completion_status_at AS ts,
             ${XP_PER_FINISH} AS xp,
             g.name AS label,
             NULL AS detail
      FROM games g
      WHERE g.completion_status = 'finished' AND g.completion_status_at IS NOT NULL
        AND g.id NOT IN (SELECT game_id FROM playthroughs)
    )
    WHERE ts IS NOT NULL
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit)
  // A game played more than once: each finished playthrough (detail = its number).
  try {
    for (const f of require('../db/queries/playthroughs').allFinishes()) {
      if (f.number > 1 && f.seconds < REPLAY_MIN_SEC) continue
      rows.push({ type: f.number === 1 ? 'finished' : 'replay', ts: f.finished_at, xp: XP_PER_FINISH, label: f.name, detail: f.number })
    }
    rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
  } catch {}
  // Sessions shorter than 30 min round to 0 XP — drop those noise rows.
  return rows.filter(r => r.xp > 0).slice(0, limit)
}

module.exports = { computeXp, xpHistory, levelForXp, tierForLevel, nextTierInfo, xpForUnlock, rarityOf, perfectBonus, RARITY_XP, XP_RULES, RULES }
