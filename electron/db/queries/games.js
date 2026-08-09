const { getDb } = require('../database')

function listGames() {
  return getDb().prepare('SELECT * FROM games ORDER BY is_favorite DESC, last_played_at DESC NULLS LAST, name ASC').all()
}

function listGamesWithStats() {
  return getDb().prepare(`
    SELECT
      g.*,
      COUNT(DISTINCT a.id)              AS _total,
      COUNT(DISTINCT au.achievement_id) AS _unlocked
    FROM games g
    LEFT JOIN achievements a            ON a.game_id = g.id
    LEFT JOIN achievement_unlocks au    ON au.achievement_id = a.id
    GROUP BY g.id
    ORDER BY g.is_favorite DESC, g.last_played_at DESC NULLS LAST, g.name ASC
  `).all()
}

function getGame(id) {
  return getDb().prepare('SELECT * FROM games WHERE id = ?').get(id)
}

// SQLite has no boolean type and better-sqlite3 refuses to bind one, so every
// flag column is normalised to 0/1 before it reaches a statement.
const FLAG_COLUMNS = ['is_installed', 'is_cracked', 'is_favorite', 'is_hidden', 'run_as_admin']
function flag(value, fallback = 0) {
  if (value === undefined || value === null) return fallback
  return (value === 0 || value === false || value === '0') ? 0 : 1
}

function addGame(data) {
  const stmt = getDb().prepare(`
    INSERT INTO games (steam_app_id, name, exe_name, install_path, banner_url, banner_local_path, source, is_installed, is_cracked)
    VALUES (@steam_app_id, @name, @exe_name, @install_path, @banner_url, @banner_local_path, @source, @is_installed, @is_cracked)
  `)
  const result = stmt.run({
    ...data,
    is_installed: flag(data.is_installed, 1),
    is_cracked: flag(data.is_cracked, 0),
  })
  return getGame(result.lastInsertRowid)
}

function updateGame(id, data) {
  const allowed = ['name', 'exe_name', 'install_path', 'banner_url', 'banner_local_path', 'source', 'steam_app_id', 'is_installed', 'is_cracked', 'is_favorite', 'is_hidden', 'completion_status', 'completion_status_at', 'manual_appid', 'crack_dir', 'total_playtime_seconds', 'first_played_at', 'last_played_at', 'genres', 'display_order', 'notes', 'run_as_admin']
  const keys = Object.keys(data).filter(k => allowed.includes(k))
  const sets = keys.map(k => `${k} = @${k}`).join(', ')

  if (!sets) return getGame(id)

  const params = { id }
  for (const k of keys) params[k] = FLAG_COLUMNS.includes(k) ? flag(data[k]) : data[k]
  getDb().prepare(`UPDATE games SET ${sets} WHERE id = @id`).run(params)
  return getGame(id)
}

function deleteGame(id) {
  getDb().prepare('DELETE FROM games WHERE id = ?').run(id)
}

function getLibraryStats() {
  return getDb().prepare(`
    SELECT
      COUNT(*) AS total_games,
      SUM(total_playtime_seconds) AS total_playtime_seconds
    FROM games
  `).get()
}

module.exports = { listGames, listGamesWithStats, getGame, addGame, updateGame, deleteGame, getLibraryStats }
