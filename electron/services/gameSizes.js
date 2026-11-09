'use strict'

// Settings > Data > Storage: how much space each game uses, per disk. A game folder's
// size is counted file by file (async, a small pause every few hundred files, so a
// 100 GB game doesn't freeze anything), never while a game is running, and kept in
// games.size_bytes / size_at so the page opens at once. A size older than a week, or
// missing, is counted again when the page opens.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const STALE_MS = 7 * 24 * 60 * 60 * 1000
let running = null

const db = () => require('../db/database').getDb()
const broadcast = (payload) => {
  try { for (const w of require('electron').BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('storage:progress', payload) } catch {}
}
const busy = () => { try { return require('./processWatcher').isSessionActive() } catch { return false } }

// Pure: the drive a path is on ("C:"), or null.
function driveOf(p) {
  const m = /^([a-z]):/i.exec(String(p || ''))
  return m ? m[1].toUpperCase() + ':' : null
}

// Pure: the overview the page shows. Games grouped under their drive, biggest first.
function group(drives, games) {
  const out = drives.map(d => ({ ...d, games: [], gamesBytes: 0 }))
  for (const g of games) {
    const drive = driveOf(g.install_path)
    let d = out.find(x => x.drive === drive)
    if (!d) { d = { drive: drive || '?', free: 0, size: 0, games: [], gamesBytes: 0, missing: true }; out.push(d) }
    d.games.push(g)
    d.gamesBytes += g.size || 0
  }
  for (const d of out) d.games.sort((a, b) => (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name))
  return out.filter(d => !d.missing || d.games.length)
}

async function drives() {
  let list = []
  try { list = await require('./backupHome').fixedDrivesAsync() } catch {}
  // Free space now, not when KoZo started (fixedDrives is read once per run). Asked without
  // blocking: a sleeping hard drive took up to 0.35 s to answer, and KoZo froze meanwhile.
  return Promise.all(list.map(async d => {
    try {
      const st = await fs.promises.statfs(d.drive + '\\')
      return { drive: d.drive, free: st.bavail * st.bsize, size: st.blocks * st.bsize }
    } catch { return { drive: d.drive, free: d.free, size: d.size } }
  }))
}

async function overview() {
  const games = db().prepare(`SELECT id, name, install_path, size_bytes AS size, size_at FROM games
    WHERE COALESCE(is_archived, 0) = 0 AND install_path IS NOT NULL AND install_path != '' AND COALESCE(is_installed, 1) = 1`).all()
  return { drives: group(await drives(), games), counting: !!running }
}

async function folderBytes(dir, stop) {
  let total = 0, seen = 0
  const stack = [dir]
  while (stack.length) {
    if (stop()) return null
    const d = stack.pop()
    let list
    try { list = await fs.promises.readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of list) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) { try { total += (await fs.promises.stat(p)).size } catch {} }
      if (++seen % 400 === 0) await new Promise(r => setTimeout(r, 5))
    }
  }
  return total
}

// Counts the games whose size is missing or older than a week (or all, `force`).
function measure({ force = false } = {}) {
  if (running) return running
  running = (async () => {
    const rows = db().prepare(`SELECT id, name, install_path, size_at FROM games
      WHERE COALESCE(is_archived, 0) = 0 AND install_path IS NOT NULL AND install_path != '' AND COALESCE(is_installed, 1) = 1`).all()
    const todo = rows.filter(r => force || !r.size_at || Date.now() - new Date(r.size_at).getTime() > STALE_MS)
    let done = 0
    broadcast({ done, total: todo.length })
    for (const r of todo) {
      if (busy()) break   // a game started: stop, the rest waits for the next visit
      if (!fs.existsSync(r.install_path)) { done++; continue }
      const bytes = await folderBytes(r.install_path, busy)
      if (bytes == null) break
      db().prepare('UPDATE games SET size_bytes = ?, size_at = ? WHERE id = ?').run(bytes, new Date().toISOString(), r.id)
      done++
      broadcast({ done, total: todo.length, gameId: r.id })
    }
    return { done, total: todo.length }
  })().catch(e => { logger.warn('gameSizes: counting failed', { message: e.message }); return null })
    .finally(() => { running = null; broadcast({ finished: true }) })
  return running
}

module.exports = { overview, measure, driveOf, group }
