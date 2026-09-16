const { getDb } = require('../database')

function listAchievementsForGame(gameId) {
  return getDb().prepare(`
    SELECT a.*, au.id AS unlock_id, au.unlocked_at, au.source AS unlock_source, au.session_id
    FROM achievements a
    LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
    WHERE a.game_id = ?
    ORDER BY (au.id IS NULL), au.unlocked_at DESC NULLS LAST, a.global_unlock_percent ASC NULLS LAST
  `).all(gameId)
}

function listAllAchievements(filters = {}) {
  let query = `
    SELECT a.*, au.id AS unlock_id, au.unlocked_at, au.source AS unlock_source, g.name AS game_name, g.id AS game_id
    FROM achievements a
    JOIN games g ON g.id = a.game_id
    LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
    WHERE 1=1
  `
  const params = []

  if (filters.status === 'unlocked') {
    query += ' AND au.id IS NOT NULL'
  } else if (filters.status === 'locked') {
    query += ' AND au.id IS NULL'
  }

  if (filters.gameId) {
    query += ' AND a.game_id = ?'
    params.push(filters.gameId)
  }

  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`
    query += ' AND (a.display_name LIKE ? OR a.description LIKE ?)'
    params.push(term, term)
  }

  if (filters.sort === 'recent') {
    query += ' ORDER BY au.unlocked_at DESC NULLS LAST'
  } else if (filters.sort === 'rarest') {
    query += ' ORDER BY a.global_unlock_percent ASC NULLS LAST'
  } else {
    query += ' ORDER BY au.unlocked_at ASC NULLS LAST'
  }

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

function bulkUpsertAchievements(gameId, achievements) {
  const stmt = getDb().prepare(`
    INSERT INTO achievements (game_id, steam_api_name, display_name, description, icon_url, icon_locked_url, global_unlock_percent, is_hidden)
    VALUES (@game_id, @steam_api_name, @display_name, @description, @icon_url, @icon_locked_url, @global_unlock_percent, @is_hidden)
    ON CONFLICT(game_id, steam_api_name) DO UPDATE SET
      display_name = excluded.display_name,
      description = excluded.description,
      icon_url = excluded.icon_url,
      icon_locked_url = excluded.icon_locked_url,
      -- COALESCE, not a bare assignment. getGlobalAchievementPercentages
      -- returns {} on ANY failure (a timeout, a 500, a rate-limit), so every
      -- row arrives with global_unlock_percent = null and one transient blip
      -- used to erase a game's entire rarity data — on a call that re-fires
      -- every time its detail page is opened. Rarity feeds the Ultra-Rare
      -- badges and the XP rarity bonus. A null now means "not known this
      -- time", never "zero".
      global_unlock_percent = COALESCE(excluded.global_unlock_percent, global_unlock_percent),
      is_hidden = excluded.is_hidden
  `)
  const run = getDb().transaction(() => {
    for (const a of achievements) {
      stmt.run({ game_id: gameId, ...a })
    }
  })
  run()
}

function getAchievementCounts() {
  return getDb().prepare(`
    SELECT
      COUNT(DISTINCT a.id) AS total,
      COUNT(DISTINCT au.achievement_id) AS unlocked
    FROM achievements a
    LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
  `).get()
}

// Returns the number of rows actually inserted: 0 means this achievement was
// already unlocked. Callers MUST gate toasts, XP and counters on that — the
// session-end retry ladder calls this repeatedly for the same unlock.
// Which session should an unlock be filed under when the caller doesn't say?
// Every automatic path (the 10s Steam poll, the crack watcher, the local stats
// watcher) passed session_id: null, so sessions.achievements_unlocked never left
// zero and the per-session counters on the Sessions page and GameDetail were
// permanently wrong. Resolved from the DB rather than plumbed through five call
// sites — an unlock belongs to the session that was open when it landed.
// The grace window catches session-end syncs: endSession closes the row and
// THEN runs a sync (plus retries) for unlocks earned in the final minutes.
const SESSION_GRACE_MS = 5 * 60 * 1000

function sessionForAchievement(achievementId, unlockedAt) {
  try {
    const db = getDb()
    // A dated unlock only belongs to a session it actually falls inside. Without
    // this, importing a game's whole back-catalogue (games:add does exactly
    // that) while that same game is running would credit every historical
    // unlock to the current session. An undated unlock is "just now".
    const open = db.prepare(`
      SELECT s.id FROM sessions s
      JOIN achievements a ON a.game_id = s.game_id
      WHERE a.id = ? AND s.ended_at IS NULL
        AND (? IS NULL OR julianday(?) >= julianday(s.started_at))
      ORDER BY s.started_at DESC LIMIT 1
    `).get(achievementId, unlockedAt ?? null, unlockedAt ?? null)
    if (open) return open.id
    const recent = db.prepare(`
      SELECT s.id FROM sessions s
      JOIN achievements a ON a.game_id = s.game_id
      WHERE a.id = ? AND s.ended_at IS NOT NULL
        AND (julianday('now') - julianday(s.ended_at)) * 86400000 <= ?
        AND (? IS NULL OR julianday(?) >= julianday(s.started_at))
      ORDER BY s.ended_at DESC LIMIT 1
    `).get(achievementId, SESSION_GRACE_MS, unlockedAt ?? null, unlockedAt ?? null)
    return recent ? recent.id : null
  } catch { return null }
}

function addUnlock(data) {
  const sessionId = data.session_id ?? sessionForAchievement(data.achievement_id, data.unlocked_at ?? null)
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO achievement_unlocks (achievement_id, session_id, unlocked_at, source)
    VALUES (@achievement_id, @session_id, @unlocked_at, @source)
  `).run({ ...data, unlocked_at: data.unlocked_at ?? null, session_id: sessionId })

  // Update session achievement count if tied to a session
  if (info.changes > 0 && sessionId) {
    getDb().prepare(`
      UPDATE sessions SET achievements_unlocked = achievements_unlocked + 1 WHERE id = ?
    `).run(sessionId)
  }
  return info.changes
}

function removeUnlock(achievementId) {
  const db = getDb()
  // Keep the owning session's counter honest — it used to only ever climb.
  const row = db.prepare('SELECT session_id FROM achievement_unlocks WHERE achievement_id = ?').get(achievementId)
  const info = db.prepare('DELETE FROM achievement_unlocks WHERE achievement_id = ?').run(achievementId)
  if (info.changes > 0 && row?.session_id) {
    db.prepare('UPDATE sessions SET achievements_unlocked = MAX(0, achievements_unlocked - 1) WHERE id = ?')
      .run(row.session_id)
  }
  return info.changes
}

module.exports = { listAchievementsForGame, listAllAchievements, bulkUpsertAchievements, getAchievementCounts, addUnlock, removeUnlock }
