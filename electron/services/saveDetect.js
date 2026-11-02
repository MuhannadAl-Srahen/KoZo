'use strict'

// Finds a game's save folders on its own, so nobody has to pick one:
//   1. the Ludusavi manifest (saveManifest.js): where the game really saves
//   2. emulator folders keyed by the app id (Goldberg, GSE, CODEX, RUNE,
//      EMPRESS, OnlineFix ...), from crackWatcher's own list of locations
//   3. Steam Cloud: Steam\userdata\<user>\<appid>\remote
//   4. learning while playing: after a session, the folders under the usual
//      save roots whose files changed during that session (changedFolders)
// Whatever these find is CONFIRMED (games.save_paths) and backed up from then
// on. saveFinder's name guessing is only offered as a suggestion.

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const logger = require('../logger')

function safeList(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}
function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }

// Files that are never worth keeping (and folders that only hold them).
const JUNK_DIRS = /(^|\/)(logs?|cache|caches|shadercache|shader_?cache|shadercaches|pipelinecache|gpucache|code cache|webcache|htmlcache|crash(es|dumps|reports?)?|crashreportclient|temp|tmp|screenshots?|videos?|movies?|webbrowser|cef|blob_storage|local storage|session storage|indexeddb|service worker|d3dscache|nvidia|amd)(\/|$)/i
const JUNK_EXT = /\.(log|tmp|dmp|mdmp|etl|pdb|lock|mp4|webm|avi|mkv)$/i
// Whether a file inside a save folder should be left out of backups. Pure.
function isJunk(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/')
  return JUNK_EXT.test(p) || JUNK_DIRS.test(p)
}

// ── 2. Emulator folders ─────────────────────────────────────────────────────
// crackWatcher.buildCandidates lists every emulator's achievement file for a
// game; the folder named after the app id is that emulator's save area. Its
// "remote" subfolder (Steam Cloud files) is the save when there is one.
const NOT_SAVE = /^(achievements?\.(json|ini)|stats?(\.bin|\.ini)?|settings|steam_settings|steam_appid\.txt|user_?stats\.ini|.*\.cfg)$/i
function emulatorDirs(game) {
  const ids = [game.steam_app_id, game.manual_appid].filter(Boolean).map(String)
  if (!ids.length) return []
  let cands = []
  try { cands = require('./crackWatcher').buildCandidates(game) } catch { return [] }
  const out = new Set()
  for (const c of cands) {
    if (typeof c.path !== 'string') continue
    const parts = c.path.split(/[\\/]/)
    const i = parts.findIndex(p => ids.includes(p))
    if (i < 1) continue
    const base = parts.slice(0, i + 1).join(path.sep)
    if (game.install_path && base.toLowerCase().startsWith(String(game.install_path).toLowerCase()) && !/local_save/i.test(base)) continue
    if (!isDir(base)) continue
    const remote = path.join(base, 'remote')
    if (isDir(remote)) { out.add(remote); continue }
    // Only achievements/stats in there: not a save.
    const real = safeList(base).filter(e => !NOT_SAVE.test(e.name))
    if (real.length) out.add(base)
  }
  return [...out]
}

// ── 3. Steam Cloud ──────────────────────────────────────────────────────────
function steamCloudDirs(game) {
  if (!game.steam_app_id) return []
  const roots = new Set()
  try { const p = require('./steamStatsWatcher').getSteamPath(); if (p) roots.add(p) } catch {}
  roots.add('C:\\Program Files (x86)\\Steam')
  const out = []
  for (const root of roots) {
    for (const u of safeList(path.join(root, 'userdata'))) {
      if (!u.isDirectory()) continue
      const remote = path.join(root, 'userdata', u.name, String(game.steam_app_id), 'remote')
      if (isDir(remote) && safeList(remote).length) out.push(remote)
    }
  }
  return out
}

// Everything known for a game, newest knowledge first. Paths that exist only.
function detect(game) {
  const found = []
  const add = (p, how) => {
    if (!p) return
    const k = path.resolve(p).toLowerCase()
    if (found.some(f => f.key === k || k.startsWith(f.key + path.sep))) return
    // A folder already listed inside the new one: the new (outer) one covers it.
    for (let i = found.length - 1; i >= 0; i--) if (found[i].key.startsWith(k + path.sep)) found.splice(i, 1)
    found.push({ key: k, path: path.resolve(p), how })
  }
  try { for (const h of require('./saveManifest').pathsFor(game)) add(h.path, 'known') } catch {}
  for (const p of emulatorDirs(game)) add(p, 'emulator')
  for (const p of steamCloudDirs(game)) add(p, 'steam')
  return found.map(({ path: p, how }) => ({ path: p, how }))
}

// ── 4. Learning while playing ───────────────────────────────────────────────
function saveRoots(game) {
  const home = os.homedir()
  let docs = path.join(home, 'Documents')
  try { docs = require('./crackWatcher').myDocsDir() || docs } catch {}
  const pub = process.env.PUBLIC || 'C:\\Users\\Public'
  const roots = [
    path.join(docs, 'My Games'), docs, path.join(home, 'Saved Games'),
    process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    path.join(home, 'AppData', 'LocalLow'),
    path.join(pub, 'Documents'),
  ]
  if (game.install_path) roots.push(game.install_path)
  return roots
}

// Folders under the roots that are never a game's save.
const SKIP_TOP = new Set(['microsoft', 'packages', 'temp', 'google', 'mozilla', 'bravesoftware', 'discord', 'spotify', 'nvidia',
  'nvidia corporation', 'amd', 'intel', 'steam', 'epic games', 'epicgameslauncher', 'unrealengine', 'crashdumps', 'crashreportclient',
  'd3dscache', 'kozo', 'electron', 'code', 'npm', 'npm-cache', 'pip', 'programs', 'microsoft help', 'connecteddevicesplatform',
  'onedrive', 'my music', 'my pictures', 'my videos', 'desktop.ini', 'adobe', 'zoom', 'slack', 'whatsapp', 'telegram desktop',
  'riot games', 'battle.net', 'blizzard entertainment', 'ubisoft game launcher', 'origin', 'ea desktop', 'electronic arts',
  'gog.com', 'galaxy', 'overwolf', 'medal', 'obs-studio', 'squirreltemp', 'history', 'temporary internet files', 'iconcache.db'])

// Files changed between `from` and `to` (ms) under the save roots. Bounded by
// depth, entries and time so it can't stall anything.
function changedFiles(game, from, to, { maxMs = 4000, maxEntries = 80000 } = {}) {
  const started = Date.now()
  let seen = 0
  const out = []
  let backupRoot = null
  try { backupRoot = path.resolve(require('./saveBackup').rootPath()).toLowerCase() } catch {}
  for (const root of saveRoots(game)) {
    const walk = (dir, rel, depth) => {
      if (depth > 5 || seen > maxEntries || Date.now() - started > maxMs) return
      for (const e of safeList(dir)) {
        if (++seen > maxEntries) return
        const abs = path.join(dir, e.name)
        if (depth === 0 && SKIP_TOP.has(e.name.toLowerCase())) continue
        if (backupRoot && abs.toLowerCase().startsWith(backupRoot)) continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { if (!JUNK_DIRS.test(r)) walk(abs, r, depth + 1) }
        else if (e.isFile() && !JUNK_EXT.test(e.name)) {
          try {
            const m = fs.statSync(abs).mtimeMs
            if (m >= from && m <= to) out.push({ root, rel: r })
          } catch {}
        }
      }
    }
    walk(root, '', 0)
  }
  return out
}

const SAVE_DIR = /^(save|saves|saved|savegames?|savedgames|savedata|profiles?|remote|slots?|userdata|storage)$/i
const SAVE_EXT = /\.(sav|save|savegame|sl2|ess|dat|bin|slot|profile|json|es3)$/i
// Which folders a session's changed files point to. Pure (`score` rates how
// well a folder name matches the game, 0 to 100, see saveFinder).
// Each file is attributed to the deepest folder above it whose name matches the
// game; with no name match, to a save-named folder ("Saves", "SaveGames").
// Folders under the install path only count through a save-named folder.
function pickChangedFolders(files, { score, installPath = null }) {
  const sep = (p) => p.split('/')
  const picks = new Map()
  for (const f of files) {
    if (isJunk(f.rel)) continue
    const parts = sep(f.rel).slice(0, -1)
    const inInstall = installPath && f.root === installPath
    let at = -1
    if (!inInstall) {
      for (let i = 0; i < Math.min(parts.length, 3); i++) if (score(parts[i]) >= 76) at = i
    }
    if (at < 0) {
      const s = parts.findIndex(p => SAVE_DIR.test(p))
      // A save-named folder counts only when it sits under a name match or in
      // the install folder; a bare "Saves" in AppData could be anything's.
      if (s >= 0 && (inInstall || parts.slice(0, s).some(p => score(p) > 0))) at = s
    }
    if (at < 0) continue
    const dir = [f.root, ...parts.slice(0, at + 1)].join('/')
    const p = picks.get(dir) || { dir, files: 0, saveLike: false }
    p.files++
    if (SAVE_EXT.test(f.rel) || parts.some(x => SAVE_DIR.test(x))) p.saveLike = true
    picks.set(dir, p)
  }
  return [...picks.values()].sort((a, b) => b.files - a.files).map(p => p.dir)
}

// After a session: learn where the game saved. Adds to the confirmed paths.
function learnFromSession(game, startedAt, endedAt) {
  try {
    const from = new Date(startedAt).getTime() - 60000
    const to = (endedAt ? new Date(endedAt).getTime() : Date.now()) + 180000
    if (!Number.isFinite(from)) return []
    const files = changedFiles(game, from, to)
    const { buildMatcher } = require('./saveFinder')
    const dirs = pickChangedFolders(files, { score: buildMatcher(game), installPath: game.install_path || null })
      .map(d => path.resolve(d.replace(/\//g, path.sep)))
    if (dirs.length) logger.info(`saveDetect: "${game.name}" wrote to`, { dirs })
    return dirs
  } catch (e) {
    logger.warn('saveDetect: learning failed', { message: e.message })
    return []
  }
}

// Detect and confirm for one game. Adds to (never replaces) what's confirmed.
// Returns the confirmed list.
function confirmFor(game, extra = []) {
  const asb = require('./autoSaveBackup')
  const have = asb.getSavePaths(game)
  const found = [...detect(game).map(f => f.path), ...extra]
  const merged = [...have]
  for (const p of found) {
    const k = p.toLowerCase()
    if (merged.some(m => { const mk = m.toLowerCase(); return mk === k || k.startsWith(mk + path.sep) })) continue
    // A broader folder replaces the narrower ones it contains.
    for (let i = merged.length - 1; i >= 0; i--) if (merged[i].toLowerCase().startsWith(k + path.sep)) merged.splice(i, 1)
    merged.push(p)
  }
  if (merged.length !== have.length || merged.some((p, i) => p !== have[i])) {
    asb.setSavePaths(game.id, merged)
    logger.info(`saveDetect: "${game.name}" saves at`, { paths: merged })
  }
  return merged
}

// Every library game (startup, when idle).
function confirmAll() {
  const db = require('../db/database').getDb()
  const games = db.prepare('SELECT * FROM games WHERE is_archived = 0').all()
  let n = 0
  for (const g of games) { try { if (confirmFor(g).length) n++ } catch {} }
  return { games: games.length, withSaves: n }
}

module.exports = { detect, emulatorDirs, steamCloudDirs, confirmFor, confirmAll, learnFromSession, changedFiles, pickChangedFolders, isJunk }
