const { getDb } = require('../database')

function listGames() {
  return getDb().prepare('SELECT * FROM games ORDER BY is_favorite DESC, last_played_at DESC NULLS LAST, name ASC').all()
}

function listGamesWithStats() {
  return getDb().prepare(`
    SELECT
      g.*,
      COUNT(DISTINCT a.id)              AS _total,
      COUNT(DISTINCT au.achievement_id) AS _unlocked,
      -- Play plan month lives on the linked Game List row (Library month filter).
      (SELECT gl.planned_month FROM game_list gl WHERE gl.game_id = g.id
        ORDER BY gl.planned_month IS NULL LIMIT 1) AS planned_month
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
const FLAG_COLUMNS = ['is_installed', 'is_cracked', 'is_favorite', 'is_hidden', 'run_as_admin', 'is_archived']
function flag(value, fallback = 0) {
  if (value === undefined || value === null) return fallback
  return (value === 0 || value === false || value === '0') ? 0 : 1
}

function addGame(data) {
  const stmt = getDb().prepare(`
    INSERT INTO games (steam_app_id, name, exe_name, install_path, banner_url, banner_local_path, source, is_installed, is_cracked, launch_uri)
    VALUES (@steam_app_id, @name, @exe_name, @install_path, @banner_url, @banner_local_path, @source, @is_installed, @is_cracked, @launch_uri)
  `)
  // Named params throw when a key is missing, so default every bound column —
  // callers only need to pass what they know.
  const result = stmt.run({
    steam_app_id: null, exe_name: null, install_path: null,
    banner_url: null, banner_local_path: null, source: null, launch_uri: null,
    ...data,
    is_installed: flag(data.is_installed, 1),
    is_cracked: flag(data.is_cracked, 0),
  })
  return getGame(result.lastInsertRowid)
}

function updateGame(id, data) {
  const allowed = ['name', 'exe_name', 'install_path', 'banner_url', 'banner_local_path', 'source', 'steam_app_id', 'is_installed', 'is_cracked', 'is_favorite', 'is_hidden', 'completion_status', 'completion_status_at', 'manual_appid', 'crack_dir', 'total_playtime_seconds', 'first_played_at', 'last_played_at', 'genres', 'display_order', 'notes', 'run_as_admin', 'is_archived', 'launch_file', 'launch_uri']
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

// Every finished game: Library games, plus Game List games only marked finished
// there. The Finished page and Your year both read this, so they always agree.
function listFinishedGames() {
  const db = getDb()
  const lib = db.prepare(`
    SELECT g.id AS game_id, g.name, g.banner_local_path, g.banner_url, g.banner_rev, g.total_playtime_seconds,
           g.completion_status_at AS finished_at, g.steam_app_id, g.genres, g.is_hidden,
           (SELECT COUNT(*) FROM achievements a WHERE a.game_id = g.id) AS ach_total,
           (SELECT COUNT(DISTINCT au.achievement_id) FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id WHERE a.game_id = g.id) AS ach_unlocked,
           (SELECT COUNT(*) FROM sessions s WHERE s.game_id = g.id) AS session_count,
           (SELECT MIN(s.started_at) FROM sessions s WHERE s.game_id = g.id) AS first_session_at,
           g.first_played_at, g.hero_local_path,
           gl.id AS list_id, gl.rating, gl.banner_url AS list_banner
    FROM games g LEFT JOIN game_list gl ON gl.game_id = g.id
    WHERE g.completion_status = 'finished' AND g.is_archived = 0
    GROUP BY g.id
  `).all()
  const listOnly = db.prepare(`
    SELECT NULL AS game_id, gl.name, NULL AS banner_local_path, gl.banner_url, NULL AS banner_rev, 0 AS total_playtime_seconds,
           gl.added_at AS finished_at, gl.steam_app_id, gl.genres, 0 AS is_hidden, 0 AS ach_total, 0 AS ach_unlocked,
           0 AS session_count, NULL AS first_session_at, NULL AS first_played_at, NULL AS hero_local_path,
           gl.id AS list_id, gl.rating, gl.banner_url AS list_banner
    FROM game_list gl
    WHERE gl.status = 'finished' AND (gl.game_id IS NULL OR gl.game_id NOT IN (SELECT id FROM games WHERE completion_status = 'finished'))
  `).all()
  return [...lib, ...listOnly]
}

module.exports = { listGames, listGamesWithStats, getGame, addGame, updateGame, deleteGame, getLibraryStats, listFinishedGames }
