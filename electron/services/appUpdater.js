'use strict'

// Auto-update via electron-updater + GitHub Releases. Fully silent when the
// publish repo isn't configured yet (package.json build.publish owner is
// REPLACE_ME) or when running unpackaged — the Settings button reports a
// friendly "not configured" instead of an error.

const logger = require('../logger')

let _wired = false

function getAutoUpdater() {
  const { autoUpdater } = require('electron-updater')
  if (!_wired) {
    _wired = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('error', (e) => logger.warn('appUpdater:', { message: e?.message }))
    autoUpdater.on('update-downloaded', async (info) => {
      try {
        const { dialog } = require('electron')
        const r = await dialog.showMessageBox({
          type: 'info',
          title: 'KoZo update ready',
          message: `KoZo ${info?.version || ''} has been downloaded.`,
          detail: 'Restart now to apply the update, or it installs automatically the next time you quit.',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
        })
        if (r.response === 0) autoUpdater.quitAndInstall()
      } catch (e) {
        logger.warn('appUpdater: update-downloaded dialog failed', { message: e.message })
      }
    })
  }
  return autoUpdater
}

// Startup check — fire-and-forget, never throws outward.
function setupAutoUpdate() {
  const { app } = require('electron')
  if (!app.isPackaged) return
  setTimeout(() => {
    try {
      getAutoUpdater().checkForUpdatesAndNotify().catch((e) => {
        logger.warn('appUpdater: startup check failed', { message: e?.message })
      })
    } catch (e) {
      logger.warn('appUpdater: setup failed', { message: e.message })
    }
  }, 15000)
}

// Manual check for the Settings button. Always resolves within 15s — a slow or
// unreachable update server must never leave the button spinning forever.
async function checkForUpdates() {
  const { app } = require('electron')
  if (!app.isPackaged) return { dev: true, current: app.getVersion() }
  try {
    const result = await Promise.race([
      getAutoUpdater().checkForUpdates(),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('timed_out')), 15000)
        t.unref?.()
      }),
    ])
    const latest = result?.updateInfo?.version || null
    return {
      current: app.getVersion(),
      latest,
      updateAvailable: !!(latest && latest !== app.getVersion()),
    }
  } catch (e) {
    const msg = e?.message || ''
    if (msg === 'timed_out') {
      return { current: app.getVersion(), error: 'timed_out' }
    }
    if (/404|ENOTFOUND|Unable to find|releases/i.test(msg)) {
      return { current: app.getVersion(), notConfigured: true }
    }
    return { current: app.getVersion(), error: msg }
  }
}

module.exports = { setupAutoUpdate, checkForUpdates }
