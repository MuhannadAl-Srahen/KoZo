const { app, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const logger = require('./logger')
const { getTrayImage } = require('./appIcon')

let tray = null

// The honeycomb icon generator lives in ./appIcon.js so the window/taskbar icon
// and the tray icon share one source of truth.
function getTrayIcon() {
  try {
    const p = path.join(__dirname, '../assets/tray-icon.png')
    const img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) return img
  } catch {}
  return getTrayImage()
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return '<1m'
}

// ── Tray setup ───────────────────────────────────────────────────────────────

function setupTray(mainWindow, processWatcher) {
  if (tray) return

  try {
    tray = new Tray(getTrayIcon())
  } catch (e) {
    logger.warn('Tray creation failed', { message: e.message })
    return
  }

  function show() { mainWindow.show(); mainWindow.focus() }

  // Reveal the window AND route it to a page (HashRouter → set location.hash).
  function openAt(hash) {
    show()
    try {
      mainWindow.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify('#' + hash)}`)
    } catch {}
  }

  // Real played time for a live session = wall time minus accumulated AFK idle.
  function liveElapsed(sess) {
    return Math.max(0, Math.floor((Date.now() - new Date(sess.started_at)) / 1000) - (sess.idle_seconds || 0))
  }

  // Today's total = finished sessions started today + any live sessions' elapsed.
  function todayPlaytimeSec(sessions) {
    let sec = 0
    try {
      sec = require('./db/database').getDb().prepare(`
        SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM sessions
        WHERE ended_at IS NOT NULL AND DATE(started_at, 'localtime') = DATE('now', 'localtime')
      `).get().s || 0
    } catch {}
    sessions.forEach(sess => { sec += liveElapsed(sess) })
    return sec
  }

  function buildMenu() {
    const sessions = processWatcher.getActiveSessions()
    const paused   = processWatcher.isPaused?.() ?? false
    const gamesQ   = require('./db/queries/games')

    const items = []

    // ── What's happening right now ──
    if (sessions.size > 0) {
      // Each running game is clickable → jumps straight to its page.
      sessions.forEach((sess, gameId) => {
        const name = sess.game_name || gamesQ.getGame(gameId)?.name || 'Game'
        const dur  = fmtDur(liveElapsed(sess))
        const tag  = sess.idle ? '  ·  away' : ''
        items.push({ label: `▶  ${name}   ${dur}${tag}`, click: () => openAt(`/game/${gameId}`) })
      })
    } else {
      items.push({ label: paused ? 'Tracking paused' : 'No game running', enabled: false })
    }

    // ── A glanceable stat: time played today ──
    const today = todayPlaytimeSec(sessions)
    if (today > 0) {
      items.push({ label: `Played today: ${fmtDur(today)}`, enabled: false })
    }

    items.push({ type: 'separator' })
    items.push({ label: 'Open', click: () => show() })
    items.push({ label: 'Quit', click: () => { app.isQuitting = true; app.quit() } })

    return Menu.buildFromTemplate(items)
  }

  // Tooltip reflects what's happening so hovering the icon is informative too.
  function updateTooltip() {
    try {
      const sessions = processWatcher.getActiveSessions()
      const paused   = processWatcher.isPaused?.() ?? false
      if (sessions.size > 0) {
        const first = sessions.values().next().value
        tray.setToolTip(`KoZo — playing ${first?.game_name || 'a game'}`)
      } else {
        tray.setToolTip(paused ? 'KoZo — tracking paused' : 'KoZo — Game Tracker')
      }
    } catch { tray.setToolTip('KoZo — Game Tracker') }
  }

  function refreshMenu() {
    if (tray && !tray.isDestroyed()) {
      tray.setContextMenu(buildMenu())
      updateTooltip()
    }
  }

  refreshMenu()
  tray.on('click',        show)
  tray.on('double-click', show)
  // Rebuild right before the menu opens so durations + "today" are current.
  tray.on('right-click',  refreshMenu)

  logger.info('System tray initialized')
  return { refreshMenu }
}

module.exports = { setupTray }
