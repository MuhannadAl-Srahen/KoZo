'use strict'

// Watches the Game List's "upcoming" entries and tells the user the moment a
// tracked game's release date passes: an overlay toast (once per game, flagged
// via release_notified) + a game:updated broadcast so the Upcoming tab regroups
// it under "Out now". Checked at startup and every 6h.
//
// The overlay is the app's only notification surface (§6) — a native
// Notification here would show as "electron.app.Electron" in dev and can be
// suppressed by Focus Assist during fullscreen play, which is exactly why OS
// notifications were removed. Don't reintroduce one.

const logger = require('../logger')

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
let _timer = null

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
    const rows = db.prepare("SELECT id, steam_app_id, release_date, genres FROM game_list WHERE release_watch = 1 AND steam_app_id IS NOT NULL").all()
    let changed = 0
    for (const row of rows) {
      const d = await getStoreDetails(row.steam_app_id).catch(() => null)
      if (d) {
        if (d.release_date && d.release_date !== row.release_date) {
          gameListQ.updateGameListItem(row.id, { release_date: d.release_date })
          changed++
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
    return { filled: changed, checked: rows.length }
  } finally {
    _refreshing = false
  }
}

function check() {
  try {
    const db = require('../db/database').getDb()
    const rows = db.prepare(`
      SELECT id, name, steam_app_id, release_date, banner_url, game_id FROM game_list
      WHERE release_watch = 1 AND release_date IS NOT NULL
        AND (release_notified IS NULL OR release_notified = 0)
    `).all()

    const released = rows.filter(r => {
      const ts = releasedTs(r.release_date)
      return ts != null && ts <= Date.now()
    })
    if (!released.length) return

    const mark = db.prepare('UPDATE game_list SET release_notified = 1 WHERE id = ?')
    for (const r of released) mark.run(r.id)

    const unseen = getUnseen()
    const known = new Set(unseen.map(r => r.id))
    setUnseen([...unseen, ...released.filter(r => !known.has(r.id))
      .map(r => ({ id: r.id, name: r.name, steam_app_id: r.steam_app_id ?? null, release_date: r.release_date }))])

    sendReleaseToast(released).catch(e => logger.warn('releaseWatch: overlay notify failed', { message: e.message }))

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
  require('../overlayWindow').sendReleaseFlash({ games })
}

// Refresh store dates first (a delay must not fire a toast), then check.
async function refreshAndCheck() {
  try { await refreshUpcomingDates() } catch (e) { logger.warn('releaseWatch: date refresh failed', { message: e.message }) }
  check()
}

function start() {
  if (_timer) return
  setTimeout(check, 12000)             // once shortly after startup (no network)
  // The network refresh waits until no game is running (runWhenIdle), so it
  // never adds store requests and DB writes on top of a play session.
  const idleRefresh = () => {
    try { require('./processWatcher').runWhenIdle('releaseRefresh', () => { refreshAndCheck() }) }
    catch { refreshAndCheck() }
  }
  setTimeout(idleRefresh, 60000)
  _timer = setInterval(idleRefresh, CHECK_EVERY_MS)
}

module.exports = { start, check, refreshUpcomingDates, getUnseen, dismiss, sendReleaseToast }
