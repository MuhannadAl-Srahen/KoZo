'use strict'

const fs   = require('fs')
const path = require('path')

// Executables that are never game launchers
const NOT_GAME_EXES = new Set([
  'unins000.exe','uninst.exe','uninstall.exe','setup.exe','install.exe',
  'crashpad_handler.exe','dxwebsetup.exe','directx.exe','dxsetup.exe',
  'vcredist_x64.exe','vcredist_x86.exe','vc_redist.x64.exe','vc_redist.x86.exe',
  'dotnetfx.exe','dotnet.exe','windowsdesktop-runtime.exe',
  'battleye_installer.exe','easyanticheat_setup.exe','easyanticheat_x64.exe',
  'redist.exe','prerequisites.exe','physxinstaller.exe','oalinst.exe',
  'unarc.exe','arc.exe','7z.exe','winrar.exe','7zfm.exe',
  'cheatengine-x86_64.exe','cheatengine.exe',
  'git.exe','git-cmd.exe','gitbash.exe',
  'node.exe','npm.cmd','npx.cmd','pnpm.exe','yarn.exe',
  'python.exe','pythonw.exe','pip.exe',
  'code.exe','devenv.exe','studio64.exe',
])

// Folder names that are definitely NOT game folders
const SKIP_FOLDERS = new Set([
  // Windows system
  'windows','program data','programdata','users','appdata','perflogs',
  '$recycle.bin','system volume information','recovery','msocache',
  'winsxs','drivers','inf','assembly','fonts',
  // Dev tools found in Program Files
  'git','nodejs','node.js','npm','python','python3','python39','python310','python311','python312',
  'visual studio code','vscode','code','jetbrains','eclipse','intellij',
  'java','jdk','jre','android studio',
  // System / Microsoft
  'intel','nvidia corporation','amd','microsoft','common files','windows kits',
  '.net framework','internet explorer','windowsapps','microsoft office',
  'microsoft visual studio','msbuild','windows defender',
  // Tools
  'cheat engine','cheatengine','autohotkey','7-zip','winrar','notepad++',
  'ruxim','ruxim folderwatcher','trcccap','tcno account switcher',
  'malwarebytes','avast','avira','kaspersky',
  // Steam/launchers themselves (not games)
  'steam','steam controller configs',
  'epic games launcher','epic games','gog galaxy','ubisoft connect',
  'ea app','origin','battle.net','blizzard entertainment','riot games',
])

// Files that indicate a folder is a developer tool / non-game app
const NON_GAME_INDICATORS = new Set([
  'package.json', '.git', 'node_modules', 'requirements.txt',
  'CMakeLists.txt', 'makefile', 'build.gradle', 'pom.xml',
])

// Files that strongly indicate a folder IS a game
const GAME_INDICATORS = new Set([
  'steam_api.dll', 'steam_api64.dll',      // Steam (official or Goldberg crack)
  'steamworks_fix.dll', 'steam_emu.ini',   // Crack emulators
  'ue4game.exe', 'ue4game-win64-shipping.exe', // Unreal Engine
  'unity.exe', 'unitycrashhandler64.exe',  // Unity
  'bink2w64.dll', 'miles_win64.dll',       // Common game audio SDKs
  'd3d9.dll', 'd3d11.dll', 'd3d12.dll',    // DirectX (games use this)
  'xinput1_3.dll', 'xinput1_4.dll',        // Controller support (games)
  'physx', 'fmod',
])

function isGameExe(name) {
  return name.toLowerCase().endsWith('.exe') && !NOT_GAME_EXES.has(name.toLowerCase())
}

// Subfolders that never hold the actual game launcher — skipped while
// recursively searching for the exe so we don't pick up redistributables /
// installers. NOTE: must NOT contain bin/win64/etc — real launchers live there.
const NESTED_SKIP = new Set([
  'redist','redistributable','redistributables','_redist','_commonredist',
  'commonredist','directx','dotnet','vcredist','dxsetup','support',
  'dependencies','prerequisites','node_modules','.git','__installer',
  'crashreportclient','engine',
])

// A game's own internal folders. When scanning a directory for *sibling* games
// we skip these so e.g. "<Game>\Binaries" isn't mistaken for its own game.
const STRUCT_FOLDERS = new Set([
  'binaries','bin','win64','win32','x64','x86','data','content','plugins',
  'saved','config','engine','redist','_commonredist','commonredist',
  'soundbanks','movies','locales','resources',
])

// Folders that hold *other* games/apps — never a game themselves. We recurse
// into these but never import them. This is what stops "Program Files",
// "Games", "XboxGames" etc. from showing up as bogus games.
const CONTAINER_NAMES = new Set([
  'program files','program files (x86)','programdata','program data',
  'games','mygames','my games','gamelibrary','game library','xboxgames',
  'windowsapps','steamlibrary','steamlibrary2','steam','steamapps','common',
  'epic games','epicgames','gog games','gog galaxy','origin games','ea games',
  'ea','origin','ubisoft','ubisoft game launcher','users','public','documents',
])

function isDriveRoot(p) {
  return /^[a-z]:[\\/]?$/i.test(p)
}

// Collect .exe files inside `gamePath` up to `maxDepth` folders deep. Many
// cracked / unzipped games keep the launcher nested (e.g.
// "<Game>\Binaries\Win64\Game-Shipping.exe"), so a flat scan misses them.
function collectExes(gamePath, maxDepth) {
  const out = []
  function walk(dir, depth) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isFile()) {
        if (isGameExe(e.name)) {
          let size = 0
          try { size = fs.statSync(path.join(dir, e.name)).size } catch {}
          out.push({ name: e.name, size, dir })
        }
      } else if (e.isDirectory() && depth < maxDepth) {
        const lower = e.name.toLowerCase()
        if (NESTED_SKIP.has(lower) || SKIP_FOLDERS.has(lower)) continue
        walk(path.join(dir, e.name), depth + 1)
      }
    }
  }
  walk(gamePath, 0)
  return out
}

function detectType(folderPath) {
  const l = folderPath.toLowerCase()
  if (l.includes('steamapps\\common\\') || l.includes('steamapps/common/')) return 'Steam'
  if (l.includes('\\epic games\\') || l.includes('/epic games/'))           return 'Epic'
  if (l.includes('\\gog games\\')  || l.includes('/gog games/') ||
      l.includes('\\gog galaxy\\') || l.includes('/gog galaxy/'))           return 'GOG'
  if (l.includes('\\ubisoft game launcher\\') || l.includes('\\ubisoft connect\\')) return 'Ubisoft'
  if (l.includes('\\origin games\\') || l.includes('\\ea games\\'))        return 'EA'
  if (l.includes('\\windowsapps\\') || l.includes('\\xboxgames\\') ||
      l.includes('/xboxgames/'))                                          return 'Xbox'
  return 'Cracked'
}

function detectSteamAppId(folderPath) {
  const hints = [
    path.join(folderPath, 'steam_settings', 'steam_appid.txt'),
    path.join(folderPath, 'steam_appid.txt'),
    path.join(folderPath, 'appid.txt'),
  ]
  for (const h of hints) {
    try { const t = fs.readFileSync(h, 'utf8').trim(); if (/^\d+$/.test(t)) return t } catch {}
  }
  return null
}

function lookupAcfAppId(gamePath) {
  // gamePath is "...\steamapps\common\<installdir>" — the appmanifest_*.acf
  // files live in "...\steamapps", i.e. two levels up, not one.
  const steamapps = path.dirname(path.dirname(gamePath))
  const folderName = path.basename(gamePath).toLowerCase()
  try {
    for (const e of fs.readdirSync(steamapps)) {
      if (!e.toLowerCase().endsWith('.acf')) continue
      try {
        const txt = fs.readFileSync(path.join(steamapps, e), 'utf8')
        const dir = (txt.match(/"installdir"\s+"([^"]+)"/i) || [])[1]
        const aid = (txt.match(/"appid"\s+"(\d+)"/i) || [])[1]
        if (dir && aid && dir.toLowerCase() === folderName) return aid
      } catch {}
    }
  } catch {}
  return null
}

// Turn a messy repack folder name into a clean game title, e.g.
// "Forza Horizon 5 [FitGirl Repack]" → "Forza Horizon 5",
// "Far.Far.West.v644-RUNE" → "Far Far West".
function cleanGameName(folderName) {
  let n = ' ' + folderName + ' '
  n = n.replace(/[\[(（【].*?[\])）】]/g, ' ')                 // [..] (..) groups
  n = n.replace(/[._]+/g, ' ')                               // dots/underscores → space
  n = n.replace(/[-_\s]+(AnkerGames|Anker|game3rb|FreeGOG(Games)?|OnlineFix|online[-\s]?fix|PCGamesTorrents|SteamRIP|GOG)\b/gi, ' ') // download-site suffixes
  n = n.replace(/\b(FitGirl|DODI|RUNE|CODEX|PLAZA|SKIDROW|EMPRESS|TENOKE|RELOADED|FLT|ElAmigos|GOG|Repack|Edition|Deluxe|Ultimate|MULTi\s*\d*|Build\s*\d+)\b/gi, ' ')
  n = n.replace(/\bv\d+(\.\d+)*[a-z]?\b/gi, ' ')             // v644, v1.2.3
  n = n.replace(/[-–—\s]+$/g, ' ')                           // trailing dashes
  n = n.replace(/\s{2,}/g, ' ').trim()
  return n || folderName
}

function pickBestExe(exes, folderName) {
  if (!exes.length) return null
  if (exes.length === 1) return exes[0].name
  const slug = folderName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)
  const match = exes.find(e => e.name.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(slug))
  if (match) return match.name
  return exes.sort((a, b) => b.size - a.size)[0].name
}

// Does the folder (within 2 levels) carry a file that proves it's a game?
function hasGameIndicator(gamePath) {
  const stack = [[gamePath, 0]]
  while (stack.length) {
    const [dir, d] = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const lower = e.name.toLowerCase()
      if (e.isFile() && GAME_INDICATORS.has(lower)) return true
      if (e.isDirectory() && d < 2 && !SKIP_FOLDERS.has(lower)) stack.push([path.join(dir, e.name), d + 1])
    }
  }
  return false
}

// Early-exit check: is there any game .exe within `maxDepth` levels of `dir`?
function hasExeWithin(dir, maxDepth) {
  const stack = [[dir, 0]]
  while (stack.length) {
    const [d, dep] = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isFile()) { if (isGameExe(e.name)) return true; continue }
      if (dep < maxDepth) {
        const lower = e.name.toLowerCase()
        if (NESTED_SKIP.has(lower) || SKIP_FOLDERS.has(lower)) continue
        stack.push([path.join(d, e.name), dep + 1])
      }
    }
  }
  return false
}

// How many of `dir`'s immediate (non-structural) child subtrees contain a
// launcher. ≥2 means `dir` is a library of separate games, not one game.
function gameBearingChildCount(dir, cap = 2) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  let n = 0
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const lower = e.name.toLowerCase()
    if (SKIP_FOLDERS.has(lower) || STRUCT_FOLDERS.has(lower)) continue
    if (hasExeWithin(path.join(dir, e.name), 4)) { n++; if (n >= cap) return n }
  }
  return n
}

// A game folder sitting directly inside a store's game root
// (…\steamapps\common\<game>, …\Epic Games\<game>, …\XboxGames\<game>). Such a
// folder IS the game — we must never split its internal subfolders (Binaries,
// thirdparty, distribution, …) into separate "games".
function isStoreGameDir(dir) {
  const parent = path.basename(path.dirname(dir)).toLowerCase()
  const grand  = path.basename(path.dirname(path.dirname(dir))).toLowerCase()
  if (parent === 'common' && grand === 'steamapps') return true
  if (parent === 'epic games' || parent === 'epicgames') return true
  if (parent === 'gog games' || parent === 'gog galaxy') return true
  if (parent === 'xboxgames') return true
  return false
}

// Does the folder look like a dev project / non-game app?
function hasNonGameIndicator(gamePath) {
  let entries
  try { entries = fs.readdirSync(gamePath, { withFileTypes: true }) } catch { return false }
  const lower = new Set(entries.filter(e => !e.isDirectory()).map(e => e.name.toLowerCase()))
  for (const ni of NON_GAME_INDICATORS) if (lower.has(ni.toLowerCase())) return true
  return false
}

/**
 * Decide whether a folder containing an exe is actually a game.
 *  - Known store paths (Steam/Epic/GOG/Xbox…) → trusted.
 *  - `lenient` (user pointed directly at this folder) → trust unless it's a
 *    dev project.
 *  - Discovered by a deep scan → require real evidence: a games/XboxGames path
 *    or a game-indicator file. This is what keeps random apps in Program Files
 *    out of the results.
 */
function isLikelyGame(gamePath, lenient) {
  const type = detectType(gamePath)
  if (type !== 'Cracked') return true
  if (hasNonGameIndicator(gamePath)) return false
  if (lenient) return true
  const l = gamePath.toLowerCase()
  if (/[\\/](games|mygames|my games|gamelibrary|xboxgames)[\\/]/.test(l)) return true
  return hasGameIndicator(gamePath)
}

// Build a game entry from a single folder that contains exes. `lenient` is true
// only when the user pointed KoZo directly at this folder.
function buildEntry(gamePath, lenient) {
  const folderLower = path.basename(gamePath).toLowerCase()
  if (isDriveRoot(gamePath) || CONTAINER_NAMES.has(folderLower)) return null

  // Search deep so nested launchers (Project\Binaries\Win64\…) are found.
  const exes = collectExes(gamePath, 4)
  if (exes.length === 0) return null
  if (!isLikelyGame(gamePath, lenient)) return null

  const folderName = path.basename(gamePath)
  const type = detectType(gamePath)
  let appid = null
  if (type === 'Steam') appid = lookupAcfAppId(gamePath) || detectSteamAppId(gamePath)
  else appid = detectSteamAppId(gamePath)

  // Steam/GOG/Epic installdirs are already clean; only de-cruft cracked repacks.
  const name = type === 'Cracked' ? cleanGameName(folderName) : folderName

  // Prefer a launcher sitting directly in the game folder (the real entry point)
  // over nested helper exes; only fall back to nested ones when there is none.
  const directExes = exes.filter(e => e.dir === gamePath)
  const pool = directExes.length ? directExes : exes
  const bestName = pickBestExe(pool, folderName)
  const bestExe  = pool.find(e => e.name === bestName) || pool[0]

  // Store games keep the game-root install path (they launch via the client and
  // crack scanning expects the root). Cracked games point at the exe's actual
  // folder so a nested launcher (Project\Binaries\Win64\…) still runs.
  const install_path = type === 'Cracked' ? (bestExe.dir || gamePath) : gamePath

  return {
    name,
    exe_name: bestName,
    install_path,
    detected_type: type,
    steam_app_id: appid,
    is_cracked: (type !== 'Steam' && type !== 'Epic' && type !== 'GOG' &&
                 type !== 'Ubisoft' && type !== 'EA' && type !== 'Xbox') ? 1 : 0,
  }
}

const MAX_SCAN_DEPTH = 5

function scanFolder(folderPath) {
  const results = []
  const seen = new Set()
  const push = (e) => {
    if (!e) return
    const k = e.install_path.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    results.push(e)
  }

  const descend = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const lower = ent.name.toLowerCase()
      if (SKIP_FOLDERS.has(lower) || STRUCT_FOLDERS.has(lower)) continue
      walk(path.join(dir, ent.name), depth + 1)
    }
  }

  const walk = (dir, depth) => {
    if (depth > MAX_SCAN_DEPTH) return
    const base = path.basename(dir).toLowerCase()

    // 1) Pure library / drive folder → recurse, never import it.
    if (isDriveRoot(dir) || CONTAINER_NAMES.has(base)) { descend(dir, depth); return }

    // 2) A game directly under a store root → claim the whole folder as ONE
    //    game; never split its internal subfolders (fixes wallpaper_engine →
    //    "thirdparty"/"distribution").
    if (isStoreGameDir(dir)) { push(buildEntry(dir, true)); return }

    // 3) Structurally a library of ≥2 separate games → recurse.
    if (gameBearingChildCount(dir, 2) >= 2) { descend(dir, depth); return }

    // 4) Single-game candidate.
    const entry = buildEntry(dir, depth === 0)
    if (entry) { push(entry); return }            // claimed → don't go deeper

    // 5) Not a game: recurse only if exe-less (publisher/wrapper). A folder with
    //    its own exe that failed the game test is a leaf app → skip.
    if (!hasExeWithin(dir, 1)) descend(dir, depth)
  }

  walk(folderPath, 0)
  return results
}

function getDefaultScanPaths() {
  const found = []
  const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(d => {
    try { return fs.existsSync(d + ':\\') } catch { return false }
  }).map(d => d + ':')

  for (const drive of drives) {
    for (const parts of [
      // Steam library paths — only common/ subfolders, never raw Program Files
      [drive, 'Program Files (x86)', 'Steam', 'steamapps', 'common'],
      [drive, 'Program Files', 'Steam', 'steamapps', 'common'],
      [drive, 'SteamLibrary', 'steamapps', 'common'],
      [drive, 'Steam', 'steamapps', 'common'],
      [drive, 'SteamLibrary2', 'steamapps', 'common'],
      // Common game install folders (explicit, not the entire Program Files tree)
      [drive, 'Games'],
      [drive, 'MyGames'],
      [drive, 'GameLibrary'],
    ]) {
      const p = path.join(...parts)
      try { if (fs.existsSync(p)) found.push(p) } catch {}
    }
  }
  return [...new Set(found)]
}

module.exports = { scanFolder, getDefaultScanPaths, pickBestExe, isGameExe }
