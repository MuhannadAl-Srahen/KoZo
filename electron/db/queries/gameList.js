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

  // Play-plan month: 'YYYY-MM', or 'none' for games without a plan.
  if (filters.month === 'none') {
    query += ' AND gl.planned_month IS NULL'
  } else if (filters.month) {
    query += ' AND gl.planned_month = ?'
    params.push(filters.month)
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
  `).run({ game_id: null, steam_app_id: null, banner_url: null, category_id: null, rating: null, genres: null, release_date: null, ...data })
  return getGameListItem(result.lastInsertRowid)
}

function updateGameListItem(id, data) {
  const allowed = ['game_id', 'steam_app_id', 'name', 'banner_url', 'category_id', 'status', 'rating', 'is_favorite', 'genres', 'display_order', 'release_date', 'planned_month']
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

// Months that have planned games, oldest first, with how many games each.
function plannedMonths() {
  return getDb().prepare(`
    SELECT planned_month AS month, COUNT(*) AS count FROM game_list
    WHERE planned_month IS NOT NULL GROUP BY planned_month ORDER BY planned_month
  `).all()
}

function setPlannedMonth(ids, month) {
  const value = month && /^\d{4}-\d{2}$/.test(month) ? month : null
  const stmt = getDb().prepare('UPDATE game_list SET planned_month = ? WHERE id = ?')
  getDb().transaction(() => { for (const id of ids) stmt.run(value, id) })()
  return value
}

// ── Library → Game List sync ─────────────────────────────────────────────────
// Every library game also has a Game List row. Linkage follows statusSync:
// game_id, else Steam appid, else case-insensitive name.
const SHARED = new Set(['playing', 'finished', 'dropped', 'on_hold'])

function listStatusForGame(game) {
  if (SHARED.has(game.completion_status)) return game.completion_status
  return (game.total_playtime_seconds || 0) > 0 ? 'playing' : 'want_to_play'
}

// Insert a Game List row for a library game unless one is already linked.
// Returns the new row id, or null when the game was already on the list.
function ensureListRowForGame(game) {
  if (!game?.id) return null
  const db = getDb()
  const linked = db.prepare(`
    SELECT id, game_id FROM game_list
    WHERE game_id = @id
       OR (steam_app_id IS NOT NULL AND steam_app_id = @steam_app_id)
       OR lower(name) = lower(@name)
    LIMIT 1
  `).get({ id: game.id, steam_app_id: game.steam_app_id ?? null, name: game.name || '' })
  if (linked) {
    if (linked.game_id !== game.id) db.prepare('UPDATE game_list SET game_id = ? WHERE id = ?').run(game.id, linked.id)
    return null
  }
  // Game List cards load remote art only — use the Steam portrait when there is one.
  const banner = game.steam_app_id
    ? `https://cdn.akamai.steamstatic.com/steam/apps/${game.steam_app_id}/library_600x900_2x.jpg`
    : (/^https?:/i.test(game.banner_url || '') ? game.banner_url : null)
  const r = db.prepare(`
    INSERT INTO game_list (game_id, steam_app_id, name, banner_url, status, genres)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(game.id, game.steam_app_id ?? null, game.name, banner, listStatusForGame(game), game.genres ?? null)
  return Number(r.lastInsertRowid)
}

// One pass over the whole library (startup migration). Returns rows added.
function syncLibraryToList() {
  const db = getDb()
  const games = db.prepare('SELECT * FROM games').all()
  let added = 0
  db.transaction(() => { for (const g of games) if (ensureListRowForGame(g)) added++ })()
  return added
}

module.exports = { plannedMonths, setPlannedMonth, ensureListRowForGame, syncLibraryToList, listStatusForGame, reorderGameListPage, listGameListItems, getGameListItem, addGameListItem, updateGameListItem, deleteGameListItem, distinctGenres }
