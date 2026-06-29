const { BrowserWindow } = require('electron')
const logger = require('../logger')

// ── Unified game status ───────────────────────────────────────────────────────
// One status vocabulary shared by the Library (games.completion_status) and the
// Game List (game_list.status): 'playing' | 'finished' | 'dropped' | 'on_hold'.
// The Game List additionally keeps 'want_to_play' / 'upcoming' for games that
// aren't in the library yet. Every status write goes through this module so the
// two tables can never drift apart.
//
// Linkage: game_list rows are created with game_id = NULL (AddGameToListModal),
// so matching by game_id alone finds almost nothing. A list row is considered
// linked to a library game when ANY of these match, checked in order:
//   1. gl.game_id = g.id
//   2. gl.steam_app_id = g.steam_app_id (both non-null)
//   3. lower(gl.name) = lower(g.name)   (manual/cracked entries)
// When a match is found via 2 or 3, gl.game_id is backfilled so future lookups
// (and the XP finished-count dedupe) get the cheap direct link.

const SHARED_STATUSES = new Set(['playing', 'finished', 'dropped', 'on_hold'])
const LIST_ONLY_STATUSES = new Set(['want_to_play', 'upcoming'])

function db() { return require('../db/database').getDb() }

function broadcast(channel, payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  } catch {}
}

// All game_list rows linked to this library game (see linkage rules above).
function linkedListRows(game) {
  return db().prepare(`
    SELECT id, game_id FROM game_list
    WHERE game_id = @id
       OR (steam_app_id IS NOT NULL AND steam_app_id = @steam_app_id)
       OR lower(name) = lower(@name)
  `).all({ id: game.id, steam_app_id: game.steam_app_id ?? null, name: game.name })
}

// The library game a game_list row points at, or null.
function linkedGame(listRow) {
  return db().prepare(`
    SELECT id, completion_status FROM games
    WHERE id = @game_id
       OR (steam_app_id IS NOT NULL AND steam_app_id = @steam_app_id)
       OR lower(name) = lower(@name)
    LIMIT 1
  `).get({
    game_id: listRow.game_id ?? -1,
    steam_app_id: listRow.steam_app_id ?? null,
    name: listRow.name,
  })
}

/**
 * Set a library game's status and mirror it onto any linked Game List rows.
 * `status` is one of the shared statuses or null (clear). Clearing the library
 * status leaves list rows untouched — a cleared card shouldn't erase a backlog
 * entry the user curated on the Game List page.
 */
function setGameStatus(gameId, status) {
  const value = status || null
  if (value && !SHARED_STATUSES.has(value)) throw new Error(`Invalid game status: ${status}`)

  const game = db().prepare('SELECT id, name, steam_app_id, completion_status FROM games WHERE id = ?').get(gameId)
  if (!game) throw new Error('Game not found')
  if (game.completion_status === value) return game

  db().prepare('UPDATE games SET completion_status = ?, completion_status_at = ? WHERE id = ?')
    .run(value, new Date().toISOString(), gameId)

  if (value) {
    for (const row of linkedListRows(game)) {
      db().prepare('UPDATE game_list SET status = ?, game_id = ? WHERE id = ?')
        .run(value, gameId, row.id)
    }
  }

  logger.info(`Game status → ${value || '(none)'}`, { gameId, name: game.name })
  try { require('./autoBackup').markDirty() } catch {}
  broadcast('game:updated', gameId)

  // Finishing a game is worth XP — surface a level-up right away if it caused one.
  if (value === 'finished') {
    try { require('./xpTracker').check({ reason: 'finished', gameName: game.name }) } catch {}
  }
  return db().prepare('SELECT * FROM games WHERE id = ?').get(gameId)
}

/**
 * A Game List row's status changed — reflect it on the linked library game.
 * Shared statuses copy over; moving a linked row back to want_to_play/upcoming
 * clears the library status (the user is saying "I haven't really played this").
 */
function syncFromGameList(listItemId, status) {
  if (!status) return
  const row = db().prepare('SELECT id, game_id, steam_app_id, name FROM game_list WHERE id = ?').get(listItemId)
  if (!row) return

  const game = linkedGame(row)
  if (!game) return

  if (row.game_id !== game.id) {
    db().prepare('UPDATE game_list SET game_id = ? WHERE id = ?').run(game.id, row.id)
  }

  if (SHARED_STATUSES.has(status) && game.completion_status !== status) {
    db().prepare('UPDATE games SET completion_status = ?, completion_status_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), game.id)
    broadcast('game:updated', game.id)
    if (status === 'finished') {
      try { require('./xpTracker').check({ reason: 'finished', gameName: row.name }) } catch {}
    }
  } else if (LIST_ONLY_STATUSES.has(status) && game.completion_status != null) {
    db().prepare('UPDATE games SET completion_status = NULL, completion_status_at = ? WHERE id = ?')
      .run(new Date().toISOString(), game.id)
    broadcast('game:updated', game.id)
  }
}

/**
 * A play session officially started. Auto-mark the game 'playing' — but only
 * from NULL or 'on_hold'. Never clobber 'finished' (replaying a finished game
 * must not un-finish it) or 'dropped' (a deliberate user verdict).
 */
function onSessionStarted(gameId) {
  const game = db().prepare('SELECT completion_status FROM games WHERE id = ?').get(gameId)
  if (!game) return
  if (game.completion_status == null || game.completion_status === 'on_hold') {
    setGameStatus(gameId, 'playing')
  }
}

module.exports = { setGameStatus, syncFromGameList, onSessionStarted, SHARED_STATUSES }
