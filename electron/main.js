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

Menu.setApplicationMenu(null)

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#09090f',
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
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    // When startMin is true the window stays hidden — only the tray icon is visible.
    if (!startMin) mainWindow.show()
  })

  // Minimize to tray instead of quitting (wired up fully in tray step)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  // Open external links in the OS browser, not in the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// Focus the existing window if a second instance is launched.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

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
      const underData = filePath.toLowerCase().startsWith(app.getPath('userData').toLowerCase())
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

  // Periodic safety-net for automatic backup (no-op unless the user enabled it)
  require('./services/autoBackup').startPeriodic()

  const trayHandle = setupTray(mainWindow, watcher)
  watcher.onChange(() => trayHandle?.refreshMenu())

  // Prompt user to add unrecognized game-like processes to the library. Send to
  // the actual main window (not getAllWindows()[0], which can be the overlay
  // after a tray re-create), falling back to broadcasting to all renderers.
  watcher.onUnknownProcess(({ exe_name, install_path }) => {
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    if (target) target.webContents.send('unknown-process', { exe_name, install_path })
    else for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('unknown-process', { exe_name, install_path })
    }
  })
})

app.on('will-quit', () => {
  require('./services/processWatcher').stop()
  require('./services/crackWatcher').stopWatching()
  try { require('./services/autoBackup').flush() } catch {}
  try { globalShortcut.unregisterAll() } catch {}
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else mainWindow?.show()
})

module.exports = { getMainWindow: () => mainWindow }
