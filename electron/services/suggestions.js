'use strict'
// Smart suggestions: one small card in KoZo's corner at a time (components/SuggestionCard.jsx).
// The maker's ask: "when I put a game as playing ... ask me if I want to plan it for the month",
// and "if there is more, bring it in". Four kinds:
//   plan   a game became Playing and isn't in this month's Play Plan: plan it (or move it here).
//   next   a game was finished: the next Up next game in its month's plan, start it?
//   carry  a new month: last month's planned games that aren't finished, move them here?
//   stale  games marked Playing that haven't been played in 3 weeks: move them to On hold?
// Never during a game (list() is empty while a session runs). Each thing is asked once (setting
// suggest_done). Each kind can be turned off (setting `suggestions`: Settings > General, or
// "Don't ask again" on its card).

const logger = require('../logger')

const KINDS = ['plan', 'next', 'carry', 'stale']
const ORDER = { plan: 0, next: 1, carry: 2, stale: 3 }
const STALE_DAYS = 21
const DONE_CAP = 200

// ── Pure ─────────────────────────────────────────────────────────────────────

// Local "YYYY-MM", the Play Plan's month key.
function monthKey(d = new Date()) {
  const x = new Date(d)
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`
}
function prevMonth(month) {
  const [y, m] = String(month).split('-').map(Number)
  return monthKey(new Date(y, m - 2, 1))
}
function monthName(month) {
  const [y, m] = String(month).split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' })
}
// A Playing game's plan month against this month: null when it's already planned here,
// else { move: the month it's planned for, or null }.
function planAsk(plannedMonth, month) {
  if (plannedMonth === month) return null
  return { move: plannedMonth || null }
}
// The Play Plan's own order for a month (gameList:planBoard): favorites, then display_order, then id.
function boardOrder(rows) {
  return (rows || []).slice().sort((a, b) =>
    ((b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0)) ||
    ((a.display_order == null ? 1 : 0) - (b.display_order == null ? 1 : 0)) ||
    ((a.display_order ?? 0) - (b.display_order ?? 0)) ||
    (a.id - b.id))
}
// The month's next Up next game: not Playing, Finished or Dropped, and not the one just finished.
const NOT_UP_NEXT = new Set(['playing', 'finished', 'dropped'])
function nextUpNext(rows, finishedListId) {
  return boardOrder(rows).find(r => r.id !== finishedListId && !NOT_UP_NEXT.has(r.status)) || null
}
// Last month's planned games worth carrying over: everything not Finished or Dropped.
function carryRows(rows) {
  return (rows || []).filter(r => r.status !== 'finished' && r.status !== 'dropped')
}
// Library games marked Playing, in the Library, not played (or set Playing) for `days`.
function stalePlaying(games, now = Date.now(), days = STALE_DAYS) {
  const cut = now - days * 86400000
  return (games || []).filter(g => {
    if (g.completion_status !== 'playing' || g.is_archived || g.is_hidden) return false
    const t = Date.parse(g.last_played_at || g.completion_status_at || '')
    return Number.isFinite(t) && t < cut
  })
}
// "A, B and 3 more"
function namesText(names, max = 3) {
  const list = (names || []).filter(Boolean)
  if (list.length <= max) return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] || '')
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`
}

// ── State ────────────────────────────────────────────────────────────────────

let queue = []

function db() { return require('../db/database').getDb() }
function settings() { return require('../db/queries/settings') }
function sessionActive() { try { return require('./processWatcher').isSessionActive() } catch { return false } }

function prefs() {
  const out = Object.fromEntries(KINDS.map(k => [k, true]))
  try { Object.assign(out, JSON.parse(settings().getSetting('suggestions') || '{}') || {}) } catch {}
  return out
}
function setPref(kind, on) {
  if (!KINDS.includes(kind)) return prefs()
  const p = { ...prefs(), [kind]: !!on }
  settings().setSetting('suggestions', JSON.stringify(p))
  if (!on) queue = queue.filter(q => q.kind !== kind)
  changed()
  return p
}
function doneKeys() {
  try { return new Set(JSON.parse(settings().getSetting('suggest_done') || '[]')) } catch { return new Set() }
}
function markDone(keys) {
  const list = [...doneKeys()]
  for (const k of [].concat(keys)) if (k && !list.includes(k)) list.push(k)
  try { settings().setSetting('suggest_done', JSON.stringify(list.slice(-DONE_CAP))) } catch {}
}

function broadcast(channel, payload) {
  try {
    for (const w of require('electron').BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  } catch {}
}
function changed() { broadcast('suggestions:changed', list().length) }

function push(item) {
  if (!prefs()[item.kind]) return
  const done = doneKeys()
  if (done.has(item.key)) return
  queue = queue.filter(q => q.key !== item.key && !(item.replaces && q.kind === item.kind))
  queue.push(item)
  queue.sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
  logger.info(`suggestions: ${item.kind}`, { key: item.key })
  changed()
}

// What the corner card shows, first one first. Nothing while a game runs.
function list() {
  if (sessionActive()) return []
  const p = prefs()
  return queue.filter(q => p[q.kind]).map(({ replaces, ...q }) => q)
}

function coverOf(gameId, listRow = null) {
  const g = gameId ? db().prepare('SELECT banner_local_path, banner_url FROM games WHERE id = ?').get(gameId) : null
  return { coverPath: g?.banner_local_path || null, coverUrl: listRow?.banner_url || g?.banner_url || null }
}

// ── Triggers ─────────────────────────────────────────────────────────────────

// A game became Playing (statusSync.setGameStatus when you set it, processWatcher after a real
// session that set it, ipc.js gameList:update for a Game List row). `listId` alone: a row
// with no Library game.
function askPlan({ gameId = null, listId = null } = {}) {
  try {
    const d = db()
    const game = gameId ? d.prepare('SELECT id, name, completion_status FROM games WHERE id = ?').get(gameId) : null
    if (gameId && game?.completion_status !== 'playing') return
    const row = listId
      ? d.prepare('SELECT id, game_id, name, status, planned_month, banner_url FROM game_list WHERE id = ?').get(listId)
      : d.prepare('SELECT id, game_id, name, status, planned_month, banner_url FROM game_list WHERE game_id = ? ORDER BY planned_month IS NULL LIMIT 1').get(gameId)
    if (!game && !row) return
    if (!game && row.status !== 'playing') return
    const month = monthKey()
    const ask = planAsk(row?.planned_month || null, month)
    if (!ask) return
    const id = game?.id ?? row?.game_id ?? null
    const name = game?.name || row?.name || ''
    push({
      key: `plan:${id ? 'g' + id : 'l' + row.id}:${month}`, kind: 'plan',
      gameId: id, listId: row?.id ?? null, month, name, ...coverOf(id, row),
      title: `Playing ${name}`,
      text: ask.move ? `It's in your ${monthName(ask.move)} plan. Move it to ${monthName(month)}?` : `Add it to your ${monthName(month)} Play Plan?`,
      primary: { action: 'plan', label: ask.move ? `Move to ${monthName(month)}` : `Plan for ${monthName(month)}` },
    })
  } catch (e) { logger.warn('suggestions: plan failed', { message: e.message }) }
}

// A game was marked Finished (statusSync.announceFinished): the next Up next in its month's plan.
function askNext({ gameId = null, listId = null } = {}) {
  try {
    const d = db()
    const finished = listId
      ? d.prepare('SELECT id, planned_month FROM game_list WHERE id = ?').get(listId)
      : (gameId ? d.prepare('SELECT id, planned_month FROM game_list WHERE game_id = ? ORDER BY planned_month IS NULL LIMIT 1').get(gameId) : null)
    const month = finished?.planned_month || monthKey()
    const rows = d.prepare('SELECT id, game_id, name, status, banner_url, is_favorite, display_order FROM game_list WHERE planned_month = ?').all(month)
    const next = nextUpNext(rows, finished?.id ?? null)
    if (!next) return
    push({
      key: `next:${finished?.id ?? 'g' + gameId}:${next.id}`, kind: 'next',
      gameId: next.game_id ?? null, listId: next.id, month, name: next.name, ...coverOf(next.game_id, next),
      title: `Next in your ${monthName(month)} plan`,
      text: `${next.name}. Start it now?`,
      primary: { action: 'start', label: 'Set it Playing' },
      secondary: { action: 'openPlan', label: 'Open Play Plan' },
    })
  } catch (e) { logger.warn('suggestions: next failed', { message: e.message }) }
}

// Once a day when nothing is playing (main.js, and after every session): carry and stale.
function check({ force = false } = {}) {
  if (sessionActive()) return
  const today = new Date().toDateString()
  try {
    if (!force && settings().getSetting('suggest_checked_at') === today) { changed(); return }
    settings().setSetting('suggest_checked_at', today)
  } catch {}
  const d = db()
  const p = prefs()
  const done = doneKeys()
  try {
    if (p.carry) {
      const month = monthKey(), prev = prevMonth(month)
      const left = carryRows(d.prepare('SELECT id, game_id, name, status FROM game_list WHERE planned_month = ?').all(prev))
      if (left.length) {
        push({
          key: `carry:${month}`, kind: 'carry', month, listIds: left.map(r => r.id), ...coverOf(left[0].game_id),
          title: `${left.length} game${left.length === 1 ? '' : 's'} from your ${monthName(prev)} plan ${left.length === 1 ? "isn't" : "aren't"} finished`,
          text: `${namesText(left.map(r => r.name))}. Move ${left.length === 1 ? 'it' : 'them'} to ${monthName(month)}?`,
          primary: { action: 'move', label: `Move to ${monthName(month)}` },
        })
      }
    }
    if (p.stale) {
      const games = d.prepare(`SELECT id, name, completion_status, completion_status_at, last_played_at, is_archived, is_hidden
        FROM games WHERE completion_status = 'playing'`).all()
      const keyOf = (g) => `stale:${g.id}:${g.last_played_at || g.completion_status_at || ''}`
      const old = stalePlaying(games).filter(g => !done.has(keyOf(g)))
      if (old.length) {
        push({
          key: `stale:${old.map(g => g.id).join(',')}`, kind: 'stale', replaces: true,
          gameIds: old.map(g => g.id), doneKeys: old.map(keyOf), ...coverOf(old[0].id),
          title: `${old.length === 1 ? `${old[0].name} hasn't` : `${old.length} games marked Playing haven't`} been played in ${STALE_DAYS / 7} weeks`,
          text: `${old.length === 1 ? 'Move it' : `${namesText(old.map(g => g.name))}. Move them`} to On hold? Current stays for what you're playing.`,
          primary: { action: 'hold', label: 'Move to On hold' },
        })
      }
    }
  } catch (e) { logger.warn('suggestions: check failed', { message: e.message }) }
  changed()
}

// ── Answers ──────────────────────────────────────────────────────────────────

// action: the card's primary action, 'later' (Not now: asked once), 'off' (Don't ask again: the
// kind is turned off). Returns { done, undo? }: Move to On hold gives back what Undo needs
// (games:bulkRestore's shape).
function answer(key, action) {
  const item = queue.find(q => q.key === key)
  if (!item) return { done: true }
  queue = queue.filter(q => q.key !== key)
  markDone(item.doneKeys || item.key)
  let out = { done: true }
  try {
    if (action === 'off') setPref(item.kind, false)
    else if (action === 'plan') planGame(item)
    else if (action === 'start') startGame(item)
    else if (action === 'move') {
      require('../db/queries/gameList').setPlannedMonth(item.listIds || [], item.month)
      touched()
    } else if (action === 'hold') out = { done: true, undo: holdGames(item.gameIds || []) }
  } catch (e) {
    logger.warn('suggestions: answer failed', { key, action, message: e.message })
    out = { done: false, error: e.message }
  }
  logger.info('suggestions: answered', { key, action })
  changed()
  return out
}

function touched() {
  try { require('./autoBackup').markDirty() } catch {}
  broadcast('game:updated', null)
}

function planGame(item) {
  const gameListQ = require('../db/queries/gameList')
  let ids = item.listId ? [item.listId] : []
  if (item.gameId) {
    const game = db().prepare('SELECT * FROM games WHERE id = ?').get(item.gameId)
    if (game) gameListQ.ensureListRowForGame(game)
    ids = db().prepare('SELECT id FROM game_list WHERE game_id = ?').all(item.gameId).map(r => r.id)
  }
  if (ids.length) gameListQ.setPlannedMonth(ids, item.month)
  touched()
}

function startGame(item) {
  const statusSync = require('./statusSync')
  if (item.gameId) statusSync.setGameStatus(item.gameId, 'playing', { announce: false })
  else if (item.listId) {
    require('../db/queries/gameList').updateGameListItem(item.listId, { status: 'playing' })
    statusSync.syncFromGameList(item.listId, 'playing')
  }
  touched()
}

function holdGames(ids) {
  const statusSync = require('./statusSync')
  const before = []
  for (const id of ids) {
    const g = db().prepare('SELECT id, completion_status, completion_status_at FROM games WHERE id = ?').get(id)
    if (!g || g.completion_status !== 'playing') continue
    before.push({ id: g.id, completion_status: g.completion_status, completion_status_at: g.completion_status_at })
    statusSync.setGameStatus(g.id, 'on_hold', { announce: false })
  }
  touched()
  return before
}

function start() {
  try {
    const pw = require('./processWatcher')
    // After a game: the card may show again, and a day may have turned.
    pw.onIdle(() => { setTimeout(() => check(), 30000) })
  } catch {}
  setInterval(() => { try { require('./processWatcher').runWhenIdle('suggestionsCheck', () => check()) } catch {} }, 3 * 3600000)
}

module.exports = {
  list, answer, askPlan, askNext, check, prefs, setPref, start,
  // pure
  monthKey, prevMonth, monthName, planAsk, boardOrder, nextUpNext, carryRows, stalePlaying, namesText, STALE_DAYS,
}
