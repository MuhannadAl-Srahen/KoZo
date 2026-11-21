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

const ic = () => require('./installCheck')

// Pure: the folder that holds the whole game. The stored path is often the game file's own
// folder: Crimson Desert's "bin64" (counted 0.69 GB), Phantom Blade Zero's "PBZ\steam" (0 GB), an
// Unreal game's "<Project>\Binaries\Win64". A Steam game's is steamapps\common\<installdir>; others
// lose the build folders installCheck knows (bin64, Binaries, Win64...), and an Unreal game goes up
// past its project folder when the engine sits beside it. Never a drive. hasDir(p) answers whether
// a folder exists (only asked for that Unreal check).
function sizeRoot(installPath, hasDir = () => false) {
  const p = String(installPath || '').replace(/[\\/]+$/, '')
  if (!p) return null
  const sf = ic().steamFolderOf(p)
  if (sf) return `${sf.steamapps}\\common\\${sf.installdir}`
  const { tail } = ic().splitGameFolder(p)
  let root = tail ? p.slice(0, p.length - tail.length).replace(/[\\/]+$/, '') : p
  if (/(^|[\\/])binaries([\\/]|$)/i.test(tail)) {
    const up = root.replace(/[\\/][^\\/]+$/, '')
    if (up !== root && hasDir(`${up}\\Engine`)) root = up
  }
  return /^[a-z]:$/i.test(root) || !root ? p : root
}

// Pure: games whose folders are the same or one inside the other are counted once, under the
// outer one; the others get `inside` (that game's name) and leave the drive's total alone.
function dedupe(games) {
  const norm = (r) => String(r || '').toLowerCase().replace(/[\\/]+/g, '\\').replace(/\\$/, '')
  const kept = []
  const sorted = games.slice().sort((a, b) => norm(a.root).length - norm(b.root).length || a.id - b.id)
  for (const g of sorted) {
    const r = norm(g.root)
    const outer = r && kept.find(k => r === norm(k.root) || r.startsWith(norm(k.root) + '\\'))
    if (outer) g.inside = outer.name
    else kept.push(g)
  }
  return games
}

// Pure: the overview the page shows. Games grouped under their drive, biggest first.
function group(drives, games) {
  const out = drives.map(d => ({ ...d, games: [], gamesBytes: 0 }))
  for (const g of games) {
    const drive = driveOf(g.install_path)
    let d = out.find(x => x.drive === drive)
    if (!d) { d = { drive: drive || '?', free: 0, size: 0, games: [], gamesBytes: 0, missing: true }; out.push(d) }
    d.games.push(g)
    if (!g.inside) d.gamesBytes += g.size || 0
  }
  for (const d of out) d.games.sort((a, b) => !!a.inside - !!b.inside || (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name))
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

const hasDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }

async function overview() {
  const games = db().prepare(`SELECT id, name, install_path, size_bytes AS size, size_at FROM games
    WHERE COALESCE(is_archived, 0) = 0 AND install_path IS NOT NULL AND install_path != '' AND COALESCE(is_installed, 1) = 1`).all()
  for (const g of games) g.root = sizeRoot(g.install_path, hasDir) || g.install_path
  return { drives: group(await drives(), dedupe(games)), counting: !!running }
}

// A Steam game's size as Steam keeps it (the manifest's SizeOnDisk): exact, and no disk walk.
async function steamSize(installPath, appid) {
  const sf = ic().steamFolderOf(installPath)
  if (!sf || !appid) return null
  try {
    const acf = ic().parseAcf(await fs.promises.readFile(path.join(sf.steamapps, `appmanifest_${appid}.acf`), 'utf8'))
    if (!acf || acf.installdir.toLowerCase() !== sf.installdir.toLowerCase()) return null
    return acf.sizeOnDisk > 0 ? acf.sizeOnDisk : null
  } catch { return null }
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
    const rows = db().prepare(`SELECT id, name, install_path, steam_app_id, size_at, size_root FROM games
      WHERE COALESCE(is_archived, 0) = 0 AND install_path IS NOT NULL AND install_path != '' AND COALESCE(is_installed, 1) = 1`).all()
    for (const r of rows) r.root = sizeRoot(r.install_path, hasDir) || r.install_path
    // Missing, a week old, or counted from another folder (sizes before the root fix were the
    // game file's folder only).
    const todo = rows.filter(r => force || !r.size_at || r.size_root !== r.root || Date.now() - new Date(r.size_at).getTime() > STALE_MS)
    let done = 0
    broadcast({ done, total: todo.length })
    for (const r of todo) {
      if (busy()) break   // a game started: stop, the rest waits for the next visit
      if (!fs.existsSync(r.root)) { done++; continue }
      const bytes = (await steamSize(r.install_path, r.steam_app_id)) ?? await folderBytes(r.root, busy)
      if (bytes == null) break
      db().prepare('UPDATE games SET size_bytes = ?, size_at = ?, size_root = ? WHERE id = ?').run(bytes, new Date().toISOString(), r.root, r.id)
      done++
      broadcast({ done, total: todo.length, gameId: r.id })
    }
    return { done, total: todo.length }
  })().catch(e => { logger.warn('gameSizes: counting failed', { message: e.message }); return null })
    .finally(() => { running = null; broadcast({ finished: true }) })
  return running
}

module.exports = { overview, measure, driveOf, group, sizeRoot, dedupe }
