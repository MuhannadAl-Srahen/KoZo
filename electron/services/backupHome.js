'use strict'

// Where everything KoZo backs up lives on this PC, picked by KoZo:
//   <base>\Saves   game-save backups (saveVault)
//   <base>\Data    kozo-autobackup.json (library, playtime, lists)
// <base> is "KoZo Backup" on the fixed drive other than Windows' with the most
// free space (a Windows reinstall usually only wipes C:), else Documents.
// Never Temp, Downloads or a removable drive: people clean those. A folder
// found in one of those is moved out on startup. Off-PC copies: a folder the
// user picks (backupCopy.js) and Google Drive (googleDrive.js).

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const logger = require('../logger')

function settings() { return require('../db/queries/settings') }

// A folder people wipe or unplug. Pure apart from the env lookups.
function isVolatile(p) {
  if (!p) return false
  const abs = path.resolve(String(p)).toLowerCase() + path.sep
  const home = os.homedir()
  const bad = [
    os.tmpdir(),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Temp'),
    path.join(process.env.windir || 'C:\\Windows', 'Temp'),
    path.join(process.env.windir || 'C:\\Windows', 'Prefetch'),
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
  ].map(d => path.resolve(d).toLowerCase() + path.sep)
  if (bad.some(d => abs.startsWith(d))) return true
  return /[\\/]\$recycle\.bin[\\/]/i.test(abs)
}

// Fixed drives with free space (PowerShell CIM, once per run).
let drivesCache = null
function fixedDrives() {
  if (drivesCache) return drivesCache
  try {
    const out = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "$($_.DeviceID)|$($_.FreeSpace)|$($_.Size)" }'],
      { encoding: 'utf8', timeout: 15000, windowsHide: true })
    drivesCache = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      const [id, free, size] = l.split('|')
      return { drive: id.toUpperCase(), free: Number(free) || 0, size: Number(size) || 0 }
    })
  } catch (e) {
    logger.warn('backupHome: could not list drives', { message: e.message })
    drivesCache = []
  }
  return drivesCache
}

function documentsDir() {
  try { return require('electron').app.getPath('documents') } catch { return path.join(os.homedir(), 'Documents') }
}

// Pick the base: the non-system fixed drive with the most free space (at
// least 10 GB), else Documents.
function chooseBase() {
  // The smoke test's throwaway profile must never settle on a real drive.
  if (process.env.KOZO_SMOKE) return path.join(documentsDir(), 'KoZo Backup')
  const sys = (process.env.SystemDrive || 'C:').toUpperCase()
  const other = fixedDrives().filter(d => d.drive !== sys && d.free > 10 * 1024 ** 3).sort((a, b) => b.free - a.free)[0]
  return other ? `${other.drive}\\KoZo Backup` : path.join(documentsDir(), 'KoZo Backup')
}

function base() {
  const b = settings().getSetting('backup_base')
  return b && !isVolatile(b) ? b : null
}

// Move the saves and data folders into <base> when they're unset, in a folder
// people wipe, or in the old default (Documents\KoZo Saves). A folder the user
// chose somewhere safe is left alone. Also turns automatic backups on once.
function ensure() {
  const s = settings()
  let b = base()
  if (!b) {
    b = chooseBase()
    s.setSetting('backup_base', b)
    logger.info(`backupHome: backups live in ${b}`)
  }
  try { fs.mkdirSync(b, { recursive: true }) } catch (e) {
    logger.warn('backupHome: cannot create the backup folder, using Documents', { message: e.message })
    b = path.join(documentsDir(), 'KoZo Backup')
    s.setSetting('backup_base', b)
    fs.mkdirSync(b, { recursive: true })
  }

  const saveBackup = require('./saveBackup')
  const savesNow = s.getSetting('saves_backup_dir')
  const oldDefault = path.join(documentsDir(), 'KoZo Saves')
  if (!savesNow || isVolatile(savesNow) || path.resolve(savesNow).toLowerCase() === oldDefault.toLowerCase()) {
    const from = savesNow || oldDefault
    const to = path.join(b, 'Saves')
    saveBackup.migrateRoot(from, to)
    s.setSetting('saves_backup_dir', to)
    if (from !== to) logger.info(`backupHome: game-save backups moved to ${to}`)
  }

  const dataNow = s.getSetting('auto_backup_dir')
  if (!dataNow || isVolatile(dataNow)) {
    const to = path.join(b, 'Data')
    fs.mkdirSync(to, { recursive: true })
    if (dataNow) {
      const f = path.join(dataNow, 'kozo-autobackup.json')
      try { if (fs.existsSync(f)) fs.copyFileSync(f, path.join(to, 'kozo-autobackup.json')) } catch {}
    }
    s.setSetting('auto_backup_dir', to)
  }

  if (s.getSetting('backup_defaults_v1') !== '1') {
    s.setSetting('auto_backup_enabled', '1')
    s.setSetting('auto_save_backup_enabled', '1')
    s.setSetting('backup_defaults_v1', '1')
    try { require('./autoBackup').markDirty() } catch {}
  }
  return { base: b, saves: s.getSetting('saves_backup_dir'), data: s.getSetting('auto_backup_dir') }
}

// The user picked another place: move both folders there.
function setBase(dir) {
  if (isVolatile(dir)) throw new Error('That folder gets cleaned out (Temp, Downloads or Desktop). Pick another one')
  const s = settings()
  const b = path.join(dir, path.basename(dir).toLowerCase() === 'kozo backup' ? '' : 'KoZo Backup')
  // The second copy must stay a separate place, or it would copy into itself.
  const copy = require('./backupCopy')
  if (copy.dir() && copy.overlaps(b, copy.dir())) throw new Error('Your backup copy is in that folder. Pick a different one, or stop copying first')
  fs.mkdirSync(b, { recursive: true })
  const saveBackup = require('./saveBackup')
  saveBackup.migrateRoot(saveBackup.rootPath(), path.join(b, 'Saves'))
  const dataOld = s.getSetting('auto_backup_dir')
  fs.mkdirSync(path.join(b, 'Data'), { recursive: true })
  if (dataOld) { try { fs.copyFileSync(path.join(dataOld, 'kozo-autobackup.json'), path.join(b, 'Data', 'kozo-autobackup.json')) } catch {} }
  s.setSetting('backup_base', b)
  s.setSetting('saves_backup_dir', path.join(b, 'Saves'))
  s.setSetting('auto_backup_dir', path.join(b, 'Data'))
  s.setSetting('sync_folder', '')
  try { require('./autoBackup').writeNow({ force: true }) } catch {}
  return b
}

// Free space on the drive holding `p`, in bytes (null if unknown).
function freeSpace(p) {
  try { const st = fs.statfsSync(path.parse(path.resolve(p)).root); return st.bavail * st.bsize } catch { return null }
}

// "KoZo Backup" folders on any fixed drive (a fresh install finding the old one).
function findExisting() {
  const out = []
  for (const d of fixedDrives()) {
    const p = `${d.drive}\\KoZo Backup`
    let data = false
    try { data = fs.readdirSync(path.join(p, 'Data')).some(n => /^kozo-autobackup.*\.json$/.test(n)) } catch {}
    if (data || fs.existsSync(path.join(p, 'Saves'))) out.push(p)
  }
  const docs = path.join(documentsDir(), 'KoZo Backup')
  if (!out.includes(docs) && fs.existsSync(path.join(docs, 'Data', 'kozo-autobackup.json'))) out.push(docs)
  return out
}

module.exports = { ensure, setBase, base, isVolatile, chooseBase, freeSpace, findExisting, fixedDrives }
