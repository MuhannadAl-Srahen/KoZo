'use strict'

const { BrowserWindow, screen, app } = require('electron')
const path   = require('path')
const logger = require('./logger')

let _win     = null
let _ready    = false   // true once the overlay renderer has registered its listeners
let _pending  = []      // messages waiting for the renderer to be ready
let _fallback = null    // safety-net timer that force-flushes if `ready` never arrives

// Creates (or returns) the transparent overlay window. Starts hidden; the first
// sendX() loads it and queues the message until the renderer signals ready.
function getOrCreate() {
  if (_win && !_win.isDestroyed()) return _win

  _ready = false
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const W = 380, H = 520

  _win = new BrowserWindow({
    width: W, height: H,
    x: width  - W - 16,
    y: height - H - 12,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    fullScreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 'screen-saver' level stays above fullscreen game windows on Windows
  _win.setAlwaysOnTop(true, 'screen-saver')
  // Click-through: mouse events pass to the game below
  _win.setIgnoreMouseEvents(true, { forward: true })

  const url = app.isPackaged
    ? `file://${path.join(__dirname, '../renderer-dist/index.html')}?overlay=1`
    : 'http://localhost:5173?overlay=1'

  _win.loadURL(url)

  // Safety net: the overlay normally flushes when its renderer calls overlay.ready()
  // (the handshake). If that IPC is ever lost/delayed (a renderer error before the
  // listeners attach, a slow first paint, etc.) the queued toast would otherwise
  // hang forever and NOTHING would ever show. Once the page has loaded, give the
  // handshake a short grace period, then force-flush so a toast always appears.
  _win.webContents.on('did-finish-load', () => {
    clearTimeout(_fallback)
    _fallback = setTimeout(() => { if (!_ready) markReady() }, 1500)
  })

  // The overlay sits transparent/always-on-top over the game, which can crash
  // or silently reload its renderer (GPU driver quirks, especially over
  // exclusive fullscreen). The window itself survives that, so `closed` never
  // fires and `_ready` would otherwise stay stale-true — new sends would then
  // go into a renderer with no listeners yet and be silently dropped, only
  // surfacing as a batch the next time an achievement sync runs. Reset `_ready`
  // and reload so the readiness handshake runs again.
  _win.webContents.on('render-process-gone', (_e, details) => {
    logger.warn(`Overlay renderer gone: ${details.reason}`)
    _ready = false
    clearTimeout(_fallback); _fallback = null
    if (_win && !_win.isDestroyed()) _win.webContents.reload()
  })
  _win.webContents.on('did-fail-load', (_e, errorCode, errorDesc) => {
    if (errorCode === -3) return // aborted load, not a real failure
    logger.warn(`Overlay failed to load: ${errorDesc}`)
    _ready = false
  })

  _win.on('closed', () => {
    _win = null; _ready = false; _pending = []
    clearTimeout(_fallback); _fallback = null
  })

  return _win
}

// Deliver any queued messages — only once the renderer has confirmed its
// listeners are attached, so a message can never be sent into the void.
function flush() {
  if (!_win || _win.isDestroyed() || !_ready || _pending.length === 0) return
  raise()
  for (const { channel, data } of _pending) {
    try { _win.webContents.send(channel, data) } catch {}
  }
  _pending = []
  // Fullscreen games re-assert topmost aggressively; re-raising once shortly
  // after the show wins the z-order race so toasts actually appear over them.
  setTimeout(() => { if (_win && !_win.isDestroyed() && _win.isVisible()) raise() }, 1000)
}

// Show + force the overlay above whatever currently owns the top of the
// z-order (borderless-fullscreen games). Set once at creation is not enough —
// games re-claim topmost, so this is re-asserted on every toast.
function raise() {
  if (!_win || _win.isDestroyed()) return
  try {
    _win.setAlwaysOnTop(true, 'screen-saver')
    _win.showInactive()
    _win.moveTop()
  } catch {}
}

function _send(channel, data) {
  try {
    clearTimeout(_idleTimer)   // activity — cancel any pending idle teardown
    getOrCreate()
    _pending.push({ channel, data })
    flush()   // delivers immediately if the renderer already signalled ready
  } catch (e) {
    logger.warn(`overlayWindow.${channel}: ${e.message}`)
  }
}

// ── Idle teardown ─────────────────────────────────────────────────────────────
// A hidden transparent always-on-top window still costs a renderer process and
// GPU compositing. Once the toast queue empties AND no game session is running,
// destroy it after a few idle minutes — it's recreated lazily on the next toast
// (and a session's start toast pre-warms it, so in-game unlocks stay instant).
const IDLE_DESTROY_MS = 3 * 60 * 1000
let _idleTimer = null

function scheduleIdleDestroy() {
  clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    try {
      const active = require('./db/queries/sessions').getActiveSessions()
      if (active.length > 0) { scheduleIdleDestroy(); return }   // in-game: stay warm
    } catch {}
    if (_win && !_win.isDestroyed() && !_win.isVisible()) {
      logger.info('overlayWindow: tearing down idle overlay to free memory')
      _win.destroy()   // the closed handler resets state; next toast recreates
    }
  }, IDLE_DESTROY_MS)
}

// Called via the `overlay:ready` IPC once the overlay React app has registered
// its event listeners. Flushes anything that arrived during load.
function markReady() {
  clearTimeout(_fallback); _fallback = null
  _ready = true
  flush()
}

function sendAchievements(data)   { _send('achievement:overlay', data) }
function sendSessionStarted(data) { _send('session:overlay',     data) }
function sendStatusFlash(data)    { _send('status:overlay',      data) }
function sendLevelUp(data)        { _send('xp:overlay',          data) }
function sendSessionEnded(data)   { _send('sessionEnd:overlay',  data) }

// Toggle whether the overlay captures mouse clicks. The window is click-through
// by default (events pass to the game). When the cursor is over a toast the
// renderer flips this on so the toast/close button is clickable, then back off
// on mouse-leave. `forward: true` keeps mouse-move events flowing to the
// renderer even while click-through, which is what lets it detect the hover.
function setInteractive(interactive) {
  if (!_win || _win.isDestroyed()) return
  _win.setIgnoreMouseEvents(!interactive, { forward: true })
}

function hideOverlay() {
  if (_win && !_win.isDestroyed()) _win.hide()
  scheduleIdleDestroy()
}

// Push a live accent change to the overlay window (its own BrowserWindow, so it
// doesn't inherit the main app's CSS vars). No-op if the overlay isn't created
// yet — it reads accent_color from settings on first load anyway. Does NOT show
// the window.
function applyAccent(hex) {
  if (_win && !_win.isDestroyed()) {
    try { _win.webContents.send('accent:changed', hex) } catch {}
  }
}

module.exports = { getOrCreate, sendAchievements, sendSessionStarted, sendStatusFlash, sendLevelUp, sendSessionEnded, hideOverlay, markReady, setInteractive, applyAccent }
