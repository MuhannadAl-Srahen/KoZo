'use strict'

// Playthroughs: playing a game again from the start (the maker: "if I want to play a game a
// second time, like a second playthrough"). A game with no rows here is on its first
// playthrough. "Start a new playthrough" adds row 1 (from the first session) the first time,
// closes the current row (finished if the game was finished during it) and opens the next.
// Hours, sessions and achievements are never touched: a session belongs to the playthrough
// whose start it falls after, so each playthrough's time is read from the sessions. The
// current playthrough's finish isn't stored: it's the game's own Finished status, set after
// that playthrough began.
//
// Times played before KoZo (the maker: "Sekiro, I played it 2 times and want a third"): the
// first start can say which time this is. The earlier ones become rows marked before_kozo,
// finished, with no time (their start is the next row's, so no session falls in them). Row 1
// counts as the first finish like marking a game Finished does; the rest have no hour played,
// so no replay XP.

const { getDb } = require('../database')

function rowsFor(gameId) {
  return getDb().prepare('SELECT id, game_id, number, started_at, finished_at, COALESCE(before_kozo, 0) AS before_kozo FROM playthroughs WHERE game_id = ? ORDER BY number').all(Number(gameId))
}

// Pure: the playthroughs as shown, with the current one's finish from the game's status.
function withCurrentFinish(rows, game) {
  if (!rows.length) return []
  const last = rows[rows.length - 1]
  const finishedNow = game?.completion_status === 'finished' && game.completion_status_at && game.completion_status_at >= last.started_at
  return rows.map((r, i) => ({
    number: r.number,
    started_at: r.started_at,
    ended_at: i < rows.length - 1 ? rows[i + 1].started_at : null,
    finished_at: i < rows.length - 1 ? r.finished_at : (finishedNow ? game.completion_status_at : null),
    current: i === rows.length - 1,
    before_kozo: !!r.before_kozo,
  }))
}

function listForGame(gameId) {
  const game = getDb().prepare('SELECT completion_status, completion_status_at FROM games WHERE id = ?').get(Number(gameId))
  return withCurrentFinish(rowsFor(gameId), game)
}

// Start the next playthrough now. Returns what undo needs. `number`: which time this is, only
// on the first start (the earlier ones not in KoZo become before_kozo rows).
function startNew(gameId, { number: wanted } = {}) {
  const db = getDb()
  const id = Number(gameId)
  const game = db.prepare('SELECT id, completion_status, completion_status_at, first_played_at, last_played_at, created_at FROM games WHERE id = ?').get(id)
  if (!game) throw new Error('Game not found')
  const now = new Date().toISOString()
  let createdFirst = false
  const number = db.transaction(() => {
    let rows = rowsFor(id)
    if (!rows.length) {
      const first = db.prepare('SELECT MIN(started_at) AS s FROM sessions WHERE game_id = ?').get(id)?.s
      // KoZo saw a playthrough of its own when it has sessions or a Finished status.
      const tracked = !!first || game.completion_status === 'finished'
      const base = tracked ? 2 : 1
      const want = Math.max(base, Math.min(99, Math.floor(Number(wanted) || base)))
      if (!tracked && want < 2) throw new Error('Nothing played yet to play again')
      const earlier = tracked ? want - 2 : want - 1
      const start = tracked ? (first || game.first_played_at || game.created_at || now) : now
      const ins = db.prepare('INSERT INTO playthroughs (game_id, number, started_at, finished_at, before_kozo) VALUES (?, ?, ?, ?, ?)')
      for (let n = 1; n <= earlier; n++) ins.run(id, n, start, start, 1)
      if (tracked) ins.run(id, earlier + 1, start, null, 0)
      createdFirst = true
      rows = rowsFor(id)
    }
    const last = rows[rows.length - 1]
    if (!last.before_kozo) {
      // A finish with no date (marked before KoZo kept one) still counts as this playthrough's.
      const finished = game.completion_status === 'finished' && (!game.completion_status_at || game.completion_status_at >= last.started_at)
      const finishedAt = finished ? (game.completion_status_at || game.last_played_at || now) : null
      db.prepare('UPDATE playthroughs SET finished_at = ? WHERE id = ?').run(finishedAt, last.id)
    }
    db.prepare('INSERT INTO playthroughs (game_id, number, started_at) VALUES (?, ?, ?)').run(id, last.number + 1, now)
    return last.number + 1
  })()
  return { number, prevStatus: game.completion_status || null, prevStatusAt: game.completion_status_at || null, createdFirst }
}

// Undo a playthrough started by mistake: the newest row goes, the one before is current again.
function undoLast(gameId, { createdFirst = false } = {}) {
  const db = getDb()
  const id = Number(gameId)
  db.transaction(() => {
    const rows = rowsFor(id)
    // The first start made every row (with any before KoZo): undo takes them all.
    if (createdFirst) { db.prepare('DELETE FROM playthroughs WHERE game_id = ?').run(id); return }
    if (rows.length < 2) return
    db.prepare('DELETE FROM playthroughs WHERE id = ?').run(rows[rows.length - 1].id)
    db.prepare('UPDATE playthroughs SET finished_at = NULL WHERE id = ?').run(rows[rows.length - 2].id)
  })()
}

// Every finished playthrough, with the time played in it (XP: services/xp.js).
function allFinishes() {
  const db = getDb()
  const rows = db.prepare(`
    SELECT p.game_id, p.number, p.started_at, p.finished_at, g.name, g.completion_status, g.completion_status_at,
           (SELECT MIN(n.started_at) FROM playthroughs n WHERE n.game_id = p.game_id AND n.number > p.number) AS next_start
    FROM playthroughs p JOIN games g ON g.id = p.game_id
    ORDER BY p.game_id, p.number
  `).all()
  const played = db.prepare(`SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM sessions
    WHERE game_id = ? AND ended_at IS NOT NULL AND started_at >= ? AND started_at < ?`)
  const out = []
  for (const r of rows) {
    const current = r.next_start == null
    const finishedAt = current
      ? (r.completion_status === 'finished' && r.completion_status_at && r.completion_status_at >= r.started_at ? r.completion_status_at : null)
      : r.finished_at
    if (!finishedAt) continue
    // '9999-12-31', not '9999': the column's numeric affinity turns '9999' into a number,
    // and every date (text) sorts after a number, so nothing was ever "before" it.
    out.push({ game_id: r.game_id, name: r.name, number: r.number, finished_at: finishedAt, seconds: played.get(r.game_id, r.started_at, r.next_start || '9999-12-31').s })
  }
  return out
}

module.exports = { listForGame, startNew, undoLast, allFinishes, withCurrentFinish }
