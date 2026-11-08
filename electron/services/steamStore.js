'use strict'

// Steam's own picks for Upcoming: the store's Personal Calendar, which Steam fills
// from each person's playtime and wishlist. It only answers a signed-in store
// session ("Not logged in" otherwise), so:
//   - Sign in happens on Steam's own login page, in a KoZo window with its own
//     storage (partition persist:steamstore). KoZo never sees the password, and the
//     session is never part of a backup or an export.
//   - KoZo then asks the same address Steam's calendar page asks:
//     store.steampowered.com/personalcalendardata?tag=&days_backward=&days_forward=
//     (found in the store's own personalcalendarstore.js). Each answer item has at
//     least `appid` and `nReleaseDate` (seconds); names and art come from GetItems,
//     like everything else on Upcoming.

const { BrowserWindow, session } = require('electron')
const logger = require('../logger')

const PARTITION = 'persist:steamstore'
const STORE = 'https://store.steampowered.com'
const TTL = 3 * 60 * 60 * 1000

let loginWin = null
let cache = null            // { at, key, data }
let shapeLogged = false

const ses = () => session.fromPartition(PARTITION)

async function isSignedIn() {
  try {
    const c = await ses().cookies.get({ url: STORE, name: 'steamLoginSecure' })
    return c.length > 0
  } catch { return false }
}

// Opens Steam's login page; resolves true once the store session exists (or false
// when the window is closed first).
function signIn() {
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return Promise.resolve(false) }
  return new Promise((resolve) => {
    loginWin = new BrowserWindow({
      width: 980, height: 760, title: 'Sign in to the Steam store', autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      clearInterval(poll)
      cache = null
      if (loginWin && !loginWin.isDestroyed()) loginWin.close()
      loginWin = null
      resolve(ok)
    }
    const poll = setInterval(async () => { if (await isSignedIn()) finish(true) }, 1000)
    loginWin.on('closed', () => { loginWin = null; finish(false) })
    // Links on the login page (help, sign up) open in the browser, not in this window.
    loginWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) require('electron').shell.openExternal(url)
      return { action: 'deny' }
    })
    loginWin.loadURL(`${STORE}/login/?redir=personalcalendar`)
  })
}

async function signOut() {
  cache = null
  try { await ses().clearStorageData() } catch (e) { logger.warn('steamStore: sign out failed', { message: e.message }) }
  return true
}

// Pure: Steam's answer -> [{ appid, ts }] (ts in ms), newest shape tolerated.
function calendarItems(data) {
  const list = Array.isArray(data?.arrAppInfos) ? data.arrAppInfos : []
  return list
    .map(a => ({ appid: Number(a?.appid ?? a?.nAppID ?? a?.id), ts: Number(a?.nReleaseDate ?? a?.release_date) * 1000 }))
    .filter(a => a.appid > 0 && a.ts > 0)
}

// Steam's picks for this person: null when not signed in.
async function personalCalendar({ daysBack = 7, daysForward = 56, tag = '' } = {}) {
  const key = `${daysBack}:${daysForward}:${tag}`
  if (cache && cache.key === key && Date.now() - cache.at < TTL) return cache.data
  if (!(await isSignedIn())) return null
  const url = `${STORE}/personalcalendardata?tag=${encodeURIComponent(tag)}&days_backward=${daysBack}&days_forward=${daysForward}`
  const res = await ses().fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Steam answered ${res.status}`)
  const data = await res.json()
  if (data?.strResultMessage && /not logged in/i.test(data.strResultMessage)) return null
  if (!shapeLogged) {
    shapeLogged = true
    const first = data?.arrAppInfos?.[0]
    logger.info('steamStore: calendar answer', { items: data?.arrAppInfos?.length || 0, keys: first ? Object.keys(first).slice(0, 20) : [], wishlist: !!data?.bUsesWishlistedGames })
  }
  const out = { items: calendarItems(data), usesWishlist: !!data?.bUsesWishlistedGames, tags: Array.isArray(data?.arrUserTags) ? data.arrUserTags : [] }
  cache = { at: Date.now(), key, data: out }
  return out
}

module.exports = { isSignedIn, signIn, signOut, personalCalendar, calendarItems }
