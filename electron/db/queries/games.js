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

function addGame(data) {
  const stmt = getDb().prepare(`
    INSERT INTO games (steam_app_id, name, exe_name, install_path, banner_url, banner_local_path, source, is_installed, is_cracked)
    VALUES (@steam_app_id, @name, @exe_name, @install_path, @banner_url, @banner_local_path, @source, 1, @is_cracked)
  `)
  const result = stmt.run(data)
  return getGame(result.lastInsertRowid)
}

function updateGame(id, data) {
  const allowed = ['name', 'exe_name', 'install_path', 'banner_url', 'banner_local_path', 'source', 'steam_app_id', 'is_installed', 'is_cracked', 'is_favorite', 'is_hidden', 'completion_status', 'completion_status_at', 'manual_appid', 'crack_dir', 'total_playtime_seconds', 'first_played_at', 'last_played_at', 'genres', 'display_order', 'notes']
  const sets = Object.keys(data)
    .filter(k => allowed.includes(k))
    .map(k => `${k} = @${k}`)
    .join(', ')

  if (!sets) return getGame(id)

  getDb().prepare(`UPDATE games SET ${sets} WHERE id = @id`).run({ ...data, id })
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
