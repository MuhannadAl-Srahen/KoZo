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
        win.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify('#' + hash)}`).catch(() => {})
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

    // ── Glanceable stats, always present so the menu never feels empty ──
    const today = todayPlaytimeSec(sessions)
    items.push({ label: today > 0 ? `Played today: ${fmtDur(today)}` : 'Nothing played today', enabled: false })
    try {
      const xp = require('./services/xp').computeXp()
      if (xp?.level != null) items.push({ label: `Level ${xp.level}${xp.tier ? ` · ${xp.tier}` : ''}`, enabled: false })
    } catch {}

    // ── Jump back in: the last games played, one click starts one ──
    const recent = recentGames(new Set(sessions.keys()))
    if (recent.length) {
      items.push({ type: 'separator' })
      items.push({
        label: 'Jump back in',
        submenu: recent.map(g => ({ label: g.name.replace(/&/g, '&&'), click: () => launch(g.id) })),
      })
    }

    // ── Quick destinations ──
    items.push({ type: 'separator' })
    items.push({ label: 'Open KoZo', click: () => show() })
    items.push({ label: 'Big Picture', click: () => openAt('/big') })
    items.push({ label: 'Statistics', click: () => openAt('/statistics') })
    items.push({ type: 'separator' })
    items.push(paused
      ? { label: 'Resume tracking', click: () => { processWatcher.resume(); updateTooltip() } }
      : { label: 'Pause tracking', click: () => { processWatcher.pause(); updateTooltip() } })
    items.push({ label: 'Quit KoZo', click: () => { app.isQuitting = true; app.quit() } })

    return Menu.buildFromTemplate(items)
  }

  // The last games played that aren't running now, newest first.
  function recentGames(liveIds) {
    try {
      return require('./db/database').getDb().prepare(`
        SELECT id, name FROM games
        WHERE last_played_at IS NOT NULL AND COALESCE(is_archived, 0) = 0 AND COALESCE(is_hidden, 0) = 0
        ORDER BY last_played_at DESC LIMIT 8
      `).all().filter(g => !liveIds.has(g.id)).slice(0, 5)
    } catch { return [] }
  }

  // Same path as Play in the app. If it can't start (a missing file, a dismissed
  // permission prompt), the game's page opens, where Play says why.
  function launch(gameId) {
    Promise.resolve()
      .then(() => require('./ipc').launchGame(gameId))
      .catch((e) => {
        logger.warn('tray: launch failed', { message: e.message })
        openAt(`/game/${gameId}`)
      })
  }
  _buildMenu = buildMenu

  // Tooltip reflects what's happening so hovering the icon is informative too.
  function updateTooltip() {
    try {
      const sessions = processWatcher.getActiveSessions()
      const paused   = processWatcher.isPaused?.() ?? false
      if (sessions.size > 0) {
        const first = sessions.values().next().value
        tray.setToolTip(`KoZo: playing ${first?.game_name || 'a game'}`)
      } else {
        tray.setToolTip(paused ? 'KoZo: tracking paused' : 'KoZo Game Tracker')
      }
    } catch { tray.setToolTip('KoZo Game Tracker') }
  }

  // Right-click shows Windows' own menu, built fresh each time so it's never stale.
  // It replaced a KoZo-styled popup window (the maker's call): that loaded the whole
  // app on every open, so it was slow to appear and cost a page's worth of memory.
  function refreshMenu() {
    if (tray && !tray.isDestroyed()) updateTooltip()
  }

  refreshMenu()
  // Wrapped (not passed directly) — Tray's 'click'/'double-click' events pass
  // (event, bounds) to the listener, which would otherwise land in show()'s
  // `afterShow` parameter and get called as a function.
  tray.on('click',        () => show())
  tray.on('double-click', () => show())
  tray.on('right-click', () => {
    try { tray.popUpContextMenu(buildMenu()) } catch (e) { logger.warn('tray menu failed', { message: e.message }) }
  })

  logger.info('System tray initialized')
  return { refreshMenu }
}

// The menu as it would show now (scripts/smoke-test.js reads it).
let _buildMenu = null
function currentMenu() { return _buildMenu ? _buildMenu() : null }

module.exports = { setupTray, currentMenu }
