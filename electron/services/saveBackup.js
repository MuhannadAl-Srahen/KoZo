'use strict'

// Per-game save backup/restore. Backups are plain recursive folder copies (no
// zip dependency, fs.cpSync) stored in a discoverable "KoZo Saves" folder under
// the user's Documents, organised by game NAME so they're easy to browse:
//   Documents/KoZo Saves/<Game Name>/<timestamp>/data/...
// Each backup keeps a meta.json (original source path, counts). restoreBackup
// auto-snapshots the current state first so a restore is always reversible.

const fs   = require('fs')
const path = require('path')
const { app } = require('electron')
const logger = require('../logger')

// Where game-save backups live. Defaults to Documents/KoZo Saves, but the user
// can pick any folder in Settings → Backups (persisted as `saves_backup_dir`).
function rootDir() {
  let dir
  try {
    const custom = require('../db/queries/settings').getSetting('saves_backup_dir')
    if (custom && String(custom).trim()) dir = String(custom).trim()
  } catch {}
  if (!dir) dir = path.join(app.getPath('documents'), 'KoZo Saves')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// Names Windows refuses as a folder, whatever the extension.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// Windows-safe folder name from a game title.
function sanitize(name) {
  let s = (name || 'Game').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  // Trailing dots/spaces make a folder Explorer struggles to delete, and
  // "." / ".." would walk out of the backups root entirely.
  s = s.replace(/[. ]+$/, '')
  if (!s || /^\.+$/.test(s)) return 'Game'
  return RESERVED_NAMES.test(s) ? `${s} (game)` : s
}

// sanitize() as it was before trailing dots were stripped — folders created by
// older builds still carry that spelling ("F.E.A.R."), so they must be adopted
// rather than abandoned. null when the old spelling is unusable (".", "..").
function legacySanitize(name) {
  const s = (name || 'Game').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!s || /^\.+$/.test(s)) return null
  return s
}

// Which game a folder already holds snapshots for — `{ gameId, gameName }`, or
// null when it's empty (claimable by anyone). gameId is the immutable games.id;
// snapshots written before it was recorded carry a name only.
function folderOwner(dir) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  let byName = null
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const meta = readMeta(path.join(dir, e.name))
    // An id settles it outright, whatever older snapshots in the folder say.
    if (meta.gameId != null) return { gameId: String(meta.gameId), gameName: String(meta.gameName || '') }
    if (!byName && meta.gameName) byName = { gameId: null, gameName: String(meta.gameName) }
  }
  return byName
}

// sanitize() decides which folder a title lands in, so it is also what makes two
// titles the same folder.
function nameKey(name) { return sanitize(name).toLowerCase() }

// Does an existing folder belong to the game we're working with? Keyed on the
// immutable games.id, because the title is both mutable and lossy: comparing raw
// names made a rename that sanitize() normalises away (a doubled space, a stripped
// ":", anything past the 80-char cut) look like a different game, which hid that
// game's whole backup history behind a fresh "<name> (2)" folder. Snapshots taken
// before meta.gameId existed have no id and fall back to the name comparison —
// exactly the behaviour those folders already had.
function ownedBy(owner, gameName, gameId) {
  if (!owner) return true
  if (owner.gameId != null && gameId != null) return owner.gameId === String(gameId)
  return nameKey(owner.gameName) === nameKey(gameName)
}

// Callers identify a game by NAME (ipc's gameNameOf, autoSaveBackup), so the id
// is resolved here. An ambiguous name (two library rows share it) or a game no
// longer in the library resolves to null, and ownership falls back to names.
function resolveGameId(gameName) {
  const name = String(gameName || '').trim()
  if (!name) return null
  try {
    const rows = require('../db/database').getDb()
      .prepare('SELECT id FROM games WHERE name = ? COLLATE NOCASE').all(name)
    return rows.length === 1 ? String(rows[0].id) : null
  } catch { return null }
}

// sanitize() is lossy (punctuation stripped, 80-char cut) and Windows folders are
// case-insensitive, so two DIFFERENT games can land on the same folder — which
// would mix their snapshot lists and make them fight over the single rolling
// `auto-latest` slot. A folder therefore belongs to the first game that wrote a
// snapshot into it and any other game falls through to "<name> (2)". Existing
// folders are never renamed.
function gameDir(gameName, gameId = resolveGameId(gameName)) {
  const root = rootDir()
  let base = sanitize(gameName)
  const legacy = legacySanitize(gameName)
  if (legacy && legacy !== base && !fs.existsSync(path.join(root, base)) && fs.existsSync(path.join(root, legacy))) {
    base = legacy
  }
  let dir = path.join(root, base)
  for (let i = 2; i <= 20 && fs.existsSync(dir); i++) {
    if (ownedBy(folderOwner(dir), gameName, gameId)) break
    dir = path.join(root, `${base} (${i})`)
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// backupId comes from the renderer and the main process is the only place it is
// checked: a "..", a separator or a drive letter would resolve outside the game's
// folder and hand rmSync/cpSync a directory that isn't a backup at all.
function backupDir(gameName, backupId) {
  const id = String(backupId ?? '')
  if (!id.trim() || id === '.' || id === '..' || /[\\/:]/.test(id) || path.basename(id) !== id) {
    throw new Error('Invalid backup id')
  }
  const base = gameDir(gameName)
  const dir  = path.join(base, id)
  if (!path.resolve(dir).startsWith(path.resolve(base) + path.sep)) throw new Error('Invalid backup path')
  return dir
}

function measure(dir) {
  let files = 0, bytes = 0
  function walk(d) {
    if (files > 100000) return
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isFile()) { files++; try { bytes += fs.statSync(p).size } catch {} }
      else if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return { files, bytes }
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) } catch { return {} }
}

function makeId() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function backupSave(gameName, sourcePath, label) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Save folder no longer exists')
  const gameId = resolveGameId(gameName)
  const id   = makeId() + (label ? `_${label}` : '')
  const dest = path.join(gameDir(gameName, gameId), id)
  const dataDest = path.join(dest, 'data')
  fs.mkdirSync(dataDest, { recursive: true })

  let meta
  try {
    fs.cpSync(sourcePath, dataDest, { recursive: true })
    const { files, bytes } = measure(dataDest)
    meta = { id, gameId, gameName: gameName || '', source: sourcePath, createdAt: new Date().toISOString(), files, bytes, label: label || null }
    fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  } catch (e) {
    // A half-copied folder with no meta.json would list as a corrupt snapshot.
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch {}
    throw e
  }
  logger.info(`saveBackup: backed up "${gameName}" (${meta.files} files) from ${sourcePath}`)
  return { ...meta, path: dataDest }
}

function listBackups(gameName) {
  const gameId = resolveGameId(gameName)
  const dir = gameDir(gameName, gameId)
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const meta = readMeta(path.join(dir, e.name))
    // A folder written before the ownership rule can hold two colliding games'
    // snapshots — never list (and so never restore/delete) another game's. Only
    // an id proves that: a differing NAME is far more often this same game,
    // renamed, and hiding its own history would be the worse mistake.
    if (gameId != null && meta.gameId != null && String(meta.gameId) !== gameId) continue
    out.push({
      id: e.name,
      gameName: meta.gameName || gameName,
      source: meta.source || null,
      createdAt: meta.createdAt || null,
      files: meta.files || 0,
      bytes: meta.bytes || 0,
      label: meta.label || null,
      path: path.join(dir, e.name, 'data'),   // for "open in Explorer"
    })
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return out
}

function restoreBackup(gameName, backupId, targetOverride) {
  const dir     = backupDir(gameName, backupId)
  const meta    = readMeta(dir)
  const dataDir = path.join(dir, 'data')
  if (!fs.existsSync(dataDir)) throw new Error('Backup data missing or corrupted')
  const target = targetOverride || meta.source
  if (!target) throw new Error('No restore destination recorded for this backup')

  // Safety net: snapshot whatever is currently there before overwriting it. If
  // that snapshot can't be taken (full/locked backup drive) the restore would be
  // irreversible, so abort rather than overwrite the live save with no way back.
  let safety = null
  if (fs.existsSync(target)) {
    try {
      safety = backupSave(gameName, target, 'before-restore').id
    } catch (e) {
      logger.warn(`saveBackup: before-restore snapshot failed for "${gameName}"`, { message: e.message })
      throw new Error(`Could not snapshot the current save before restoring (${e.message}) — restore cancelled so nothing was overwritten`)
    }
  }

  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(dataDir, target, { recursive: true })
  logger.info(`saveBackup: restored "${gameName}" → ${target}`)
  return { restoredTo: target, safetyBackupId: safety }
}

function deleteBackup(gameName, backupId) {
  const dir = backupDir(gameName, backupId)
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

// Automatic backup (called after a play session). To avoid a pile of one
// folder-per-session, the auto backup is a SINGLE rolling snapshot per game
// ("auto-latest") that is refreshed in place each time the save changes — so
// there's only ever one combined auto save per game, always the most recent.
//   • dedupe — if the rolling snapshot already matches the live save (same file
//     count + byte size), nothing changed, so skip.
//   • clean replace — the snapshot folder is wiped before copying so files the
//     game deleted don't linger.
// Manual backups (and before-restore safety copies) stay as their own separate
// timestamped snapshots — those are deliberate restore points and are untouched.
const AUTO_ID      = 'auto-latest'
const AUTO_PREV_ID = 'auto-prev'

// Remove legacy per-session auto snapshots (from before the two-slot model)
// and any stray auto folders other than the rolling slots.
function cleanupLegacyAutos(gameName) {
  for (const b of listBackups(gameName)) {
    if ((b.label === 'auto' || b.label === 'auto (previous)') && b.id !== AUTO_ID && b.id !== AUTO_PREV_ID) {
      try { deleteBackup(gameName, b.id) } catch {}
    }
  }
}

// Two rolling slots: `auto-latest` (this session) and `auto-prev` (the one
// before). On each changed save, latest rotates into prev — so the last TWO
// sessions' saves are always recoverable without snapshots piling up on disk.
function autoBackupGame(gameName, sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return { skipped: 'no_source' }
  const cur = measure(sourcePath)
  if (cur.files === 0) return { skipped: 'empty' }

  const gameId   = resolveGameId(gameName)
  const dir      = gameDir(gameName, gameId)
  const dest     = path.join(dir, AUTO_ID)
  const dataDest = path.join(dest, 'data')
  const prevDest = path.join(dir, AUTO_PREV_ID)

  // Dedupe against the existing rolling snapshot.
  if (fs.existsSync(dataDest)) {
    const prev = measure(dataDest)
    if (prev.files === cur.files && prev.bytes === cur.bytes) {
      cleanupLegacyAutos(gameName)
      return { skipped: 'unchanged' }
    }
  }

  // Rotate: current latest becomes the "previous session" slot.
  if (fs.existsSync(dest)) {
    try {
      fs.rmSync(prevDest, { recursive: true, force: true })
      fs.renameSync(dest, prevDest)
      const prevMetaPath = path.join(prevDest, 'meta.json')
      try {
        const prevMeta = JSON.parse(fs.readFileSync(prevMetaPath, 'utf8'))
        prevMeta.id = AUTO_PREV_ID
        prevMeta.label = 'auto (previous)'
        fs.writeFileSync(prevMetaPath, JSON.stringify(prevMeta, null, 2), 'utf8')
      } catch {}
    } catch (e) {
      logger.warn(`saveBackup: auto rotation failed for "${gameName}"`, { message: e.message })
      fs.rmSync(dest, { recursive: true, force: true })
    }
  }

  // Write the fresh latest snapshot.
  fs.mkdirSync(dataDest, { recursive: true })
  fs.cpSync(sourcePath, dataDest, { recursive: true })
  const { files, bytes } = measure(dataDest)
  const meta = {
    id: AUTO_ID, gameId, gameName: gameName || '', source: sourcePath,
    createdAt: new Date().toISOString(), files, bytes, label: 'auto',
  }
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')

  cleanupLegacyAutos(gameName)
  logger.info(`saveBackup: refreshed rolling auto save for "${gameName}" (${files} files)`)
  return { ...meta, path: dataDest }
}

function rootPath() { return rootDir() }

// When the user changes the backup folder (or sets up a sync folder), existing
// backups must FOLLOW them — otherwise everything backed up so far silently
// vanishes from every game's Save Manager (it still lives in the old folder,
// but nothing reads it anymore). Moves each game folder; merges when the
// destination already has the game (only non-colliding snapshot subfolders move).
function migrateRoot(oldDir, newDir) {
  try {
    if (!oldDir || !newDir) return { moved: 0 }
    const from = path.resolve(oldDir)
    const to   = path.resolve(newDir)
    if (from.toLowerCase() === to.toLowerCase()) return { moved: 0 }
    if (!fs.existsSync(from)) return { moved: 0 }

    fs.mkdirSync(to, { recursive: true })
    let moved = 0
    const moveEntry = (src, dest) => {
      try {
        fs.renameSync(src, dest)
      } catch {
        // Cross-drive or locked — copy then delete.
        fs.cpSync(src, dest, { recursive: true })
        fs.rmSync(src, { recursive: true, force: true })
      }
    }

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const srcGame  = path.join(from, entry.name)
      const destGame = path.join(to, entry.name)
      if (!fs.existsSync(destGame)) {
        moveEntry(srcGame, destGame)
        moved++
        continue
      }
      // Game exists in both roots — merge snapshot subfolders that don't collide.
      for (const snap of fs.readdirSync(srcGame, { withFileTypes: true })) {
        if (!snap.isDirectory()) continue
        const destSnap = path.join(destGame, snap.name)
        if (fs.existsSync(destSnap)) continue
        moveEntry(path.join(srcGame, snap.name), destSnap)
        moved++
      }
      // Remove the old game folder if it's now empty.
      try { if (fs.readdirSync(srcGame).length === 0) fs.rmdirSync(srcGame) } catch {}
    }
    if (moved > 0) logger.info(`saveBackup: migrated ${moved} backup folder(s) from "${from}" to "${to}"`)
    return { moved }
  } catch (e) {
    logger.warn('saveBackup: migrateRoot failed', { message: e.message })
    return { moved: 0, error: e.message }
  }
}

module.exports = { backupSave, listBackups, restoreBackup, deleteBackup, autoBackupGame, rootPath, migrateRoot }
