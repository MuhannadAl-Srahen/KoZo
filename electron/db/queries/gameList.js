const { getDb } = require('../database')

// Favorites always lead ("Pin to top"), then the custom drag order, then
// newest-first for rows that were never dragged.
const ORDER_BY = ' ORDER BY gl.is_favorite DESC, (gl.display_order IS NULL), gl.display_order, gl.added_at DESC'

function listGameListItems(filters = {}) {
  let query = `
    SELECT gl.*, c.name AS category_name, c.emoji AS category_emoji
    FROM game_list gl
    LEFT JOIN categories c ON c.id = gl.category_id
    WHERE 1=1
  `
  const params = []

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

  if (filters.search) {
    query += " AND gl.name LIKE '%' || ? || '%' COLLATE NOCASE"
    params.push(filters.search)
  }

  query += ORDER_BY

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
  // Dedupe on Steam appid OR (case-insensitive) name — manual adds have no
  // appid, so an appid-only check let identical entries pile up.
  const existing = getDb().prepare(`
    SELECT id FROM game_list
    WHERE (@steam_app_id IS NOT NULL AND steam_app_id = @steam_app_id)
       OR lower(name) = lower(@name)
    LIMIT 1
  `).get({ steam_app_id: data.steam_app_id ?? null, name: data.name || '' })
  if (existing) throw new Error('This game is already in your list.')
  const result = getDb().prepare(`
    INSERT INTO game_list (game_id, steam_app_id, name, banner_url, category_id, status, rating, genres, release_date)
    VALUES (@game_id, @steam_app_id, @name, @banner_url, @category_id, @status, @rating, @genres, @release_date)
  `).run({ category_id: null, genres: null, release_date: null, ...data })
  return getGameListItem(result.lastInsertRowid)
}

function updateGameListItem(id, data) {
  const allowed = ['game_id', 'steam_app_id', 'name', 'banner_url', 'category_id', 'status', 'rating', 'is_favorite', 'genres', 'display_order', 'release_date']
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

// Persist a drag on one page of a (possibly filtered) view. Writing orders for
// just that page made them outrank every never-dragged (NULL) row, so a drop on
// page 2 jumped those items to page 1. Instead the new page order is spliced
// into the full filtered view, the view's rows are put back into the slots they
// occupy in the global order, and display_order is rewritten for every row.
function reorderGameListPage(filters = {}, offset = 0, pageIds = []) {
  const db = getDb()
  const all = db.prepare('SELECT gl.id FROM game_list gl' + ORDER_BY).all().map(r => r.id)
  const view = listGameListItems({ ...filters, limit: -1, offset: 0 }).items.map(r => r.id)
  const pageSet = new Set(pageIds)
  const newView = view.filter(id => !pageSet.has(id))
  newView.splice(Math.max(0, Math.min(offset, newView.length)), 0, ...pageIds.filter(id => view.includes(id)))
  const viewSet = new Set(view)
  let k = 0
  const merged = all.map(id => (viewSet.has(id) ? newView[k++] : id))
  const stmt = db.prepare('UPDATE game_list SET display_order = ? WHERE id = ?')
  db.transaction(() => { merged.forEach((id, i) => stmt.run(i, id)) })()
  return true
}

module.exports = { reorderGameListPage, listGameListItems, getGameListItem, addGameListItem, updateGameListItem, deleteGameListItem, distinctGenres }
