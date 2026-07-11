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

// Windows-safe folder name from a game title.
function sanitize(name) {
  return (name || 'Game').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Game'
}

function gameDir(gameName) {
  const dir = path.join(rootDir(), sanitize(gameName))
  fs.mkdirSync(dir, { recursive: true })
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
  const id   = makeId() + (label ? `_${label}` : '')
  const dest = path.join(gameDir(gameName), id)
  const dataDest = path.join(dest, 'data')
  fs.mkdirSync(dataDest, { recursive: true })

  fs.cpSync(sourcePath, dataDest, { recursive: true })
  const { files, bytes } = measure(dataDest)
  const meta = { id, gameName: gameName || '', source: sourcePath, createdAt: new Date().toISOString(), files, bytes, label: label || null }
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  logger.info(`saveBackup: backed up "${gameName}" (${files} files) from ${sourcePath}`)
  return { ...meta, path: dataDest }
}

function listBackups(gameName) {
  const dir = gameDir(gameName)
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const meta = readMeta(path.join(dir, e.name))
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
  const dir     = path.join(gameDir(gameName), backupId)
  const meta    = readMeta(dir)
  const dataDir = path.join(dir, 'data')
  if (!fs.existsSync(dataDir)) throw new Error('Backup data missing or corrupted')
  const target = targetOverride || meta.source
  if (!target) throw new Error('No restore destination recorded for this backup')

  // Safety net: snapshot whatever is currently there before overwriting it.
  let safety = null
  if (fs.existsSync(target)) {
    try { safety = backupSave(gameName, target, 'before-restore').id } catch {}
  }

  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(dataDir, target, { recursive: true })
  logger.info(`saveBackup: restored "${gameName}" → ${target}`)
  return { restoredTo: target, safetyBackupId: safety }
}

function deleteBackup(gameName, backupId) {
  const dir = path.join(gameDir(gameName), backupId)
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

  const dest     = path.join(gameDir(gameName), AUTO_ID)
  const dataDest = path.join(dest, 'data')
  const prevDest = path.join(gameDir(gameName), AUTO_PREV_ID)

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
    id: AUTO_ID, gameName: gameName || '', source: sourcePath,
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
