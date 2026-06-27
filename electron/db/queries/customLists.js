const { getDb } = require('../database')

function listLists() {
  return getDb().prepare(`
    SELECT cl.*, COUNT(clg.item_id) AS game_count
    FROM custom_lists cl
    LEFT JOIN custom_list_games clg ON clg.list_id = cl.id
    GROUP BY cl.id
    ORDER BY cl.display_order, cl.created_at
  `).all()
}

function getList(id) {
  return getDb().prepare('SELECT * FROM custom_lists WHERE id = ?').get(id)
}

function createList({ name, emoji = null, color = null }) {
  if (!name || !name.trim()) throw new Error('List name is required')
  const maxOrder = getDb().prepare('SELECT COALESCE(MAX(display_order), -1) AS m FROM custom_lists').get().m
  const r = getDb().prepare(
    'INSERT INTO custom_lists (name, emoji, color, display_order) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), emoji, color, maxOrder + 1)
  return getList(r.lastInsertRowid)
}

function updateList(id, data) {
  const allowed = ['name', 'emoji', 'color', 'display_order']
  const sets = Object.keys(data)
    .filter(k => allowed.includes(k))
    .map(k => `${k} = @${k}`)
    .join(', ')
  if (!sets) return getList(id)
  getDb().prepare(`UPDATE custom_lists SET ${sets} WHERE id = @id`).run({ ...data, id })
  return getList(id)
}

function deleteList(id) {
  getDb().prepare('DELETE FROM custom_lists WHERE id = ?').run(id)
}

function addGameToList(listId, itemId) {
  getDb().prepare(
    'INSERT OR IGNORE INTO custom_list_games (list_id, item_id) VALUES (?, ?)'
  ).run(listId, itemId)
  return true
}

function removeGameFromList(listId, itemId) {
  getDb().prepare(
    'DELETE FROM custom_list_games WHERE list_id = ? AND item_id = ?'
  ).run(listId, itemId)
  return true
}

// List ids a given game_list item belongs to — drives the "Add to list" checkmarks.
function listIdsForItem(itemId) {
  return getDb().prepare('SELECT list_id FROM custom_list_games WHERE item_id = ?')
    .all(itemId).map(r => r.list_id)
}

module.exports = { listLists, getList, createList, updateList, deleteList, addGameToList, removeGameFromList, listIdsForItem }
