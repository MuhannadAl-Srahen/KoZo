'use strict'

// A game's own save files when its crack changes. A Steam game saves some files
// through Steam Cloud (Halls of Torment: HoT_profile.dat), and every crack keeps
// those same files in its own folder:
//   Goldberg / GSE        %APPDATA%\GSE Saves\<appid>\remote   (older: "Goldberg SteamEmu Saves")
//   CODEX, RUNE, EMPRESS  ...\<appid>\remote
//   TENOKE                SteamData beside the game (its own steam_api64.dll says so)
//   Steam itself          Steam\userdata\<user>\<appid>\remote
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

// Pure: is `dir` a crack's (or Steam's) cloud-save folder for this game?
function isCloudFolder(dir, { appid, installPath } = {}) {
  const parts = String(dir || '').replace(/[\\/]+$/, '').split(/[\\/]+/)
  const last = (parts[parts.length - 1] || '').toLowerCase()
  if (appid && last === 'remote' && parts.includes(String(appid))) return true
  if (last === 'steamdata' && installPath && isInside(dir, installPath)) return true
  return false
}

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

// Which crack the game's files use now, and the folder its saves go to. Only cracks
// whose folder is certain; null for anything else (a restore then goes back exactly
// where it came from).
function currentCrack(game) {
  const appid = String(game?.steam_app_id || game?.manual_appid || '')
  for (const dir of gameFolders(game)) {
    if (exists(path.join(dir, 'tenoke.ini'))) return { crack: 'TENOKE', folder: path.join(dir, 'SteamData') }
  }
  if (!appid) return null
  for (const dir of gameFolders(game)) {
    if (exists(path.join(dir, 'steam_settings')) || exists(path.join(dir, 'ColdClientLoader.ini')) || exists(path.join(dir, 'steamclient64.ini'))) {
      const appdata = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming')
      const gse = path.join(appdata, 'GSE Saves', appid, 'remote')
      const old = path.join(appdata, 'Goldberg SteamEmu Saves', appid, 'remote')
      return { crack: 'Goldberg', folder: !exists(gse) && exists(old) ? old : gse }
    }
  }
  return null
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

module.exports = { isCloudFolder, currentCrack, currentCloudFolder, retarget, hasMoreProgress, folderBytes, progressOffer, dismissOffer }
