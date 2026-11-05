'use strict'

// Adding another PC's library to this one: the three questions after a Google sign-in, and
// a .kozo file or folder from another install. Ids mean nothing across PCs (game 5 there is
// another game here), so rows match by what they are and everything gets this PC's ids.
// Nothing here is removed, a game is never added twice, and running it again adds nothing.

const fs = require('fs')

// The same game under another spelling: "Red-Alert-2" and "Red Alert 2".
function nameKey(name) {
  const t = String(name || '').normalize('NFKD').toLowerCase()
  return t.replace(/[^\p{L}\p{N}]/gu, '') || t.trim()
}
const appKey = (v) => (v == null || v === '' ? null : String(v))
const isEmpty = (v) => v == null || v === ''
const timeOf = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : null }
const earlier = (a, b) => { const x = timeOf(a), y = timeOf(b); return x == null ? b : y == null || x <= y ? a : b }
const later = (a, b) => { const x = timeOf(a), y = timeOf(b); return x == null ? b : y == null || x >= y ? a : b }

// Find a game or a list row: by Steam id, else by name. The same name under two different
// Steam ids is two games (a demo and the full game can share one).
function makeIndex() {
  const byApp = new Map(), byName = new Map()
  return {
    add(row) {
      const app = appKey(row.steam_app_id), key = nameKey(row.name)
      if (app && !byApp.has(app)) byApp.set(app, row)
      if (key && !byName.has(key)) byName.set(key, row)
    },
    find(row) {
      const app = appKey(row.steam_app_id)
      if (app && byApp.has(app)) return byApp.get(app)
      const hit = byName.get(nameKey(row.name))
      if (!hit) return null
      const theirs = appKey(hit.steam_app_id)
      return app && theirs && app !== theirs ? null : hit
    },
  }
}

// Pure: what adding `backups` to `local` would do. backups: payloads from autoBackup, newest
// first. local: this PC's tables (readLocal). Returns the rows to write, with negative ids
// standing for rows that don't exist yet, and the counts the questions show.
function planMerge(backups, local, { list: wantList = true, library: wantLibrary = true, exists = () => false } = {}) {
  let nextTemp = -1
  const temp = () => nextTemp--
  const plan = {
    newGames: [], gameChanges: new Map(), newSessions: [], newAchievements: [], newUnlocks: [], unlockChanges: [],
    newList: [], listChanges: new Map(),
    counts: { list: { total: 0, fresh: 0 }, library: { total: 0, fresh: 0, sessions: 0, seconds: 0, unlocks: 0 } },
  }

  const games = makeIndex()
  for (const g of local.games || []) games.add({ ...g })
  const setGame = (mine, field, value) => {
    if (mine[field] === value) return
    mine[field] = value
    if (mine.id > 0) plan.gameChanges.set(mine.id, { ...(plan.gameChanges.get(mine.id) || {}), [field]: value })
  }

  const sessionsSeen = new Map((local.sessions || []).map(s => [`${s.game_id}|${s.started_at}`, s.id]))
  const achsSeen = new Map((local.achievements || []).map(a => [`${a.game_id}|${a.steam_api_name}`, a.id]))
  const unlocksSeen = new Map((local.achievement_unlocks || []).map(u => [u.achievement_id, { ...u }]))

  const rows = makeIndex()
  const rowsByGame = new Map()
  const addRow = (r) => { rows.add(r); if (r.game_id != null && !rowsByGame.has(r.game_id)) rowsByGame.set(r.game_id, r) }
  for (const r of local.game_list || []) addRow({ ...r })
  let order = Math.max(0, ...(local.game_list || []).map(r => Number(r.display_order) || 0))
  const setRow = (mine, field, value) => {
    if (mine[field] === value) return
    mine[field] = value
    if (mine.id > 0) plan.listChanges.set(mine.id, { ...(plan.listChanges.get(mine.id) || {}), [field]: value })
  }

  const touchedGames = new Map(), touchedRows = new Set()
  const shownGames = new Set(), shownFresh = new Set()

  for (const b of backups) {
    const gameIds = new Map()     // this backup's id -> this PC's
    const madeHere = new Set()    // games this backup creates: its playtime already counts their sessions
    const sessionIds = new Map(), achIds = new Map()

    for (const g of b.games || []) {
      if (!g?.name) continue
      let mine = games.find(g)
      if (mine) {
        if (wantLibrary) {
          for (const f of ['steam_app_id', 'manual_appid', 'genres', 'banner_url', 'completion_status', 'completion_status_at']) {
            if (isEmpty(mine[f]) && !isEmpty(g[f])) setGame(mine, f, g[f])
          }
        }
      } else if (wantLibrary) {
        const installed = !!g.is_installed && !!g.install_path && exists(g.install_path)
        mine = {
          ...g, id: temp(),
          // Pictures and save folders are that PC's. Art comes back by itself, and saves are found again here.
          banner_local_path: null, hero_local_path: null, save_paths: null,
          is_installed: installed ? 1 : 0,
          exe_name: g.exe_name ?? '', source: g.source || 'manual',
        }
        games.add(mine)
        plan.newGames.push(mine)
        madeHere.add(mine.id)
        if (!g.is_archived) shownFresh.add(mine.id)
      } else continue
      gameIds.set(g.id, mine.id)
      if (wantLibrary) {
        touchedGames.set(mine.id, mine)
        if (!g.is_archived) shownGames.add(mine.id)
      }
    }

    if (wantLibrary) {
      for (const s of b.sessions || []) {
        const gid = gameIds.get(s.game_id)
        if (gid == null || !s.started_at) continue
        const key = `${gid}|${s.started_at}`
        if (sessionsSeen.has(key)) { sessionIds.set(s.id, sessionsSeen.get(key)); continue }
        if (!s.ended_at) continue   // still running on that PC
        const id = temp(), secs = Number(s.duration_seconds) || 0
        plan.newSessions.push({ ...s, id, game_id: gid })
        sessionsSeen.set(key, id)
        sessionIds.set(s.id, id)
        plan.counts.library.sessions++
        plan.counts.library.seconds += secs
        if (!madeHere.has(gid)) {
          const mine = touchedGames.get(gid)
          setGame(mine, 'total_playtime_seconds', (Number(mine.total_playtime_seconds) || 0) + secs)
          setGame(mine, 'first_played_at', mine.first_played_at ? earlier(mine.first_played_at, s.started_at) : s.started_at)
          setGame(mine, 'last_played_at', mine.last_played_at ? later(mine.last_played_at, s.ended_at) : s.ended_at)
        }
      }

      for (const a of b.achievements || []) {
        const gid = gameIds.get(a.game_id)
        if (gid == null || !a.steam_api_name) continue
        const key = `${gid}|${a.steam_api_name}`
        let id = achsSeen.get(key)
        if (id == null) {
          id = temp()
          achsSeen.set(key, id)
          plan.newAchievements.push({ ...a, id, game_id: gid, display_name: a.display_name || a.steam_api_name })
        }
        achIds.set(a.id, id)
      }

      for (const u of b.achievement_unlocks || []) {
        const aid = achIds.get(u.achievement_id)
        if (aid == null) continue
        const sid = u.session_id != null ? (sessionIds.get(u.session_id) ?? null) : null
        const have = unlocksSeen.get(aid)
        if (!have) {
          const row = { ...u, id: temp(), achievement_id: aid, session_id: sid, source: u.source || 'backup' }
          unlocksSeen.set(aid, row)
          plan.newUnlocks.push(row)
          plan.counts.library.unlocks++
        } else if (u.unlocked_at && (!have.unlocked_at || (timeOf(u.unlocked_at) ?? Infinity) < (timeOf(have.unlocked_at) ?? Infinity))) {
          have.unlocked_at = u.unlocked_at
          have.session_id = sid
          if (have.id > 0) {
            const i = plan.unlockChanges.findIndex(c => c.id === have.id)
            if (i >= 0) plan.unlockChanges.splice(i, 1)
            plan.unlockChanges.push({ id: have.id, unlocked_at: u.unlocked_at, session_id: sid })
          }
        }
      }
    }

    for (const r of b.game_list || []) {
      if (!r?.name) continue
      const gid = r.game_id != null ? gameIds.get(r.game_id) : undefined
      // Every library game needs a row, so a game the Library question adds brings its own
      // even when the Game List question got a No.
      if (!wantList && !(gid != null && madeHere.has(gid))) continue
      const mine = (gid != null && rowsByGame.get(gid)) || rows.find(r)
      if (mine) {
        for (const f of ['steam_app_id', 'banner_url', 'rating', 'genres', 'release_date', 'planned_month']) {
          if (isEmpty(mine[f]) && !isEmpty(r[f])) setRow(mine, f, r[f])
        }
        if (mine.price_target_cents == null && r.price_target_cents != null) {
          for (const f of ['price_target_cents', 'price_target_cc', 'price_target_hit']) setRow(mine, f, r[f] ?? null)
        }
        if (!mine.is_favorite && r.is_favorite) setRow(mine, 'is_favorite', 1)
        if (mine.game_id == null && (gid ?? games.find(r)?.id) != null) {
          setRow(mine, 'game_id', gid ?? games.find(r).id)
          rowsByGame.set(mine.game_id, mine)
        }
        if (wantList) touchedRows.add(mine.id)
      } else {
        const row = {
          ...r, id: temp(), game_id: gid ?? games.find(r)?.id ?? null,
          category_id: null, status: r.status || 'want_to_play', display_order: ++order,
        }
        addRow(row)
        plan.newList.push(row)
        if (wantList) { touchedRows.add(row.id); plan.counts.list.fresh++ }
      }
    }
  }

  plan.counts.list.total = touchedRows.size
  plan.counts.library.total = shownGames.size
  plan.counts.library.fresh = shownFresh.size
  return plan
}

// Pure: does this plan change anything at all?
function planIsEmpty(plan) {
  return !plan.newGames.length && !plan.gameChanges.size && !plan.newSessions.length && !plan.newAchievements.length
    && !plan.newUnlocks.length && !plan.unlockChanges.length && !plan.newList.length && !plan.listChanges.size
}

function readLocal(db) {
  return {
    games: db.prepare('SELECT * FROM games').all(),
    sessions: db.prepare('SELECT id, game_id, started_at FROM sessions').all(),
    achievements: db.prepare('SELECT id, game_id, steam_api_name FROM achievements').all(),
    achievement_unlocks: db.prepare('SELECT id, achievement_id, session_id, unlocked_at FROM achievement_unlocks').all(),
    game_list: db.prepare('SELECT * FROM game_list').all(),
  }
}

// Writes a plan in one transaction: all of it or none of it.
function applyPlan(db, plan) {
  const ids = new Map()
  const real = (id) => (id != null && id < 0 ? ids.get(id) : id)
  const columns = new Map()
  const colsOf = (table) => {
    if (!columns.has(table)) columns.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)))
    return columns.get(table)
  }
  const insert = (table, row) => {
    const keys = Object.keys(row).filter(k => k !== 'id' && colsOf(table).has(k))
    return db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(keys.map(k => row[k] ?? null)).lastInsertRowid
  }
  const update = (table, id, fields) => {
    const keys = Object.keys(fields).filter(k => colsOf(table).has(k))
    if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => fields[k] ?? null), id)
  }
  const newGameIds = []
  db.transaction(() => {
    for (const g of plan.newGames) { const id = Number(insert('games', g)); ids.set(g.id, id); newGameIds.push(id) }
    for (const [id, fields] of plan.gameChanges) update('games', id, fields)
    for (const s of plan.newSessions) ids.set(s.id, Number(insert('sessions', { ...s, game_id: real(s.game_id) })))
    for (const a of plan.newAchievements) ids.set(a.id, Number(insert('achievements', { ...a, game_id: real(a.game_id) })))
    for (const u of plan.newUnlocks) insert('achievement_unlocks', { ...u, achievement_id: real(u.achievement_id), session_id: real(u.session_id) })
    for (const c of plan.unlockChanges) db.prepare('UPDATE achievement_unlocks SET unlocked_at = ?, session_id = ? WHERE id = ?').run(c.unlocked_at, real(c.session_id) ?? null, c.id)
    for (const r of plan.newList) insert('game_list', { ...r, game_id: real(r.game_id) })
    for (const [id, fields] of plan.listChanges) update('game_list', id, { ...fields, ...('game_id' in fields ? { game_id: real(fields.game_id) } : {}) })
    // A new game whose backup had no list row for it (every library game needs one).
    const q = require('../db/queries/gameList')
    for (const id of newGameIds) q.ensureListRowForGame(db.prepare('SELECT * FROM games WHERE id = ?').get(id))
  })()
  return newGameIds
}

// Add `backups` to this PC. Earned long ago on another PC: no level-up toast, and the next
// session's "+XP" counts only that session.
function merge(backups, choices) {
  const db = require('../db/database').getDb()
  const plan = planMerge(backups, readLocal(db), { ...choices, exists: fs.existsSync })
  const newGameIds = planIsEmpty(plan) ? [] : applyPlan(db, plan)
  try { require('./xpTracker').rebase() } catch {}
  try { require('./autoBackup').markDirty() } catch {}
  return { ...plan.counts, newGameIds }
}

// What each question can offer, without writing anything.
function counts(backups) {
  const db = require('../db/database').getDb()
  return planMerge(backups, readLocal(db), { list: true, library: true, exists: fs.existsSync }).counts
}

function isEmptyHere() {
  const db = require('../db/database').getDb()
  return db.prepare('SELECT COUNT(*) c FROM games').get().c === 0 && db.prepare('SELECT COUNT(*) c FROM game_list').get().c === 0
}

// Pure: game name (as a backup folder has it) -> this PC's game id, or null. The backups
// know its Steam id, so another spelling of the name still finds it.
function gameResolver(backups, localGames) {
  const games = makeIndex()
  for (const g of localGames || []) games.add(g)
  const theirs = new Map()
  for (const b of backups || []) for (const g of b.games || []) theirs.set(nameKey(g.name), g)
  return (name) => (games.find(theirs.get(nameKey(name)) || { name })?.id ?? null)
}

// Pure: a count that grew is news. `seen` also comes down when a count does, so what's added
// later counts as new even after a big yes.
const NEWS_KEYS = ['list', 'games', 'sessions', 'unlocks', 'saves']
function newsSince(now, seen) {
  const before = seen || {}
  const next = {}
  let isNew = false
  for (const k of NEWS_KEYS) {
    const n = now?.[k] || 0, b = before[k] || 0
    if (n > b) isNew = true
    next[k] = Math.min(n, b)
  }
  return { isNew, seen: next }
}

module.exports = {
  newsSince, nameKey, planMerge, planIsEmpty, readLocal, applyPlan, merge, counts, isEmptyHere, gameResolver }
