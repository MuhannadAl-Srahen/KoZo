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
      // checkForUpdates, NOT checkForUpdatesAndNotify — the latter fires a
      // native OS toast on download (§6: overlay/dialog are the only surfaces).
      getAutoUpdater().checkForUpdates().catch((e) => {
        logger.warn('appUpdater: startup check failed', { message: e?.message })
      })
    } catch (e) {
      logger.warn('appUpdater: setup failed', { message: e.message })
    }
  }, 15000)
}

// Plain GitHub Releases lookup — works in dev AND packaged, needs no
// electron-updater metadata, so "did I push a newer build to the repo?" can be
// answered even before the app is installed from a release.
function isNewer(latest, current) {
  const a = String(latest).split('.').map(n => parseInt(n, 10) || 0)
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

async function fetchLatestRelease() {
  const pkg = require('../../package.json')
  const pub = Array.isArray(pkg.build?.publish) ? pkg.build.publish[0] : pkg.build?.publish
  if (!pub?.owner || !pub?.repo || /replace_me/i.test(pub.owner)) return { notConfigured: true }
  const repo = `${pub.owner}/${pub.repo}`
  const axios = require('axios')
  const r = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, {
    timeout: 10_000,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KoZo' },
    validateStatus: () => true,
  })
  if (r.status === 404) return { noReleases: true, repo }
  if (r.status !== 200) return { error: `GitHub responded ${r.status}`, repo }
  const latest = String(r.data?.tag_name || '').replace(/^v/i, '') || null
  return {
    latest,
    repo,
    releaseUrl: r.data?.html_url || `https://github.com/${repo}/releases`,
  }
}

// Manual check for the Settings button. Always resolves within 15s — a slow or
// unreachable update server must never leave the button spinning forever.
async function checkForUpdates() {
  const { app } = require('electron')
  if (!app.isPackaged) {
    // Dev build: electron-updater can't install anything, but the repo can
    // still be QUERIED — report whether a newer release exists up on GitHub.
    const rel = await fetchLatestRelease().catch(e => ({ error: e?.message || 'fetch failed' }))
    return {
      dev: true,
      current: app.getVersion(),
      ...rel,
      updateAvailable: !!(rel.latest && isNewer(rel.latest, app.getVersion())),
    }
  }
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
      // electron-updater found no update metadata — check the repo directly so
      // "repo has no releases yet" and "misconfigured" get distinct answers.
      const rel = await fetchLatestRelease().catch(() => null)
      if (rel?.noReleases) return { current: app.getVersion(), noReleases: true, repo: rel.repo }
      if (rel?.latest) {
        return {
          current: app.getVersion(),
          latest: rel.latest,
          releaseUrl: rel.releaseUrl,
          repo: rel.repo,
          updateAvailable: isNewer(rel.latest, app.getVersion()),
          manualOnly: true,   // release exists but updater metadata (latest.yml) is missing
        }
      }
      return { current: app.getVersion(), notConfigured: true }
    }
    return { current: app.getVersion(), error: msg }
  }
}

module.exports = { setupAutoUpdate, checkForUpdates, fetchLatestRelease, isNewer }
