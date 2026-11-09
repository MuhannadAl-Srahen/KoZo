'use strict'

// A game's own save files when its crack changes, for every game. Most games save in
// Documents or AppData themselves, which no crack changes, so those backups come back
// as they are. But a Steam game saves some files through Steam Cloud (Halls of Torment:
// HoT_profile.dat), and every emulator keeps those same files in its own folder
// (CRACK_FOLDERS below):
//   Goldberg / GSE        %APPDATA%\GSE Saves\<appid>\remote   (older: "Goldberg SteamEmu Saves")
//   CODEX, RUNE, PLAZA    Public Documents\Steam\<name>\<appid>\remote
//   EMPRESS               Public Documents (or AppData)\EMPRESS\<appid>\remote[\<appid>\remote]
//   OnlineFix             Public Documents (or AppData)\OnlineFix\<appid>\Saves
//   SmartSteamEmu         %APPDATA%\SmartSteamEmu\<appid>\remote
//   SKIDROW               %LOCALAPPDATA%\SKIDROW\<appid>\Storage (or Documents\SkidRow)
//   TENOKE                SteamData beside the game (its own steam_api64.dll says so)
//   Steam itself          Steam\userdata\<user>\<appid>\remote (also CreamAPI, which runs on Steam)
// An update that switched Halls of Torment from Goldberg to TENOKE left the new copy
// on an empty profile, and every restore went back to the old crack's folder, where
// the new copy never looks. So: the current crack's folder is a save folder
// (saveDetect), a restore lands where the game reads now (saveVault.restore), and
// a game whose crack changed is offered its progress (progressOffer).

const fs = require('fs')
const path = require('path')

const lower = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
const isInside = (p, dir) => !!dir && (lower(p) === lower(dir) || lower(p).startsWith(lower(dir) + path.sep) || lower(p).startsWith(lower(dir) + '/'))
const exists = (p) => { try { fs.accessSync(p); return true } catch { return false } }

// Pure: is `dir` a crack's (or Steam's) cloud-save folder for this game? A "remote"
// folder under the game's app id (Goldberg, CODEX, RUNE, PLAZA, EMPRESS, SSE, Steam),
// OnlineFix's "Saves" and SKIDROW's "Storage" under it, or TENOKE's SteamData in the game.
function isCloudFolder(dir, { appid, installPath } = {}) {
  const parts = String(dir || '').replace(/[\\/]+$/, '').split(/[\\/]+/)
  const low = parts.map(x => x.toLowerCase())
  const last = low[low.length - 1] || ''
  if (appid && parts.includes(String(appid))) {
    if (last === 'remote') return true
    if (last === 'saves' && low.includes('onlinefix')) return true
    if (last === 'storage' && low.includes('skidrow')) return true
  }
  if (last === 'steamdata' && installPath && isInside(dir, installPath)) return true
  return false
}

// Pure: where each emulator keeps a game's cloud files. `sure` = KoZo may write there
// before the game ever has (the folder is certain); for the rest only a folder that
// already exists is used, because a restore into a guessed folder the game never reads
// would say "done" and bring nothing. env: { appdata, local, publicDocs, docs }.
function crackFolders(label, appid, env) {
  const id = String(appid)
  const j = path.win32.join
  const { appdata, local, publicDocs, docs } = env
  switch (label) {
    case 'Goldberg': return { sure: true, dirs: [j(appdata, 'GSE Saves', id, 'remote'), j(appdata, 'Goldberg SteamEmu Saves', id, 'remote')] }
    case 'CODEX': return { sure: true, dirs: [j(publicDocs, 'Steam', 'CODEX', id, 'remote'), j(appdata, 'Steam', 'CODEX', id, 'remote')] }
    case 'RUNE': return { sure: true, dirs: [j(publicDocs, 'Steam', 'RUNE', id, 'remote')] }
    case 'PLAZA': return { sure: false, dirs: [j(publicDocs, 'Steam', 'PLAZA', id, 'remote'), j(publicDocs, 'Steam', 'CODEX', id, 'remote')] }
    case 'CODEX/RUNE-family (steam_emu.ini)': return { sure: false, dirs: [j(publicDocs, 'Steam', 'CODEX', id, 'remote'), j(publicDocs, 'Steam', 'RUNE', id, 'remote'), j(appdata, 'Steam', 'CODEX', id, 'remote')] }
    case 'EMPRESS': return { sure: false, dirs: [j(publicDocs, 'EMPRESS', id, 'remote', id, 'remote'), j(publicDocs, 'EMPRESS', id, 'remote'), j(appdata, 'EMPRESS', id, 'remote', id, 'remote'), j(appdata, 'EMPRESS', id, 'remote')] }
    case 'online-fix': return { sure: false, dirs: [j(publicDocs, 'OnlineFix', id, 'Saves'), j(appdata, 'OnlineFix', id, 'Saves')] }
    case 'SmartSteamEmu': return { sure: false, dirs: [j(appdata, 'SmartSteamEmu', id, 'remote')] }
    case 'SKIDROW': return { sure: false, dirs: [j(local, 'SKIDROW', id, 'Storage'), j(docs, 'SkidRow', id, 'Storage'), j(publicDocs, 'Steam', 'SKIDROW', id, 'Storage')] }
    default: return { sure: false, dirs: [] }
  }
}
const CRACK_LABELS = ['Goldberg', 'CODEX', 'RUNE', 'PLAZA', 'EMPRESS', 'online-fix', 'SmartSteamEmu', 'SKIDROW']

function envDirs() {
  const os = require('os')
  const home = os.homedir()
  let docs = path.join(home, 'Documents')
  try { docs = require('./crackWatcher').myDocsDir() || docs } catch {}
  return {
    appdata: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    local: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    publicDocs: path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Documents'),
    docs,
  }
}
const mtime = (p) => { try { return fs.statSync(p).mtimeMs } catch { return 0 } }

// The folders in a game's install where its crack's files may sit: the install
// folder, the launch file's folder, and the first level below (a game in a subfolder).
function gameFolders(game) {
  const out = new Set()
  const ip = game?.install_path
  if (!ip || !exists(ip)) return []
  out.add(ip)
  if (game.launch_file) out.add(path.dirname(game.launch_file))
  try {
    for (const e of fs.readdirSync(ip, { withFileTypes: true }).slice(0, 60)) {
      if (e.isDirectory() && !/^(_?redist|_commonredist|directx|vcredist|dotnet|steamdata|steam_settings)$/i.test(e.name)) out.add(path.join(ip, e.name))
    }
  } catch {}
  return [...out]
}

// Which emulator the game's files use now, and the folder its cloud files go to:
//   1. TENOKE by its tenoke.ini (SteamData beside it);
//   2. the emulator crackWatcher.detectEmulator names from the game's files (steam_emu.ini,
//      OnlineFix.ini, steam_settings, a patched steam_api dll, ...), at its folder: one
//      that exists wins, else its usual folder when that is certain;
//   3. nothing named: of every emulator's folder for this app id that exists (and Steam's
//      own), the one written last, because a new crack makes its folder on its first run.
// Null when nothing is known: a restore then goes back exactly where it came from.
function currentCrack(game) {
  const appid = String(game?.steam_app_id || game?.manual_appid || '')
  for (const dir of gameFolders(game)) {
    if (exists(path.join(dir, 'tenoke.ini'))) return { crack: 'TENOKE', folder: path.join(dir, 'SteamData') }
  }
  if (!appid) return null
  const env = envDirs()
  let label = null
  try {
    const cw = require('./crackWatcher')
    for (const dir of [game.install_path, game.launch_file && path.dirname(game.launch_file)].filter(Boolean)) {
      label = cw.detectEmulator(dir)
      if (label) break
    }
  } catch {}
  if (label === 'TENOKE') return null   // a tenoke.ini deeper than KoZo looks; not guessed
  const known = crackFolders(label, appid, env)
  const found = known.dirs.find(exists)
  if (found) return { crack: label, folder: found }
  if (known.sure && known.dirs.length) return { crack: label, folder: known.dirs[0] }
  // Nothing named (or nothing there yet): the folder written last.
  const all = []
  for (const l of CRACK_LABELS) for (const d of crackFolders(l, appid, env).dirs) if (exists(d)) all.push({ crack: l, folder: d, at: mtime(d) })
  try { for (const d of require('./saveDetect').steamCloudDirs(game)) all.push({ crack: 'Steam', folder: d, at: mtime(d) }) } catch {}
  all.sort((x, y) => y.at - x.at)
  return all.length ? { crack: all[0].crack, folder: all[0].folder } : null
}
const currentCloudFolder = (game) => currentCrack(game)?.folder || null

// Pure: where a restore point's folders go now. The first cloud folder that isn't the
// current crack's goes to the current one; when the restore point already has the
// current folder, nothing moves (both are real, separate folders).
function retarget(sources, { appid, installPath, current }) {
  const list = [...(sources || [])]
  if (!current || list.some(s => lower(s) === lower(current))) return list
  const i = list.findIndex(s => isCloudFolder(s, { appid, installPath }))
  if (i >= 0) list[i] = current
  return list
}

// Pure: does a restore point hold real progress the current folder lacks? A crack's
// first run writes a near-empty profile (1.6 KB against 92 KB of real progress).
function hasMoreProgress(savedBytes, currentBytes) {
  return savedBytes >= 4096 && savedBytes >= 4 * Math.max(currentBytes || 0, 1)
}

function folderBytes(dir) {
  let n = 0
  const walk = (d, depth) => {
    let list = []
    try { list = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1) }
      else { try { n += fs.statSync(p).size } catch {} }
    }
  }
  walk(dir, 0)
  return n
}

// What the game page and Play offer: the newest restore point whose cloud files sit
// in another crack's folder and hold more than the current one. Null when there's
// nothing to bring, or "Not now" was pressed for this same folder.
function progressOffer(game) {
  const cur = currentCrack(game)
  if (!cur) return null
  try {
    const seen = JSON.parse(require('../db/queries/settings').getSetting('crack_offer_dismissed') || '{}')
    if (seen[game.id] && lower(seen[game.id]) === lower(cur.folder)) return null
  } catch {}
  const appid = String(game.steam_app_id || game.manual_appid || '')
  const vault = require('./saveVault')
  const snaps = vault.listSnapshots(game).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const currentBytes = exists(cur.folder) ? folderBytes(cur.folder) : 0
  for (const s of snaps.slice(0, 30)) {
    let snap
    try { snap = vault.readSnapshotFor(game, s.id) } catch { continue }
    const i = snap.sources.findIndex(src => isCloudFolder(src, { appid, installPath: game.install_path }) && lower(src) !== lower(cur.folder))
    if (i < 0) continue
    const bytes = snap.files.filter(f => f.s === i).reduce((n, f) => n + (f.n || 0), 0)
    if (!hasMoreProgress(bytes, currentBytes)) continue
    return { id: s.id, createdAt: s.createdAt, crack: cur.crack, folder: cur.folder, bytes, currentBytes }
  }
  return null
}

function dismissOffer(game) {
  const cur = currentCrack(game)
  if (!cur) return
  const settingsQ = require('../db/queries/settings')
  let seen = {}
  try { seen = JSON.parse(settingsQ.getSetting('crack_offer_dismissed') || '{}') } catch {}
  seen[game.id] = cur.folder
  settingsQ.setSetting('crack_offer_dismissed', JSON.stringify(seen))
}

module.exports = { isCloudFolder, crackFolders, CRACK_LABELS, currentCrack, currentCloudFolder, retarget, hasMoreProgress, folderBytes, progressOffer, dismissOffer }
