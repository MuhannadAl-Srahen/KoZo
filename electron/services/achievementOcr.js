'use strict'

// Last-resort AUTOMATIC achievement detection for cracks with NO working
// Steam-emulator backend at all (crackWatcher.detectEmulator returns null, or
// 'GFWL') — nothing is ever written to disk when these games' achievements
// pop, so file-watching has nothing to watch. Some of these games still
// render their own on-screen "Achievement Unlocked" banner (drawn by the game
// engine itself, independent of any platform overlay) — this periodically
// screenshots the game, OCRs it, and fuzzy-matches recognized text against
// the game's already-imported achievement list, auto-unlocking on a
// confident hit. Applies to ANY game that hits this wall, not one title.
//
// Scoped tightly: only runs while such a game is the active session (started
// by crackWatcher.watchGame/unwatchGame, mirroring the file-watch lifecycle),
// polls slowly (screenshot + OCR is real CPU cost), and stops the moment the
// session ends or the setting is turned off.

const POLL_MS = 6000

// Screenshots are downscaled to at most this width before OCR. Banner text is
// still perfectly legible, and it cuts OCR cost ~4-6x on high-DPI displays.
const MAX_CAPTURE_WIDTH = 1600

const active = new Map()   // gameId -> setInterval handle
let worker = null
let workerPromise = null
let scanBusy = false       // single-flight: a slow OCR pass must never stack

function isEnabled() {
  try {
    const v = require('../db/queries/settings').getSetting('ocr_achievement_watch')
    // Default OFF. desktopCapturer's screen grab is a GPU/compositor readback —
    // doing it every 6s visibly hitches a fullscreen game (brief mouse freeze on
    // exactly that cadence). Users who need it for a no-emulator crack opt in
    // via Settings → About, where the toggle warns about the cost.
    return v === '1'
  } catch {
    return false
  }
}

function broadcastToRenderers(channel, payload) {
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  } catch {}
}

// Lazily spins up a single shared Tesseract worker (English, LSTM-only — the
// fast/small model, plenty for short UI banner text). cachePath keeps the
// downloaded language data in userData so it only ever fetches once, and
// works fully offline after that.
async function getWorker() {
  if (worker) return worker
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js')
      const { app } = require('electron')
      const path = require('path')
      const fs = require('fs')
      const cachePath = path.join(app.getPath('userData'), 'ocr-cache')
      try { fs.mkdirSync(cachePath, { recursive: true }) } catch {}
      const w = await createWorker('eng', 1, { cachePath, cacheMethod: 'readWrite' })
      worker = w
      return w
    })()
    workerPromise.catch((e) => {
      workerPromise = null
      try { require('../logger').warn('achievementOcr: worker init failed: ' + e.message) } catch {}
    })
  }
  return workerPromise
}

function normalize(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// Requires the achievement's normalized name to appear as a contiguous
// substring of some OCR'd line (or the reverse, for a short banner fragment
// containing a longer name) — much stricter than word-overlap scoring, which
// is what makes it safe to auto-unlock on a hit with no human confirmation.
function findMatch(lines, achievements) {
  const locked = achievements.filter(a => !a.unlocked_at && a.display_name)
  if (!locked.length) return null
  for (const rawLine of lines) {
    const line = normalize(rawLine)
    if (line.length < 4) continue
    for (const ach of locked) {
      const name = normalize(ach.display_name)
      if (name.length < 4) continue
      if (line.includes(name) || (line.length > 8 && name.includes(line))) return ach
    }
  }
  return null
}

async function scanOnce(gameId) {
  // One pass at a time: on a slow machine (or 4K screen) OCR can take longer
  // than the poll interval — without this guard, passes stack up and the whole
  // app starts stuttering.
  if (scanBusy) return
  scanBusy = true
  try {
    const gamesQ = require('../db/queries/games')
    const achievementsQ = require('../db/queries/achievements')
    const game = gamesQ.getGame(gameId)
    if (!game) return
    const achievements = achievementsQ.listAchievementsForGame(gameId) || []
    if (!achievements.some(a => !a.unlocked_at)) return   // nothing left to catch

    const { desktopCapturer, screen } = require('electron')
    const display = screen.getPrimaryDisplay().size
    const scale = Math.min(1, MAX_CAPTURE_WIDTH / display.width)
    const width  = Math.round(display.width * scale)
    const height = Math.round(display.height * scale)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    if (!sources.length) return
    const png = sources[0].thumbnail.toPNG()
    if (!png || !png.length) return

    const w = await getWorker()
    const { data } = await w.recognize(png)
    const lines = (data?.text || '').split('\n').map(l => l.trim()).filter(Boolean)
    const match = findMatch(lines, achievements)
    if (!match) return

    const unlocked_at = new Date().toISOString()
    achievementsQ.addUnlock({ achievement_id: match.id, session_id: null, unlocked_at, source: 'ocr' })
    try { require('./autoBackup').markDirty() } catch {}
    broadcastToRenderers('game:updated', game.id)
    if (!global.__kozoSilenceAchNotify) {
      const payload = { gameId: game.id, achievements: [{ ...match, unlocked_at }], gameName: game.name, artPath: game.banner_local_path, artUrl: game.banner_url }
      broadcastToRenderers('achievement:unlocked', payload)
      try { require('../overlayWindow').sendAchievements(payload) } catch {}
      try { require('./xpTracker').check({ reason: 'achievement', gameName: game.name, artPath: payload.artPath, artUrl: payload.artUrl }) } catch {}
    }
    try { require('../logger').info(`achievementOcr: matched "${match.display_name}" for "${game.name}" from on-screen text`) } catch {}
  } catch (e) {
    try { require('../logger').warn('achievementOcr.scanOnce: ' + e.message) } catch {}
  } finally {
    scanBusy = false
  }
}

function start(gameId) {
  if (!isEnabled() || active.has(gameId)) return
  active.set(gameId, setInterval(() => scanOnce(gameId), POLL_MS))
}

function stop(gameId) {
  const t = active.get(gameId)
  if (t) { clearInterval(t); active.delete(gameId) }
  // No game left watching → release the worker now instead of waiting for app
  // quit. It holds a WASM instance + worker_thread (~100MB+); previously a
  // single OCR-enabled session leaked that for the rest of the app's run.
  if (active.size === 0 && worker) {
    try { worker.terminate() } catch {}
    worker = null
    workerPromise = null
  }
}

// Full teardown (app quit) — stop every poll loop and release the OCR worker
// (it holds a WASM instance + worker_thread, not worth keeping idle).
function stopAll() {
  for (const gameId of [...active.keys()]) stop(gameId)
  if (worker) { try { worker.terminate() } catch {} ; worker = null }
  workerPromise = null
}

module.exports = { start, stop, stopAll }
