'use strict'

// Where games REALLY keep their saves: the Ludusavi manifest
// (github.com/mtkennerly/ludusavi-manifest), a community list built from
// PCGamingWiki covering thousands of games. The 17 MB YAML is downloaded at
// most once a week (in the background, when idle), reduced to the Windows
// save paths only and kept as userData/save-manifest.json.
//
// pathsFor(game) expands the manifest's placeholders (<base>, <winAppData>,
// <storeUserId>, ...) and globs, and returns the save files/folders that exist
// on this PC. saveFinder puts these first; name guessing is only a fallback.

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const logger = require('../logger')

const URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml'
const REFRESH_MS = 7 * 86400000

let index = null   // { bySteam: Map, byName: Map }

function userDataPath(...p) {
  const { app } = require('electron')
  return path.join(app.getPath('userData'), ...p)
}

const EDITION_RE = /\b(goty|game of the year|definitive|remastered|remaster|complete|enhanced|deluxe|ultimate|gold|directors? cut|anniversary|edition|hd)\b/g
function normName(s) {
  return String(s || '').toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, '')
}
function normLoose(s) {
  return normName(String(s || '').toLowerCase().replace(/[™®©]/g, '').replace(EDITION_RE, ' '))
}

// The parsed YAML → only what Windows save backups need. Pure.
function compactManifest(parsed) {
  const games = []
  for (const [name, g] of Object.entries(parsed || {})) {
    if (!g || typeof g !== 'object' || !g.files) continue
    const files = []
    for (const [pattern, info] of Object.entries(g.files)) {
      const tags = info?.tags || []
      if (!tags.includes('save')) continue
      const when = info?.when
      // Windows (or no OS given); skip Linux/Mac-only paths.
      if (Array.isArray(when) && when.length && !when.some(w => !w.os || w.os === 'windows')) continue
      if (/<xdg|<home>\/\.|<home>\/Library/.test(pattern)) continue
      files.push(pattern)
    }
    if (!files.length) continue
    const steam = [g.steam?.id, ...(g.id?.steamExtra || [])].filter(Boolean).map(Number)
    games.push({ n: name, s: steam, i: Object.keys(g.installDir || {}), f: files })
  }
  return games
}

function buildIndex(games) {
  const bySteam = new Map(), byName = new Map(), byLoose = new Map()
  for (const g of games) {
    for (const id of g.s) bySteam.set(id, g)
    byName.set(normName(g.n), g)
    if (!byLoose.has(normLoose(g.n))) byLoose.set(normLoose(g.n), g)
  }
  return { bySteam, byName, byLoose, count: games.length }
}

function load() {
  if (index) return index
  try {
    const data = JSON.parse(fs.readFileSync(userDataPath('save-manifest.json'), 'utf8'))
    index = buildIndex(data.games || [])
  } catch { index = null }
  return index
}

function status() {
  const settings = require('../db/queries/settings')
  const idx = load()
  return { games: idx?.count || 0, updatedAt: settings.getSetting('save_manifest_at') || null }
}

// Download + reduce. Parsing runs in a worker thread so the 17 MB YAML never
// freezes the window; falls back to the main thread if a worker can't start.
async function refresh({ force = false } = {}) {
  const settings = require('../db/queries/settings')
  const last = Date.parse(settings.getSetting('save_manifest_at') || '') || 0
  if (!force && Date.now() - last < REFRESH_MS && load()) return status()
  const axios = require('axios')
  const res = await axios.get(URL, { responseType: 'text', timeout: 180000, transformResponse: x => x })
  const yamlPath = require.resolve('js-yaml')
  let games
  try {
    games = await new Promise((resolve, reject) => {
      const { Worker } = require('worker_threads')
      const w = new Worker(`
        const { parentPort, workerData } = require('worker_threads')
        const yaml = require(workerData.yamlPath)
        const compact = new Function('return ' + workerData.compact)()
        parentPort.postMessage(compact(yaml.load(workerData.text)))
      `, { eval: true, workerData: { text: res.data, yamlPath, compact: compactManifest.toString() } })
      w.once('message', resolve)
      w.once('error', reject)
    })
  } catch (e) {
    logger.warn('saveManifest: worker parse failed, parsing here', { message: e.message })
    games = compactManifest(require('js-yaml').load(res.data))
  }
  fs.writeFileSync(userDataPath('save-manifest.json'), JSON.stringify({ games }))
  index = buildIndex(games)
  settings.setSetting('save_manifest_at', new Date().toISOString())
  logger.info(`saveManifest: ${games.length} games with known save locations`)
  return status()
}

function entryFor(game) {
  const idx = load()
  if (!idx) return null
  const ids = [game.steam_app_id, game.manual_appid].filter(Boolean).map(Number)
  for (const id of ids) if (idx.bySteam.has(id)) return idx.bySteam.get(id)
  return idx.byName.get(normName(game.name)) || idx.byLoose.get(normLoose(game.name)) || null
}

// The Steam library root of an install path (…\steamapps\common\Game → …).
function libraryRoot(installPath) {
  if (!installPath) return null
  const m = /^(.*?)[\\/]steamapps[\\/]common[\\/]/i.exec(installPath + path.sep)
  return m ? m[1] : path.dirname(installPath)
}

// Placeholder values for one game on this PC.
function placeholders(game, entry) {
  const home = os.homedir()
  let docs = path.join(home, 'Documents')
  try { docs = require('electron').app.getPath('documents') } catch {}
  let steam = null
  try { steam = require('./steamStatsWatcher').getSteamPath() } catch {}
  return {
    '<base>': game.install_path || null,
    '<root>': libraryRoot(game.install_path),
    '<steamRoot>': steam,
    '<game>': entry?.i?.[0] || (game.install_path ? path.basename(game.install_path) : game.name),
    '<home>': home,
    '<winAppData>': process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    '<winLocalAppData>': process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    '<winLocalAppDataLow>': path.join(home, 'AppData', 'LocalLow'),
    '<winDocuments>': docs,
    '<winPublic>': process.env.PUBLIC || 'C:\\Users\\Public',
    '<winProgramData>': process.env.ProgramData || 'C:\\ProgramData',
    '<winDir>': process.env.windir || 'C:\\Windows',
    '<storeUserId>': '*',
    '<storeGameId>': game.steam_app_id ? String(game.steam_app_id) : '*',
    '<osUserName>': os.userInfo().username,
  }
}

// Fill the placeholders in; null when one has no value here. Pure.
function fillPattern(pattern, ph) {
  // Steam Cloud folders live under the Steam install, not the game's library.
  let p = pattern.startsWith('<root>/userdata/') ? pattern.replace('<root>', '<steamRoot>') : pattern
  let missing = false
  p = p.replace(/<[A-Za-z]+>/g, (k) => {
    if (!(k in ph)) { missing = true; return k }
    if (ph[k] == null) { missing = true; return k }
    return ph[k]
  })
  return missing ? null : p.replace(/\//g, path.sep)
}

// Expand * and ** against the disk; returns existing paths.
function expandGlob(pattern, limit = 200) {
  const parts = pattern.split(/[\\/]+/)
  const out = []
  const isGlob = (s) => /[*?]/.test(s)
  const rx = (s) => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  function walk(base, i) {
    if (out.length >= limit) return
    if (i === parts.length) { if (fs.existsSync(base)) out.push(base); return }
    const seg = parts[i]
    if (seg === '**') {
      walk(base, i + 1)
      let entries = []
      try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch { return }
      for (const e of entries) if (e.isDirectory()) walkDeep(path.join(base, e.name), i, 1)
      return
    }
    if (!isGlob(seg)) { walk(i === 0 ? seg + path.sep : path.join(base, seg), i + 1); return }
    let entries = []
    try { entries = fs.readdirSync(base, { withFileTypes: true }) } catch { return }
    const r = rx(seg)
    for (const e of entries) if (r.test(e.name)) walk(path.join(base, e.name), i + 1)
  }
  function walkDeep(dir, i, depth) {
    if (depth > 5) return
    walk(dir, i + 1)
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) if (e.isDirectory()) walkDeep(path.join(dir, e.name), i, depth + 1)
  }
  walk('', 0)
  return out
}

// The game's known save files/folders that exist here. A file match inside a
// matched folder is dropped (the folder covers it). [] when the manifest
// doesn't know the game (or isn't downloaded yet).
function pathsFor(game) {
  const entry = entryFor(game)
  if (!entry) return []
  const ph = placeholders(game, entry)
  const found = new Set()
  for (const pat of entry.f) {
    const filled = fillPattern(pat, ph)
    if (!filled) continue
    for (const p of expandGlob(filled)) found.add(path.resolve(p))
  }
  const list = [...found]
  const dirs = list.filter(p => { try { return fs.statSync(p).isDirectory() } catch { return false } })
  const inside = (p) => dirs.some(d => d !== p && p.toLowerCase().startsWith(d.toLowerCase() + path.sep))
  // Many loose files in one folder: back up that folder instead.
  const files = list.filter(p => !dirs.includes(p) && !inside(p))
  const byParent = new Map()
  for (const f of files) { const d = path.dirname(f); byParent.set(d, (byParent.get(d) || 0) + 1) }
  const result = dirs.filter(d => !inside(d))
  for (const f of files) {
    const d = path.dirname(f)
    if (byParent.get(d) >= 3) { if (!result.includes(d)) result.push(d) }
    else result.push(f)
  }
  return result.map(p => ({ path: p, name: entry.n }))
}

module.exports = { refresh, status, pathsFor, entryFor, compactManifest, fillPattern, normName }
