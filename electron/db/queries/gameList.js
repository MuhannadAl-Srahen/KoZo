const { getDb } = require('../database')

function listGameListItems(filters = {}) {
  let query = `
    SELECT gl.*, c.name AS category_name, c.emoji AS category_emoji
    FROM game_list gl
    LEFT JOIN categories c ON c.id = gl.category_id
    WHERE 1=1
  `
  const params = []

  if (filters.categoryId) {
    query += ' AND gl.category_id = ?'
    params.push(filters.categoryId)
  }

  if (filters.status) {
    query += ' AND gl.status = ?'
    params.push(filters.status)
  }

  query += ' ORDER BY gl.is_favorite DESC, gl.added_at DESC'

  const total = getDb()
    .prepare(query.replace('SELECT gl.*, c.name AS category_name, c.emoji AS category_emoji', 'SELECT COUNT(*) AS count'))
    .get(...params)

  const limit = filters.limit || 20
  const offset = filters.offset || 0
  query += ' LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const items = getDb().prepare(query).all(...params)
  return { items, total: total.count }
}

function getGameListItem(id) {
  return getDb().prepare(`
    SELECT gl.*, c.name AS category_name, c.emoji AS category_emoji
    FROM game_list gl
    LEFT JOIN categories c ON c.id = gl.category_id
    WHERE gl.id = ?
  `).get(id)
}

function addGameListItem(data) {
  if (data.steam_app_id) {
    const existing = getDb()
      .prepare('SELECT id FROM game_list WHERE steam_app_id = ? LIMIT 1')
      .get(data.steam_app_id)
    if (existing) throw new Error('This game is already in your list.')
  }
  const result = getDb().prepare(`
    INSERT INTO game_list (game_id, steam_app_id, name, banner_url, category_id, status, rating)
    VALUES (@game_id, @steam_app_id, @name, @banner_url, @category_id, @status, @rating)
  `).run(data)
  return getGameListItem(result.lastInsertRowid)
}

function updateGameListItem(id, data) {
  const allowed = ['game_id', 'steam_app_id', 'name', 'banner_url', 'category_id', 'status', 'rating', 'is_favorite']
  const sets = Object.keys(data)
    .filter(k => allowed.includes(k))
    .map(k => `${k} = @${k}`)
    .join(', ')

  if (!sets) return getGameListItem(id)
  getDb().prepare(`UPDATE game_list SET ${sets} WHERE id = @id`).run({ ...data, id })
  return getGameListItem(id)
}

function deleteGameListItem(id) {
  getDb().prepare('DELETE FROM game_list WHERE id = ?').run(id)
}

module.exports = { listGameListItems, getGameListItem, addGameListItem, updateGameListItem, deleteGameListItem }
