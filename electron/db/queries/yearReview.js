'use strict'
// Activity > Your year. Everything comes from what's already in the database,
// with the same rules as Statistics: games hidden from the Library don't count,
// and a year is a local year, by when a session started.

function getDb() { return require('../database').getDb() }

// Pure: the most days in a row, from local 'YYYY-MM-DD' keys in any order.
function longestStreak(days) {
  const sorted = [...new Set((days || []).filter(Boolean))].sort()
  let best = 0, run = 0, prev = null
  for (const key of sorted) {
    const [y, m, d] = key.split('-').map(Number)
    const at = Date.UTC(y, m - 1, d)   // UTC: a local day can be 23 or 25 hours long
    run = prev != null && at - prev === 86400000 ? run + 1 : 1
    if (run > best) best = run
    prev = at
  }
  return best
}

// Pure: which month played most (1 to 12), or null if none was played.
function busiestMonth(months) {
  let best = null
  ;(months || []).forEach((secs, i) => { if (secs > 0 && (best == null || secs > months[best])) best = i })
  return best == null ? null : best + 1
}

const VISIBLE_SESSION = `s.ended_at IS NOT NULL AND g.is_hidden = 0`
// A date range the index can use comes first (two days wider than the year on each side,
// so no time zone falls outside it), then the exact local-year check on those rows only.
// It used to convert every session ever played to local time (0.07 s at 30,000 sessions).
const IN_YEAR = `s.started_at >= @from AND s.started_at < @to AND strftime('%Y', s.started_at, 'localtime') = @year`
const UNLOCK_IN_YEAR = `au.unlocked_at >= @from AND au.unlocked_at < @to AND strftime('%Y', au.unlocked_at, 'localtime') = @year AND g.is_hidden = 0`

function availableYears(finished = [], thisYear = new Date().getFullYear()) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT strftime('%Y', s.started_at, 'localtime') AS y FROM sessions s JOIN games g ON g.id = s.game_id WHERE ${VISIBLE_SESSION}
    UNION
    SELECT strftime('%Y', au.unlocked_at, 'localtime') AS y FROM achievement_unlocks au
      JOIN achievements a ON a.id = au.achievement_id JOIN games g ON g.id = a.game_id
      WHERE au.unlocked_at IS NOT NULL AND g.is_hidden = 0
  `).all()
  const years = new Set(rows.map(r => Number(r.y)).filter(n => n > 2000))
  for (const f of finished) {
    const y = f.finished_at ? new Date(f.finished_at).getFullYear() : null
    if (y > 2000) years.add(y)
  }
  years.add(thisYear)
  return [...years].sort((a, b) => b - a)
}

// `finished` = the Finished page's list (shared query), so both pages agree.
function yearReview(year, finished = []) {
  const db = getDb()
  const y = String(Number(year))
  const p = { year: y, from: `${Number(y) - 1}-12-30`, to: `${Number(y) + 1}-01-03` }

  const totals = db.prepare(`
    SELECT COALESCE(SUM(s.duration_seconds), 0) AS seconds, COUNT(*) AS sessions, COUNT(DISTINCT s.game_id) AS games
    FROM sessions s JOIN games g ON g.id = s.game_id WHERE ${VISIBLE_SESSION} AND ${IN_YEAR}
  `).get(p)

  const dayRows = db.prepare(`
    SELECT DISTINCT DATE(s.started_at, 'localtime') AS day
    FROM sessions s JOIN games g ON g.id = s.game_id WHERE ${VISIBLE_SESSION} AND ${IN_YEAR}
  `).all(p)

  const topGames = db.prepare(`
    SELECT g.id, g.name, g.banner_local_path, g.banner_url, g.banner_rev, g.steam_app_id,
           SUM(s.duration_seconds) AS seconds, COUNT(*) AS sessions
    FROM sessions s JOIN games g ON g.id = s.game_id WHERE ${VISIBLE_SESSION} AND ${IN_YEAR}
    GROUP BY g.id ORDER BY seconds DESC LIMIT 5
  `).all(p)

  const months = Array(12).fill(0)
  for (const r of db.prepare(`
    SELECT CAST(strftime('%m', s.started_at, 'localtime') AS INTEGER) AS m, SUM(s.duration_seconds) AS seconds
    FROM sessions s JOIN games g ON g.id = s.game_id WHERE ${VISIBLE_SESSION} AND ${IN_YEAR} GROUP BY m
  `).all(p)) months[r.m - 1] = r.seconds || 0

  const longestSession = db.prepare(`
    SELECT g.name AS game_name, s.duration_seconds AS seconds, s.started_at
    FROM sessions s JOIN games g ON g.id = s.game_id WHERE ${VISIBLE_SESSION} AND ${IN_YEAR}
    ORDER BY s.duration_seconds DESC, s.id ASC LIMIT 1   -- a tie: the session saved first, as before the indexes
  `).get(p) || null

  const achievements = db.prepare(`
    SELECT COUNT(DISTINCT au.achievement_id) AS n FROM achievement_unlocks au
    JOIN achievements a ON a.id = au.achievement_id JOIN games g ON g.id = a.game_id WHERE ${UNLOCK_IN_YEAR}
  `).get(p).n

  const rarest = db.prepare(`
    SELECT a.display_name, a.icon_url, a.global_unlock_percent AS percent, g.name AS game_name
    FROM achievement_unlocks au
    JOIN achievements a ON a.id = au.achievement_id JOIN games g ON g.id = a.game_id
    WHERE ${UNLOCK_IN_YEAR} AND a.global_unlock_percent > 0
    ORDER BY a.global_unlock_percent ASC LIMIT 1
  `).get(p) || null

  const finishedThisYear = finished
    .filter(f => !f.is_hidden && f.finished_at && new Date(f.finished_at).getFullYear() === Number(year))
    .map(f => ({
      name: f.name, rating: f.rating ?? null, steam_app_id: f.steam_app_id ?? null,
      banner_local_path: f.banner_local_path || null, banner_url: f.banner_url || f.list_banner || null, banner_rev: f.banner_rev ?? null,
    }))
  const bestRated = finishedThisYear
    .filter(f => f.rating != null)
    .sort((a, b) => b.rating - a.rating)[0] || null

  const days = dayRows.map(r => r.day)
  return {
    year: Number(year),
    seconds: totals.seconds, sessions: totals.sessions, games: totals.games,
    days: days.length, streak: longestStreak(days),
    topGames, months, busiestMonth: busiestMonth(months), longestSession,
    achievements, rarest,
    finished: finishedThisYear, bestRated,
  }
}

module.exports = { yearReview, availableYears, longestStreak, busiestMonth }
