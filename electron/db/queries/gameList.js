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

  // Genre filter — genres is a JSON array string, LIKE match is fine at this scale.
  if (filters.genre) {
    query += " AND gl.genres LIKE ?"
    params.push(`%"${filters.genre}"%`)
  }

  // Custom-list filter — only items that belong to the given list.
  if (filters.listId) {
    query += ' AND gl.id IN (SELECT item_id FROM custom_list_games WHERE list_id = ?)'
    params.push(filters.listId)
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
    INSERT INTO game_list (game_id, steam_app_id, name, banner_url, category_id, status, rating, genres)
    VALUES (@game_id, @steam_app_id, @name, @banner_url, @category_id, @status, @rating, @genres)
  `).run({ category_id: null, genres: null, ...data })
  return getGameListItem(result.lastInsertRowid)
}

function updateGameListItem(id, data) {
  const allowed = ['game_id', 'steam_app_id', 'name', 'banner_url', 'category_id', 'status', 'rating', 'is_favorite', 'genres']
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

// Distinct genre names across the game_list, for filter chips.
function distinctGenres() {
  const rows = getDb().prepare('SELECT genres FROM game_list WHERE genres IS NOT NULL').all()
  const set = new Set()
  for (const r of rows) {
    try { for (const g of JSON.parse(r.genres)) set.add(g) } catch {}
  }
  return [...set].sort()
}

module.exports = { listGameListItems, getGameListItem, addGameListItem, updateGameListItem, deleteGameListItem, distinctGenres }
