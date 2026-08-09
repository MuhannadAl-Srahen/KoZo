const { app, BrowserWindow, Menu, shell, protocol, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const { setupTray } = require('./tray')

// Register a private "kozo://" scheme for serving local cached images (banners,
// hero art). This lets us keep webSecurity ON in dev and production — the old
// approach disabled webSecurity to load file:// images, which Electron flags as
// a serious security risk. Must run before app is ready. corsEnabled lets the
// dev renderer (http://localhost) load these images cross-scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: 'kozo', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

// Identify the app as "KoZo" everywhere Windows/Electron surfaces a name —
// taskbar grouping, notifications, the main process title in Task Manager.
// (In a packaged build the .exe is KoZo.exe so child processes also read "KoZo";
// in `npm run dev` the binary is electron.exe so children still show "Electron".)
app.setName('KoZo')
app.setAppUserModelId('com.kozo.gametracker')
try { process.title = 'KoZo' } catch {}

// Single-instance lock — prevents a second launch (e.g. autostart + manual open)
// from spawning a whole duplicate process tree. The second instance just focuses
// the existing window and exits.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
  process.exit(0)
}

// Suppress Chrome DevTools Autofill warnings (not implemented in Electron)
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication')

let mainWindow = null

// How long the main window can sit hidden in the tray before its whole
// renderer (React tree + every decoded banner bitmap) is unloaded. This is
// the bulk of KoZo's idle RAM — the window is only ~1s to recreate, and
// tracking/achievements/overlay toasts/Alt+K all run from the main process
// regardless of whether this window currently exists.
const UNLOAD_AFTER_HIDDEN_MS = 60 * 1000
let destroyTimer = null
function clearDestroyTimer() {
  if (destroyTimer) { clearTimeout(destroyTimer); destroyTimer = null }
}
function armDestroyTimer() {
  clearDestroyTimer()
  destroyTimer = setTimeout(() => {
    destroyTimer = null
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.destroy()
    }
  }, UNLOAD_AFTER_HIDDEN_MS)
}

Menu.setApplicationMenu(null)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#10101a',
    show: false,
    autoHideMenuBar: true,
    icon: require('./appIcon').getWindowImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,              // always on — local images go through kozo://
      allowRunningInsecureContent: false,
    },
  })

  // Silence noisy CDP warnings that DevTools emits for unimplemented Electron features
  mainWindow.webContents.on('console-message', (event) => {
    const message = event.message ?? ''
    if (message.includes('Autofill.enable') || message.includes('Autofill.setAddresses')) return
  })

  // Resolve "start minimized to tray" BEFORE loading so we can also skip opening
  // DevTools in dev — openDevTools() force-shows the (otherwise hidden) window,
  // which is exactly why start-minimized appeared not to work during development.
  let startMin = false
  try { startMin = require('./db/queries/settings').getSetting('start_minimized') === '1' } catch {}

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
    if (!startMin) mainWindow.webContents.openDevTools()
  } else {
    // Vite outputs to renderer-dist (NOT dist) — a wrong path here is a silent
    // black window in every packaged build.
    mainWindow.loadFile(path.join(__dirname, '../renderer-dist/index.html'))
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      try { require('./logger').error(`main window failed to load renderer: ${desc} (${code}) ${url}`) } catch {}
    })
  }

  mainWindow.once('ready-to-show', () => {
    // When startMin is true the window stays hidden — only the tray icon is visible.
    if (!startMin) mainWindow.show()
    else armDestroyTimer()   // never shown at all — still eligible to unload
  })

  // Minimize to tray instead of quitting (wired up fully in tray step)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('hide', () => { if (!app.isQuitting) armDestroyTimer() })
  mainWindow.on('show', clearDestroyTimer)
  // destroy() (the unload-in-tray path below) skips 'close' but still fires
  // 'closed' — clear the module ref so getOrCreateMainWindow knows to recreate.
  mainWindow.on('closed', () => { mainWindow = null })

  // Open external links in the OS browser, not in the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Bring the main window to front, recreating it first if it was unloaded
// while hidden in the tray. `afterShow(win)` runs once the window is actually
// visible and (for a fresh recreate) finished loading — callers that need to
// touch webContents/navigate should do it there, not immediately after this
// call returns, since a recreate is asynchronous.
function getOrCreateMainWindow(afterShow) {
  clearDestroyTimer()
  if (mainWindow && !mainWindow.isDestroyed()) {
    const win = mainWindow   // the module ref can be nulled before the load ends
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    // An existing window can still be mid-load (a recreate triggered moments ago
    // by a caller that passed no callback) — a send into a loading renderer is
    // dropped on the floor, which is why the recreate path below waits too.
    if (afterShow) {
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) afterShow(win) })
      } else {
        afterShow(win)
      }
    }
    return win
  }
  createWindow()
  const win = mainWindow
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.webContents.once('did-finish-load', () => { if (afterShow) afterShow(win) })
  return win
}

// Focus the existing window if a second instance is launched (recreating it
// first if it was unloaded while sitting hidden in the tray).
app.on('second-instance', () => { getOrCreateMainWindow() })

app.whenReady().then(() => {
  // Serve local cached images securely: kozo://local/<url-encoded absolute path>.
  // Reads the file directly and returns it (more reliable than net.fetch of a
  // file URL). Only allows files inside the app's own data dir OR image files
  // anywhere (a user-picked banner) — never arbitrary files.
  const MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  }
  protocol.handle('kozo', async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = path.resolve(decodeURIComponent(url.pathname.replace(/^\//, '')))
      const ext = path.extname(filePath).toLowerCase()
      // The separator matters: a bare startsWith would also accept siblings that
      // merely share the prefix ("…\KoZo Saves", "…\KoZo-backup") and serve any
      // file type out of them.
      const base = app.getPath('userData').toLowerCase().replace(/[\\/]+$/, '')
      const fp = filePath.toLowerCase()
      const underData = fp === base || fp.startsWith(base + path.sep)
      if (!underData && !MIME[ext]) return new Response('Forbidden', { status: 403 })
      const data = await fs.promises.readFile(filePath)
      return new Response(data, { status: 200, headers: { 'content-type': MIME[ext] || 'application/octet-stream' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  const { initDatabase } = require('./db/database')
  initDatabase()

  require('./ipc')

  createWindow()

  const watcher = require('./services/processWatcher')
  watcher.start()

  // The overlay window is created lazily on the first session-start / achievement
  // (overlayWindow.sendX queues the message until it finishes loading), so there's
  // no persistent extra renderer process while the app sits idle in the tray.

  const crackWatcher = require('./services/crackWatcher')
  crackWatcher.startWatching()

  // Global hotkey: flash the current session time + achievement progress over the
  // game (works while a game has focus). Registration can fail if another app
  // already owns the combo — logged, non-fatal.
  try {
    const ok = globalShortcut.register('Alt+K', () => {
      try { require('./services/statusFlash').flash() } catch {}
    })
    if (!ok) require('./logger').warn('globalShortcut Alt+K registration failed (in use by another app)')
  } catch (e) {
    require('./logger').warn('globalShortcut Alt+K error: ' + e.message)
  }

  // Global hotkey: show the current game's achievement list over the game, and
  // press again to dismiss it. Read-only — there is deliberately no way to mark
  // anything from here (an earlier manual-marking panel on this same hotkey was
  // removed on purpose; this is a display-only successor).
  // While the list is open, achievementListFlash also binds Alt+Down / Alt+Up
  // to scroll it — those are registered only for as long as it's on screen,
  // since the overlay can never take keyboard focus itself.
  try {
    const ok = globalShortcut.register('Alt+J', () => {
      try { require('./services/achievementListFlash').flash() } catch {}
    })
    if (!ok) require('./logger').warn('globalShortcut Alt+J registration failed (in use by another app)')
  } catch (e) {
    require('./logger').warn('globalShortcut Alt+J error: ' + e.message)
  }

  // Periodic safety-net for automatic backup (no-op unless the user enabled it)
  require('./services/autoBackup').startPeriodic()

  // Silently fill in any missing game genres in the background — no button,
  // no progress UI. Delayed so it doesn't compete with startup work.
  setTimeout(() => {
    require('./services/steamApi').runGenreBackfill().catch(() => {})
  }, 8000)

  // Automatic achievement catch-up on startup, so unlocks earned while KoZo was
  // closed appear on their own — no manual sync button needed, ever. Both
  // sweeps walk the disk, so both are deferred until nothing is playing (KoZo
  // is often launched *by* a game session, or starts minimized while one is
  // already running).
  // Tell the truth about what's actually installed. Cheap (one fs.access per
  // game), and the UI already renders is_installed=0 properly — it just was
  // never being updated after a drive change or reinstall.
  setTimeout(() => {
    watcher.runWhenIdle('installCheck', () => {
      require('./services/installCheck').reconcile().catch(() => {})
    })
  }, 6000)

  // Re-test the Steam profile's readability once per launch. The private-profile
  // warning is persisted, and nothing else clears it — set Game details back to
  // Public and the banner would otherwise keep warning about a solved problem.
  // One request, and only when the flag is actually set.
  setTimeout(() => {
    try {
      const flag = require('./db/queries/settings').getSetting('steam_profile_private')
      if (!flag) return
      watcher.runWhenIdle('steamPrivacyRecheck', () => {
        require('./services/achievementSync').revalidateProfilePrivacy().catch(() => {})
      })
    } catch {}
  }, 10000)

  setTimeout(() => {
    watcher.runWhenIdle('startupCatchUp', () => {
      // Cracked games: emulator save files.
      require('./services/crackWatcher').scanAllCrackedGames().catch(() => {})
      // Steam games: the Steam client's own local stats files. This needs no
      // API key and — unlike the Web API — works with a private profile, which
      // is why it's the primary path rather than a fallback.
      require('./services/steamStatsWatcher').scanAllSteamGames().catch(() => {})
    })
  }, 20000)

  // "It's out now!" — notify when a tracked upcoming game's release date passes.
  try { require('./services/releaseWatch').start() } catch {}

  // Auto-update from GitHub Releases (packaged builds only; silent when the
  // release repo isn't configured yet).
  try { require('./services/appUpdater').setupAutoUpdate() } catch {}

  // Zero-setup Steam: if no SteamID is saved yet, read the logged-in account
  // from the local Steam install so the user never has to type it.
  try {
    const settingsQ = require('./db/queries/settings')
    if (!settingsQ.getSetting('steam_user_id')) {
      const d = require('./services/steamStatsWatcher').detectLoggedInUser()
      if (d?.steamId) {
        settingsQ.setSetting('steam_user_id', d.steamId)
        if (d.personaName) settingsQ.setSetting('steam_persona', d.personaName)
        require('./logger').info(`Auto-detected Steam account: ${d.personaName || d.steamId}`)
      }
    }
  } catch {}

  const trayHandle = setupTray(watcher)
  watcher.onChange(() => trayHandle?.refreshMenu())

  // "New game detected" is a notification now: it goes to the overlay window
  // (visible over any game or the desktop) instead of a card inside the app.
  // The overlay's "Add to library" button calls back via overlay:addUnknownGame,
  // which brings up the main window with the Add flow prefilled.
  watcher.onUnknownProcess((data) => {
    try { require('./overlayWindow').sendUnknownGame(data) } catch (e) {
      try { require('./logger').warn('unknown-game notify failed: ' + e.message) } catch {}
    }
  })
})

app.on('will-quit', () => {
  require('./services/processWatcher').stop()
  require('./services/crackWatcher').stopWatching()
  try { require('./services/autoBackup').flush() } catch {}
  // Save snapshots deferred to idle would otherwise die with the process.
  try { require('./services/autoSaveBackup').flushPending() } catch {}
  try { globalShortcut.unregisterAll() } catch {}
})

app.on('window-all-closed', () => {
  // The main window is deliberately destroyed while parked in the tray to
  // free RAM (see armDestroyTimer) — that leaves zero windows without
  // meaning to quit. Only actually quit if the user chose to (Quit from tray
  // / an OS quit sets isQuitting before any window closes).
  if (app.isQuitting) app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('activate', () => { getOrCreateMainWindow() })

module.exports = { getMainWindow: () => mainWindow, getOrCreateMainWindow }
