'use strict'

// Library cards show a cover about 200 to 300 px wide, but covers are kept 600 px wide
// (steamApi.shrinkCover) for the game page and Big Picture. Every cover a card drew was held
// at full size by the graphics process: 500 games scrolled through took about 675 MB
// (scripts/perf-check.js). A card asks for `kozo://local/<path>?card=1` and gets a copy
// CARD_W wide from <userData>/card-covers once it exists; until then the original, while the
// copy is made in the background. The Library asks for it only when the card is drawn
// CARD_W device pixels wide or less, so a card never looks softer than before.
//
// Copies are made one at a time, a little apart, never while a game runs (the image work is
// on the main thread). A copy is named by its original's path and modified time, so a cover
// changed in place gets a new copy, and `cleanup` (once, at an idle start) removes copies of
// covers no game uses any more.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const logger = require('../logger')

const CARD_W = 360
const GAP_MS = 120
const queue = new Map()          // copy path → original
const small = new Set()          // originals already CARD_W or narrower: served as they are
let working = false

function dir() { return path.join(require('electron').app.getPath('userData'), 'card-covers') }
function hashOf(file) { return crypto.createHash('sha1').update(String(file).toLowerCase()).digest('hex').slice(0, 20) }

// The file to serve for a card: the copy when it's ready, else the original (and a copy is queued).
async function pick(original) {
  try {
    if (small.has(original)) return original
    const st = await fs.promises.stat(original)
    const copy = path.join(dir(), `${hashOf(original)}-${Math.round(st.mtimeMs)}.jpg`)
    try { await fs.promises.access(copy); return copy } catch {}
    if (!queue.has(copy)) { queue.set(copy, original); if (!working) setTimeout(work, GAP_MS) }
  } catch {}
  return original
}

function busy() {
  try { return require('./processWatcher').isSessionActive() } catch { return false }
}

function work() {
  if (working) return
  if (!queue.size) return
  if (busy()) { setTimeout(work, 30000); return }   // after the game
  working = true
  const [copy, original] = queue.entries().next().value
  queue.delete(copy)
  try {
    const { nativeImage } = require('electron')
    const img = nativeImage.createFromPath(original)
    const { width } = img.getSize()
    if (img.isEmpty() || width <= CARD_W) small.add(original)
    else {
      fs.mkdirSync(dir(), { recursive: true })
      const tmp = copy + '.part'
      fs.writeFileSync(tmp, img.resize({ width: CARD_W, quality: 'good' }).toJPEG(85))
      fs.renameSync(tmp, copy)
      // The copy of the same cover from before it changed.
      const prefix = path.basename(copy).split('-')[0] + '-'
      for (const f of fs.readdirSync(dir())) if (f.startsWith(prefix) && path.join(dir(), f) !== copy) { try { fs.unlinkSync(path.join(dir(), f)) } catch {} }
    }
  } catch (e) { logger.debug('cardCovers: copy failed', { message: e.message }) }
  working = false
  if (queue.size) setTimeout(work, GAP_MS)
}

// Copies of covers no game uses any more (a new cover is a new file, see applyArt).
function cleanup() {
  try {
    const d = dir()
    if (!fs.existsSync(d)) return
    const live = new Set(require('../db/database').getDb()
      .prepare("SELECT banner_local_path AS p FROM games WHERE banner_local_path IS NOT NULL AND banner_local_path != ''")
      .all().map(r => hashOf(r.p)))
    let removed = 0
    for (const f of fs.readdirSync(d)) {
      if (!live.has(f.split('-')[0]) || f.endsWith('.part')) { try { fs.unlinkSync(path.join(d, f)); removed++ } catch {} }
    }
    if (removed) logger.info(`cardCovers: removed ${removed} unused card cover(s)`)
  } catch (e) { logger.debug('cardCovers: cleanup failed', { message: e.message }) }
}

// How many copies are still to be made (scripts/perf-check.js waits for them).
function pending() { return queue.size + (working ? 1 : 0) }

module.exports = { pick, cleanup, pending, CARD_W, hashOf }
