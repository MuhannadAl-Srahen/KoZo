'use strict'

// A second copy of the backups in a folder the user picks: a cloud sync folder
// (Google Drive, Dropbox, MEGA, iCloud: cloudFolders.js) or a USB stick or other
// drive. The provider's own app uploads it to the user's own storage, so it costs
// KoZo nothing and needs no account or key.
//
// Setting `backup_copy_dir` = <picked folder>\KoZo Backup, same layout as the
// local folder (Saves\, Data\), so restoring reads it like any other backup.
// Local backups always stay: this is a copy, never a move. saveVault's mirror
// does the save files; this file adds the library file, the status and the rules.

const fs   = require('fs')
const path = require('path')
const logger = require('../logger')

const DATA_NAME = 'kozo-autobackup.json'

function settings() { return require('../db/queries/settings') }
function vault() { return require('./saveVault') }
function home() { return require('./backupHome') }

function dir() { return String(settings().getSetting('backup_copy_dir') || '').trim() || null }

function norm(p) { return path.resolve(String(p)).toLowerCase().replace(/[\\/]+$/, '') + path.sep }
// True when one folder is the other, or inside it.
function overlaps(a, b) {
  const x = norm(a), y = norm(b)
  return x.startsWith(y) || y.startsWith(x)
}

// <picked>\KoZo Backup, unless they picked a folder already named that.
function copyPathFor(picked) {
  const p = path.resolve(String(picked))
  return path.basename(p).toLowerCase() === 'kozo backup' ? p : path.join(p, 'KoZo Backup')
}

// Throws a message fit to show when this can't be the copy folder.
function validate(copyPath) {
  if (home().isVolatile(copyPath)) throw new Error('That folder gets cleaned out (Temp, Downloads or Desktop). Pick another one')
  const base = home().base()
  if (base && overlaps(copyPath, base)) throw new Error('KoZo already keeps its backups there. Pick a different folder')
}

function broadcast() {
  status().then((st) => {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) { if (!w.isDestroyed()) w.webContents.send('backup:copyStatus', st) }
  }).catch(() => {})
}

// ── The library file ────────────────────────────────────────────────────────
// A file another install wrote (another PC, a fresh Windows) is kept beside
// under a dated name, never overwritten, the same rule autoBackup uses locally.
function asideName(dataDir, head) {
  const owner = /"install":"([^"]+)"/.exec(head)?.[1] || 'old'
  return path.join(dataDir, `kozo-autobackup-${new Date().toISOString().slice(0, 10)}-${owner.slice(0, 6)}.json`)
}
function mine(head, me) { return /"install":"([^"]+)"/.exec(head)?.[1] === me }
function installId() { return settings().getSetting('install_id') }

async function copyData(file) {
  const d = dir()
  if (!d || !file) return false
  const dataDir = path.join(d, 'Data')
  const dest = path.join(dataDir, DATA_NAME)
  try {
    await fs.promises.mkdir(dataDir, { recursive: true })
    try {
      const head = (await fs.promises.readFile(dest, 'utf8')).slice(0, 400)
      if (!mine(head, installId())) await fs.promises.rename(dest, asideName(dataDir, head))
    } catch {}
    await fs.promises.copyFile(file, `${dest}.tmp`)
    await fs.promises.rename(`${dest}.tmp`, dest)
    return true
  } catch (e) {
    logger.warn('backupCopy: library copy failed', { message: e.message })
    return false
  }
}

// For the quit flush, where async work would never finish.
function copyDataSync(file) {
  const d = dir()
  if (!d || !file) return false
  const dataDir = path.join(d, 'Data')
  const dest = path.join(dataDir, DATA_NAME)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    try {
      const head = fs.readFileSync(dest, 'utf8').slice(0, 400)
      if (!mine(head, installId())) fs.renameSync(dest, asideName(dataDir, head))
    } catch {}
    // Own temp name: an async copyData may still hold `${dest}.tmp` open.
    fs.copyFileSync(file, `${dest}.flush.tmp`)
    fs.renameSync(`${dest}.flush.tmp`, dest)
    return true
  } catch (e) {
    logger.warn('backupCopy: library copy failed', { message: e.message })
    return false
  }
}

// ── Sync ────────────────────────────────────────────────────────────────────
let syncing = null
let soonTimer = null

function localDataFile() {
  const d = settings().getSetting('auto_backup_dir')
  return d ? path.join(d, DATA_NAME) : null
}

function syncNow() {
  if (syncing) return syncing
  syncing = (async () => {
    const r = await vault().syncMirror()
    if (dir()) {
      const local = localDataFile()
      if (!r.error && local && fs.existsSync(local)) await copyData(local)
      settings().setSetting('backup_copy_error', r.error || '')
    }
    // A game started part way through: finish when it closes.
    if (r.paused) syncSoon(0)
    return r
  })().finally(() => { syncing = null; broadcast() })
  broadcast()
  return syncing
}

function syncSoon(ms = 60000) {
  if (!dir() && !vault().mirrorRoot()) return
  clearTimeout(soonTimer)
  soonTimer = setTimeout(() => {
    const run = () => { syncNow().catch(e => logger.warn('backupCopy: sync failed', { message: e.message })) }
    try { require('./processWatcher').runWhenIdle('backupCopySync', run) } catch { run() }
  }, ms)
  soonTimer.unref?.()
}

// ── Choosing ────────────────────────────────────────────────────────────────
// Start copying to `picked`. The first copy runs in the background.
function set(picked) {
  const copyPath = copyPathFor(picked)
  validate(copyPath)
  fs.mkdirSync(copyPath, { recursive: true })
  const s = settings()
  s.setSetting('backup_copy_dir', copyPath)
  s.setSetting('backup_copy_error', '')
  logger.info(`backupCopy: copying backups to ${copyPath}`)
  syncNow().catch(e => logger.warn('backupCopy: first copy failed', { message: e.message }))
  return copyPath
}

// Stop copying. Files already there stay.
function off() {
  const s = settings()
  s.setSetting('backup_copy_dir', '')
  s.setSetting('backup_copy_error', '')
  broadcast()
  return true
}

async function status() {
  const d = dir()
  if (!d) return { configured: false }
  const s = settings()
  const reachable = await require('./cloudFolders').isDir(d)
  return {
    configured: true,
    dir: d,
    reachable,
    syncing: !!syncing,
    lastAt: s.getSetting('save_mirror_last') || null,
    error: s.getSetting('backup_copy_error') || null,
  }
}

// "KoZo Backup" folders inside the cloud folders found here, and the current
// copy folder, for the restore lists.
async function existingCopies() {
  const { detect, isDir } = require('./cloudFolders')
  const found = (await detect()).map(c => path.join(c.path, 'KoZo Backup'))
  const cur = dir()
  if (cur) found.push(cur)
  const out = []
  for (const p of found) {
    if (out.some(x => norm(x) === norm(p))) continue
    if (await isDir(path.join(p, 'Data')) || await isDir(path.join(p, 'Saves'))) out.push(p)
  }
  return out
}

// A folder the user pointed at to restore from: the folder itself, or the
// "KoZo Backup" inside it. Null when neither holds a backup.
function resolveBackupFolder(picked) {
  const p = path.resolve(String(picked))
  const has = (x) => fs.existsSync(path.join(x, 'Data')) || fs.existsSync(path.join(x, 'Saves'))
  if (has(p)) return p
  const inside = path.join(p, 'KoZo Backup')
  return has(inside) ? inside : null
}

module.exports = {
  dir, overlaps, copyPathFor, validate, set, off, status, syncNow, syncSoon,
  copyData, copyDataSync, existingCopies, resolveBackupFolder,
}
