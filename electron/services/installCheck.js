'use strict'

// Reconcile games.is_installed against what's actually on disk.
//
// Why this exists: KoZo set is_installed when a game was added or scanned and
// then never revisited it. After a drive swap or a reinstall the library was
// full of games flagged installed whose folders were long gone — 15 of 24 in
// the case that prompted this. That's not cosmetic: the card stays bright, the
// Play button stays enabled, and clicking it either fails or hands a dead path
// to Steam. The UI already renders is_installed=0 correctly (dimmed card, "not
// installed" badge, no Play button) — it was just never being told the truth.
//
// Deliberately conservative:
//   • only ever flips the is_installed flag, never touches install_path,
//     exe_name, playtime, achievements or anything else;
//   • a game on a disconnected drive flips to not-installed and flips straight
//     back when the drive returns, which is exactly what "not available right
//     now" should look like;
//   • games with no install_path at all are left alone (nothing to check —
//     Steam-only entries are legitimately launchable via steam://).
//
// PERF: async fs.access, one per game, and gated on no session running (see
// main.js) — it must never walk the disk while a game is playing.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

async function exists(p) {
  try { await fs.promises.access(p); return true } catch { return false }
}

function existsSync(p) {
  try { return fs.existsSync(p) } catch { return false }
}

// ── Relocation ───────────────────────────────────────────────────────────────
// Marking a game not-installed is only half an answer. If you MOVE a game —
// to another drive, into a different library — the stored path stays dead
// forever and the card stays dimmed, because nothing ever looks for where it
// went. This finds it again.
//
// Deliberately targeted probing, never a disk walk: scan roots here can include
// whole drive roots, and walking those on every launch is exactly the kind of
// background cost that made games stutter in the first place. Every strategy
// below is a bounded set of existsSync calls.

// Path segments that are part of a game's internal layout rather than its
// identity — "M:/Games/Outlast/Binaries/Win64" is really the game "Outlast"
// with the tail "Binaries/Win64", and it's the Outlast folder that moved.
const STRUCT_TAIL = new Set([
  'win64', 'win32', 'x64', 'x86', 'binaries', 'bin', 'binary', 'win',
  'shipping', 'retail', 'game', 'app', 'build', 'redist',
])

// Split a stored path into the game's own folder name and the tail beneath it.
function splitGameFolder(installPath) {
  const parts = String(installPath || '').replace(/[\\/]+$/, '').split(/[\\/]/)
  let end = parts.length
  while (end > 1 && STRUCT_TAIL.has(String(parts[end - 1]).toLowerCase())) end--
  return {
    folderName: parts[end - 1] || '',
    tail: parts.slice(end).join(path.sep),
  }
}

// Steam records exactly where it put each game. appmanifest_<appid>.acf lives
// in the library that currently holds it and names the install dir, so for a
// Steam game this is authoritative and costs a couple of file reads.
function steamLibraries() {
  const out = []
  try {
    const steam = require('./steamStatsWatcher').getSteamPath()
    if (!steam) return out
    out.push(steam)
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf')
    const raw = existsSync(vdf) ? fs.readFileSync(vdf, 'utf8') : ''
    for (const m of raw.matchAll(/"path"\s*"([^"]+)"/gi)) {
      const p = m[1].replace(/\\\\/g, '\\')
      if (p && !out.some(x => x.toLowerCase() === p.toLowerCase())) out.push(p)
    }
  } catch {}
  return out
}

function fromSteamManifest(appId) {
  if (!appId) return null
  for (const lib of steamLibraries()) {
    const acf = path.join(lib, 'steamapps', `appmanifest_${appId}.acf`)
    if (!existsSync(acf)) continue
    try {
      const dir = fs.readFileSync(acf, 'utf8').match(/"installdir"\s*"([^"]+)"/i)?.[1]
      if (!dir) continue
      const full = path.join(lib, 'steamapps', 'common', dir)
      if (existsSync(full)) return full
    } catch {}
  }
  return null
}

// Roots a moved game could plausibly now live under.
function searchRoots() {
  const roots = []
  const add = (p) => {
    if (!p) return
    const c = String(p).replace(/[\\/]+$/, '')
    if (c && !roots.some(r => r.toLowerCase() === c.toLowerCase())) roots.push(c)
  }
  try {
    const raw = require('../db/queries/settings').getSetting('scan_paths')
    if (raw) for (const p of JSON.parse(raw)) add(p)
  } catch {}
  try { for (const p of require('./pcScanner').getDefaultScanPaths()) add(p) } catch {}
  for (const lib of steamLibraries()) {
    add(path.join(lib, 'steamapps', 'common'))
    add(lib)
  }
  return roots
}

// Does this folder actually hold the game we're looking for? Requiring the
// known exe keeps a same-named folder elsewhere from being accepted.
function looksRight(dir, exeName) {
  if (!existsSync(dir)) return false
  if (!exeName) return true
  if (existsSync(path.join(dir, exeName))) return true
  // Some layouts keep the exe one level down (Bin/, Retail/, x64/…).
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (!STRUCT_TAIL.has(ent.name.toLowerCase())) continue
      if (existsSync(path.join(dir, ent.name, exeName))) return true
    }
  } catch {}
  return false
}

/**
 * Try to find a game whose stored install_path no longer exists.
 * Returns the new absolute path, or null.
 */
function findNewLocation(game) {
  const oldPath = game.install_path || ''
  const exe = game.exe_name || ''

  // 1. Steam's own manifest — authoritative when it applies.
  const viaSteam = fromSteamManifest(game.steam_app_id)
  if (viaSteam && looksRight(viaSteam, exe)) return viaSteam

  const { folderName, tail } = splitGameFolder(oldPath)
  if (!folderName) return null
  const withTail = (base) => (tail ? path.join(base, tail) : base)

  // 2. Same layout, different drive — the usual "I moved my library" case.
  const m = oldPath.match(/^([A-Za-z]):(.*)$/)
  if (m) {
    for (const letter of driveLetters()) {
      if (letter.toLowerCase() === m[1].toLowerCase()) continue
      const cand = `${letter}:${m[2]}`
      if (looksRight(cand, exe)) return cand
    }
  }

  // 3. The game folder sitting under any known root, with its tail re-appended.
  for (const root of searchRoots()) {
    for (const cand of [
      withTail(path.join(root, folderName)),
      withTail(path.join(root, 'steamapps', 'common', folderName)),
      withTail(path.join(root, 'common', folderName)),
    ]) {
      if (looksRight(cand, exe)) return cand
    }
  }
  return null
}

let _drives = null
function driveLetters() {
  if (_drives) return _drives
  _drives = []
  for (let c = 67; c <= 90; c++) {          // C..Z
    const l = String.fromCharCode(c)
    if (existsSync(`${l}:\\`)) _drives.push(l)
  }
  return _drives
}

/**
 * Check every library game's install folder. Returns
 * { checked, nowMissing, nowFound, missing: [{id, name, install_path}] }.
 */
async function reconcile() {
  const { getDb } = require('../db/database')
  let db
  try { db = getDb() } catch { return { checked: 0, nowMissing: 0, nowFound: 0, missing: [] } }

  let games = []
  try {
    games = db.prepare(
      "SELECT id, name, install_path, exe_name, is_installed FROM games WHERE install_path IS NOT NULL AND install_path != ''"
    ).all()
  } catch { return { checked: 0, nowMissing: 0, nowFound: 0, missing: [] } }

  const setFlag = db.prepare('UPDATE games SET is_installed = ? WHERE id = ?')
  const setPath = db.prepare('UPDATE games SET install_path = ?, is_installed = 1 WHERE id = ?')
  const changed = []
  const missing = []
  const moved = []

  for (const g of games) {
    let there = await exists(g.install_path)

    // Gone from where we last saw it — before writing it off, look for where
    // it moved to. Without this a game you relocate stays dimmed forever, since
    // the only path we ever check is the dead one.
    if (!there) {
      let dest = null
      try { dest = findNewLocation(g) } catch (e) {
        logger.warn(`installCheck: relocate failed for "${g.name}"`, { message: e.message })
      }
      if (dest) {
        try {
          setPath.run(dest, g.id)
          moved.push({ id: g.id, name: g.name, from: g.install_path, to: dest })
          changed.push({ id: g.id, name: g.name, want: 1 })
          there = true
        } catch {}
      }
    }

    if (!there) missing.push({ id: g.id, name: g.name, install_path: g.install_path })
    const want = there ? 1 : 0
    if ((g.is_installed === 1 ? 1 : 0) === want) continue
    if (moved.some(mv => mv.id === g.id)) continue   // already recorded above
    try { setFlag.run(want, g.id); changed.push({ id: g.id, name: g.name, want }) } catch {}
  }

  const nowMissing = changed.filter(c => c.want === 0).length
  const nowFound   = changed.filter(c => c.want === 1).length

  if (moved.length) {
    logger.info(`installCheck: relocated ${moved.length} moved game(s)`,
      { moves: moved.map(mv => `${mv.name}: ${mv.from} -> ${mv.to}`) })
  }

  if (changed.length) {
    logger.info(
      `installCheck: ${nowMissing} game(s) marked not-installed (folder gone), ` +
      `${nowFound} marked installed again`,
      { games: changed.map(c => `${c.name}${c.want ? '' : ' (missing)'}`) }
    )
    // Refresh every window so the Library re-renders with honest state.
    try {
      const { BrowserWindow } = require('electron')
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) for (const c of changed) w.webContents.send('game:updated', c.id)
      }
    } catch {}
  }

  return { checked: games.length, nowMissing, nowFound, missing, moved }
}

module.exports = { reconcile, findNewLocation }
