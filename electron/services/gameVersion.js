'use strict'
// The version of a game's files for its page, and whether Steam has moved on: nothing
// updates a cracked copy by itself. Runs when a game page opens, never in the background,
// and starts no process: the exe's version is read from its bytes.
//
// Where the version comes from, most exact first:
//   1. The Steam build the emulator was set up with (steam_settings/branches.json or
//      build_id.txt), or Steam's own manifest for a real Steam install.
//   2. The version stamped in the exe, unless it's the engine's (Unreal, Unity, ...).
//   3. The install folder's name ("Game.v1.2.3-GROUP").
// Steam's newest build comes from api.steamcmd.net (free, public, only the app id is
// sent; Steam has no keyless call for it). Its newest version number, when it has one,
// comes from the titles of the newest patch notes.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const TTL = 6 * 60 * 60 * 1000
const MAX_CACHED = 100
const WAIT_MS = 6000
const DAY = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 4000
const MAX_DEPTH = 4
const NOT_THE_GAME = /^(__redist|_commonredist|redist|directx|vcredist|dotnet|engine|logs|crashes)$/i

const latestCache = new Map()   // appid -> { at, latest }

// ── The version stamped in an exe ───────────────────────────────────────────

// Pure: a VS_VERSIONINFO block -> { fixed: 'a.b.c.d', strings: { FileVersion, ... } }.
function parseVersionBlock(buf) {
  const strings = {}
  let fixed = null
  const align = (n) => (n + 3) & ~3
  const walk = (start, end, depth) => {
    let off = start
    while (off + 6 <= end) {
      const length = buf.readUInt16LE(off)
      if (length < 6 || off + length > end) return
      const valueLength = buf.readUInt16LE(off + 2)
      const isText = buf.readUInt16LE(off + 4) === 1
      let p = off + 6
      let key = ''
      while (p + 2 <= off + length) {
        const c = buf.readUInt16LE(p)
        p += 2
        if (!c) break
        key += String.fromCharCode(c)
      }
      const valueAt = align(p)
      const valueBytes = isText ? valueLength * 2 : valueLength
      if (depth === 0 && valueBytes >= 16 && valueAt + 16 <= end && buf.readUInt32LE(valueAt) === 0xFEEF04BD) {
        const ms = buf.readUInt32LE(valueAt + 8), ls = buf.readUInt32LE(valueAt + 12)
        fixed = [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.')
      }
      if (depth === 3) {
        if (isText) strings[key] = buf.toString('utf16le', valueAt, Math.min(valueAt + valueBytes, off + length)).split('\0')[0].trim()
      } else {
        walk(align(valueAt + valueBytes), off + length, depth + 1)
      }
      off = align(off + length)
    }
  }
  walk(0, buf.length, 0)
  return { fixed, strings }
}

// An exe's version resource, reading only the few bytes it needs. Null when it has none.
function readExeVersion(file) {
  let fd = null
  try {
    fd = fs.openSync(file, 'r')
    const read = (pos, len) => {
      const b = Buffer.alloc(len)
      return b.subarray(0, fs.readSync(fd, b, 0, len, pos))
    }
    const head = read(0, 8192)
    if (head.length < 64 || head.toString('latin1', 0, 2) !== 'MZ') return null
    const pe = head.readUInt32LE(0x3c)
    if (pe + 24 > head.length || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null
    const sectionCount = head.readUInt16LE(pe + 6)
    const optional = pe + 24
    const dirs = optional + (head.readUInt16LE(optional) === 0x20b ? 112 : 96)
    const resourceRva = head.readUInt32LE(dirs + 16)
    if (!resourceRva) return null
    const sections = []
    const table = optional + head.readUInt16LE(pe + 20)
    for (let i = 0; i < sectionCount; i++) {
      const o = table + i * 40
      if (o + 40 > head.length) break
      sections.push({ va: head.readUInt32LE(o + 12), size: Math.max(head.readUInt32LE(o + 8), head.readUInt32LE(o + 16)), raw: head.readUInt32LE(o + 20) })
    }
    const toOffset = (rva) => {
      const s = sections.find(x => rva >= x.va && rva < x.va + x.size)
      return s ? rva - s.va + s.raw : null
    }
    const base = toOffset(resourceRva)
    if (base == null) return null
    // A resource directory: 16 bytes, then 8 per entry (named ones first). Without an
    // id, the first entry: a version resource has one name and one language that matter.
    const entry = (dirOffset, wantId) => {
      const h = read(base + dirOffset, 16)
      if (h.length < 16) return null
      const named = h.readUInt16LE(12), total = named + h.readUInt16LE(14)
      if (!total || total > 4096) return null
      const list = read(base + dirOffset + 16, total * 8)
      for (let i = 0; i * 8 + 8 <= list.length; i++) {
        if (wantId == null || (i >= named && list.readUInt32LE(i * 8) === wantId)) return list.readUInt32LE(i * 8 + 4)
      }
      return null
    }
    const SUB = 0x80000000, RT_VERSION = 16
    let to = entry(0, RT_VERSION)
    if (to == null || !(to & SUB)) return null
    to = entry(to & 0x7fffffff, null)
    if (to == null || !(to & SUB)) return null
    to = entry(to & 0x7fffffff, null)
    if (to == null || (to & SUB)) return null
    const dataEntry = read(base + to, 16)
    if (dataEntry.length < 16) return null
    const at = toOffset(dataEntry.readUInt32LE(0))
    if (at == null) return null
    return parseVersionBlock(read(at, Math.min(dataEntry.readUInt32LE(4), 65536)))
  } catch {
    return null
  } finally {
    if (fd != null) try { fs.closeSync(fd) } catch {}
  }
}

// Pure: "2, 5, 0, 1" -> "2.5.0.1", "1.2.0.0" -> "1.2". The stamp a build tool leaves
// when nobody set one ("1.0.0.0", "0.0.0.0") says nothing, so it counts as none.
function cleanVersion(raw) {
  const m = String(raw ?? '').match(/\d+(?:\s*[.,]\s*\d+)+/)
  if (!m) return null
  const parts = m[0].split(/\s*[.,]\s*/)
  while (parts.length > 2 && /^0+$/.test(parts[parts.length - 1])) parts.pop()
  const v = parts.join('.')
  return /^[01](\.0)*$/.test(v) ? null : v
}

// An engine's own version says nothing about the game (Unreal stamps 4.27.2, Unity 2021.3).
const ENGINE = /\b(unreal|unrealgame|epic games|unity|godot|bootstrap|cryengine|gamemaker|game maker|rpg maker|nw\.js|electron)\b/i

// Pure: what parseVersionBlock read -> the game's version, or null.
function exeVersion(info) {
  if (!info) return null
  const s = info.strings || {}
  if (ENGINE.test([s.ProductName, s.CompanyName, s.FileDescription].filter(Boolean).join(' '))) return null
  const v = cleanVersion(s.FileVersion) || cleanVersion(s.ProductVersion) || cleanVersion(info.fixed)
  return v && Number(v.split('.')[0]) < 2000 ? v : null
}

// ── Builds from the files around the game ───────────────────────────────────

// Pure: steam_settings/branches.json -> { build, date }.
function buildFromBranches(text) {
  try {
    const list = JSON.parse(text)
    const b = Array.isArray(list) ? (list.find(x => x?.name === 'public') || list[0]) : null
    const build = Number(b?.build_id)
    if (!(build > 0)) return null
    const at = Number(b.time_updated)
    return { build, date: at > 0 ? at * 1000 : null }
  } catch { return null }
}

// Pure: a Steam appmanifest_<id>.acf -> { build, date }.
function buildFromManifest(text) {
  const build = Number(String(text).match(/"buildid"\s+"(\d+)"/i)?.[1])
  if (!(build > 0)) return null
  const at = Number(String(text).match(/"LastUpdated"\s+"(\d+)"/i)?.[1])
  return { build, date: at > 0 ? at * 1000 : null }
}

// Pure: "Game.Name.v1.2.3-GROUP" -> "1.2.3".
function versionInFolder(name) {
  const m = String(name).match(/(?:^|[ ._-])v(\d+(?:[._]\d+)+)(?=$|[ ._-])/i)
  return m ? cleanVersion(m[1].replace(/_/g, '.')) : null
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }

function emulatorBuild(folders) {
  for (const dir of folders) {
    const branches = readText(path.join(dir, 'steam_settings', 'branches.json'))
    const fromBranches = branches && buildFromBranches(branches)
    if (fromBranches) return fromBranches
    const build = Number((readText(path.join(dir, 'steam_settings', 'build_id.txt')) || '').trim())
    if (build > 0) return { build, date: null }
  }
  return null
}

function manifestBuild(dir, appid) {
  const lib = String(dir).match(/^(.*[\\/]steamapps)[\\/]common[\\/]/i)?.[1]
  if (!lib || !appid) return null
  const text = readText(path.join(lib, `appmanifest_${appid}.acf`))
  return text ? buildFromManifest(text) : null
}

// The game's exe, and the real one for an Unreal game whose exe is only a small launcher.
async function findExes(root, exeName) {
  const want = String(exeName || '').toLowerCase()
  const found = { exact: null, shipping: null }
  const queue = [[root, 0]]
  let seen = 0
  while (queue.length && seen < MAX_ENTRIES && !(found.exact && found.shipping)) {
    const [dir, depth] = queue.shift()
    let list
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of list) {
      seen++
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !NOT_THE_GAME.test(e.name)) queue.push([path.join(dir, e.name), depth + 1])
      } else if (!found.exact && want && e.name.toLowerCase() === want) {
        found.exact = path.join(dir, e.name)
      } else if (!found.shipping && /-shipping\.exe$/i.test(e.name)) {
        found.shipping = path.join(dir, e.name)
      }
    }
  }
  return found
}

// What this PC's copy is. Null when its folder isn't here.
async function readLocal(game) {
  const dir = game?.install_path
  if (!dir || !fs.existsSync(dir)) return null
  const { exact, shipping } = await findExes(dir, game.exe_name)
  // A tool or an installer says nothing about the game's version.
  const watched = exact && !require('./pcScanner').isHelperExe(path.basename(exact)) ? exact : null
  const exes = [watched, shipping].filter(Boolean)
  const folders = [...new Set([dir, ...exes.map(x => path.dirname(x))])]
  const built = emulatorBuild(folders) || manifestBuild(dir, game.steam_app_id)
  let version = null
  for (const x of exes) {
    version = exeVersion(readExeVersion(x))
    if (version) break
  }
  if (!version) version = versionInFolder(path.basename(dir)) || versionInFolder(path.basename(path.dirname(dir)))
  // The biggest exe is the game itself: a launcher's date can be any time.
  let fileDate = null, biggest = -1
  for (const x of exes) {
    try {
      const st = fs.statSync(x)
      if (st.size > biggest) { biggest = st.size; fileDate = st.mtimeMs }
    } catch {}
  }
  return { version, build: built?.build || null, date: built?.date || fileDate || null }
}

// ── What Steam has ──────────────────────────────────────────────────────────

// Pure: "Update 0.5.4.7" -> "0.5.4.7". "HoT Patch | 2026-10-29" -> null.
function versionInTitle(title) {
  const t = String(title || '')
  const m = t.match(/\b(?:v|ver\.?|version|update|patch|hotfix|build)\s*(\d+(?:\.\d+)+)/i) || t.match(/\b(\d+\.\d+\.\d+(?:\.\d+)?)\b/)
  return m ? m[1] : null
}

// Pure: what the newest patch notes say. Only the newest few count: an old number on a
// game that stopped writing them would make an old copy look current.
function newsFacts(items) {
  const patches = (items || []).filter(n => n.patch).sort((a, b) => b.date - a.date)
  if (!patches.length) return null
  let version = null
  for (const n of patches.slice(0, 3)) {
    version = versionInTitle(n.title)
    if (version) break
  }
  return { at: patches[0].date || null, version }
}

const within = (promise, ms) => Promise.race([
  promise.catch(() => null),
  new Promise(resolve => setTimeout(() => resolve(null), ms)),
])

async function fetchBuild(appid) {
  const r = await require('axios').get(`https://api.steamcmd.net/v1/info/${appid}`, {
    timeout: WAIT_MS, headers: { 'User-Agent': 'KoZo' },
  })
  const pub = r.data?.data?.[appid]?.depots?.branches?.public
  const build = Number(pub?.buildid)
  if (!(build > 0)) return null
  const at = Number(pub.timeupdated)
  return { build, at: at > 0 ? at * 1000 : null }
}

async function latestOnSteam(appid) {
  const id = Number(appid)
  if (!(id > 0)) return null
  const hit = latestCache.get(id)
  if (hit && Date.now() - hit.at < TTL) return hit.latest
  const [built, news] = await Promise.all([
    within(fetchBuild(id), WAIT_MS),
    within(require('./steamNews').getNews(id).then(newsFacts), WAIT_MS),
  ])
  if (!built && !news) return hit?.latest || null   // keep the last answer
  const latest = { build: built?.build || null, at: built?.at || news?.at || null, version: news?.version || null }
  latestCache.set(id, { at: Date.now(), latest })
  if (latestCache.size > MAX_CACHED) latestCache.delete(latestCache.keys().next().value)
  return latest
}

// ── The tag ─────────────────────────────────────────────────────────────────

// Pure: 1.10 is newer than 1.9, so numbers, not text.
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

// Pure. Builds and version numbers can be compared for certain ('behind', 'current').
// Dates can't: an update may not touch the exe, and a copy from another store has its own
// dates. So a date only ever says 'maybe', and never that a copy is up to date.
function versionState(local, latest) {
  if (!local || !latest) return 'unknown'
  if (local.build && latest.build) return local.build >= latest.build ? 'current' : 'behind'
  if (local.version && latest.version) return compareVersions(local.version, latest.version) >= 0 ? 'current' : 'behind'
  if (local.date && latest.at && latest.at > local.date + 3 * DAY) return 'maybe'
  return 'unknown'
}

const fullDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// Pure: what the page shows. Null when there's nothing to say about this copy.
function versionSummary(local, latest) {
  if (!local) return null
  const text = local.version ? `v${local.version}`
    : local.build ? `Build ${local.build}`
      : local.date ? `Files from ${new Date(local.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`
        : null
  if (!text) return null
  const state = versionState(local, latest)
  const mine = local.version ? `version ${local.version}` : local.build ? `build ${local.build}` : "no version number in its files"
  const lines = [`Your copy: ${mine}${local.date ? `, from ${fullDate(local.date)}` : ''}.`]
  if (latest) {
    const theirs = latest.version ? `version ${latest.version}` : latest.build ? `build ${latest.build}` : null
    const when = latest.at ? `updated ${fullDate(latest.at)}` : null
    if (theirs || when) lines.push(`Steam: ${[theirs, when].filter(Boolean).join(', ')}.`)
  }
  if (state === 'maybe') lines.push('This only compares dates, and a copy from another store can differ.')
  return { text, state, hint: lines.join(' ') }
}

async function getVersion(gameId) {
  const game = require('../db/queries/games').getGame(gameId)
  if (!game) return null
  const local = await readLocal(game)
  if (!local) return null
  let latest = null
  try { latest = await latestOnSteam(game.steam_app_id) }
  catch (e) { logger.warn('gameVersion: Steam check failed', { message: e.message }) }
  return versionSummary(local, latest)
}

module.exports = {
  getVersion, readLocal, latestOnSteam, readExeVersion,
  parseVersionBlock, cleanVersion, exeVersion, buildFromBranches, buildFromManifest, versionInFolder,
  versionInTitle, newsFacts, compareVersions, versionState, versionSummary,
}
