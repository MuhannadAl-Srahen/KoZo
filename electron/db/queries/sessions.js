const { getDb } = require('../database')

function listSessions(filters = {}) {
  let query = `
    SELECT s.*, g.name AS game_name, g.banner_local_path
    FROM sessions s
    JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NOT NULL
  `
  const params = []

  if (filters.gameId) {
    query += ' AND s.game_id = ?'
    params.push(filters.gameId)
  }

  if (filters.from) {
    query += ' AND s.started_at >= ?'
    params.push(filters.from)
  }

  if (filters.to) {
    query += ' AND s.started_at <= ?'
    params.push(filters.to)
  }

  query += ' ORDER BY s.started_at DESC'

  if (filters.limit) {
    query += ' LIMIT ?'
    params.push(filters.limit)
  }

  if (filters.offset) {
    query += ' OFFSET ?'
    params.push(filters.offset)
  }

  return getDb().prepare(query).all(...params)
}

function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id)
}

function getActiveSessions() {
  return getDb().prepare(`
    SELECT s.*, g.name AS game_name, g.exe_name
    FROM sessions s
    JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NULL
  `).all()
}

function startSession(gameId) {
  const now = new Date().toISOString()
  const result = getDb().prepare(`
    INSERT INTO sessions (game_id, started_at) VALUES (?, ?)
  `).run(gameId, now)

  getDb().prepare(`
    UPDATE games SET first_played_at = COALESCE(first_played_at, ?), last_played_at = ? WHERE id = ?
  `).run(now, now, gameId)

  return getSession(result.lastInsertRowid)
}

// Like startSession, but if a session for this game ended within the last
// 3 minutes (e.g. because KoZo was restarted while the game was running),
// reopen that session instead of creating a new one so restarts don't
// produce a flood of short split sessions.
function resumeOrStartSession(gameId) {
  const db = getDb()

  // Any DB-level orphan (ended_at IS NULL) left from a crash — re-attach directly.
  const orphan = db.prepare(
    `SELECT * FROM sessions WHERE game_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`
  ).get(gameId)
  if (orphan) return orphan

  // Recently-ended session within the 3-minute merge window.
  const MERGE_WINDOW_SEC = 3 * 60
  const cutoff = new Date(Date.now() - MERGE_WINDOW_SEC * 1000).toISOString()
  const recent = db.prepare(
    `SELECT * FROM sessions WHERE game_id = ? AND ended_at >= ? ORDER BY ended_at DESC LIMIT 1`
  ).get(gameId, cutoff)

  if (recent) {
    // Reverse the playtime credit then reopen the row so duration accumulates naturally.
    db.prepare(`UPDATE games SET total_playtime_seconds = MAX(0, total_playtime_seconds - ?) WHERE id = ?`)
      .run(recent.duration_seconds || 0, gameId)
    db.prepare(`UPDATE sessions SET ended_at = NULL, duration_seconds = NULL WHERE id = ?`)
      .run(recent.id)
    return getSession(recent.id)
  }

  return startSession(gameId)
}

function endSession(id) {
  const now = new Date().toISOString()
  const session = getSession(id)
  if (!session) return null

  const durationSeconds = Math.max(
    0,
    Math.floor((new Date(now) - new Date(session.started_at)) / 1000)
  )

  getDb().prepare(`
    UPDATE sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?
  `).run(now, durationSeconds, id)

  getDb().prepare(`
    UPDATE games
    SET total_playtime_seconds = total_playtime_seconds + ?,
        last_played_at = ?
    WHERE id = ?
  `).run(durationSeconds, now, session.game_id)

  return getSession(id)
}

function getSessionsStats(gameId, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  return getDb().prepare(`
    SELECT
      DATE(started_at) AS day,
      SUM(duration_seconds) AS total_seconds
    FROM sessions
    WHERE game_id = ? AND ended_at IS NOT NULL AND started_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(gameId, since)
}

function getWeeklyPlaytime() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString()
  return getDb().prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS seconds
    FROM sessions
    WHERE ended_at IS NOT NULL AND started_at >= ?
  `).get(since)
}

module.exports = { listSessions, getSession, getActiveSessions, startSession, resumeOrStartSession, endSession, getSessionsStats, getWeeklyPlaytime }
