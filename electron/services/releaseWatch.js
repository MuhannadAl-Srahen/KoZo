'use strict'

// Watches the Game List's tracked upcoming games and tells the user:
//   - the day before an exact release date ("out tomorrow", from 10:00 local),
//   - when a tracked game gets a real date, is delayed or moves up (the 6-hourly store
//     refresh compares the old and new date, pure dateChange),
//   - the moment the release date passes ("out now", once per game, release_notified),
//     plus the `unseen_releases` list behind the "Now out" panel and the Upcoming badge.
// The news goes through services/notifications.js: a Windows notification with no game
// running, the overlay toast during one. It used to be the overlay toast only, which with
// no game running showed for 10 seconds in a corner and was gone, so the maker never saw
// one. Checked at startup, every 30 minutes, at local midnight and when the window is
// shown (DB only), with the store dates refreshed every 6 hours when no game runs.

const logger = require('../logger')

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const QUICK_EVERY_MS = 30 * 60 * 1000
const REMIND_FROM_HOUR = 10
let _timer = null
let _quickTimer = null
let _midnightTimer = null

// Only PRECISE dates count — a year-only "2026" must not fire mid-year.
// Vague Steam dates ("2026", "June 2026") must never count as released — the
// notification fires once and sets release_notified, so a false positive on the
// 1st of the month is unrecoverable.
function releasedTs(str) {
  if (!str) return null
  const trimmed = str.trim()
  if (/^\d{4}$/.test(trimmed)) return null
  if (/^[A-Za-z]{3,9},?\s+\d{4}$/.test(trimmed)) return null
  const t = Date.parse(trimmed)
  return Number.isFinite(t) ? t : null
}

// Pure: a store date as a span of local time. An exact day is that day; "June 2027" the month;
// "Q1 2027" the quarter; "2027", "Winter 2026", "Early 2027" the year; anything else
// ("Coming soon", "To be announced") null.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function dateSpan(str) {
  if (!str) return null
  const t = String(str).trim()
  const span = (a, b, exact = false) => ({ start: a.getTime(), end: b.getTime() - 1, exact })
  let m = /^(\d{4})$/.exec(t)
  if (m) return span(new Date(+m[1], 0, 1), new Date(+m[1] + 1, 0, 1))
  m = /^Q([1-4])\s+(\d{4})$/i.exec(t)
  if (m) { const q = (+m[1] - 1) * 3; return span(new Date(+m[2], q, 1), new Date(+m[2], q + 3, 1)) }
  m = /^([A-Za-z]{3,9}),?\s+(\d{4})$/.exec(t)
  if (m) {
    const i = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    const y = +m[2]
    return i >= 0 ? span(new Date(y, i, 1), new Date(y, i + 1, 1)) : span(new Date(y, 0, 1), new Date(y + 1, 0, 1))
  }
  const ts = releasedTs(t)
  if (ts == null) return null
  const d = new Date(ts)
  return span(new Date(d.getFullYear(), d.getMonth(), d.getDate()), new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), true)
}

// Pure: what a store date change means. null = nothing worth saying (the same date written
// another way, or a vague date narrowed inside itself like "2027" to "Q2 2027").
//   announced: a real day where there was none; delayed / earlier: moved; removed: a real day
//   gone ("Coming soon" again).
function dateChange(oldStr, newStr) {
  const a0 = String(oldStr || '').trim(), b0 = String(newStr || '').trim()
  if (!a0 || a0 === b0) return null
  const a = dateSpan(a0), b = dateSpan(b0)
  if (!b) return a?.exact ? 'removed' : null
  if (b.exact && !a?.exact) return 'announced'
  if (!a) return null
  if (b.start > a.end) return 'delayed'
  if (b.end < a.start) return 'earlier'
  return null
}

// Pure: tracked games coming out tomorrow (an exact local day), not reminded yet, once it is
// REMIND_FROM_HOUR or later (no one wants it at midnight).
function dueReminders(rows, now = Date.now()) {
  const d = new Date(now)
  if (d.getHours() < REMIND_FROM_HOUR) return []
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  return (rows || []).filter(r => {
    if (r.release_reminded) return false
    const sp = dateSpan(r.release_date)
    return !!sp?.exact && sp.start === tomorrow
  })
}

// A game released more than two weeks ago is old news: setting an already
// released game to Upcoming (or tracking it late) must never announce it as
// "Now out". Such rows are quietly unwatched instead.
const FRESH_MS = 14 * 24 * 60 * 60 * 1000
function isLongReleased(str) {
  const ts = releasedTs(str)
  return ts != null && ts < Date.now() - FRESH_MS
}

// Released games the user hasn't acknowledged in the app yet — shown as the
// "Now out" panel and the Upcoming badge, so a release that happened while
// KoZo (or the overlay) wasn't visible is never missed.
function getUnseen() {
  try {
    const raw = require('../db/queries/settings').getSetting('unseen_releases')
    const list = JSON.parse(raw || '[]')
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

function setUnseen(list) {
  try { require('../db/queries/settings').setSetting('unseen_releases', JSON.stringify(list)) } catch {}
  broadcastAll('releases:changed', list)
}

function dismiss(ids) {
  const drop = ids === 'all' ? null : new Set((Array.isArray(ids) ? ids : [ids]).map(Number))
  setUnseen(drop ? getUnseen().filter(r => !drop.has(r.id)) : [])
}

function broadcastAll(channel, payload) {
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  } catch {}
}

// Steam moves release dates (delays, or a vague "2027" becoming a real day).
// Re-read the store date for every tracked upcoming game so a delayed game
// can't fire early and a newly dated one starts counting down.
let _refreshing = false
async function refreshUpcomingDates() {
  if (_refreshing) return { skipped: true }
  _refreshing = true
  try {
    const { getStoreDetails } = require('./steamApi')
    const gameListQ = require('../db/queries/gameList')
    const db = require('../db/database').getDb()
    const rows = db.prepare(`SELECT id, name, steam_app_id, release_date, genres, banner_url, game_id,
      release_notified FROM game_list WHERE release_watch = 1 AND steam_app_id IS NOT NULL`).all()
    let changed = 0
    const moved = []
    for (const row of rows) {
      const d = await getStoreDetails(row.steam_app_id).catch(() => null)
      if (d) {
        if (d.release_date && d.release_date !== row.release_date) {
          gameListQ.updateGameListItem(row.id, { release_date: d.release_date })
          // A new date gets its own "out tomorrow".
          try { db.prepare('UPDATE game_list SET release_reminded = 0 WHERE id = ?').run(row.id) } catch {}
          changed++
          const kind = row.release_notified ? null : dateChange(row.release_date, d.release_date)
          if (kind) moved.push({ ...row, kind, old: row.release_date, release_date: d.release_date })
        }
        if ((!row.genres || row.genres === '[]') && d.genres?.length) {
          gameListQ.updateGameListItem(row.id, { genres: JSON.stringify(d.genres) })
        }
      }
      await new Promise(r => setTimeout(r, 250))
    }
    if (changed > 0) {
      try { require('./autoBackup').markDirty() } catch {}
      broadcastAll('game:updated', null)
    }
    if (moved.length) {
      logger.info(`releaseWatch: ${moved.length} release date(s) changed`, { games: moved.map(m => `${m.name}: ${m.old} -> ${m.release_date}`) })
      announceDates(moved).catch(e => logger.warn('releaseWatch: date notice failed', { message: e.message }))
    }
    return { filled: changed, checked: rows.length, moved: moved.length }
  } finally {
    _refreshing = false
  }
}

function check() {
  try {
    const db = require('../db/database').getDb()
    const rows = db.prepare(`
      SELECT id, name, steam_app_id, release_date, banner_url, game_id, release_reminded FROM game_list
      WHERE release_watch = 1 AND release_date IS NOT NULL
        AND (release_notified IS NULL OR release_notified = 0)
    `).all()

    const stale = rows.filter(r => isLongReleased(r.release_date))
    if (stale.length) {
      const unwatch = db.prepare('UPDATE game_list SET release_notified = 1, release_watch = 0 WHERE id = ?')
      for (const r of stale) unwatch.run(r.id)
    }
    const released = rows.filter(r => {
      const ts = releasedTs(r.release_date)
      return ts != null && ts <= Date.now() && !isLongReleased(r.release_date)
    })

    // Out tomorrow.
    const remind = dueReminders(rows.filter(r => !released.includes(r)))
    if (remind.length) {
      const markReminded = db.prepare('UPDATE game_list SET release_reminded = 1 WHERE id = ?')
      for (const r of remind) markReminded.run(r.id)
      announceTomorrow(remind).catch(e => logger.warn('releaseWatch: reminder failed', { message: e.message }))
      logger.info(`releaseWatch: ${remind.length} tracked game(s) out tomorrow`)
    }

    if (!released.length) return

    const mark = db.prepare('UPDATE game_list SET release_notified = 1 WHERE id = ?')
    for (const r of released) mark.run(r.id)

    const unseen = getUnseen()
    const known = new Set(unseen.map(r => r.id))
    setUnseen([...unseen, ...released.filter(r => !known.has(r.id))
      .map(r => ({ id: r.id, name: r.name, steam_app_id: r.steam_app_id ?? null, release_date: r.release_date }))])

    sendReleaseToast(released).catch(e => logger.warn('releaseWatch: release notice failed', { message: e.message }))

    try {
      const { BrowserWindow } = require('electron')
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('game:updated', null)
      }
    } catch (e) {
      logger.warn('releaseWatch: broadcast failed', { message: e.message })
    }
    logger.info(`releaseWatch: ${released.length} upcoming game(s) reached release`)
  } catch (e) {
    logger.warn('releaseWatch: check failed', { message: e.message })
  }
}

const TRACKED = '/upcoming?view=tracked'
function names(list, max = 4) {
  const shown = list.slice(0, max).map(g => g.name).join(', ')
  return list.length > max ? `${shown} and ${list.length - max} more` : shown
}

async function announceTomorrow(rows) {
  const games = await releaseArt(rows)
  const one = games.length === 1 ? games[0] : null
  const art = games.find(g => g.artPath || g.artUrl) || {}
  const title = one ? `${one.name} is out tomorrow` : `${games.length} games you track are out tomorrow`
  const body = one ? `Releasing ${one.release_date}.` : names(games)
  const n = require('./notifications')
  await n.notify({
    kind: 'reminder', title, body, artPath: art.artPath, artUrl: art.artUrl, open: TRACKED,
    // The toast's heading says what it is, so its title is the game (a sentence was cut off).
    overlay: n.overlayNotice({ kind: 'reminder', header: 'Out tomorrow', title: one ? one.name : title, body, artPath: art.artPath, artUrl: art.artUrl }),
  })
}

const MOVE_WORDS = {
  announced: (m) => `Now has a release date: ${m.release_date}`,
  delayed: (m) => `Delayed to ${m.release_date}`,
  earlier: (m) => `Moved up to ${m.release_date}`,
  removed: () => 'No release date any more',
}
async function announceDates(moved) {
  const art = (await releaseArt(moved)).find(g => g.artPath || g.artUrl) || {}
  const one = moved.length === 1 ? moved[0] : null
  const title = one ? `${one.name}: new release date` : `${moved.length} release dates changed`
  const body = one
    ? `${MOVE_WORDS[one.kind](one)} (was ${one.old}).`
    : moved.slice(0, 4).map(m => `${m.name}: ${m.kind === 'removed' ? 'no date' : m.release_date}`).join(' · ') + (moved.length > 4 ? ` and ${moved.length - 4} more` : '')
  const n = require('./notifications')
  await n.notify({
    kind: 'date', title, body, artPath: art.artPath, artUrl: art.artUrl, open: TRACKED,
    overlay: n.overlayNotice({ kind: 'date', header: one ? 'New release date' : 'Release dates', title: one ? one.name : title, body, artPath: art.artPath, artUrl: art.artUrl }),
  })
}

// The "Out Now" toast carries the game's cover, the same way "Now Playing"
// does: the local library cover when the game is in the Library, else Steam's
// portrait (cached GetItems call, capped at 4s so the toast is never late),
// else the Game List's own art.
async function releaseArt(rows) {
  let assets = new Map()
  try {
    const ids = rows.map(r => r.steam_app_id).filter(Boolean)
    if (ids.length) {
      assets = await Promise.race([
        require('./steamApi').getAppAssets(ids),
        new Promise(resolve => setTimeout(() => resolve(new Map()), 4000)),
      ])
    }
  } catch {}
  const db = require('../db/database').getDb()
  return rows.map(r => {
    const a = r.steam_app_id ? assets.get(Number(r.steam_app_id)) : null
    let artPath = null
    try {
      const lib = r.game_id
        ? db.prepare('SELECT banner_local_path FROM games WHERE id = ?').get(r.game_id)
        : (r.steam_app_id ? db.prepare('SELECT banner_local_path FROM games WHERE steam_app_id = ?').get(String(r.steam_app_id)) : null)
      artPath = lib?.banner_local_path || null
    } catch {}
    return {
      name: r.name,
      release_date: r.release_date,
      artPath,
      artUrl: a?.portrait || a?.header || r.banner_url || null,
    }
  })
}

async function sendReleaseToast(rows) {
  const games = await releaseArt(rows)
  const one = games.length === 1 ? games[0] : null
  const art = games.find(g => g.artPath || g.artUrl) || {}
  await require('./notifications').notify({
    kind: 'release',
    title: one ? `${one.name} is out now` : `${games.length} games you're waiting for are out`,
    body: one ? `Released ${one.release_date}. It's under Out now in Upcoming.` : names(games),
    artPath: art.artPath, artUrl: art.artUrl, open: TRACKED,
    overlay: () => require('../overlayWindow').sendReleaseFlash({ games }),
  })
}

// Refresh store dates first (a delay must not fire a toast), then check.
async function refreshAndCheck() {
  try { await refreshUpcomingDates() } catch (e) { logger.warn('releaseWatch: date refresh failed', { message: e.message }) }
  check()
}

// One time: "Now out" entries that were never new (old games set to Upcoming
// before the two-week rule) go away, and their rows stop being watched.
function cleanupStale() {
  try {
    const settings = require('../db/queries/settings')
    if (settings.getSetting('release_unseen_cleanup_v1')) return
    const unseen = getUnseen()
    const old = unseen.filter(r => isLongReleased(r.release_date))
    if (old.length) {
      const db = require('../db/database').getDb()
      const unwatch = db.prepare('UPDATE game_list SET release_watch = 0 WHERE id = ?')
      for (const r of old) unwatch.run(r.id)
      setUnseen(unseen.filter(r => !isLongReleased(r.release_date)))
      logger.info(`releaseWatch: cleared ${old.length} old "Now out" entr${old.length === 1 ? 'y' : 'ies'}`)
    }
    settings.setSetting('release_unseen_cleanup_v1', '1')
  } catch (e) { logger.warn('releaseWatch: cleanup failed', { message: e.message }) }
}

// A release day starts at local midnight: look then, not up to 30 minutes later.
function armMidnight() {
  clearTimeout(_midnightTimer)
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5)
  _midnightTimer = setTimeout(() => { check(); armMidnight() }, next - now)
}

function start() {
  if (_timer) return
  cleanupStale()
  setTimeout(check, 12000)             // once shortly after startup (no network)
  _quickTimer = setInterval(check, QUICK_EVERY_MS)
  armMidnight()
  // The network refresh waits until no game is running (runWhenIdle), so it
  // never adds store requests and DB writes on top of a play session.
  const idleRefresh = () => {
    try { require('./processWatcher').runWhenIdle('releaseRefresh', () => { refreshAndCheck() }) }
    catch { refreshAndCheck() }
  }
  setTimeout(idleRefresh, 60000)
  _timer = setInterval(idleRefresh, CHECK_EVERY_MS)
}

module.exports = { start, check, refreshUpcomingDates, getUnseen, dismiss, sendReleaseToast, isLongReleased, dateSpan, dateChange, dueReminders, releasedTs }
