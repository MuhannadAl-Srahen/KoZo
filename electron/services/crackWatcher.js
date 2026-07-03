// Crack achievement scanner — heavily inspired by Achievement-Watcher.
//
// Supported emulators & sources:
//   Goldberg SteamEmu, online-fix, CODEX, EMPRESS, ALI213,
//   SmartSteamEmu (SSE binary), CreamAPI, SKIDROW, Reloaded/3DM (RLD!),
//   PLAZA, RLD!, DARKSiDERS, Hoodlum
//
// File formats handled:
//   JSON  — { "ACH_NAME": { "earned": true, "earned_time": 1234567890 } }
//   INI   — [ACH_NAME]\nAchieved=1\nUnlockTime=1234567890  (CODEX/EMPRESS variants)
//   BIN   — SmartSteamEmu 24-byte chunk format (CRC32 API name lookup)

'use strict'

const fs   = require('fs')
const path = require('path')
const os   = require('os')
const logger = require('../logger')

const SCAN_INTERVAL_MS = 30_000
let scanTimer = null

// ── Tiny helpers ─────────────────────────────────────────────────────────────

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

function safeReadBuf(p) {
  try { return fs.readFileSync(p) } catch { return null }
}

function exists(p) {
  try { return fs.existsSync(p) } catch { return false }
}

// ── CRC32 for SSE binary matching ────────────────────────────────────────────
// crc-32 is a transitive dependency already in node_modules.
let _crc32 = null
function crc32hex(str) {
  if (!_crc32) {
    try { _crc32 = require('crc-32') } catch { return null }
  }
  const val = (_crc32.str(str) >>> 0)   // unsigned 32-bit
  return val.toString(16).padStart(8, '0')
}

// ── Parsers ──────────────────────────────────────────────────────────────────

// Goldberg JSON:
//   { "ACH_NAME": { "earned": true, "earned_time": 1700000000 }, ... }
function parseGoldbergJson(text) {
  try {
    const data = JSON.parse(text)
    const out = []
    for (const [name, info] of Object.entries(data)) {
      // earned can be true (bool) or "1" (string)
      const earned = info?.earned === true || info?.earned === 1 || info?.earned === '1'
      if (earned) {
        out.push({ name, unlocktime: parseInt(info.earned_time) || 0 })
      }
    }
    return out
  } catch { return [] }
}

// CODEX / EMPRESS / ALI213 / SKIDROW INI:
//   [ACH_NAME]
//   Achieved=1      (or HaveAchieved=1, Unlocked=1, State=1, State=0101, earned=1)
//   UnlockTime=1700000000   (or HaveAchievedTime=..., Time=...)
function parseCodexIni(text) {
  const out = []
  // Split on section headers
  const parts = text.split(/^\s*\[([^\]]+)\]\s*$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i]?.trim()
    const body = parts[i + 1] || ''
    if (!name) continue
    // Skip meta-sections
    const lower = name.toLowerCase()
    if (lower === 'steamachievements' || lower === 'achievements' ||
        lower === 'settings' || lower === 'gamesettings') continue

    // All the different "achieved" field names across emulators
    const achieved =
      /^Achieved\s*=\s*1/im.test(body)        ||   // CODEX
      /^achieved\s*=\s*1/im.test(body)        ||
      /^HaveAchieved\s*=\s*1/im.test(body)    ||   // SSE INI
      /^Unlocked\s*=\s*1/im.test(body)        ||   // Skidrow alt
      /^State\s*=\s*0101/im.test(body)        ||   // ALI213 hex state
      /^State\s*=\s*1/im.test(body)           ||   // Generic
      /^earned\s*=\s*1/im.test(body)          ||   // EMPRESS alt
      /^CurProgress\s*=\s*1/im.test(body)     ||   // RUNE
      /^AchievementState\s*=\s*1/im.test(body)     // RUNE alt

    if (!achieved) continue

    const timeMatch =
      body.match(/^UnlockTime\s*=\s*(\d+)/im) ||
      body.match(/^HaveAchievedTime\s*=\s*(\d+)/im) ||
      body.match(/^Time\s*=\s*(\d+)/im)

    out.push({ name, unlocktime: timeMatch ? parseInt(timeMatch[1]) : 0 })
  }
  return out
}

// SmartSteamEmu binary (stats.bin):
//   4-byte header: int32LE = entry count
//   Each entry: 24 bytes
//     [0..3]  = CRC32 of API name (reversed bytes → hex)
//     [8..11] = unlock time (int32LE)
//     [20..23]= value: 0 or 1 = achievement; >1 = stat (skip)
//
// We match the stored CRC against crc32(schemaName) for every achievement.
function parseSseBinary(buf, schemaNames) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return []
    const count = buf.readInt32LE(0)
    const data  = buf.slice(4)
    const CHUNK = 24
    if (data.length !== count * CHUNK) return []  // sanity check

    // Pre-compute schema CRC lookup map
    const crcMap = {}     // hex → apiname
    for (const name of schemaNames) {
      const h = crc32hex(name)
      if (h) crcMap[h] = name
    }

    const out = []
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(i * CHUNK, (i + 1) * CHUNK)
      const value = chunk.readInt32LE(20)
      if (value > 1) continue   // stat, not an achievement

      const crcBytes = chunk.slice(0, 4).reverse().toString('hex')
      const apiName  = crcMap[crcBytes]
      if (!apiName) continue

      const unlocktime = chunk.readInt32LE(8)
      if (value === 1) {
        out.push({ name: apiName, unlocktime })
      }
    }
    return out
  } catch { return [] }
}

// ── Path builder ─────────────────────────────────────────────────────────────

function buildCandidates(game) {
  const home    = os.homedir()
  const appdata = process.env.APPDATA       || path.join(home, 'AppData', 'Roaming')
  const local   = process.env.LOCALAPPDATA  || path.join(home, 'AppData', 'Local')
  const pub     = process.env.PUBLIC        || 'C:\\Users\\Public'
  const progdata= process.env.PROGRAMDATA   || 'C:\\ProgramData'

  // My Documents — try env var first, fall back to default
  let mydocs = null
  try {
    const { execSync } = require('child_process')
    const reg = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v Personal',
      { encoding: 'utf8', stdio: 'pipe' }
    )
    const m = reg.match(/Personal\s+REG_EXPAND_SZ\s+(.+)/i)
    if (m) mydocs = m[1].trim().replace(/%USERPROFILE%/i, home)
  } catch {}
  if (!mydocs) mydocs = path.join(home, 'Documents')

  // Unzipped/cracked games without a detected steam_app_id fall back to the
  // name-matched manual_appid — emulator folders are keyed by that same appid.
  const id  = String(game.steam_app_id || game.manual_appid || 0)
  const ip  = game.install_path || ''
  const cands = []

  const add = (filePath, parse, source) =>
    cands.push({ path: filePath, parse, source })

  const J = parseGoldbergJson
  const I = parseCodexIni

  // ── 1. Goldberg SteamEmu — AppData\Roaming ─────────────────────────────
  add(path.join(appdata, 'Goldberg SteamEmu Saves', id, 'achievements.json'), J, 'Goldberg')
  add(path.join(appdata, 'GSE Saves', id, 'achievements.json'),               J, 'Goldberg')
  add(path.join(appdata, 'Steam', id, 'achievements.json'),                   J, 'Goldberg')
  add(path.join(local,   'Goldberg SteamEmu Saves', id, 'achievements.json'), J, 'Goldberg')

  // ── 2. CODEX ─────────────────────────────────────────────────────────────
  add(path.join(pub, 'Documents', 'Steam', 'CODEX', id, 'achievements.ini'),  I, 'CODEX')
  add(path.join(appdata, 'Steam', 'CODEX', id, 'achievements.ini'),           I, 'CODEX')
  add(path.join(appdata, 'Steam', 'CODEX', id, 'stats', 'achievements.ini'),  I, 'CODEX')

  // ── 3. EMPRESS ───────────────────────────────────────────────────────────
  add(path.join(pub, 'Documents', 'EMPRESS', id, 'achievements.ini'),                   I, 'EMPRESS')
  add(path.join(pub, 'Documents', 'EMPRESS', id, 'remote', id, 'achievements.ini'),     I, 'EMPRESS')
  add(path.join(appdata, 'EMPRESS', id, 'achievements.ini'),                            I, 'EMPRESS')
  add(path.join(appdata, 'EMPRESS', id, 'remote', id, 'achievements.ini'),              I, 'EMPRESS')

  // ── 4. SmartSteamEmu (SSE) — binary stats.bin ────────────────────────────
  // Parsed differently — defer to scanGameSse below
  cands.push({ path: path.join(appdata, 'SmartSteamEmu', id, 'stats.bin'), parse: 'sse', source: 'SSE' })
  add(path.join(appdata, 'SmartSteamEmu', id, 'achievements.ini'),                      I, 'SSE')

  // ── 5. SKIDROW ───────────────────────────────────────────────────────────
  add(path.join(local, 'SKIDROW', id, 'achievements.ini'),                     I, 'SKIDROW')
  add(path.join(mydocs, 'SkidRow', id, 'achievements.ini'),                    I, 'SKIDROW')
  add(path.join(pub, 'Documents', 'Steam', 'SKIDROW', id, 'achievements.ini'), I, 'SKIDROW')

  // ── 6. CreamAPI ──────────────────────────────────────────────────────────
  add(path.join(appdata, 'CreamAPI', id, 'achievements.ini'),                                I, 'CreamAPI')
  add(path.join(appdata, 'CreamAPI', id, 'stats', 'CreamAPI.Achievements.cfg'),              I, 'CreamAPI')

  // ── 7. Reloaded / 3DM / RLD! ─────────────────────────────────────────────
  add(path.join(progdata, 'Steam', id, 'achievements.ini'),                    I, 'Reloaded')
  add(path.join(pub, 'Documents', 'RLD!', id, 'achievements.ini'),             I, 'RLD!')
  add(path.join(pub, 'Documents', 'Steam', 'RUNE',  id, 'achievements.ini'),   I, 'RUNE')
  add(path.join(pub, 'Documents', 'Steam', 'PLAZA', id, 'achievements.ini'),   I, 'PLAZA')

  // ── 8. ALI213 ─────────────────────────────────────────────────────────────
  add(path.join(local, 'Ali213', id, 'Stats', 'achievements.ini'),             I, 'ALI213')

  // ── 9. online-fix ─────────────────────────────────────────────────────────
  add(path.join(appdata, 'OnlineFix', id, 'achievements.json'),                J, 'online-fix')
  add(path.join(pub, 'Documents', 'OnlineFix', id, 'achievements.json'),       J, 'online-fix')

  // ── 10. In-game install folder (various layouts) ──────────────────────────
  if (ip) {
    // Goldberg local save mode — some repacks configure saves inside game folder
    add(path.join(ip, id, 'achievements.json'),                                J, 'Goldberg')
    add(path.join(ip, 'local_save', id, 'achievements.json'),                  J, 'Goldberg')
    add(path.join(ip, 'local_save', id, 'stats', 'achievements.json'),         J, 'Goldberg')
    // Goldberg inside game folder
    add(path.join(ip, 'steam_settings', 'achievements.json'),                  J, 'Goldberg')
    add(path.join(ip, 'Goldberg SteamEmu Saves', id, 'achievements.json'),     J, 'Goldberg')
    add(path.join(ip, 'GSE Saves', id, 'achievements.json'),                   J, 'Goldberg')
    add(path.join(ip, 'steam_emu', 'saves', 'achievements.json'),              J, 'Goldberg')
    add(path.join(ip, 'steam_api', 'achievements.json'),                       J, 'Goldberg')
    // online-fix inside game
    add(path.join(ip, 'OnlineFix', 'achievements.json'),                       J, 'online-fix')
    add(path.join(ip, 'online-fix.me', 'achievements.json'),                   J, 'online-fix')
    // CODEX/INI inside game
    add(path.join(ip, 'achievements.ini'),                                     I, 'CODEX')
    add(path.join(ip, 'steam_api', 'achievements.ini'),                        I, 'CODEX')
    add(path.join(ip, 'steam_emu', 'stats', 'achievements.ini'),               I, 'CODEX')
    add(path.join(ip, 'Profile', id, 'achievements.ini'),                      I, 'CODEX')
    // EMPRESS in-game subfolder
    add(path.join(ip, 'EMPRESS', 'remote', id, 'achievements.ini'),            I, 'EMPRESS')
    // SKIDROW / RLD in-game
    add(path.join(ip, 'RUNE', id, 'achievements.ini'),                         I, 'RUNE')
    // SSE inside game
    cands.push({ path: path.join(ip, 'SmartSteamEmu', 'stats.bin'), parse: 'sse', source: 'SSE' })
  }

  return cands
}

// ── Emulator config detection ────────────────────────────────────────────────
// Cracks ship their own appid config; when it differs from the appid KoZo
// stored (common with repacks) every fixed candidate path points at the wrong
// emulator folder. Read every appid the install folder declares.

function readEmuConfigAppIds(installPath) {
  const ids = new Set()
  if (!installPath || !exists(installPath)) return []

  const tryTxt = (p) => {
    const raw = safeRead(p)
    if (raw && /^\d+$/.test(raw.trim())) ids.add(raw.trim())
  }
  const tryIni = (p) => {
    const raw = safeRead(p)
    const m = raw && raw.match(/^\s*AppId\s*=\s*(\d+)/im)
    if (m) ids.add(m[1])
  }

  const roots = [installPath]
  // One level of subdirs — repacks often keep the emu config beside the exe in Bin/.
  try {
    for (const ent of fs.readdirSync(installPath, { withFileTypes: true })) {
      if (ent.isDirectory() && !SKIP_DIRS.has(ent.name.toLowerCase())) {
        roots.push(path.join(installPath, ent.name))
      }
      if (roots.length > 25) break
    }
  } catch {}

  for (const root of roots) {
    tryTxt(path.join(root, 'steam_appid.txt'))
    tryTxt(path.join(root, 'appid.txt'))
    tryTxt(path.join(root, 'steam_settings', 'steam_appid.txt'))
    tryIni(path.join(root, 'steam_emu.ini'))       // CODEX / RUNE / PLAZA family
    tryIni(path.join(root, 'OnlineFix.ini'))
    tryIni(path.join(root, 'SmartSteamEmu.ini'))
    tryIni(path.join(root, 'ColdClientLoader.ini')) // Goldberg loader
  }
  return [...ids]
}

// Best-effort emulator family name from the install folder's config files.
function detectEmulator(installPath) {
  if (!installPath || !exists(installPath)) return null
  const emuIni = safeRead(path.join(installPath, 'steam_emu.ini'))
  if (emuIni) {
    if (/RUNE/i.test(emuIni))  return 'RUNE'
    if (/CODEX/i.test(emuIni)) return 'CODEX'
    if (/PLAZA/i.test(emuIni)) return 'PLAZA'
    return 'CODEX/RUNE-family (steam_emu.ini)'
  }
  if (exists(path.join(installPath, 'steam_settings')) ||
      exists(path.join(installPath, 'ColdClientLoader.ini'))) return 'Goldberg'
  if (exists(path.join(installPath, 'OnlineFix.ini')))        return 'online-fix'
  if (exists(path.join(installPath, 'SmartSteamEmu.ini')))    return 'SmartSteamEmu'
  return null
}

// ── Recursive walk of install folder ─────────────────────────────────────────

const MAX_DEPTH   = 4
const MAX_ENTRIES = 4000
const SKIP_DIRS = new Set([
  'engine','content','paks','movies','audio','video','binaries',
  'data','gamedata','localization','shaders','fonts','maps','levels',
  'sound','textures','redist','redistributable','__macosx',
  'shader_cache', 'vulkan', 'directx', 'dx11', 'dx12',
])

function recursiveScan(rootPath, appid) {
  const hits = []
  if (!rootPath || !exists(rootPath)) return hits
  let visited = 0
  function walk(dir, depth) {
    if (depth > MAX_DEPTH || visited > MAX_ENTRIES) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    visited += entries.length
    for (const ent of entries) {
      const lower = ent.name.toLowerCase()
      if (ent.isFile()) {
        if (lower === 'achievements.json') {
          hits.push({ path: path.join(dir, ent.name), parse: parseGoldbergJson, source: 'auto-JSON' })
        } else if (lower === 'achievements.ini' || lower === 'achiev.ini' || lower === 'stats.ini') {
          hits.push({ path: path.join(dir, ent.name), parse: parseCodexIni, source: 'auto-INI' })
        } else if (lower === 'stats.bin') {
          hits.push({ path: path.join(dir, ent.name), parse: 'sse', source: 'auto-SSE' })
        }
      } else if (ent.isDirectory()) {
        if (SKIP_DIRS.has(lower)) continue
        if (appid && lower === String(appid)) {
          walk(path.join(dir, ent.name), depth)   // appid subfolder doesn't count against depth
        } else {
          walk(path.join(dir, ent.name), depth + 1)
        }
      }
    }
  }
  walk(rootPath, 0)
  return hits
}

// ── Main per-game scan ────────────────────────────────────────────────────────

async function scanGameForCrackAchievements(gameId) {
  const { getDb }     = require('../db/database')
  const achievementsQ = require('../db/queries/achievements')
  const gamesQ        = require('../db/queries/games')

  const game = gamesQ.getGame(gameId)
  if (!game) return { added: 0, hits: [], scannedPaths: [], candidatesTried: 0 }

  // Make sure the achievement schema is present BEFORE matching. Without it
  // `localAchs` is empty and every crack unlock is silently skipped — the same
  // "empty schema = no unlocks" root-cause bug that affected Steam sync. Cracked
  // games still carry a steam_app_id (for art + name matching), so the schema can
  // be fetched from Steam even though the player doesn't own the game on Steam.
  try { await require('./achievementSync').ensureSchema(gameId) } catch {}

  // Build candidate list
  const fixed     = buildCandidates(game)
  const gameAppid = game.steam_app_id || game.manual_appid
  const recursive = recursiveScan(game.install_path, gameAppid)

  // The install folder's own emu config may declare a DIFFERENT appid than the
  // one KoZo stored (repacks do this) — emulator save folders are keyed by the
  // config appid, so build candidates for those too, tagged so a hit can
  // auto-correct manual_appid below.
  const configIds = readEmuConfigAppIds(game.install_path)
  const configCandidates = []
  for (const cid of configIds) {
    if (String(cid) === String(gameAppid)) continue
    for (const c of buildCandidates({ ...game, steam_app_id: Number(cid), manual_appid: null })) {
      configCandidates.push({ ...c, appid: cid })
    }
  }

  // If install_path ends in a binary subfolder (e.g. \Binaries\Win64, \Bin\x64),
  // also scan the parent directories since achievement files live at the game root.
  const BINARY_SUBDIRS = new Set([
    'win64','win32','x64','x86','binaries','bin','binary','win','shipping'
  ])
  const ipLower = (game.install_path || '').toLowerCase()
  const ipBase  = path.basename(ipLower)
  let extraRecursive = []
  if (BINARY_SUBDIRS.has(ipBase) && game.install_path) {
    const parent1 = path.dirname(game.install_path)
    const parent2 = path.dirname(parent1)
    const root    = path.parse(game.install_path).root
    if (parent1 !== game.install_path && parent1 !== root) {
      extraRecursive = [...extraRecursive, ...recursiveScan(parent1, gameAppid)]
    }
    if (parent2 !== parent1 && parent2 !== root) {
      extraRecursive = [...extraRecursive, ...recursiveScan(parent2, gameAppid)]
    }
  }

  const all = [...fixed, ...configCandidates, ...recursive, ...extraRecursive]

  // Deduplicate by lowercase path
  const seen = new Set()
  const unique = all.filter(c => {
    const k = c.path.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // Load schema names for SSE CRC matching
  let schemaNames = null
  function getSchemaNames() {
    if (schemaNames !== null) return schemaNames
    const achs = achievementsQ.listAchievementsForGame(gameId)
    schemaNames = achs.map(a => a.steam_api_name).filter(Boolean)
    return schemaNames
  }

  const hits        = []
  const scannedPaths = []
  const allUnlocks  = []

  for (const c of unique) {
    if (!exists(c.path)) continue
    scannedPaths.push({ path: c.path, source: c.source })

    let unlocks = []
    if (c.parse === 'sse') {
      const buf = safeReadBuf(c.path)
      if (buf) unlocks = parseSseBinary(buf, getSchemaNames())
    } else {
      const text = safeRead(c.path)
      if (text) unlocks = c.parse(text)
    }

    if (unlocks.length > 0) {
      hits.push({ path: c.path, source: c.source, count: unlocks.length, appid: c.appid || null })
      for (const u of unlocks) allUnlocks.push(u)
    }
  }

  if (allUnlocks.length === 0) {
    return { added: 0, hits, scannedPaths, candidatesTried: unique.length }
  }

  // Map api_name → local achievement row
  const localAchs = achievementsQ.listAchievementsForGame(gameId)
  const nameToAch = {}
  const alreadyUnlocked = new Set()
  for (const a of localAchs) {
    if (a.steam_api_name) nameToAch[a.steam_api_name.toUpperCase()] = a
    if (a.unlocked_at) alreadyUnlocked.add(a.id)
  }

  let added = 0
  const newUnlocks = []
  for (const u of allUnlocks) {
    if (!u.name) continue
    const ach = nameToAch[u.name.toUpperCase()]
    if (!ach || alreadyUnlocked.has(ach.id)) continue
    const ts = u.unlocktime > 0
      ? new Date(u.unlocktime * 1000).toISOString()
      : new Date().toISOString()
    try {
      achievementsQ.addUnlock({
        achievement_id: ach.id,
        session_id: null,
        unlocked_at: ts,
        source: 'crack',
      })
      newUnlocks.push({ ...ach, unlocked_at: ts })
      alreadyUnlocked.add(ach.id)
      added++
    } catch {}
  }

  if (added > 0) {
    logger.info(`crackWatcher: ${added} new unlocks for "${game.name}" via [${hits.map(h => h.source).join(', ')}]`)
    // A hit under a config-declared appid means KoZo's stored appid was wrong —
    // remember the working one so future scans/watchers key off it directly.
    const hitAppid = hits.find(h => h.appid)?.appid
    if (hitAppid && !game.steam_app_id) {
      try { gamesQ.updateGame(gameId, { manual_appid: Number(hitAppid) }) } catch {}
    }
    require('./achievementSync').emitNewUnlocks(game, newUnlocks)
  }

  return { added, hits, scannedPaths, candidatesTried: unique.length }
}

// ── Structured diagnosis (powers the "Check achievements" panel) ─────────────

async function diagnoseGame(gameId) {
  const gamesQ        = require('../db/queries/games')
  const achievementsQ = require('../db/queries/achievements')

  const game = gamesQ.getGame(gameId)
  if (!game) return { error: 'game_not_found' }

  const storedAppId  = game.steam_app_id || game.manual_appid || null
  const configAppIds = readEmuConfigAppIds(game.install_path)
  const emulator     = detectEmulator(game.install_path)
  const mismatch     = !!(storedAppId && configAppIds.length &&
                          !configAppIds.includes(String(storedAppId)))

  // Candidate files for the stored appid AND every config-declared appid.
  const cands = [...buildCandidates(game)]
  for (const cid of configAppIds) {
    if (String(cid) === String(storedAppId)) continue
    for (const c of buildCandidates({ ...game, steam_app_id: Number(cid), manual_appid: null })) {
      cands.push({ ...c, appid: cid })
    }
  }
  const seen = new Set()
  const schemaNames = achievementsQ.listAchievementsForGame(gameId)
    .map(a => a.steam_api_name).filter(Boolean)

  const candidates = []
  for (const c of cands) {
    const k = c.path.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    if (!exists(c.path)) continue

    let parsedUnlockCount = 0
    let stat = null
    try { stat = fs.statSync(c.path) } catch {}
    if (c.parse === 'sse') {
      const buf = safeReadBuf(c.path)
      if (buf) parsedUnlockCount = parseSseBinary(buf, schemaNames).length
    } else {
      const text = safeRead(c.path)
      if (text) parsedUnlockCount = c.parse(text).length
    }
    candidates.push({
      path: c.path,
      source: c.source,
      appid: c.appid || String(storedAppId || ''),
      parsedUnlockCount,
      mtime: stat ? stat.mtime.toISOString() : null,
      neverModified: stat ? Math.abs(stat.mtimeMs - stat.birthtimeMs) < 2000 : false,
    })
  }

  // Plain-language verdict for the UI.
  let verdict
  if (candidates.some(c => c.parsedUnlockCount > 0)) verdict = 'ok'
  else if (!candidates.length)                       verdict = mismatch ? 'appid-mismatch' : 'no-files'
  else if (mismatch)                                 verdict = 'appid-mismatch'
  else                                               verdict = 'emu-not-persisting'

  return {
    emulator, storedAppId, configAppIds, mismatch, candidates, verdict,
    installPath: game.install_path || null,
    schemaCount: schemaNames.length,
  }
}

// ── Bulk scans ────────────────────────────────────────────────────────────────

async function scanAllCrackedGames() {
  const gamesQ = require('../db/queries/games')
  const db     = require('../db/database').getDb()
  // Only scan cracked games with some appid — steam_app_id or the name-matched
  // manual_appid (needed for the schema so unlock names can be matched).
  const games  = db.prepare(`SELECT * FROM games WHERE is_cracked = 1 AND (steam_app_id IS NOT NULL OR manual_appid IS NOT NULL)`).all()
  let totalAdded = 0
  const perGame  = []
  for (const g of games) {
    const r = await scanGameForCrackAchievements(g.id)
    perGame.push({ gameId: g.id, name: g.name, added: r.added, sources: r.hits.map(h => h.source) })
    totalAdded += r.added
  }
  return { totalAdded, perGame, gamesScanned: games.length }
}

async function scanActiveSessions() {
  try {
    const { getActiveSessions } = require('./processWatcher')
    const active = getActiveSessions()
    let total = 0
    for (const [gameId] of active) {
      const r = await scanGameForCrackAchievements(gameId)
      total += r.added
    }
    return total
  } catch (e) {
    logger.warn('crackWatcher.scanActiveSessions failed', { message: e.message })
    return 0
  }
}

// ── Live file watching (instant cracked-game unlocks) ─────────────────────────
// Crack achievement files are written to disk the moment you unlock something, so
// unlike Steam (whose Web API caches for ~1–2 min) we can surface a cracked unlock
// INSTANTLY by watching the files instead of waiting for the 30s poll. When a
// cracked game's session starts we watch the emulator save folders; a change fires
// a debounced re-scan. The 30s poll stays as a safety net.

const fileWatchers = new Map()   // gameId → chokidar watcher
const scanDebounce = new Map()   // gameId → timeout

// Directories worth watching for one game: the (already-existing) parent + emulator
// root of each candidate file. We deliberately skip the game's own install root and
// any ancestor of it — those trees can be huge and would make the watcher expensive;
// install-folder-only setups are still covered by the 30s safety poll.
function dirsToWatch(game) {
  const ipLower = (game.install_path || '').toLowerCase().replace(/[\\/]+$/, '')
  const dirs = new Set()
  for (const c of buildCandidates(game)) {
    const parent = path.dirname(c.path)
    const grand  = path.dirname(parent)   // emulator root → catches a freshly-created appid folder
    for (const d of [parent, grand]) {
      if (!d || !exists(d)) continue
      const dl = d.toLowerCase().replace(/[\\/]+$/, '')
      if (dl === path.parse(d).root.toLowerCase().replace(/[\\/]+$/, '')) continue  // drive root
      if (ipLower && (dl === ipLower || ipLower.startsWith(dl + path.sep.toLowerCase()))) continue  // install root / ancestor
      dirs.add(d)
    }
  }
  return [...dirs]
}

function scheduleScan(gameId) {
  clearTimeout(scanDebounce.get(gameId))
  scanDebounce.set(gameId, setTimeout(() => {
    scanDebounce.delete(gameId)
    scanGameForCrackAchievements(gameId).catch(e =>
      logger.warn(`crackWatcher: live re-scan failed for game ${gameId}`, { message: e.message }))
  }, 500))
}

const WATCH_NAMES = new Set([
  'achievements.json', 'achievements.ini', 'achiev.ini', 'stats.ini',
  'stats.bin', 'creamapi.achievements.cfg',
])

function watchGame(gameId) {
  if (fileWatchers.has(gameId)) return
  let game
  try { game = require('../db/queries/games').getGame(gameId) } catch { return }
  if (!game || game.is_cracked !== 1) return  // SQLite boolean

  const dirs = dirsToWatch(game)
  if (!dirs.length) return

  let chokidar
  try { chokidar = require('chokidar') } catch { return }

  let watcher
  try {
    watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 100 },
    })
  } catch (e) {
    logger.warn(`crackWatcher: could not watch files for "${game.name}"`, { message: e.message })
    return
  }

  const onHit = (fp) => {
    if (WATCH_NAMES.has(path.basename(fp).toLowerCase())) scheduleScan(gameId)
  }
  watcher.on('add', onHit).on('change', onHit)
  fileWatchers.set(gameId, watcher)
  logger.info(`crackWatcher: live-watching ${dirs.length} folder(s) for "${game.name}"`)
}

function unwatchGame(gameId) {
  const w = fileWatchers.get(gameId)
  if (w) { try { w.close() } catch {} ; fileWatchers.delete(gameId) }
  clearTimeout(scanDebounce.get(gameId)); scanDebounce.delete(gameId)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function startWatching() {
  if (scanTimer) return
  scanTimer = setInterval(() => { scanActiveSessions().catch(() => {}) }, SCAN_INTERVAL_MS)
  logger.info('crackWatcher started (live file-watch + 30s safety poll)')
}

function stopWatching() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
  for (const id of [...fileWatchers.keys()]) unwatchGame(id)
}

module.exports = {
  startWatching, stopWatching,
  scanGameForCrackAchievements, scanAllCrackedGames, scanActiveSessions,
  watchGame, unwatchGame,
  buildCandidates, readEmuConfigAppIds, detectEmulator, diagnoseGame,
}
