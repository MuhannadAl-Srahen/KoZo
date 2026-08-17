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

function setupTray(processWatcher) {
  if (tray) return

  try {
    tray = new Tray(getTrayIcon())
  } catch (e) {
    logger.warn('Tray creation failed', { message: e.message })
    return
  }

  // Lazy require — main.js requires tray.js at module-load time (before
  // getOrCreateMainWindow exists), but every use here happens later, from a
  // click handler, by which point main.js has finished loading (§ services
  // require up a level / gotcha pattern used elsewhere for the same reason).
  // getOrCreateMainWindow recreates the window if it was unloaded while
  // hidden in the tray (see main.js armDestroyTimer) — it may not be
  // instantly ready, hence the callback for anything past show/focus.
  function show(afterShow) { require('./main').getOrCreateMainWindow(afterShow) }

  // Reveal the window AND route it to a page (HashRouter → set location.hash).
  function openAt(hash) {
    show((win) => {
      try {
        win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify('#' + hash)}`)
      } catch {}
    })
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
      // Each running game is clickable → jumps straight to its page, and the
      // label doubles as a mini HUD: elapsed time + achievement progress.
      sessions.forEach((sess, gameId) => {
        const name = sess.game_name || gamesQ.getGame(gameId)?.name || 'Game'
        const dur  = fmtDur(liveElapsed(sess))
        const tag  = sess.idle ? '  ·  away' : ''
        let ach = ''
        try {
          const list = require('./db/queries/achievements').listAchievementsForGame(gameId)
          if (list.length > 0) {
            const un = list.filter(a => a.unlock_id != null).length
            ach = `  ·  ${un}/${list.length}`
          }
        } catch {}
        items.push({ label: `▶  ${name}   ${dur}${ach}${tag}`, click: () => openAt(`/game/${gameId}`) })
      })
    } else {
      items.push({ label: paused ? 'Tracking paused' : 'No game running', enabled: false })
    }

    // ── Glanceable stat, always present so the menu never feels empty ──
    const today = todayPlaytimeSec(sessions)
    items.push({ label: today > 0 ? `Played today: ${fmtDur(today)}` : 'Nothing played today', enabled: false })

    // ── Quick destinations ──
    items.push({ type: 'separator' })
    items.push({ label: 'Open KoZo', click: () => show() })
    items.push({ label: 'Statistics', click: () => openAt('/statistics') })
    items.push({ label: 'Profile', click: () => openAt('/profile') })
    items.push({ type: 'separator' })
    items.push({ label: 'Quit KoZo', click: () => { app.isQuitting = true; app.quit() } })

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
  // Wrapped (not passed directly) — Tray's 'click'/'double-click' events pass
  // (event, bounds) to the listener, which would otherwise land in show()'s
  // `afterShow` parameter and get called as a function.
  tray.on('click',        () => show())
  tray.on('double-click', () => show())
  // Rebuild right before the menu opens so durations + "today" are current.
  tray.on('right-click',  refreshMenu)

  logger.info('System tray initialized')
  return { refreshMenu }
}

module.exports = { setupTray }
