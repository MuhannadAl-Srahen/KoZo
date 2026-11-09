// A game was uninstalled: its folder (or its game file) is gone, so installCheck flagged it
// not installed. Before, the card only went dim and the game stayed "Playing" everywhere,
// also on the Game List (the maker uninstalled Need for Speed Most Wanted and it still said
// Playing). Now a card in KoZo's corner (components/UninstalledCard.jsx, the maker's pick
// over a bar or a window) asks what to do: a status, Remove from Library, Delete from KoZo,
// or keep it as it is.
//
// Asked once per game and folder (setting `uninstall_asked`: { id: install_path }). A game
// that comes back (reinstalled, drive plugged in) is forgotten, so a later uninstall asks
// again. A game whose whole drive is missing is not asked: that's an unplugged drive.

const logger = require('../logger')

const SETTING = 'uninstall_asked'
const STATUSES = new Set(['finished', 'dropped', 'on_hold'])

function db() { return require('../db/database').getDb() }
function settings() { return require('../db/queries/settings') }

function askedMap() {
  try { return JSON.parse(settings().getSetting(SETTING) || '{}') || {} } catch { return {} }
}
function saveAsked(map) {
  try { settings().setSetting(SETTING, JSON.stringify(map)) } catch {}
}

// Pure: which games to ask about. `rows` are not-installed, not-archived games with a folder;
// `asked` the setting; `gone(path)` true when the folder's whole drive is missing.
function pickPending(rows, asked, driveGone) {
  const out = []
  const seen = new Set()
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (asked[r.id] && asked[r.id] === r.install_path) continue
    if (driveGone(r.install_path)) continue
    out.push(r)
  }
  return out
}

// Answers for games that are installed again (or gone) are dropped, so they're asked next time.
function forgetReturned(asked, stillMissingIds) {
  const keep = {}
  for (const [id, p] of Object.entries(asked)) if (stillMissingIds.has(Number(id))) keep[id] = p
  return keep
}

function driveGone(p) {
  const m = /^([a-z]):[\\/]/i.exec(String(p || ''))
  if (!m) return false
  try { return !require('fs').existsSync(`${m[1]}:\\`) } catch { return false }
}

function pending() {
  let rows = []
  try {
    rows = db().prepare(`
      SELECT g.id, g.name, g.install_path, g.completion_status, g.banner_local_path, g.banner_url,
             g.steam_app_id, g.total_playtime_seconds,
             (SELECT gl.status FROM game_list gl WHERE gl.game_id = g.id LIMIT 1) AS list_status
      FROM games g
      WHERE g.is_installed = 0 AND COALESCE(g.is_archived, 0) = 0
        AND g.install_path IS NOT NULL AND g.install_path != ''
      ORDER BY g.last_played_at DESC, g.id
    `).all()
  } catch (e) { logger.warn('uninstalled: list failed', { message: e.message }); return [] }
  const asked = askedMap()
  const trimmed = forgetReturned(asked, new Set(rows.map(r => r.id)))
  if (Object.keys(trimmed).length !== Object.keys(asked).length) saveAsked(trimmed)
  return pickPending(rows, trimmed, driveGone)
}

function markAsked(id) {
  const g = db().prepare('SELECT install_path FROM games WHERE id = ?').get(id)
  const map = askedMap()
  map[id] = g?.install_path || ''
  saveAsked(map)
}

/**
 * The answer from the card. `action`: finished | dropped | on_hold (a status, the game stays
 * in the Library, dimmed), remove (Library's Remove: the history stays, Archived shelf),
 * delete (the game, its history and its Game List entry), keep (nothing changes).
 * `deleteGames` is ipc.js's delete, passed in so the file cleanup lives in one place.
 */
function answer(id, action, { deleteGames } = {}) {
  id = Number(id)
  const game = db().prepare('SELECT id, name, completion_status FROM games WHERE id = ?').get(id)
  if (!game) return { ok: true }
  const statusSync = require('./statusSync')
  if (STATUSES.has(action)) {
    statusSync.setGameStatus(id, action)
    markAsked(id)
  } else if (action === 'remove') {
    // Removed and not installed isn't "Playing" any more: On hold says it was left unfinished,
    // and the card's button says so before it's pressed.
    if (game.completion_status === 'playing') statusSync.setGameStatus(id, 'on_hold')
    db().prepare('UPDATE games SET is_archived = 1 WHERE id = ?').run(id)
    markAsked(id)
  } else if (action === 'delete') {
    if (typeof deleteGames !== 'function') throw new Error('No delete')
    deleteGames([id], { listRows: true })
    const map = askedMap(); delete map[id]; saveAsked(map)
  } else if (action === 'keep') {
    markAsked(id)
  } else {
    throw new Error(`Unknown answer: ${action}`)
  }
  logger.info(`uninstalled: "${game.name}" → ${action}`)
  try { require('./autoBackup').markDirty() } catch {}
  return { ok: true }
}

module.exports = { pending, answer, pickPending, forgetReturned, SETTING }
