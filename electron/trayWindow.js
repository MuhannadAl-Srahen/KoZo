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
const IDLE_DESTROY_MS = 3 * 60 * 1000
const REFRESH_MS = 5000

let _win = null
let _destroyTimer = null
let _refreshTimer = null
let _hiddenAt = 0

function create() {
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
  if (app.isPackaged) {
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
  let y = trayBounds && trayBounds.y < workArea.y + workArea.height / 2
    ? workArea.y + 8                                   // taskbar on top
    : workArea.y + workArea.height - H - 8             // taskbar at the bottom
  x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - W - 8))
  y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - H - 8))
  _win.setBounds({ x, y, width: W, height: H })
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
    win.show()
    win.focus()
    push()
    clearInterval(_refreshTimer)
    _refreshTimer = setInterval(push, REFRESH_MS)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal)
  else reveal()
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

module.exports = { toggle, show, hide }
