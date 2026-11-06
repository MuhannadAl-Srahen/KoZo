'use strict'

// The tray popup: a small frameless KoZo-styled panel shown when the tray icon
// is right-clicked, in place of the plain native context menu. Same bundle as
// the main window, loaded with ?tray=1 (src/TrayApp.jsx). Created on first use,
// hidden on blur, and torn down after a few idle minutes like the overlay.

const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const logger = require('./logger')

const W = 340
const H = 500
// The popup is as tall as what it shows (the page reports its panel's height through
// tray:fit). A fixed 500 px left a big empty middle on a day with nothing played.
const MIN_H = 200
const MAX_H = 640
const FIT_WAIT_MS = 400
const IDLE_DESTROY_MS = 3 * 60 * 1000
const REFRESH_MS = 5000

let _win = null
let _destroyTimer = null
let _refreshTimer = null
let _hiddenAt = 0
let _height = H
let _fitted = false
let _place = null           // the work area, the x, and whether it hangs from the top
let _pendingReveal = null

function create() {
  _height = H
  _fitted = false
  _win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  // Like the main window and the overlay: tests run the built app with KOZO_RENDERER=dist, and
  // without it this popup came up blank in every test, so nothing ever looked at it.
  if (app.isPackaged || process.env.KOZO_RENDERER === 'dist') {
    _win.loadFile(path.join(__dirname, '../renderer-dist/index.html'), { query: { tray: '1' } })
  } else {
    _win.loadURL('http://localhost:5173?tray=1')
  }
  _win.on('blur', hide)
  _win.on('closed', () => { _win = null; clearInterval(_refreshTimer) })
  _win.webContents.on('render-process-gone', (_e, d) => {
    logger.warn('tray popup renderer gone', d)
    try { _win?.destroy() } catch {}
  })
  return _win
}

// Above the tray icon (taskbar at the bottom) or below it (taskbar at the top),
// clamped into the work area of the display the icon is on.
function position(trayBounds) {
  const point = trayBounds
    ? { x: Math.round(trayBounds.x + trayBounds.width / 2), y: Math.round(trayBounds.y + trayBounds.height / 2) }
    : screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(point)
  let x = point.x - Math.round(W / 2)
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - W - 8))
  _place = { workArea, x, top: !!trayBounds && trayBounds.y < workArea.y + workArea.height / 2 }
  applyBounds()
}

// Pure: where the popup goes for a height. It hangs from the taskbar's edge, so a new height
// keeps that edge where it is.
function boundsFor(place, height) {
  const { workArea, x, top } = place
  const h = Math.min(height, workArea.height - 16)
  const y = top ? workArea.y + 8 : workArea.y + workArea.height - h - 8
  return { x, y: Math.max(workArea.y + 8, y), width: W, height: h }
}

function applyBounds() {
  if (!_win || _win.isDestroyed() || !_place) return
  _win.setBounds(boundsFor(_place, _height))
}

// The page measured its panel. The first time, the popup waits for this before it shows.
function fit(height) {
  const h = Math.round(Math.max(MIN_H, Math.min(MAX_H, Number(height) || H)))
  const changed = h !== _height
  _height = h
  _fitted = true
  if (changed) applyBounds()
  if (_pendingReveal) { const r = _pendingReveal; _pendingReveal = null; r() }
}

function push() {
  if (_win && !_win.isDestroyed() && _win.isVisible()) {
    try { _win.webContents.send('tray:refresh') } catch {}
  }
}

function show(trayBounds) {
  clearTimeout(_destroyTimer)
  const win = _win && !_win.isDestroyed() ? _win : create()
  position(trayBounds)
  const reveal = () => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
    push()
    clearInterval(_refreshTimer)
    _refreshTimer = setInterval(push, REFRESH_MS)
  }
  // A new popup first measures itself, so it doesn't show at the old size and then jump.
  const revealFitted = () => {
    if (_fitted) { reveal(); return }
    _pendingReveal = reveal
    setTimeout(() => { if (_pendingReveal === reveal) { _pendingReveal = null; reveal() } }, FIT_WAIT_MS)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', revealFitted)
  else revealFitted()
}

function hide() {
  if (!_win || _win.isDestroyed() || !_win.isVisible()) return
  _win.hide()
  _hiddenAt = Date.now()
  clearInterval(_refreshTimer)
  clearTimeout(_destroyTimer)
  _destroyTimer = setTimeout(() => { try { _win?.destroy() } catch {} }, IDLE_DESTROY_MS)
}

// Clicking the icon while the popup is open blurs (hides) it first — don't
// immediately reopen it on that same click.
function toggle(trayBounds) {
  if (_win && !_win.isDestroyed() && _win.isVisible()) { hide(); return }
  if (Date.now() - _hiddenAt < 300) return
  show(trayBounds)
}

module.exports = { toggle, show, hide, fit, boundsFor }
