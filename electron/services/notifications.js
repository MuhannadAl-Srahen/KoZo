'use strict'

// Release, price and sale news (releaseWatch.js, deals.js) reaches the user one of two ways,
// never both:
//   - a Windows notification when no game is running. It stays in the Action Center until
//     it is seen, and a click opens KoZo on the right page. The maker's releases and price
//     alerts used to go only to the overlay toast, which shows for 10 seconds in a corner:
//     with no game running (KoZo in the tray, often nobody at the PC) it came and went
//     unseen, and the maker thought there were no notifications at all.
//   - the overlay toast during a game, where a Windows notification is held back by Focus
//     Assist anyway, or in a development build (Windows names the sender
//     "electron.app.Electron" there, which is why these were removed once; an installed
//     KoZo has its app id, main.js, and a Start Menu shortcut, so Windows says "KoZo"), or
//     with Settings > General > Windows notifications off (`os_notifications` = '0').
//
// Session and achievement news stays on the overlay only: the old notify* calls below
// are kept as no-ops so their callers keep working.

const fs = require('fs')
const logger = require('../logger')

// Each notification is kept until it closes: a notification the garbage collector takes
// loses its click handler while it still sits in the Action Center.
const live = new Set()
const iconCache = new Map()

function settingOn() {
  try { return require('../db/queries/settings').getSetting('os_notifications') !== '0' } catch { return true }
}

// Pure: which way a notification goes.
function route({ packaged, supported, enabled, sessionActive, devOverride = false }) {
  if (sessionActive) return 'overlay'
  if (!supported || !enabled) return 'overlay'
  if (!packaged && !devOverride) return 'overlay'
  return 'os'
}

function sessionActive() {
  try { return require('./processWatcher').isSessionActive() } catch { return false }
}

function wayFor() {
  let packaged = false, supported = false
  try {
    const { app, Notification } = require('electron')
    packaged = app.isPackaged
    supported = Notification.isSupported()
  } catch {}
  return route({
    packaged, supported, enabled: settingOn(), sessionActive: sessionActive(),
    devOverride: process.env.KOZO_OS_NOTIFY === '1',
  })
}

// The picture: the game's local cover, else its Steam art (downloaded, a few seconds at
// most, kept for the run), else none (Windows shows KoZo's icon).
// Windows draws it at under 100 px: kept small, so the cache holds a few KB a picture, not MB.
const ICON_WIDTH = 192
const small = (img) => (img.getSize().width > ICON_WIDTH ? img.resize({ width: ICON_WIDTH, quality: 'good' }) : img)
async function iconFor({ artPath, artUrl }) {
  const { nativeImage } = require('electron')
  try {
    if (artPath && fs.existsSync(artPath)) {
      const img = nativeImage.createFromPath(artPath)
      if (!img.isEmpty()) return small(img)
    }
  } catch {}
  if (!artUrl) return undefined
  if (iconCache.has(artUrl)) return iconCache.get(artUrl)
  try {
    const r = await require('axios').get(artUrl, { responseType: 'arraybuffer', timeout: 4000 })
    const raw = nativeImage.createFromBuffer(Buffer.from(r.data))
    if (raw.isEmpty()) return undefined
    const img = small(raw)
    if (iconCache.size > 30) iconCache.delete(iconCache.keys().next().value)
    iconCache.set(artUrl, img)
    return img
  } catch { return undefined }
}

// Bring KoZo up on a page (a hash route such as '/upcoming?view=tracked').
function openInApp(where) {
  const go = (win) => {
    if (!where) return
    try { win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify('#' + where)}`).catch(() => {}) } catch {}
  }
  try {
    const main = require('../main')
    if (main.showFromAnywhere) main.showFromAnywhere({ afterShow: go })
    else main.getOrCreateMainWindow(go)
  } catch (e) { logger.warn('notifications: open failed', { message: e.message }) }
}

async function showWindows({ title, body, artPath, artUrl, open }) {
  const { Notification } = require('electron')
  const icon = await iconFor({ artPath, artUrl })
  const n = new Notification({ title, body, ...(icon ? { icon } : {}) })
  live.add(n)
  const drop = () => live.delete(n)
  n.on('click', () => { drop(); openInApp(open) })
  n.on('close', drop)
  n.on('failed', (_, error) => {
    drop()
    logger.warn('notifications: Windows notification failed', { error: String(error) })
  })
  n.show()
  // Windows keeps it in the Action Center; nothing needs it after a day.
  const t = setTimeout(drop, 24 * 3600 * 1000)
  t.unref?.()
  return true
}

// One piece of news. `overlay` sends the in-game toast (a function), `title` / `body` /
// `artPath` / `artUrl` / `open` make the Windows notification. Returns 'os' or 'overlay'.
async function notify({ kind, title, body, artPath = null, artUrl = null, open = null, overlay }) {
  const way = wayFor()
  if (way === 'os') {
    try {
      await showWindows({ title, body, artPath, artUrl, open })
      logger.info('notifications: Windows notification', { kind, title })
      return 'os'
    } catch (e) {
      logger.warn('notifications: Windows notification failed, using the overlay', { message: e.message })
    }
  }
  try { overlay?.() } catch (e) { logger.warn('notifications: overlay toast failed', { message: e.message }) }
  logger.info('notifications: overlay toast', { kind, title })
  return 'overlay'
}

// The generic in-game toast (OverlayApp NoticeToast) for news without a toast of its own.
function overlayNotice(payload) {
  return () => require('../overlayWindow').sendNotice(payload)
}

function notifyAchievements() {}
function notifySessionStarted() {}
function notifySessionEnded() {}

module.exports = {
  notify, overlayNotice, route, openInApp,
  notifyAchievements, notifySessionStarted, notifySessionEnded,
}
