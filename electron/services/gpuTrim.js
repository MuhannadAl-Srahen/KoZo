'use strict'

// Gives back the memory Chromium's graphics process keeps after KoZo's windows
// are gone. It holds what it drew (covers, trailers, page layers) and Electron
// has no call to release it: measured with the window closed, 74 MB after the
// Library and 295 MB after Upcoming. On graphics built into the processor that
// is ordinary RAM, and it is most of what Task Manager shows for KoZo in the tray.
// Ending the process frees it; Chromium starts a fresh one (about 30 MB) the
// next time something is drawn. Measured: the reopened window drew normally,
// with graphics acceleration still on.
//
// Chromium counts a graphics process that ends as a crash, and after a few
// close together it stops using the graphics card. So this runs at most once
// every 2 hours (Chromium forgives one per hour), never with a window on
// screen, never during a game or its launch (the overlay is up then), and only
// when the process holds enough to be worth it.

const { app, BrowserWindow } = require('electron')
const logger = require('../logger')

const WAIT_MS = 30 * 1000                  // after the last window went away
const MIN_GAP_MS = 2 * 60 * 60 * 1000      // between two restarts
const MIN_MB = 150                         // below this, leave it alone

let timer = null
let lastAt = 0

// Pure: should the graphics process be restarted now?
function shouldTrim({ now, lastAt, windowShown, sessionActive, compositing, mb }) {
  if (now - lastAt < MIN_GAP_MS) return false
  if (windowShown || sessionActive) return false
  if (!String(compositing || '').startsWith('enabled')) return false   // software drawing: nothing to free
  return mb >= MIN_MB
}

function run() {
  timer = null
  try {
    const gpu = app.getAppMetrics().find(m => m.type === 'GPU')
    if (!gpu) return
    const kb = gpu.memory?.privateBytes ?? gpu.memory?.workingSetSize ?? 0
    const mb = Math.round(kb / 1024)
    let sessionActive = false
    try { sessionActive = require('./processWatcher').isSessionActive() } catch {}
    const ok = shouldTrim({
      now: Date.now(),
      lastAt,
      windowShown: BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isVisible()),
      sessionActive,
      compositing: app.getGPUFeatureStatus()?.gpu_compositing,
      mb,
    })
    if (!ok) return
    lastAt = Date.now()
    process.kill(gpu.pid)
    logger.info(`gpuTrim: restarted the graphics process to free ${mb} MB`)
  } catch (e) {
    logger.debug('gpuTrim: skipped', { message: e.message })
  }
}

// Called when the main window unloads and when the overlay is torn down.
function schedule() {
  clearTimeout(timer)
  timer = setTimeout(run, WAIT_MS)
  if (timer.unref) timer.unref()
}

module.exports = { schedule, shouldTrim, MIN_GAP_MS, MIN_MB }
