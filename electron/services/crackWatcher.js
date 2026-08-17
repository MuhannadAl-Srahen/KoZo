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

// Pure safety net — the live chokidar watcher (watchGame) re-scans instantly
// on every file write, so this periodic pass only exists to catch anything a
// watcher somehow missed. 60s (was 15s) cuts the redundant synchronous
// fs.existsSync/readFileSync sweep over every candidate path to a quarter of
// its previous frequency — that sweep, running every 15s on top of the live
// watch AND processWatcher's own periodic sync, was contributing to the
// in-session stutter without adding any real detection speed.
const SCAN_INTERVAL_MS = 60_000
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

// True while a game is playing (or launching). Gates the expensive directory
// walking — see collectCandidates and watchGame's deep scan.
function sessionActive() {
  try { return require('./processWatcher').isSessionActive() } catch { return false }
}

// ── CRC32 for SSE binary matching ────────────────────────────────────────────
// Inline standard CRC-32 (IEEE 802.3) — the previously-required `crc-32`
// package was never actually installed, which silently disabled ALL SmartSteamEmu
// binary parsing (require failed → null → zero matches). Zero-dependency now.
let _crcTable = null
function crc32hex(str) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      _crcTable[n] = c
    }
  }
  const bytes = Buffer.from(str, 'utf8')
  let crc = -1
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ _crcTable[(crc ^ bytes[i]) & 0xFF]
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0')
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

// CODEX / EMPRESS / ALI213 / SKIDROW / online-fix INI:
//   [ACH_NAME]
//   Achieved=1      (or HaveAchieved=1, Unlocked=1, State=1, State=0101, earned=1)
//   UnlockTime=1700000000   (or HaveAchievedTime=..., Time=...)
//
//   online-fix writes the boolean as the literal word `true`/`false` instead
//   of 1/0, and its timestamp key is `timestamp=` — e.g.:
//   [TROPHY_10]
//   achieved=true
//   timestamp=1782324898
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
      /^achieved\s*=\s*true/im.test(body)     ||   // online-fix
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
      body.match(/^timestamp\s*=\s*(\d+)/im)  ||   // online-fix
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

// My Documents (registry-resolved — handles OneDrive redirection), memoized so
// the reg query doesn't run on every scan.
let _myDocs = null
function myDocsDir() {
  if (_myDocs) return _myDocs
  const home = os.homedir()
  try {
    const { execSync } = require('child_process')
    const reg = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v Personal',
      { encoding: 'utf8', stdio: 'pipe' }
    )
    const m = reg.match(/Personal\s+REG_EXPAND_SZ\s+(.+)/i)
    if (m) _myDocs = m[1].trim().replace(/%USERPROFILE%/i, home)
  } catch {}
  if (!_myDocs) _myDocs = path.join(home, 'Documents')
  return _myDocs
}

function buildCandidates(game) {
  const home    = os.homedir()
  const appdata = process.env.APPDATA       || path.join(home, 'AppData', 'Roaming')
  const local   = process.env.LOCALAPPDATA  || path.join(home, 'AppData', 'Local')
  const pub     = process.env.PUBLIC        || 'C:\\Users\\Public'
  const progdata= process.env.PROGRAMDATA   || 'C:\\ProgramData'
  const mydocs  = myDocsDir()

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
  // Real-world online-fix layout: an INI at Stats\Achievements.ini, one
  // per-achievement section (`[TROPHY_10]`) with `achieved=true`/`timestamp=`
  // — see parseCodexIni. Also put its Stats dir on our radar directly (rather
  // than relying only on a previously-discovered crack_dir) so detection and
  // the live chokidar watch work from the very first scan.
  add(path.join(pub, 'Documents', 'OnlineFix', id, 'Stats', 'Achievements.ini'), I, 'online-fix')
  add(path.join(appdata, 'OnlineFix', id, 'Stats', 'Achievements.ini'),          I, 'online-fix')

  // ── 10. In-game install folder (various layouts) ──────────────────────────
  if (ip) {
    // Goldberg local save mode — some repacks configure saves inside game folder
    add(path.join(ip, id, 'achievements.json'),                                J, 'Goldberg')
    add(path.join(ip, 'local_save', id, 'achievements.json'),                  J, 'Goldberg')
    add(path.join(ip, 'local_save', id, 'stats', 'achievements.json'),         J, 'Goldberg')
    // Goldberg inside game folder. NOTE: steam_settings\achievements.json is
    // deliberately NOT a candidate — that's the achievement DEFINITIONS file
    // (the one "Enable achievement tracking" writes), never a save file.
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
    // DARKSiDERS / Hoodlum / Skidrow keep their stats in a SteamEmu folder
    // beside the exe rather than under a user directory.
    add(path.join(ip, 'SteamEmu', 'UserStats', 'achievements.ini'),            I, 'SteamEmu')
    add(path.join(ip, 'SteamEmu', 'achievements.ini'),                         I, 'SteamEmu')
    add(path.join(ip, 'UserStats', 'achievements.ini'),                        I, 'SteamEmu')
    // ALI213 writes per-profile; the unnamed variant is the common one.
    add(path.join(ip, 'Profile', 'Stats', 'achievements.ini'),                 I, 'ALI213')
    add(path.join(ip, 'ALI213', 'Profile', 'Stats', 'achievements.ini'),       I, 'ALI213')
    // Hoodlum profile layout
    add(path.join(ip, 'Profile', 'VALVE', 'Stats', 'achievements.ini'),        I, 'Hoodlum')
    // SSE inside game
    cands.push({ path: path.join(ip, 'SmartSteamEmu', 'stats.bin'), parse: 'sse', source: 'SSE' })
  }

  return cands
}

// ── Emulator config detection ────────────────────────────────────────────────
// Cracks ship their own appid config; when it differs from the appid KoZo
// stored (common with repacks) every fixed candidate path points at the wrong
// emulator folder. Read every appid the install folder declares.

// The install root + one level of subdirs — repacks often keep the emu config
// beside the exe in Bin/ (or Retail/, Game/, …) rather than at the root.
function configRoots(installPath) {
  const roots = [installPath]
  try {
    for (const ent of fs.readdirSync(installPath, { withFileTypes: true })) {
      if (ent.isDirectory() && !SKIP_DIRS.has(ent.name.toLowerCase())) {
        roots.push(path.join(installPath, ent.name))
      }
      if (roots.length > 25) break
    }
  } catch {}
  return roots
}

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

  for (const root of configRoots(installPath)) {
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

// Search a DLL's bytes for an emulator signature — many repacks ship a patched
// steam_api(64).dll with NO config ini at all, so filenames alone miss them.
const DLL_SIGNATURES = [
  ['gse saves', 'Goldberg'],
  ['goldberg', 'Goldberg'],
  ['steamemu saves', 'Goldberg'],
  ['smartsteamemu', 'SmartSteamEmu'],
  ['onlinefix', 'online-fix'],
  ['online-fix', 'online-fix'],
  ['creamapi', 'CreamAPI'],
]
function sniffDll(p) {
  const buf = safeReadBuf(p)
  if (!buf) return null
  const hay = buf.toString('latin1').toLowerCase()
  for (const [needle, label] of DLL_SIGNATURES) {
    if (hay.includes(needle)) return label
  }
  return undefined   // readable but no known signature
}

// Best-effort emulator family name from the install folder's config files AND
// dlls. Checks the root plus one level of subdirs — configs commonly sit beside
// the exe in Retail/, Bin/, etc., not at the folder KoZo stored.
function detectEmulator(installPath) {
  if (!installPath || !exists(installPath)) return null
  const roots = configRoots(installPath)

  // 1. Named config files — the most reliable signal.
  for (const root of roots) {
    const emuIni = safeRead(path.join(root, 'steam_emu.ini'))
    if (emuIni) {
      if (/RUNE/i.test(emuIni))  return 'RUNE'
      if (/CODEX/i.test(emuIni)) return 'CODEX'
      if (/PLAZA/i.test(emuIni)) return 'PLAZA'
      return 'CODEX/RUNE-family (steam_emu.ini)'
    }
    if (exists(path.join(root, 'steam_settings')) ||
        exists(path.join(root, 'ColdClientLoader.ini'))) return 'Goldberg'
    if (exists(path.join(root, 'OnlineFix.ini')) ||
        exists(path.join(root, 'OnlineFix64.dll')))      return 'online-fix'
    if (exists(path.join(root, 'SmartSteamEmu.ini')) ||
        exists(path.join(root, 'SmartSteamEmu.dll')) ||
        exists(path.join(root, 'SmartSteamEmu64.dll')))  return 'SmartSteamEmu'
    if (exists(path.join(root, 'cream_api.ini')))        return 'CreamAPI'
  }

  // 2. Games for Windows LIVE — achievements predate Steam entirely in these
  //    builds (old GTA IV etc.); no crack can produce Steam-style unlock files.
  for (const root of roots) {
    if (exists(path.join(root, 'xlive.dll'))) return 'GFWL'
  }

  // 3. Patched steam_api dll with no config — sniff its bytes for a signature.
  for (const root of roots) {
    for (const dll of ['steam_api64.dll', 'steam_api.dll']) {
      const p = path.join(root, dll)
      if (!exists(p)) continue
      const label = sniffDll(p)
      if (label) return label
      if (label === undefined) return `Unknown Steam emulator (${dll} present)`
    }
  }
  return null
}

// Goldberg/GSE specifics that decide whether the emulator CAN track achievements:
// without steam_settings\achievements.json it never tracks or saves a single
// unlock, no matter how long the game is played — the #1 "12 hours and nothing"
// cause. local_save.txt means saves land inside the game folder instead of
// %APPDATA%.
function inspectGoldberg(installPath) {
  if (!installPath || !exists(installPath)) return null
  for (const root of configRoots(installPath)) {
    const ss = path.join(root, 'steam_settings')
    if (exists(ss)) {
      return {
        settingsDir: ss,
        hasAchList: exists(path.join(ss, 'achievements.json')),
        localSave: exists(path.join(ss, 'local_save.txt')) || exists(path.join(root, 'local_save.txt')),
      }
    }
    if (exists(path.join(root, 'ColdClientLoader.ini'))) {
      return { settingsDir: null, hasAchList: false, localSave: exists(path.join(root, 'local_save.txt')) }
    }
  }
  return null
}

// Repair path for cracks that ship WITHOUT the achievements list: write the
// schema KoZo already has into steam_settings\achievements.json (Goldberg/GSE
// format) so the emulator starts tracking and persisting unlocks from the next
// launch. Only adds a file the emulator is designed to read; an existing file
// is backed up first.
async function enableGoldbergAchievements(gameId) {
  const gamesQ = require('../db/queries/games')
  const game = gamesQ.getGame(gameId)
  if (!game) return { ok: false, reason: 'game_not_found' }

  const schema = await require('./achievementSync').ensureSchema(gameId, { force: true }).catch(() => [])
  if (!schema || !schema.length) return { ok: false, reason: 'no_schema' }

  // Prefer an existing steam_settings dir; else create one beside the emu dll.
  let target = null
  const roots = configRoots(game.install_path || '')
  for (const r of roots) {
    if (exists(path.join(r, 'steam_settings'))) { target = path.join(r, 'steam_settings'); break }
  }
  if (!target) {
    for (const r of roots) {
      if (exists(path.join(r, 'steam_api64.dll')) || exists(path.join(r, 'steam_api.dll'))) {
        target = path.join(r, 'steam_settings'); break
      }
    }
  }
  if (!target) {
    // No dll and no existing steam_settings — but GSE-family repacks
    // increasingly embed the emulator inside a hooked GAME dll (Khazan ships
    // it as voices38.dll), so no steam_api*.dll ever appears on disk. If the
    // emulator's save folder for THIS appid already exists in AppData, the emu
    // is provably running for this game — create steam_settings beside the
    // exe, which is the directory the hook dll loads its config from.
    const id = String(game.steam_app_id || game.manual_appid || '')
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    const emuRuns = id && (
      exists(path.join(appdata, 'GSE Saves', id)) ||
      exists(path.join(appdata, 'Goldberg SteamEmu Saves', id))
    )
    if (emuRuns && game.install_path && exists(game.install_path)) {
      target = path.join(game.install_path, 'steam_settings')
    }
  }
  if (!target) return { ok: false, reason: 'no_goldberg' }

  const list = schema.map(a => ({
    name: a.steam_api_name,
    displayName: a.display_name || a.steam_api_name,
    description: a.description || '',
    hidden: a.is_hidden ? '1' : '0',
    icon: '',
    icon_gray: '',
  }))
  try {
    fs.mkdirSync(target, { recursive: true })
    const f = path.join(target, 'achievements.json')
    if (exists(f)) { try { fs.copyFileSync(f, f + '.kozo-bak') } catch {} }
    fs.writeFileSync(f, JSON.stringify(list, null, 2))
    logger.info(`crackWatcher: wrote ${list.length} achievements into ${f} for "${game.name}"`)
    return { ok: true, count: list.length, path: f }
  } catch (e) {
    return { ok: false, reason: 'write_failed', error: e.message }
  }
}

// ── Recursive walk of install folder ─────────────────────────────────────────

const MAX_DEPTH   = 4
const MAX_ENTRIES = 4000
const SKIP_DIRS = new Set([
  'engine','content','paks','movies','audio','video','binaries',
  'data','gamedata','localization','shaders','fonts','maps','levels',
  'sound','textures','redist','redistributable','__macosx',
  'shader_cache', 'vulkan', 'directx', 'dx11', 'dx12',
  // Goldberg's CONFIG dir — its achievements.json holds definitions, not saves;
  // treating it as a save file made diagnose report "emulator never persists".
  'steam_settings',
])

// recursiveScan runs on every in-session sync poll (10s) — walking a game
// install (up to 4 roots x 4000 entries) with SYNCHRONOUS readdir on the main
// process every few seconds caused visible app stutter. Directory structure
// rarely changes mid-session, so memoize the hit list per root for a few
// minutes: the chokidar live watcher and the fixed-path candidates still catch
// fresh unlock writes instantly, and every manual/diagnostic path passes
// fresh=true to bypass the cache.
const RECURSIVE_SCAN_TTL_MS = 3 * 60 * 1000
const recursiveScanCache = new Map()   // `${root}|${appid}` -> { at, hits }
const scanCacheKey = (rootPath, appid) => `${String(rootPath || '').toLowerCase()}|${appid || ''}`

function recursiveScan(rootPath, appid, fresh = false) {
  const cacheKey = scanCacheKey(rootPath, appid)
  const cached = recursiveScanCache.get(cacheKey)
  if (!fresh && cached && Date.now() - cached.at < RECURSIVE_SCAN_TTL_MS) return cached.hits

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
  recursiveScanCache.set(cacheKey, { at: Date.now(), hits })
  return hits
}

// ── Deep scan: find save folders by appid anywhere in the usual save roots ────
// Last-resort discovery for emulator layouts we don't know a priori: nearly
// every emu keys its save folder by appid, so sweep the machine's save roots
// for a directory literally NAMED the appid and scan whatever is inside it.
// Bounded walk (depth cap + entry cap per root) — used by the manual check and
// once per game per app run at watch time, never on the 15s poll. A found dir
// is persisted to games.crack_dir so all future scans/watchers cover it cheaply.

const DEEP_SKIP = new Set([
  'windows', 'microsoft', 'packages', 'programs', 'temp', 'tmp', 'cache',
  'node_modules', 'google', 'mozilla', 'nvidia', 'nvidia corporation',
  'intel', 'amd', 'discord', 'spotify', 'slack', 'zoom', 'obs-studio',
  'jetbrains', 'unity', 'unrealengine', 'epicgameslauncher', 'battle.net',
  'python', 'pip', 'npm', 'npm-cache', 'yarn', 'electron', 'kozo',
  'connecteddevicesplatform', 'comms', 'squirrel', 'crashdumps', 'd3dscache',
])
const DEEP_MAX_ENTRIES = 6000
const DEEP_MAX_DEPTH   = 4

// ASYNC and yielding. This walks thousands of directories across seven roots;
// done synchronously it blocks the main process (and therefore every IPC reply,
// timer and window paint) for however long the disk takes. Using fs.promises
// plus an explicit yield every DEEP_YIELD_EVERY entries keeps the event loop
// responsive throughout, so even when this does run it can't be felt.
const DEEP_YIELD_EVERY = 200
const yieldToLoop = () => new Promise(r => setImmediate(r))

async function deepScanForAppIds(appids) {
  const ids = new Set((appids || []).filter(Boolean).map(String))
  const dirs = []
  const files = []
  if (!ids.size) return { dirs, files }

  const home = os.homedir()
  const pub  = process.env.PUBLIC || 'C:\\Users\\Public'
  const roots = [...new Set([
    process.env.APPDATA      || path.join(home, 'AppData', 'Roaming'),
    process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    path.join(home, 'AppData', 'LocalLow'),
    process.env.PROGRAMDATA  || 'C:\\ProgramData',
    path.join(pub, 'Documents'),
    myDocsDir(),
    path.join(home, 'Saved Games'),
  ].filter(Boolean))]

  const seenDirs = new Set()
  for (const root of roots) {
    let visited = 0
    let sinceYield = 0
    const walk = async (dir, depth) => {
      if (depth > DEEP_MAX_DEPTH || visited > DEEP_MAX_ENTRIES) return
      let entries
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
      visited += entries.length
      sinceYield += entries.length
      if (sinceYield >= DEEP_YIELD_EVERY) { sinceYield = 0; await yieldToLoop() }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const full = path.join(dir, ent.name)
        if (ids.has(ent.name)) {
          const k = full.toLowerCase()
          if (!seenDirs.has(k)) {
            seenDirs.add(k)
            dirs.push(full)
            // Small, appid-keyed folder — the sync walk is bounded and fine here.
            for (const h of recursiveScan(full, ent.name, true)) files.push({ ...h, source: 'deep-scan' })
          }
          continue
        }
        if (!DEEP_SKIP.has(ent.name.toLowerCase())) await walk(full, depth + 1)
      }
    }
    await walk(root, 1)
  }
  return { dirs, files }
}

// Pick the dir most worth remembering/watching: prefer one that actually
// contains a parseable achievements file, else the first appid dir found.
function bestDeepDir(deep) {
  return deep.dirs.find(d =>
    deep.files.some(f => f.path.toLowerCase().startsWith(d.toLowerCase()))) || deep.dirs[0] || null
}

// ── Shared candidate collection (scan AND diagnosis use the SAME list, so the
//    report can never disagree with what the scanner actually reads) ──────────

// install_path ending in one of these means the real game root is a parent —
// achievement files often live there (…\Binaries\Win64, …\Retail, …\Game).
const BINARY_SUBDIRS = new Set([
  'win64', 'win32', 'x64', 'x86', 'binaries', 'bin', 'binary', 'win',
  'shipping', 'retail', 'game', 'app',
])

// Parser for a file the live watcher reported, keyed off its name alone. MUST
// cover every entry in WATCH_NAMES — a watched name with no parser here is a
// file that wakes a scan which then can't read it.
function parserForFile(p) {
  const n = path.basename(p).toLowerCase()
  if (n === 'achievements.json') return parseGoldbergJson
  if (n === 'stats.bin')         return 'sse'
  if (n.endsWith('.ini') || n.endsWith('.cfg')) return parseCodexIni
  return null
}

function collectCandidates(game, fresh = false, allowWalk = true, extraPaths = []) {
  const gameAppid = game.steam_app_id || game.manual_appid
  const fixed     = buildCandidates(game)

  // While a game is running, do NOT walk the install tree. Directory walking is
  // DISCOVERY — finding save files in a layout we don't have a fixed path for —
  // and a layout doesn't appear mid-session. Detection of a fresh unlock during
  // play comes from the live chokidar watcher and the fixed candidate paths,
  // neither of which needs this. Skipping it keeps the in-session safety poll
  // down to a handful of stat() calls instead of a recursive readdir over a
  // game install, on the exact disk the game is streaming from.
  // `fresh` (manual "Check achievements" / diagnostics) always walks. The live
  // file watcher passes allowWalk:false: it reports the exact path that changed
  // (extraPaths below), so it needs the CACHE bypass, not the tree.
  const walkOk = (fresh && allowWalk) || !sessionActive()
  // With the walk off, serve whatever an earlier (idle) walk already found
  // instead of nothing — a pure Map lookup, no disk I/O, so install-tree
  // layouts discovered while idle stay visible for the whole session. The TTL
  // is deliberately ignored here: a stale entry only lists paths, and every
  // candidate is exists()-checked before it's read.
  const cachedHits = (p) => {
    const c = recursiveScanCache.get(scanCacheKey(p, gameAppid))
    return c ? c.hits : []
  }
  const scan = (p) => (!p ? [] : walkOk ? recursiveScan(p, gameAppid, fresh) : cachedHits(p))

  const recursive = scan(game.install_path)

  // The install folder's own emu config may declare a DIFFERENT appid than the
  // one KoZo stored (repacks do this) — emulator save folders are keyed by the
  // config appid, so build candidates for those too, tagged so a hit can
  // auto-correct manual_appid.
  const configIds = readEmuConfigAppIds(game.install_path)
  const configCandidates = []
  for (const cid of configIds) {
    if (String(cid) === String(gameAppid)) continue
    for (const c of buildCandidates({ ...game, steam_app_id: Number(cid), manual_appid: null })) {
      configCandidates.push({ ...c, appid: cid })
    }
  }

  // Parent scan when install_path points at a binary/edition subfolder.
  let extraRecursive = []
  const ipBase = path.basename((game.install_path || '').toLowerCase())
  if (BINARY_SUBDIRS.has(ipBase) && game.install_path) {
    const parent1 = path.dirname(game.install_path)
    const parent2 = path.dirname(parent1)
    const root    = path.parse(game.install_path).root
    if (parent1 !== game.install_path && parent1 !== root) {
      extraRecursive = [...extraRecursive, ...scan(parent1)]
    }
    if (parent2 !== parent1 && parent2 !== root) {
      extraRecursive = [...extraRecursive, ...scan(parent2)]
    }
  }

  // Save folder a previous deep scan discovered. Always scanned, session or
  // not: it's one small appid-keyed folder (not a game install), and it is the
  // most likely place a live unlock lands.
  const crackDirHits = game.crack_dir ? recursiveScan(game.crack_dir, gameAppid, fresh) : []

  // Files the live watcher actually saw change. chokidar watches whole dirs
  // (depth 3), not just the fixed candidate files, so it fires for unlock files
  // no candidate list knows — per-profile ALI213/Hoodlum nesting, nested
  // SteamEmu\UserStats subfolders, in-game OnlineFix Stats\. Reading the exact
  // path it reported is what keeps those layouts instant mid-session; it costs
  // one exists() + one read of a file the OS just wrote, no readdir.
  const extra = extraPaths
    .map(p => ({ path: p, parse: parserForFile(p), source: 'live-watch' }))
    .filter(c => c.parse)

  const all = [...fixed, ...configCandidates, ...recursive, ...extraRecursive, ...crackDirHits, ...extra]
  const seen = new Set()
  const unique = all.filter(c => {
    const k = c.path.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { unique, configIds, gameAppid }
}

// ── Main per-game scan ────────────────────────────────────────────────────────

async function scanGameForCrackAchievements(gameId, opts = {}) {
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
  // forceSchema (manual "Check achievements") bypasses the failed-fetch backoff.
  // Never swallow this silently: with no schema, `localAchs` is empty and every
  // unlock found on disk is skipped, which looks exactly like "the crack isn't
  // saving achievements" while the real cause is a failed schema fetch.
  try { await require('./achievementSync').ensureSchema(gameId, { force: !!opts.forceSchema }) }
  catch (e) { logger.warn(`crackWatcher: ensureSchema failed for game ${gameId}`, { message: e.message }) }

  const { unique } = collectCandidates(game, !!opts.fresh, opts.allowWalk !== false, opts.extraPaths || [])

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
  if (localAchs.length === 0) {
    // Unlocks parsed but no schema to match them against — without this the
    // unlocks vanish silently (the #1 confusing failure for cracked games).
    logger.warn(`crackWatcher: ${allUnlocks.length} unlocks parsed for "${game.name}" but no achievement schema — check the appid, add a Steam API key, or make your Steam profile public`)
    return { added: 0, hits, scannedPaths, candidatesTried: unique.length, schemaMissing: true }
  }
  const nameToAch = {}
  const alreadyUnlocked = new Set()
  for (const a of localAchs) {
    if (a.steam_api_name) nameToAch[a.steam_api_name.toUpperCase()] = a
    // unlock_id, not unlocked_at — an unlock Steam reported with unlocktime 0 is
    // stored with a NULL date and is still very much unlocked.
    if (a.unlock_id != null) alreadyUnlocked.add(a.id)
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
      // addUnlock is INSERT OR IGNORE — a row that already existed reports 0
      // inserted, and must not produce a toast or an XP award.
      const inserted = achievementsQ.addUnlock({
        achievement_id: ach.id,
        session_id: null,
        unlocked_at: ts,
        source: 'crack',
      })
      alreadyUnlocked.add(ach.id)
      if (inserted > 0) {
        newUnlocks.push({ ...ach, unlocked_at: ts })
        added++
      }
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

  // Schema first — with the keyless fallback even a no-API-key setup can load
  // the list, so "Check achievements" doubles as the list importer.
  try { await require('./achievementSync').ensureSchema(gameId) } catch {}

  const storedAppId  = game.steam_app_id || game.manual_appid || null
  const emulator     = detectEmulator(game.install_path)
  const goldberg     = emulator === 'Goldberg' ? inspectGoldberg(game.install_path) : null

  // The exact same candidate list the scanner reads. Always a fresh walk —
  // a diagnosis must reflect what's on disk right now, never the poll cache.
  const { unique, configIds: configAppIds } = collectCandidates(game, true)
  const mismatch = !!(storedAppId && configAppIds.length &&
                      !configAppIds.includes(String(storedAppId)))

  const schemaNames = achievementsQ.listAchievementsForGame(gameId)
    .map(a => a.steam_api_name).filter(Boolean)

  const examine = (c) => {
    if (!exists(c.path)) return null
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
    return {
      path: c.path,
      source: c.source,
      appid: c.appid || String(storedAppId || ''),
      parsedUnlockCount,
      mtime: stat ? stat.mtime.toISOString() : null,
      neverModified: stat ? Math.abs(stat.mtimeMs - stat.birthtimeMs) < 2000 : false,
    }
  }

  const candidates = []
  for (const c of unique) {
    const row = examine(c)
    if (row) candidates.push(row)
  }

  // No readable unlocks anywhere we know — deep-scan every save root on the
  // machine for a folder named after any of this game's appids. A find is
  // persisted to crack_dir so future scans and the live watcher cover it.
  let deepDirs = []
  let crackDir = game.crack_dir || null
  if (!candidates.some(c => c.parsedUnlockCount > 0)) {
    const deep = await deepScanForAppIds([storedAppId, ...configAppIds].filter(Boolean))
    deepDirs = deep.dirs
    for (const h of deep.files) {
      const row = examine(h)
      if (row && !candidates.some(x => x.path.toLowerCase() === row.path.toLowerCase())) {
        candidates.push(row)
      }
    }
    const best = bestDeepDir(deep)
    if (best && best.toLowerCase() !== (game.crack_dir || '').toLowerCase()) {
      try { gamesQ.updateGame(gameId, { crack_dir: best }); crackDir = best } catch {}
    }
  }

  // Plain-language verdict for the UI.
  let verdict
  if (candidates.some(c => c.parsedUnlockCount > 0)) {
    // Unlocks parse fine — but with no schema they can't be recorded.
    verdict = schemaNames.length === 0 ? 'no-schema' : 'ok'
  }
  else if (emulator === 'GFWL') {
    // Games for Windows LIVE build — Steam-style unlocks cannot exist.
    verdict = 'gfwl'
  }
  else if (goldberg && !goldberg.hasAchList) {
    // Goldberg without steam_settings\achievements.json NEVER tracks — the
    // honest (and fixable) explanation for "no files after hours of play".
    verdict = 'crack-no-ach-config'
  }
  else if (!candidates.length) {
    if (!emulator && !configAppIds.length) verdict = 'no-emulator'
    else verdict = mismatch ? 'appid-mismatch' : 'no-files'
  }
  else if (mismatch)                                 verdict = 'appid-mismatch'
  else {
    // Files exist and parse to zero unlocks. Only call this "never saves to
    // disk" when that's actually true (every file's mtime === birthtime, i.e.
    // untouched since creation) — otherwise the file HAS been written to since
    // (achievements almost certainly ARE in there) and the honest verdict is
    // that our parser doesn't understand this emulator's format yet, not that
    // the crack never persists anything.
    const contentCandidates = candidates.filter(c => c.parsedUnlockCount === 0)
    const allUntouched = contentCandidates.length > 0 && contentCandidates.every(c => c.neverModified)
    verdict = allUntouched ? 'emu-not-persisting' : 'unreadable-format'
  }

  return {
    emulator, storedAppId, configAppIds, mismatch, candidates, verdict,
    goldberg, deepDirs, crackDir,
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
    const { getActiveSessions, getDetectingGames } = require('./processWatcher')
    // Include games still inside the detection/sensitivity window — an unlock in
    // the first seconds of play shouldn't have to wait for the session to start.
    const ids = new Set([...getActiveSessions().keys(), ...getDetectingGames().keys()])
    let total = 0
    for (const gameId of ids) {
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
// INSTANTLY by watching the files instead of waiting for the 15s poll. When a
// cracked game is detected we watch the emulator save folders; a change fires a
// debounced re-scan. Folders that don't exist yet (game never unlocked anything)
// go into a pending list polled every 5s and watched the moment they appear —
// otherwise the very FIRST unlock would always miss the live path. The 15s poll
// stays as a safety net.

const fileWatchers    = new Map()   // gameId → chokidar watcher
const scanDebounce    = new Map()   // gameId → timeout
const pendingPaths    = new Map()   // gameId → Set of paths the watcher saw change
const pendingPollers  = new Map()   // gameId → interval polling not-yet-existing dirs
const PENDING_POLL_MS = 5_000
const deepScanned     = new Set()   // gameIds deep-scanned this app run

// User-profile roots that see constant unrelated writes — a watcher must never
// land on one of these even via the ancestor walk.
let _busyRoots = null
function busyRoots() {
  if (_busyRoots) return _busyRoots
  const home = os.homedir()
  const pub = process.env.PUBLIC || 'C:\\Users\\Public'
  const raw = [
    process.env.APPDATA, process.env.LOCALAPPDATA, process.env.PROGRAMDATA,
    home, path.join(home, 'Documents'), myDocsDir(),
    pub, path.join(pub, 'Documents'),
  ]
  _busyRoots = new Set(raw.filter(Boolean).map(p => p.toLowerCase().replace(/[\\/]+$/, '')))
  return _busyRoots
}

// Directories worth watching for one game: the parent + emulator root of each
// candidate file, for the stored appid AND any appid the install folder's emu
// config declares (repacks often mismatch — their save folders are keyed by the
// config appid). Split into { existing, pending }: existing dirs are watched
// immediately, pending ones (not created yet) are polled for creation. We still
// skip the game's own install root and any ancestor of it — those trees can be
// huge and would make the watcher expensive; install-folder-only setups are
// covered by the 15s safety poll.
function dirsToWatch(game) {
  const ipLower = (game.install_path || '').toLowerCase().replace(/[\\/]+$/, '')
  const gameAppid = game.steam_app_id || game.manual_appid
  const cands = [...buildCandidates(game)]
  for (const cid of readEmuConfigAppIds(game.install_path)) {
    if (String(cid) === String(gameAppid)) continue
    cands.push(...buildCandidates({ ...game, steam_app_id: Number(cid), manual_appid: null }))
  }

  const allowed = (d) => {
    if (!d) return false
    const dl = d.toLowerCase().replace(/[\\/]+$/, '')
    if (dl === path.parse(d).root.toLowerCase().replace(/[\\/]+$/, '')) return false  // drive root
    if (busyRoots().has(dl)) return false                                             // %APPDATA%, Documents, …
    if (ipLower && (dl === ipLower || ipLower.startsWith(dl + path.sep.toLowerCase()))) return false  // install root / ancestor
    return true
  }

  const existing = new Map()   // lowercased → original (case-insensitive dedupe)
  const pending  = new Map()
  for (const c of cands) {
    const parent = path.dirname(c.path)
    const grand  = path.dirname(parent)   // emulator root → catches a freshly-created appid folder
    if (allowed(parent) && exists(parent)) existing.set(parent.toLowerCase(), parent)
    if (allowed(grand)) {
      if (exists(grand)) {
        existing.set(grand.toLowerCase(), grand)   // depth covers the appid dir's creation
      } else if (!exists(parent)) {
        // Neither level exists — the emulator root's creation signals the whole
        // layout, so that's the one dir worth polling for.
        pending.set(grand.toLowerCase(), grand)
      }
    }
  }
  for (const k of existing.keys()) pending.delete(k)
  // A deep-scan-discovered save folder is always watched directly (it's one
  // small appid-keyed dir — the busy-root/install-root guards don't apply).
  if (game.crack_dir && exists(game.crack_dir)) {
    existing.set(game.crack_dir.toLowerCase(), game.crack_dir)
    pending.delete(game.crack_dir.toLowerCase())
  }
  return { existing: [...existing.values()], pending: [...pending.values()] }
}

// changedPath: the file the watcher reported. Collected across the whole
// debounce window, not just the last event — an emulator commonly writes
// achievements.ini AND stats.bin within those 500ms, and dropping either loses
// the unlock for any layout the fixed candidate list doesn't cover.
function scheduleScan(gameId, changedPath) {
  if (changedPath) {
    let paths = pendingPaths.get(gameId)
    if (!paths) { paths = new Set(); pendingPaths.set(gameId, paths) }
    paths.add(changedPath)
  }
  clearTimeout(scanDebounce.get(gameId))
  scanDebounce.set(gameId, setTimeout(() => {
    scanDebounce.delete(gameId)
    const extraPaths = [...(pendingPaths.get(gameId) || [])]
    pendingPaths.delete(gameId)
    // fresh: a file just changed on disk — this pass exists to pick it up, so
    // it must never be served the cached hit list. allowWalk:false keeps that
    // cache bypass off the install tree: this runs mid-session (and at watch
    // attach, while the game is loading), where a synchronous recursive readdir
    // is exactly the stutter the deferred deep scan was added to remove. The
    // changed paths above replace what that walk would have found.
    scanGameForCrackAchievements(gameId, { fresh: true, allowWalk: false, extraPaths }).catch(e =>
      logger.warn(`crackWatcher: live re-scan failed for game ${gameId}`, { message: e.message }))
  }, 500))
}

const WATCH_NAMES = new Set([
  'achievements.json', 'achievements.ini', 'achiev.ini', 'stats.ini',
  'stats.bin', 'creamapi.achievements.cfg',
])

function watchGame(gameId) {
  let game
  try { game = require('../db/queries/games').getGame(gameId) } catch { return }
  if (!game || game.is_cracked !== 1) return  // SQLite boolean

  // A game with no Steam emulator at all (detectEmulator === null, or GFWL)
  // never writes an unlock to disk, so there is genuinely nothing to watch and
  // nothing KoZo can detect automatically — its achievements are marked by hand
  // (§20). A screen-capture + OCR fallback used to run here; it was removed
  // because it (a) fired a full desktopCapturer GPU readback every 6s, which is
  // the periodic in-game stutter, and (b) matched an achievement whenever its
  // NAME appeared anywhere on screen, so games that title missions after their
  // achievements (GTA IV) auto-unlocked dozens of them from mission cards.
  // Do not reintroduce screen-scraped unlocks.

  if (fileWatchers.has(gameId)) return

  const { existing, pending } = dirsToWatch(game)
  if (!existing.length && !pending.length) return

  let chokidar
  try { chokidar = require('chokidar') } catch { return }

  let watcher
  try {
    // depth 3: a watch rooted at the emulator root must still reach nested
    // layouts like EMPRESS\<id>\remote\<id>\achievements.ini. Cheap — these
    // trees only hold per-appid save folders. Don't raise it further.
    watcher = chokidar.watch(existing, {
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 350, pollInterval: 100 },
    })
  } catch (e) {
    logger.warn(`crackWatcher: could not watch files for "${game.name}"`, { message: e.message })
    return
  }

  const onHit = (fp) => {
    if (WATCH_NAMES.has(path.basename(fp).toLowerCase())) scheduleScan(gameId, fp)
  }
  watcher.on('add', onHit).on('change', onHit)
  // An 'error' emit with no listener is an uncaught main-process exception —
  // Windows raises EPERM/EBUSY routinely when an emulator (or AV) locks a file
  // mid-write, which is precisely when this watcher is doing its job.
  watcher.on('error', (e) => logger.debug(`crackWatcher: watch error for game ${gameId}`, { message: e?.message }))
  fileWatchers.set(gameId, watcher)

  // Dirs that don't exist yet (game never unlocked anything): poll for their
  // creation and add them to the watcher the moment they appear, so even the
  // first-ever unlock hits the live path. A deterministic poller — never hand
  // chokidar a nonexistent path (it would fall back to watching an ancestor).
  if (pending.length) {
    const left = new Set(pending)
    pendingPollers.set(gameId, setInterval(() => {
      for (const d of [...left]) {
        if (!exists(d)) continue
        left.delete(d)
        try { watcher.add(d) } catch {}
        scheduleScan(gameId)   // catch a file written before the add landed
        logger.info(`crackWatcher: watch dir appeared for "${game.name}": ${d}`)
      }
      if (!left.size) {
        clearInterval(pendingPollers.get(gameId))
        pendingPollers.delete(gameId)
      }
    }, PENDING_POLL_MS))
  }

  logger.info(`crackWatcher: live-watching ${existing.length} folder(s) (+${pending.length} pending) for "${game.name}"`)
  // Immediate catch-up scan at attach time — picks up anything unlocked while
  // KoZo (or the watcher) wasn't running.
  scheduleScan(gameId)

  // One-time (per app run) background deep scan: if this game has no known
  // save folder yet, sweep the machine's save roots for a folder named after
  // its appid(s) and watch whatever turns up — covers emulators/layouts the
  // fixed candidate list doesn't know.
  //
  // DEFERRED UNTIL THE SESSION ENDS. This used to fire 3 seconds after the
  // session started, which is precisely the worst moment: the sweep walks up to
  // seven save roots four levels deep with synchronous readdir, on the main
  // process, while the game is loading and hammering the same disk. That was a
  // large part of the "lag when I enter a game". Nothing is lost by waiting —
  // the deep scan is folder DISCOVERY, and once it finds a dir it's persisted
  // to games.crack_dir, so from the next launch onward the folder is watched
  // live from the very first second.
  if (!game.crack_dir && !deepScanned.has(gameId)) {
    deepScanned.add(gameId)
    try {
      require('./processWatcher').runWhenIdle(`deepScan:${gameId}`, () => runDeepScan(gameId))
    } catch {}
  }
}

// The install-folder/save-root sweep for one game. Only ever called when no
// session is running (see watchGame).
async function runDeepScan(gameId) {
  let game
  try { game = require('../db/queries/games').getGame(gameId) } catch { return }
  if (!game || game.crack_dir) return
  try {
    const ids = [game.steam_app_id || game.manual_appid,
                 ...readEmuConfigAppIds(game.install_path)].filter(Boolean)
    const best = bestDeepDir(await deepScanForAppIds(ids))
    if (!best) return
    try { require('../db/queries/games').updateGame(gameId, { crack_dir: best }) } catch {}
    const w = fileWatchers.get(gameId)
    if (w) { try { w.add(best) } catch {} }
    scheduleScan(gameId)
    logger.info(`crackWatcher: deep scan found save folder for "${game.name}": ${best}`)
  } catch (e) {
    logger.warn(`crackWatcher: deep scan failed for game ${gameId}`, { message: e.message })
  }
}

function unwatchGame(gameId) {
  const w = fileWatchers.get(gameId)
  if (w) { try { w.close() } catch {} ; fileWatchers.delete(gameId) }
  clearInterval(pendingPollers.get(gameId)); pendingPollers.delete(gameId)
  clearTimeout(scanDebounce.get(gameId)); scanDebounce.delete(gameId)
  pendingPaths.delete(gameId)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function startWatching() {
  if (scanTimer) return
  scanTimer = setInterval(() => { scanActiveSessions().catch(() => {}) }, SCAN_INTERVAL_MS)
  logger.info(`crackWatcher started (live file-watch + ${SCAN_INTERVAL_MS / 1000}s safety poll)`)
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
  inspectGoldberg, enableGoldbergAchievements, deepScanForAppIds, collectCandidates,
  // Pure parsers — exported for the standalone test script (scripts/test-parsers.js)
  parseGoldbergJson, parseCodexIni, parseSseBinary,
}
