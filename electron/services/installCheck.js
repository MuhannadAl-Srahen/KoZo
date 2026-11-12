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
// main.js) — it must never walk the disk while a game is playing. It runs at start, when the
// window comes back and every few minutes (quick): a game removed while KoZo is open shows as
// removed. Quick only hunts for a new location the moment a game goes missing, not every time.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

async function exists(p) {
  try { await fs.promises.access(p); return true } catch { return false }
}

function existsSync(p) {
  try { return fs.existsSync(p) } catch { return false }
}

// A folder isn't a game: an uninstaller leaves saves and settings behind. This looks for a file
// that can start it. A game Steam or a launcher starts may keep its exe further in, so what
// proved it once is remembered, and the search only runs when that file is gone. A folder that
// can't be read (Xbox's WindowsApps) says nothing, so it counts as there.
const provedBy = new Map()   // game id -> file
const walkedAt = new Map()   // game id -> when its folder was last walked and held no game file
async function hasGameFile(g, { walkGapMs = 0 } = {}) {
  if (g.launch_uri) return true
  const known = provedBy.get(g.id)
  if (known && await exists(known)) return true
  provedBy.delete(g.id)
  try { await fs.promises.readdir(g.install_path) } catch (e) { return e.code !== 'ENOENT' }
  for (const f of [g.launch_file, g.exe_name && path.join(g.install_path, g.exe_name)]) {
    if (f && await exists(f)) { provedBy.set(g.id, f); return true }
  }
  // The fast recheck comes by every few seconds: a folder an installer is still filling is
  // walked at most once per gap, not on every round.
  if (walkGapMs && Date.now() - (walkedAt.get(g.id) || 0) < walkGapMs) return false
  const [found] = require('./pcScanner').collectExes(g.install_path, 4)
  if (!found) { walkedAt.set(g.id, Date.now()); return false }
  walkedAt.delete(g.id)
  provedBy.set(g.id, path.join(found.dir, found.name))
  return true
}

// Is the whole volume this path lives on unavailable? Distinguishes "the game
// was uninstalled or moved" from "the drive it lives on isn't connected right
// now" — only the first should trigger a hunt for a new location. Returns false
// for UNC and any path we can't parse a drive letter from, so the caller falls
// back to its previous behaviour rather than silently skipping relocation.
async function volumeMissing(p) {
  const m = /^([a-z]):[\\/]/i.exec(String(p || ''))
  if (!m) return false
  return !(await exists(`${m[1]}:\\`))
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
  'shipping', 'retail', 'game', 'app', 'build', 'redist', 'bin64', 'bin32',
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
let _libs = null, _libsAt = 0, _libsFor = null
function steamLibraries() {
  let steam = null
  try { steam = require('./steamStatsWatcher').getSteamPath() } catch {}
  // Kept for a minute (for the same Steam folder): the fast recheck asks every few seconds.
  if (_libs && _libsFor === steam && Date.now() - _libsAt < 60_000) return _libs
  const out = []
  _libs = out; _libsAt = Date.now(); _libsFor = steam
  try {
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

let _drives = null, _drivesAt = 0
function driveLetters() {
  // Looked up again every 10 minutes: a drive plugged in later must be found too.
  if (_drives && Date.now() - _drivesAt < 10 * 60_000) return _drives
  _drives = []; _drivesAt = Date.now()
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
async function reconcile({ quick = false } = {}) {
  const { getDb } = require('../db/database')
  let db
  try { db = getDb() } catch { return { checked: 0, nowMissing: 0, nowFound: 0, missing: [] } }

  let games = []
  try {
    games = db.prepare(
      "SELECT id, name, install_path, exe_name, launch_file, launch_uri, is_installed, steam_app_id, is_cracked, source FROM games WHERE install_path IS NOT NULL AND install_path != ''"
    ).all()
  } catch { return { checked: 0, nowMissing: 0, nowFound: 0, missing: [] } }

  const setFlag = db.prepare('UPDATE games SET is_installed = ? WHERE id = ?')
  const setPath = db.prepare('UPDATE games SET install_path = ?, is_installed = 1 WHERE id = ?')
  const changed = []
  const missing = []
  const moved = []

  for (const g of games) {
    const folderThere = await exists(g.install_path)
    let there = folderThere && await hasGameFile(g)
    // A game coming back: not while Steam is still downloading it.
    if (there && g.is_installed !== 1 && await steamState(g) === 'installing') there = false

    // Gone from where we last saw it — before writing it off, look for where
    // it moved to. Without this a game you relocate stays dimmed forever, since
    // the only path we ever check is the dead one.
    if (!folderThere && (!quick || g.is_installed === 1)) {
      let dest = null
      // Only hunt for a new location when the game is genuinely gone — not when
      // its whole VOLUME is simply absent. An unplugged external drive or an
      // unmounted library made every game on it look moved, and if a second
      // copy existed anywhere (an old install, a different Steam library) the
      // relocation permanently rewrote install_path onto that copy and the
      // original never came back when the drive was reconnected. A missing
      // drive root means "not available right now", which is what the flag
      // already expresses.
      // Steam keeps one install per game and its manifest says where it is now: safe to
      // follow even when the old drive is gone.
      if (isSteamManaged(g)) { try { dest = await steamDest(g) } catch {} }
      if (!dest && !(await volumeMissing(g.install_path))) {
        try { dest = findNewLocation(g) } catch (e) {
          logger.warn(`installCheck: relocate failed for "${g.name}"`, { message: e.message })
        }
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
    announce(changed.map(c => c.id))
  }

  return { checked: games.length, nowMissing, nowFound, missing, moved }
}

// Refresh every window so the Library re-renders with honest state, and the uninstalled card
// (components/UninstalledCard.jsx) asks about games that went. One message however many games
// changed (the id for one game, null for several): every listener reloads on any value, and a
// message per game made the Library reload once per game when a drive came back.
function announce(ids) {
  if (!ids || !ids.length) return
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      w.webContents.send('game:updated', ids.length === 1 ? ids[0] : null)
      w.webContents.send('uninstalled:changed', null)
    }
  } catch {}
}

// ── Steam's own word on a game ───────────────────────────────────────────────
// "D:\SteamLibrary\steamapps\common\Crimson Desert\bin64" gives the steamapps folder, Steam's
// folder name for the game and what comes under it. null for a path outside a Steam library.
function steamFolderOf(installPath) {
  const m = /^(.*[\\/]steamapps)[\\/]common[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(String(installPath || '').replace(/[\\/]+$/, ''))
  if (!m) return null
  return { steamapps: m[1], installdir: m[2], tail: m[3] || '' }
}

function parseAcf(text) {
  const t = String(text || '')
  const get = (k) => t.match(new RegExp(`"${k}"\\s*"([^"]*)"`, 'i'))?.[1]
  const appid = get('appid'), installdir = get('installdir')
  if (!appid && !installdir) return null
  return { appid: appid || '', installdir: installdir || '', stateFlags: Number(get('StateFlags')) }
}

// Bit 4 = fully installed: 4 and 6 (an update is waiting) can be played, 1026 is still downloading.
function isFullyInstalled(flags) {
  const n = Number(flags)
  return flags !== '' && flags != null && Number.isFinite(n) && (n & 4) === 4
}

function isSteamManaged(g) {
  if (!g || !g.steam_app_id) return false
  return (g.source === 'steam' && !g.is_cracked) || !!steamFolderOf(g.install_path)
}

async function readAcf(steamapps, appId) {
  try { return parseAcf(await fs.promises.readFile(path.join(steamapps, `appmanifest_${appId}.acf`), 'utf8')) } catch { return null }
}

// What Steam says about the copy in this game's own folder: 'installed', 'installing', or null
// when Steam has nothing to say (no manifest beside it, or a manifest for another folder). Only
// ever used to hold a game back from "installed again", never to mark an installed game missing.
async function steamState(g) {
  if (!g || !g.steam_app_id) return null
  const sf = steamFolderOf(g.install_path)
  if (!sf) return null
  const acf = await readAcf(sf.steamapps, g.steam_app_id)
  if (!acf || acf.installdir.toLowerCase() !== sf.installdir.toLowerCase()) return null
  return isFullyInstalled(acf.stateFlags) ? 'installed' : 'installing'
}

// Where Steam has this game now, when that isn't the stored folder: installed again into another
// Steam library, or under another folder name. null unless Steam has it fully installed.
async function steamDest(g, libs = steamLibraries()) {
  if (!g || !g.steam_app_id) return null
  const sf = steamFolderOf(g.install_path)
  const tail = sf ? sf.tail : splitGameFolder(g.install_path).tail
  const stored = String(g.install_path || '').replace(/[\\/]+$/, '').toLowerCase()
  for (const lib of libs) {
    const acf = await readAcf(path.join(lib, 'steamapps'), g.steam_app_id)
    if (!acf || !acf.installdir || !isFullyInstalled(acf.stateFlags)) continue
    const base = path.join(lib, 'steamapps', 'common', acf.installdir)
    for (const dest of tail ? [path.join(base, tail), base] : [base]) {
      if (dest.toLowerCase() === stored) continue
      if (!(await exists(dest))) continue
      if (!g.exe_name || looksRight(dest, g.exe_name)) return dest
    }
  }
  return null
}

// ── The fast recheck ─────────────────────────────────────────────────────────
// A game installed again showed as "not installed" for minutes: nothing looked between the
// window getting focus and the five-minute round. This looks only at the games flagged not
// installed (a couple of file checks each; about 1 ms for 26 games, measured), so it runs every
// few seconds while KoZo is on screen (main.js) and on the watcher's idle ticks.

// Which rows to look at, and which drive letters they need. Network paths are left to the full
// round: a dead share can hold one file check for 20 seconds.
function pickRecheck(rows) {
  const seen = new Set(), probe = [], letters = new Set()
  for (const g of rows || []) {
    if (!g || seen.has(g.id)) continue
    const m = /^([A-Za-z]):[\\/]/.exec(String(g.install_path || ''))
    if (!m) continue
    seen.add(g.id); probe.push(g); letters.add(m[1].toUpperCase())
  }
  return { probe, letters: [...letters] }
}

// How long until the next look while the window is on screen. null = don't look.
function fastDelay({ visible, minimized, sessionActive } = {}) {
  return visible && !minimized && !sessionActive ? 5000 : null
}

// 0 = run now, else the milliseconds left before a call may run again.
function throttleDelay(lastAt, now, gapMs) {
  return Math.max(0, (Number(lastAt) || 0) + gapMs - now)
}

let rechecking = null
let lastSteamPass = 0
// One round at a time: a call while one runs gets the same answer.
function recheckMissing(opts = {}) {
  if (rechecking) return rechecking
  rechecking = doRecheck(opts)
    .catch((e) => { logger.warn('installCheck: recheck failed', { message: e.message }); return { found: 0, moved: 0 } })
    .finally(() => { rechecking = null })
  return rechecking
}

async function doRecheck({ reason = '', steam } = {}) {
  const none = { found: 0, moved: 0 }
  let db, rows
  try {
    db = require('../db/database').getDb()
    rows = db.prepare(
      "SELECT id, name, install_path, exe_name, launch_file, launch_uri, steam_app_id, is_cracked, source FROM games WHERE is_installed = 0 AND install_path IS NOT NULL AND install_path != ''"
    ).all()
  } catch { return none }
  if (!rows.length) return none

  const { probe, letters } = pickRecheck(rows)
  const drives = new Map()
  for (const l of letters) drives.set(l, await exists(`${l}:\\`))

  const found = [], moved = []
  for (const g of probe) {
    if (!drives.get(g.install_path[0].toUpperCase())) continue
    if (!(await exists(g.install_path))) continue
    if (!(await hasGameFile(g, { walkGapMs: 15000 }))) continue
    if (await steamState(g) === 'installing') continue
    found.push(g)
  }

  // Installed again through Steam somewhere else: another library, or the old drive is gone.
  if (steam === 'force' || Date.now() - lastSteamPass >= 15000) {
    lastSteamPass = Date.now()
    for (const g of probe) {
      if (found.includes(g) || !isSteamManaged(g)) continue
      let dest = null
      try { dest = await steamDest(g) } catch {}
      if (dest) moved.push({ g, dest })
    }
  }
  if (!found.length && !moved.length) return none

  try {
    const setFlag = db.prepare('UPDATE games SET is_installed = 1 WHERE id = ?')
    const setPath = db.prepare('UPDATE games SET install_path = ?, is_installed = 1 WHERE id = ?')
    db.transaction(() => {
      for (const g of found) setFlag.run(g.id)
      for (const m of moved) setPath.run(m.dest, m.g.id)
    })()
  } catch (e) {
    logger.warn('installCheck: recheck could not save', { message: e.message })
    return none
  }
  if (moved.length) { try { require('./autoBackup').markDirty() } catch {} }
  logger.info(`installCheck: ${found.length + moved.length} game(s) installed again (recheck: ${reason || 'tick'})`, {
    games: found.map(g => g.name),
    moves: moved.map(m => `${m.g.name}: ${m.g.install_path} -> ${m.dest}`),
  })
  announce([...found.map(g => g.id), ...moved.map(m => m.g.id)])
  return { found: found.length, moved: moved.length }
}

module.exports = {
  reconcile, findNewLocation, hasGameFile, fromSteamManifest, steamLibraries,
  recheckMissing, announce, steamState, steamDest, isSteamManaged,
  pickRecheck, fastDelay, throttleDelay, steamFolderOf, parseAcf, isFullyInstalled, splitGameFolder,
}
