const { getDb } = require('../database')

function listCategories() {
  return getDb().prepare(`
    SELECT c.*, COUNT(gl.id) AS game_count
    FROM categories c
    LEFT JOIN game_list gl ON gl.category_id = c.id
    GROUP BY c.id
    ORDER BY c.display_order ASC, c.name ASC
  `).all()
}

function getCategory(id) {
  return getDb().prepare('SELECT * FROM categories WHERE id = ?').get(id)
}

function addCategory(data) {
  const maxOrder = getDb()
    .prepare('SELECT COALESCE(MAX(display_order), -1) AS m FROM categories')
    .get().m
  const result = getDb().prepare(`
    INSERT INTO categories (name, emoji, display_order) VALUES (@name, @emoji, @display_order)
  `).run({ ...data, display_order: maxOrder + 1 })
  return getCategory(result.lastInsertRowid)
}

function updateCategory(id, data) {
  const allowed = ['name', 'emoji', 'display_order']
  const sets = Object.keys(data)
    .filter(k => allowed.includes(k))
    .map(k => `${k} = @${k}`)
    .join(', ')

  if (!sets) return getCategory(id)
  getDb().prepare(`UPDATE categories SET ${sets} WHERE id = @id`).run({ ...data, id })
  return getCategory(id)
}

function deleteCategory(id, reassignToId = null) {
  const db = getDb()
  const del = db.transaction(() => {
    db.prepare('UPDATE game_list SET category_id = ? WHERE category_id = ?').run(reassignToId, id)
    db.prepare('DELETE FROM categories WHERE id = ?').run(id)
  })
  del()
}

module.exports = { listCategories, getCategory, addCategory, updateCategory, deleteCategory }
