'use strict'

// Steam accounts on this PC, and whose achievements count.
//
// KoZo used to know one account (setting steam_user_id) and read achievements only for it.
// The maker plays on several: an own account and shared ones signed into the same Steam app.
// A game played on another account showed no achievements ("Profile is not public"), and when
// a shared account was connected, everything other people had unlocked on it became the
// maker's (88 unlocks, some earned months before KoZo's first session).
//
// Now every account on the PC is read from Steam's own files (appcache\stats, no network, no
// privacy setting in the way), and each account has a mode:
//   mine    every unlock counts, also ones from other PCs.
//   shared  only unlocks that happened while KoZo saw that game being played here: inside one
//           of its sessions (2 minutes before the start to 5 minutes after the end).
// Without a choice by the user: the connected account is 'mine' when the user picked it or it is
// the only account on the PC; everything else is 'shared', the safe side: shared never brings in
// someone else's unlocks.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const STEAMID64_BASE = 76561197960265728n
const PRE_MS = 2 * 60 * 1000
const POST_MS = 5 * 60 * 1000

// ── Pure ─────────────────────────────────────────────────────────────────────

function accountIdOf(steamId) {
  const raw = String(steamId ?? '').trim()
  if (!/^\d{17}$/.test(raw)) return null
  const id = BigInt(raw)
  return id > STEAMID64_BASE ? (id - STEAMID64_BASE).toString() : null
}

function steamIdOf(accountId) {
  const raw = String(accountId ?? '').trim()
  if (!/^\d+$/.test(raw) || raw === '0') return null
  return (BigInt(raw) + STEAMID64_BASE).toString()
}

// Steam's config\loginusers.vdf. Key names come in any case ("Timestamp" and "timestamp" were
// both seen), and "MostRecent" is not always there.
function parseLoginUsers(text) {
  const users = []
  for (const m of String(text || '').matchAll(/"(7656\d{13})"\s*\{([^}]*)\}/g)) {
    const body = m[2]
    const get = (k) => body.match(new RegExp(`"${k}"\\s*"([^"]*)"`, 'i'))?.[1] || ''
    users.push({
      steamId: m[1],
      accountName: get('AccountName'),
      persona: get('PersonaName'),
      timestamp: parseInt(get('Timestamp') || '0', 10) || 0,
      mostRecent: get('MostRecent') === '1',
    })
  }
  return users
}

function effectiveMode(steamId, { modes = {}, connectedId = '', confirmed = false, accountCount = 1 } = {}) {
  const explicit = modes?.[steamId]
  if (explicit === 'mine' || explicit === 'shared') return explicit
  if (steamId && steamId === connectedId && (confirmed || accountCount <= 1)) return 'mine'
  return 'shared'
}

// A game's sessions as time windows. An open session runs until now.
function sessionWindows(rows, { pre = PRE_MS, post = POST_MS, now = Date.now() } = {}) {
  const out = []
  for (const r of rows || []) {
    const a = Date.parse(r.started_at)
    if (!Number.isFinite(a)) continue
    const end = r.ended_at ? Date.parse(r.ended_at) : now
    out.push({ id: r.id, a: a - pre, b: (Number.isFinite(end) ? end : now) + post })
  }
  return out.sort((x, y) => x.a - y.a)
}

// The session a moment falls in (the latest one that started before it), or null.
function windowAt(windows, ms) {
  let hit = null
  for (const w of windows || []) if (ms >= w.a && ms <= w.b) hit = w.id
  return hit
}

// What of an account's unlocks count. entries: Map<api name, unix seconds or 0>.
// mine: everything. shared: only dated unlocks inside a session of that game.
function countedUnlocks(entries, mode, windows) {
  const out = []
  for (const [name, t] of entries || []) {
    const sessionId = t > 0 ? windowAt(windows, t * 1000) : null
    if (mode !== 'mine' && sessionId == null) continue
    out.push({ name, t: t > 0 ? t : 0, sessionId })
  }
  return out
}

// Stored unlocks that are someone else's: no account of yours has it, a shared account's file
// has it at that very second, and that second is outside every session of the game.
// stored: [{ id, name, unlocked_at }], files: [{ mode, entries: Map }].
function foreignRows(stored, files, windows) {
  const mine = files.filter(f => f.mode === 'mine')
  const shared = files.filter(f => f.mode !== 'mine')
  const out = []
  for (const row of stored || []) {
    const name = String(row.name || '').toLowerCase()
    const ms = Date.parse(row.unlocked_at)
    if (!name || !Number.isFinite(ms)) continue
    if (mine.some(f => f.entries.has(name))) continue
    const sec = Math.round(ms / 1000)
    if (!shared.some(f => f.entries.get(name) === sec)) continue
    if (windowAt(windows, ms) != null) continue
    out.push(row)
  }
  return out
}

// Steam's Library page cache for one account and game (userdata\<account>\config\librarycache\
// <appid>.json, an array of [key, { version, data }]): its achievements panel, written by Steam
// itself. On a rented account in Offline Mode it was rewritten after a session while the stats
// file had not changed for three days (Phantom Blade Zero), so it is read beside the stats file.
// lowercase api name -> unlock seconds (0 = no time), or null when it can't be read.
function libraryCacheUnlocks(text) {
  let list
  try { list = JSON.parse(String(text || '')) } catch { return null }
  if (!Array.isArray(list)) return null
  const data = list.find(e => Array.isArray(e) && e[0] === 'achievements')?.[1]?.data
  if (!data || typeof data !== 'object') return null
  const out = new Map()
  for (const key of ['vecHighlight', 'vecUnachieved', 'vecAchievedHidden']) {
    for (const a of Array.isArray(data[key]) ? data[key] : []) {
      if (!a?.bAchieved || !a.strID) continue
      const t = Number(a.rtUnlocked) > 0 ? Math.floor(Number(a.rtUnlocked)) : 0
      const name = String(a.strID).toLowerCase()
      const cur = out.get(name)
      if (cur == null || (t > 0 && (cur === 0 || t < cur))) out.set(name, t)
    }
  }
  return out
}

// Two sources for one account: every name, the earliest time (0 = no time). null when neither.
function mergeEntries(a, b) {
  if (!a) return b || null
  if (!b) return a
  const out = new Map(a)
  for (const [k, t] of b) {
    const cur = out.get(k)
    if (cur == null || (t > 0 && (cur === 0 || t < cur))) out.set(k, t)
  }
  return out
}

// Achievements a shared account has that you don't, unlocked outside every session of the game
// here: someone else on that account got there first, and Steam keeps one unlock per account, so
// it never showed them to you (Phantom Blade Zero: 59 of 66 were unlocked by another renter before
// the maker got there). files: [{ mode, steamId, persona, entries }], mine: Set of lowercase names
// already yours. Unlocks inside a session are yours and are imported, so they're left out here.
function othersUnlocks(files, windows, mine) {
  const out = new Map()
  for (const f of files || []) {
    if (f.mode === 'mine') continue
    for (const [name, t] of f.entries || []) {
      if (mine?.has(name)) continue
      if (t > 0 && windowAt(windows, t * 1000) != null) continue
      const cur = out.get(name)
      if (!cur || (t > 0 && (cur.t === 0 || t < cur.t))) out.set(name, { name, t, steamId: f.steamId, persona: f.persona || '' })
    }
  }
  return [...out.values()]
}

// Dated unlocks filed under a session they did not happen in: [{ id, session_id: right one or null }].
function misfiledRows(rows, windows) {
  const out = []
  for (const r of rows || []) {
    const ms = Date.parse(r.unlocked_at)
    if (r.session_id == null || !Number.isFinite(ms)) continue
    const right = windowAt(windows, ms)
    const own = (windows || []).find(w => w.id === r.session_id)
    if (own && ms >= own.a && ms <= own.b) continue
    out.push({ id: r.id, session_id: right })
  }
  return out
}

// ── This PC ──────────────────────────────────────────────────────────────────

const settingsQ = () => require('../db/queries/settings')
const steamPath = () => { try { return require('./steamStatsWatcher').getSteamPath() } catch { return null } }

function getModes() {
  try { return JSON.parse(settingsQ().getSetting('steam_accounts') || '{}') || {} } catch { return {} }
}
function connectedId() { return String(settingsQ().getSetting('steam_user_id') || '').trim() }
function isConfirmed() { return settingsQ().getSetting('steam_user_confirmed') === '1' }

// Account ids known on this PC: signed in before (loginusers.vdf), a userdata folder, or a
// stats file. Kept a minute; small directory listings.
let _known = null, _knownAt = 0
function knownAccounts() {
  if (_known && Date.now() - _knownAt < 60_000) return _known
  const steam = steamPath()
  const byId = new Map()   // account id -> { accountId, steamId, accountName, persona, lastLogin, statsGames }
  const add = (accountId, more = {}) => {
    if (!accountId || accountId === '0') return
    const cur = byId.get(accountId) || { accountId, steamId: steamIdOf(accountId), accountName: '', persona: '', lastLogin: 0, statsGames: 0 }
    byId.set(accountId, { ...cur, ...more })
  }
  if (steam) {
    try {
      for (const u of parseLoginUsers(fs.readFileSync(path.join(steam, 'config', 'loginusers.vdf'), 'utf8'))) {
        add(accountIdOf(u.steamId), { accountName: u.accountName, persona: u.persona, lastLogin: u.timestamp, mostRecent: u.mostRecent })
      }
    } catch {}
    try {
      for (const d of fs.readdirSync(path.join(steam, 'userdata'), { withFileTypes: true })) {
        if (d.isDirectory() && /^\d+$/.test(d.name)) add(d.name)
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(path.join(steam, 'appcache', 'stats'))) {
        const m = /^UserGameStats_(\d+)_\d+\.bin$/i.exec(f)
        if (!m) continue
        add(m[1])
        byId.get(m[1]).statsGames++
      }
    } catch {}
  }
  _known = [...byId.values()]
  _knownAt = Date.now()
  return _known
}
function forget() { _known = null }

function modeOf(steamId, count = knownAccounts().length) {
  return effectiveMode(steamId, { modes: getModes(), connectedId: connectedId(), confirmed: isConfirmed(), accountCount: count })
}

// Every account's stats file for one game (the file may not exist yet).
function accountsForApp(appid) {
  const steam = steamPath()
  if (!steam || !appid) return []
  const known = knownAccounts()
  const list = known.map(a => a.accountId)
  // The connected account even when Steam's files don't name it (a hand-typed id).
  const own = accountIdOf(connectedId())
  if (own && !list.includes(own)) list.push(own)
  const dir = path.join(steam, 'appcache', 'stats')
  return list.map(accountId => {
    const steamId = steamIdOf(accountId)
    return {
      accountId, steamId, mode: modeOf(steamId, Math.max(known.length, list.length)),
      persona: known.find(k => k.accountId === accountId)?.persona || '',
      statsFile: path.join(dir, `UserGameStats_${accountId}_${appid}.bin`),
      libraryFile: path.join(steam, 'userdata', accountId, 'config', 'librarycache', `${appid}.json`),
    }
  })
}

// A name for an account Steam's sign-in list doesn't have: its own settings file says it.
async function personaFromUserdata(steam, accountId) {
  try {
    const raw = await fs.promises.readFile(path.join(steam, 'userdata', accountId, 'config', 'localconfig.vdf'), 'utf8')
    return raw.match(/"PersonaName"\s*"([^"]*)"/i)?.[1] || ''
  } catch { return '' }
}

// The account signed into Steam right now (registry), asked without blocking. '' when unknown.
function activeAccountId() {
  return new Promise((resolve) => {
    if (process.env.KOZO_STEAM_PATH != null) return resolve('')
    try {
      require('child_process').execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess', '/v', 'ActiveUser'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, out) => {
          const m = !err && /ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(out || ''))
          const n = m ? parseInt(m[1], 16) : 0
          resolve(n ? String(n) : '')
        })
    } catch { resolve('') }
  })
}

// For Settings > Connections > Steam accounts.
async function listAccounts() {
  forget()
  const steam = steamPath()
  const known = knownAccounts()
  const active = await activeAccountId()
  const own = connectedId()
  const accounts = []
  for (const a of known) {
    let persona = a.persona
    if (!persona && steam) persona = await personaFromUserdata(steam, a.accountId)
    accounts.push({
      steamId: a.steamId, accountId: a.accountId, accountName: a.accountName, persona,
      lastLogin: a.lastLogin, statsGames: a.statsGames,
      signedInNow: !!active && active === a.accountId,
      connected: a.steamId === own,
      mode: modeOf(a.steamId, known.length),
    })
  }
  accounts.sort((x, y) => (y.connected - x.connected) || (y.lastLogin - x.lastLogin) || (y.statsGames - x.statsGames))
  return { accounts, connected: own, confirmed: isConfirmed(), foreign: readForeign() }
}

function broadcast(channel, payload) {
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  } catch {}
}

// Everything that depends on which account is whose, after a change: forget old sync errors,
// read the files again (quietly: a backlog must not toast or level up), look for foreign rows.
function afterChange() {
  forget()
  try { require('./achievementSync').resetAccountState() } catch {}
  try { require('./steamStatsWatcher').rewatchActive?.() } catch {}
  const run = async () => {
    try { await require('./achievementSync').revalidateProfilePrivacy() } catch {}
    try {
      const r = await require('./steamStatsWatcher').scanAllSteamGames({ quiet: true })
      if (r?.totalAdded) { try { require('./xpTracker').rebase() } catch {} }
    } catch {}
    try { findForeign() } catch {}
    broadcast('steam:accounts-changed', null)
    broadcast('game:updated', null)
  }
  try { require('./processWatcher').runWhenIdle('steamAccounts', () => { run().catch(() => {}) }) } catch { run().catch(() => {}) }
  broadcast('steam:accounts-changed', null)
}

// "This one is mine": the account KoZo is connected to (profile, wishlist, For you) and counts fully.
function useAccount(steamId, { persona } = {}) {
  const id = String(steamId || '').trim()
  if (!accountIdOf(id)) throw new Error('That is not a Steam account id.')
  const s = settingsQ()
  const changed = s.getSetting('steam_user_id') !== id
  s.setSetting('steam_user_id', id)
  s.setSetting('steam_user_confirmed', '1')
  const name = persona || knownAccounts().find(a => a.steamId === id)?.persona || ''
  if (name || changed) s.setSetting('steam_persona', name)
  const modes = getModes()
  if (modes[id] !== 'mine') { modes[id] = 'mine'; s.setSetting('steam_accounts', JSON.stringify(modes)) }
  logger.info(`steamAccounts: using ${name || id} as the user's own account`)
  afterChange()
  return { steamId: id, persona: name }
}

function setMode(steamId, mode) {
  const id = String(steamId || '').trim()
  if (!accountIdOf(id) || (mode !== 'mine' && mode !== 'shared')) throw new Error('Unknown account or mode.')
  const modes = getModes()
  modes[id] = mode
  settingsQ().setSetting('steam_accounts', JSON.stringify(modes))
  logger.info(`steamAccounts: ${id} counts as ${mode}`)
  afterChange()
  return { steamId: id, mode }
}

// ── Unlocks that came from other people ──────────────────────────────────────

function readForeign() {
  try { return JSON.parse(settingsQ().getSetting('steam_foreign_found') || 'null') || { total: 0, games: [] } } catch { return { total: 0, games: [] } }
}

// name (lowercase) -> seconds, for one stats file. null when it can't be read.
function readEntries(statsFile, schemaFile) {
  try {
    const { parseBinaryKV, unlockedWithTimes } = require('./binaryKV')
    const stats = parseBinaryKV(fs.readFileSync(statsFile))
    const schema = parseBinaryKV(fs.readFileSync(schemaFile))
    if (!stats || !schema) return null
    const set = unlockedWithTimes(schema, stats)
    if (!set) return null
    const out = new Map()
    for (const [name, t] of set) out.set(String(name).toLowerCase(), t)
    return out
  } catch { return null }
}

function readLibraryCache(file) {
  try { return libraryCacheUnlocks(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// Everything Steam on this PC says one account has unlocked in a game: its stats file and its
// Library cache together. lowercase name -> seconds, or null when neither can be read.
function accountEntries(account, schemaFile) {
  return mergeEntries(readEntries(account.statsFile, schemaFile), account.libraryFile ? readLibraryCache(account.libraryFile) : null)
}

function gameFiles(appid) {
  const steam = steamPath()
  if (!steam) return []
  const schemaFile = path.join(steam, 'appcache', 'stats', `UserGameStatsSchema_${appid}.bin`)
  const out = []
  for (const a of accountsForApp(appid)) {
    const entries = accountEntries(a, schemaFile)
    if (entries) out.push({ ...a, entries })
  }
  return out
}

// The game page's Achievements tab: what someone else unlocked on a shared account this game was
// played on, for the "I did these too" choice. [{ achievementId, persona, unlockedAt }]
function othersOnAccount(gameId) {
  const db = require('../db/database').getDb()
  const g = db.prepare('SELECT id, steam_app_id, is_cracked FROM games WHERE id = ?').get(Number(gameId))
  if (!g?.steam_app_id || g.is_cracked === 1) return []
  const files = gameFiles(g.steam_app_id).filter(f => f.mode !== 'mine')
  if (!files.length) return []
  const achs = db.prepare(`SELECT a.id, a.steam_api_name,
      (SELECT au.id FROM achievement_unlocks au WHERE au.achievement_id = a.id LIMIT 1) AS unlock_id
    FROM achievements a WHERE a.game_id = ?`).all(g.id)
  const byName = new Map()
  const mine = new Set()
  for (const a of achs) {
    if (!a.steam_api_name) continue
    const k = String(a.steam_api_name).toLowerCase()
    byName.set(k, a)
    if (a.unlock_id != null) mine.add(k)
  }
  const windows = sessionWindows(db.prepare('SELECT id, started_at, ended_at FROM sessions WHERE game_id = ?').all(g.id))
  const out = []
  for (const o of othersUnlocks(files, windows, mine)) {
    const a = byName.get(o.name)
    if (!a || a.unlock_id != null) continue
    out.push({ achievementId: a.id, persona: o.persona, unlockedAt: o.t > 0 ? new Date(o.t * 1000).toISOString() : null })
  }
  return out
}

// How far along each counted achievement is ("Kill 50 enemies": 31 / 50), from Steam's files on
// this PC: the schema says which stat each one counts, the account's stats file holds the value.
// Your own account first, else the shared one the game was played on last (its numbers are the
// account's, so they say whose). [{ achievementId, cur, max, persona }]. Steam games only: an
// emulator keeps no such schema (Dead Space's saves nothing at all).
function progressFor(gameId) {
  const db = require('../db/database').getDb()
  const g = db.prepare('SELECT id, steam_app_id, is_cracked, source FROM games WHERE id = ?').get(gameId)
  if (!g?.steam_app_id || g.is_cracked === 1) return []
  try { if (require('./achievementSync').isForeignLauncher(g)) return [] } catch {}
  const steam = steamPath()
  if (!steam) return []
  const { parseBinaryKV, achievementProgress } = require('./binaryKV')
  let schema
  try { schema = parseBinaryKV(fs.readFileSync(path.join(steam, 'appcache', 'stats', `UserGameStatsSchema_${g.steam_app_id}.bin`))) } catch { return [] }
  const accs = accountsForApp(g.steam_app_id)
    .map(a => { try { return { ...a, mtime: fs.statSync(a.statsFile).mtimeMs } } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => (b.mode === 'mine') - (a.mode === 'mine') || b.mtime - a.mtime)
  for (const acc of accs) {
    let stats
    try { stats = parseBinaryKV(fs.readFileSync(acc.statsFile)) } catch { continue }
    const prog = achievementProgress(schema, stats)
    if (!prog.size) return []
    const out = []
    for (const r of db.prepare('SELECT id, steam_api_name FROM achievements WHERE game_id = ?').all(g.id)) {
      const p = prog.get(String(r.steam_api_name || '').toLowerCase())
      if (p) out.push({ achievementId: r.id, cur: p.cur, max: p.max, persona: acc.mode === 'mine' ? null : (acc.persona || 'a shared account') })
    }
    return out
  }
  return []
}

// Look through the stored Steam unlocks for ones other people earned on a shared account.
// Nothing is removed here: the answer goes to the Steam accounts window, which asks.
function findForeign() {
  const db = require('../db/database').getDb()
  const games = db.prepare(`
    SELECT g.id, g.name, g.steam_app_id FROM games g
    WHERE g.steam_app_id IS NOT NULL AND IFNULL(g.is_cracked,0) != 1
      AND EXISTS (SELECT 1 FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
                  WHERE a.game_id = g.id AND au.source IN ('steam_stats','steam_api'))`).all()
  const found = { total: 0, games: [], rows: [] }
  for (const g of games) {
    const files = gameFiles(g.steam_app_id)
    if (!files.some(f => f.mode !== 'mine')) continue
    const stored = db.prepare(`
      SELECT au.id, au.achievement_id, au.session_id, au.unlocked_at, au.source, a.steam_api_name AS name
      FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
      WHERE a.game_id = ? AND au.source IN ('steam_stats','steam_api')`).all(g.id)
    const windows = sessionWindows(db.prepare('SELECT id, started_at, ended_at FROM sessions WHERE game_id = ?').all(g.id))
    const rows = foreignRows(stored, files, windows)
    if (!rows.length) continue
    found.total += rows.length
    found.games.push({ id: g.id, name: g.name, n: rows.length })
    found.rows.push(...rows.map(r => ({ id: r.id, achievement_id: r.achievement_id, session_id: r.session_id, unlocked_at: r.unlocked_at, source: r.source })))
  }
  const summary = { total: found.total, games: found.games }
  try {
    const s = settingsQ()
    const next = JSON.stringify(summary)
    if ((s.getSetting('steam_foreign_found') || '') !== next) s.setSetting('steam_foreign_found', next)
  } catch {}
  return found
}

function recountSessions(db, sessionIds) {
  const upd = db.prepare('UPDATE sessions SET achievements_unlocked = (SELECT COUNT(*) FROM achievement_unlocks WHERE session_id = sessions.id) WHERE id = ?')
  for (const id of new Set(sessionIds.filter(x => x != null))) upd.run(id)
}

// Remove them (the user pressed Remove). Returns the rows, so Undo can put them back.
function removeForeign() {
  const db = require('../db/database').getDb()
  const { rows } = findForeign()
  if (!rows.length) return { removed: 0, rows: [] }
  db.transaction(() => {
    const del = db.prepare('DELETE FROM achievement_unlocks WHERE id = ?')
    for (const r of rows) del.run(r.id)
    recountSessions(db, rows.map(r => r.session_id))
  })()
  settingsQ().setSetting('steam_foreign_found', JSON.stringify({ total: 0, games: [] }))
  try { require('./xpTracker').rebase() } catch {}
  try { require('./autoBackup').markDirty() } catch {}
  logger.info(`steamAccounts: removed ${rows.length} unlock(s) other people earned on shared accounts`)
  broadcast('game:updated', null)
  broadcast('steam:accounts-changed', null)
  return { removed: rows.length, rows }
}

function restoreUnlocks(rows) {
  const db = require('../db/database').getDb()
  let restored = 0
  db.transaction(() => {
    const ins = db.prepare('INSERT OR IGNORE INTO achievement_unlocks (achievement_id, session_id, unlocked_at, source) VALUES (?, ?, ?, ?)')
    const hasSession = db.prepare('SELECT 1 FROM sessions WHERE id = ?')
    const hasAch = db.prepare('SELECT 1 FROM achievements WHERE id = ?')
    for (const r of rows || []) {
      if (!hasAch.get(r.achievement_id)) continue
      const sid = r.session_id != null && hasSession.get(r.session_id) ? r.session_id : null
      restored += ins.run(r.achievement_id, sid, r.unlocked_at ?? null, r.source || 'steam_stats').changes
    }
    recountSessions(db, (rows || []).map(r => r.session_id))
  })()
  try { require('./xpTracker').rebase() } catch {}
  try { require('./autoBackup').markDirty() } catch {}
  try { findForeign() } catch {}
  broadcast('game:updated', null)
  broadcast('steam:accounts-changed', null)
  return { restored }
}

// At an idle start. Once: unlocks filed under a session they didn't happen in go to the right
// one (a backlog read at a session's start was all filed under that session: one session showed
// 59 unlocks). Every time: look for other people's unlocks, for the accounts window to offer.
function reviewStored() {
  const db = require('../db/database').getDb()
  const s = settingsQ()
  if (s.getSetting('unlock_session_fix_v1') !== '1') {
    try {
      const games = db.prepare(`SELECT DISTINCT a.game_id AS id FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
        WHERE au.session_id IS NOT NULL AND au.unlocked_at IS NOT NULL AND au.source IN ('steam_stats','steam_api')`).all()
      let moved = 0
      const touched = []
      db.transaction(() => {
        const set = db.prepare('UPDATE achievement_unlocks SET session_id = ? WHERE id = ?')
        for (const g of games) {
          const rows = db.prepare(`SELECT au.id, au.session_id, au.unlocked_at FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id
            WHERE a.game_id = ? AND au.session_id IS NOT NULL AND au.unlocked_at IS NOT NULL AND au.source IN ('steam_stats','steam_api')`).all(g.id)
          const windows = sessionWindows(db.prepare('SELECT id, started_at, ended_at FROM sessions WHERE game_id = ?').all(g.id))
          const byId = new Map(rows.map(r => [r.id, r.session_id]))
          for (const fix of misfiledRows(rows, windows)) {
            touched.push(byId.get(fix.id), fix.session_id)
            set.run(fix.session_id, fix.id)
            moved++
          }
        }
        recountSessions(db, touched)
      })()
      if (moved) logger.info(`steamAccounts: ${moved} unlock(s) moved to the session they happened in`)
      s.setSetting('unlock_session_fix_v1', '1')
      if (moved) { try { require('./autoBackup').markDirty() } catch {} }
    } catch (e) { logger.warn('steamAccounts: session fix failed', { message: e.message }) }
  }
  try { return findForeign() } catch (e) { logger.warn('steamAccounts: review failed', { message: e.message }); return null }
}

module.exports = {
  // pure
  accountIdOf, steamIdOf, parseLoginUsers, effectiveMode, sessionWindows, windowAt, countedUnlocks, foreignRows, misfiledRows,
  libraryCacheUnlocks, mergeEntries, othersUnlocks,
  PRE_MS, POST_MS,
  // this PC
  knownAccounts, accountsForApp, modeOf, connectedId, isConfirmed, listAccounts, forget,
  useAccount, setMode, findForeign, removeForeign, restoreUnlocks, reviewStored, readForeign,
  accountEntries, othersOnAccount, progressFor,
}
