'use strict'

// Best-effort save-game locator. Searches the standard Windows + Steam save
// locations for folders that belong to a game and actually contain save data.
//
// Accuracy matters more than coverage here, so a candidate is only returned when
// EITHER the folder name is a strong match for the game name OR the folder
// genuinely looks like a save folder (save-typed files / a "save" subfolder).
// This also handles publisher\abbreviation layouts like
// `AppData\Local\Pearl Abyss\CD\save` (Crimson Desert) by walking two levels
// deep and matching the game's acronym ("CD").

const fs   = require('fs')
const path = require('path')
const os   = require('os')

function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '') }

function safeList(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}

// File extensions that strongly indicate save data.
const SAVE_EXTS = new Set(['.sav', '.save', '.dat', '.bin', '.slot', '.profile', '.prof', '.svg', '.gamesave', '.save0', '.save1'])
const SAVE_DIR_NAMES = new Set(['save', 'saves', 'saved', 'savegame', 'savegames', 'savedata', 'savedgames', 'profile', 'profiles', 'player', 'players', 'storage'])

// Looks for save-typed files or a save subfolder up to `depth` levels deep.
// Returns { files, saveLike } — files = quick count, saveLike = confidence flag.
function inspect(dir, depth = 2) {
  let files = 0
  let saveLike = false
  function walk(d, lvl) {
    if (lvl > depth || files > 2000) return
    for (const e of safeList(d)) {
      if (e.isFile()) {
        files++
        const ext = path.extname(e.name).toLowerCase()
        if (SAVE_EXTS.has(ext)) saveLike = true
      } else if (e.isDirectory()) {
        if (SAVE_DIR_NAMES.has(e.name.toLowerCase())) saveLike = true
        walk(path.join(d, e.name), lvl + 1)
      }
    }
  }
  walk(dir, 0)
  return { files, saveLike }
}

// Words that are just edition/qualifier suffixes — a folder named "Game GOTY"
// is still the same game, but "Hollow Knight Silksong" is NOT.
const EDITION_WORDS = new Set([
  'goty', 'gameoftheyear', 'definitive', 'definitiveedition', 'edition', 'remastered',
  'remaster', 'complete', 'completeedition', 'enhanced', 'deluxe', 'ultimate', 'gold',
  'directorscut', 'redux', 'anniversary', 'hd', 'remake', 'reloaded', 'classic', 'standard',
])

function buildMatcher(game) {
  const gameNorm = norm(game.name)
  const words = (game.name || '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  const acronym = words.length >= 2 ? words.map(w => w[0]).join('').toLowerCase() : null

  // Is `leftover` (folder name minus the game name) only edition-qualifier text?
  function leftoverIsEdition(leftover) {
    if (!leftover) return true
    let rest = leftover
    for (const w of EDITION_WORDS) rest = rest.split(w).join('')
    return rest.length === 0
  }

  // Returns a confidence score 0–100 for a folder name belonging to this game.
  return function score(folderName) {
    const n = norm(folderName)
    if (!n) return 0
    if (n === gameNorm) return 100
    // Folder CONTAINS the game name — only accept if the extra text is an edition
    // qualifier, never a different game (e.g. reject "hollowknightsilksong").
    if (gameNorm.length >= 4 && n.includes(gameNorm)) {
      const leftover = n.split(gameNorm).join('')
      return leftoverIsEdition(leftover) ? 90 : 0
    }
    // Game name contains the folder name (folder is a shorter form) — require the
    // folder to be a substantial prefix so "witcher3" matches "thewitcher3wildhunt"
    // but a tiny fragment doesn't match everything.
    if (n.length >= 6 && gameNorm.includes(n)) return 76
    if (acronym && acronym.length >= 2 && n === acronym) return 64   // "CD" → Crimson Desert
    return 0
  }
}

function findSaveLocations(game) {
  const home     = os.homedir()
  const appdata  = process.env.APPDATA      || path.join(home, 'AppData', 'Roaming')
  const local    = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const localLow = path.join(home, 'AppData', 'LocalLow')
  const docs     = path.join(home, 'Documents')
  const savedG   = path.join(home, 'Saved Games')
  const score    = buildMatcher(game)

  const results = []
  const seen = new Set()
  function add(p, source, confidence) {
    if (!p) return
    const key = p.toLowerCase()
    if (seen.has(key)) return
    try { if (!fs.existsSync(p)) return } catch { return }
    seen.add(key)
    const { files, saveLike } = inspect(p)
    results.push({ path: p, source, files, saveLike, confidence })
  }

  // Walk each base dir up to 2 levels, scoring folder names. A name match at any
  // level is a candidate; if its name is only a weak (acronym) match we still
  // accept it because acronym + existence is meaningful for publisher layouts.
  const baseDirs = [
    { dir: path.join(docs, 'My Games'), source: 'Documents\\My Games' },
    { dir: savedG,   source: 'Saved Games' },
    { dir: docs,     source: 'Documents' },
    { dir: appdata,  source: 'AppData\\Roaming' },
    { dir: local,    source: 'AppData\\Local' },
    { dir: localLow, source: 'AppData\\LocalLow' },
  ]

  for (const { dir, source } of baseDirs) {
    for (const lvl1 of safeList(dir)) {
      if (!lvl1.isDirectory()) continue
      const p1 = path.join(dir, lvl1.name)
      const s1 = score(lvl1.name)
      if (s1 > 0) addBest(p1, source, s1)

      // Second level (publisher\game). Only descend into non-matching parents to
      // find e.g. Pearl Abyss → CD; cap how many children we scan for speed.
      let scanned = 0
      for (const lvl2 of safeList(p1)) {
        if (scanned++ > 60) break
        if (!lvl2.isDirectory()) continue
        const s2 = score(lvl2.name)
        if (s2 > 0) addBest(path.join(p1, lvl2.name), source, s2)
      }
    }
  }

  // Prefer the deepest save-typed subfolder when a matched folder contains one.
  function addBest(folder, source, confidence) {
    // If the matched folder has a save subfolder, point at that instead.
    const sub = safeList(folder).find(e => e.isDirectory() && SAVE_DIR_NAMES.has(e.name.toLowerCase()))
    if (sub) add(path.join(folder, sub.name), source, confidence)
    add(folder, source, confidence)
  }

  // The game's own install folder save subfolders (high confidence).
  if (game.install_path) {
    for (const sub of SAVE_DIR_NAMES) {
      add(path.join(game.install_path, sub), 'Game folder', 95)
    }
  }

  // Steam Cloud — Steam\userdata\<user>\<appid>\
  if (game.steam_app_id) {
    const steamRoots = ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', path.join(local, 'Steam')]
    for (const root of steamRoots) {
      const ud = path.join(root, 'userdata')
      for (const user of safeList(ud)) {
        if (user.isDirectory()) add(path.join(ud, user.name, String(game.steam_app_id)), 'Steam Cloud', 88)
      }
    }
  }

  // Keep only trustworthy candidates: a strong name match, OR a weaker match that
  // actually looks like a save folder. Drop empty folders.
  const trustworthy = results.filter(r =>
    r.files > 0 && (r.confidence >= 78 || r.saveLike || r.source === 'Steam Cloud' || r.source === 'Game folder')
  )

  // Rank: confidence, then save-like, then file count.
  trustworthy.sort((a, b) =>
    (b.confidence - a.confidence) || (Number(b.saveLike) - Number(a.saveLike)) || (b.files - a.files)
  )

  return trustworthy.map(({ path: p, source, files, saveLike }) => ({ path: p, source, files, saveLike }))
}

module.exports = { findSaveLocations }
