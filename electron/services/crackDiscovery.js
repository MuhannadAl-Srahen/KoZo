'use strict'

// Find cracked games that have achievement data on this PC but aren't in the
// library yet.
//
// KoZo has always worked the other way round: you add a game, and only then
// does it go looking for that game's emulator files. So a game you played
// without adding it is invisible, even though its unlocks are sitting on disk
// in a folder KoZo already knows how to read. (Achievement Watcher goes at it
// from this end — it discovers games from the save files rather than from a
// list you maintain.)
//
// PERF: this is deliberately NOT Achievement Watcher's approach of globbing
// entire drives for emulator config files. It is one shallow readdir per known
// emulator root (about 20 of them), looking for app-id-named subfolders — a
// bounded, few-millisecond pass. It still only runs on demand or at idle, never
// while a game is running.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const DISMISSED_SETTING = 'discover_dismissed_appids'

let lastResult = null   // last completed sweep — served while a session is active

// Placeholder app id used to reverse the emulator roots out of buildCandidates.
// Deriving them means discovery automatically covers every layout the scanner
// knows; a hand-copied second list would silently drift the moment one is added.
const PLACEHOLDER = '__KOZO_ID__'

function emulatorRoots() {
  const { buildCandidates } = require('./crackWatcher')
  const roots = new Map()   // lowercased -> { root, source }
  let cands = []
  try {
    cands = buildCandidates({ steam_app_id: PLACEHOLDER, manual_appid: null, install_path: null })
  } catch (e) {
    logger.warn('crackDiscovery: could not derive emulator roots', { message: e.message })
    return []
  }
  for (const c of cands) {
    const parts = String(c.path).split(path.sep)
    const i = parts.indexOf(PLACEHOLDER)
    if (i <= 0) continue                       // not an appid-keyed layout
    const root = parts.slice(0, i).join(path.sep)
    const key = root.toLowerCase()
    if (!roots.has(key)) roots.set(key, { root, source: c.source })
  }
  return [...roots.values()]
}

function dismissed() {
  try {
    const raw = require('../db/queries/settings').getSetting(DISMISSED_SETTING)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch { return new Set() }
}

function dismiss(appId) {
  try {
    const settingsQ = require('../db/queries/settings')
    const set = dismissed()
    set.add(String(appId))
    settingsQ.setSetting(DISMISSED_SETTING, JSON.stringify([...set]))
  } catch {}
  return true
}

function knownAppIds() {
  const ids = new Set()
  try {
    const rows = require('../db/database').getDb()
      .prepare('SELECT steam_app_id, manual_appid FROM games').all()
    for (const r of rows) {
      if (r.steam_app_id) ids.add(String(r.steam_app_id))
      if (r.manual_appid) ids.add(String(r.manual_appid))
    }
  } catch {}
  return ids
}

// Read the game's name straight out of Steam's local schema file. Free, offline,
// and available for anything the Steam client has ever fetched stats for — worth
// trying before spending a network round trip.
function localName(appId) {
  try {
    const steam = require('./steamStatsWatcher').getSteamPath()
    if (!steam) return null
    const f = path.join(steam, 'appcache', 'stats', `UserGameStatsSchema_${appId}.bin`)
    if (!fs.existsSync(f)) return null
    const root = require('./binaryKV').parseBinaryKV(fs.readFileSync(f))
    if (!root) return null
    const app = root[Object.keys(root)[0]]
    return app?.gamename || app?.gameName || null
  } catch { return null }
}

// How many achievements this app id has actually unlocked on disk. Reuses the
// same candidate list and parsers the real scanner uses, so a game discovered
// here reads exactly as it will once it's added.
function unlockInfo(appId) {
  const cw = require('./crackWatcher')
  let best = { unlocked: 0, file: null, source: null }
  let cands = []
  try {
    cands = cw.buildCandidates({ steam_app_id: appId, manual_appid: null, install_path: null })
  } catch { return best }

  for (const c of cands) {
    let text
    try {
      if (!fs.existsSync(c.path)) continue
      if (c.parse === 'sse') continue          // needs a schema to match CRCs; skip here
      text = fs.readFileSync(c.path, 'utf8')
    } catch { continue }
    let unlocks = []
    try { unlocks = c.parse(text) || [] } catch { continue }
    if (!best.file || unlocks.length > best.unlocked) {
      best = { unlocked: unlocks.length, file: c.path, source: c.source }
    }
  }
  return best
}

/**
 * Emulator app ids with achievement data that aren't in the library.
 * Returns [{ appId, source, path, unlocked, name, headerImage }].
 * `resolveNames: false` skips the network lookups.
 */
async function discover({ resolveNames = true } = {}) {
  const known = knownAppIds()
  const skip = dismissed()

  // Perf invariant (§10): no disk sweep or network while a game is running —
  // serve the last completed sweep instead, re-filtered against the live
  // added/dismissed state so mid-session adds and dismissals still drop out.
  if (require('./processWatcher').isSessionActive()) {
    return (lastResult || []).filter(g => !known.has(g.appId) && !skip.has(g.appId))
  }
  const found = new Map()   // appId -> entry

  for (const { root, source } of emulatorRoots()) {
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue
      const appId = ent.name
      if (known.has(appId) || skip.has(appId)) continue
      if (found.has(appId)) continue
      const info = unlockInfo(appId)
      // A folder with no readable achievement file is just emulator scaffolding.
      if (!info.file) continue
      // ...and a readable file with ZERO unlocks is scaffolding too: emulators
      // create these on first run, and they outlive the game by years. Offering
      // to add a game the user no longer has (or never played) is pure noise —
      // only surface a folder that actually holds progress worth importing.
      if (!info.unlocked) continue
      found.set(appId, {
        appId,
        source: info.source || source,
        path: path.join(root, appId),
        unlocked: info.unlocked,
        name: localName(appId),
        headerImage: null,
      })
    }
  }

  const list = [...found.values()]
  if (resolveNames) {
    const { getStoreDetails } = require('./steamApi')
    for (const g of list) {
      try {
        const d = await getStoreDetails(g.appId)
        if (d?.name) g.name = d.name
        if (d?.header_image) g.headerImage = d.header_image
      } catch {}
    }
  }
  // Most unlocks first — that's the one most worth adding.
  list.sort((a, b) => b.unlocked - a.unlocked || String(a.name || '').localeCompare(String(b.name || '')))
  lastResult = list

  if (list.length) {
    logger.info(`crackDiscovery: ${list.length} game(s) with achievement data not in the library`,
      { games: list.map(g => `${g.name || g.appId} (${g.unlocked} unlocked, ${g.source})`) })
  }
  return list
}

module.exports = { discover, dismiss, emulatorRoots }
