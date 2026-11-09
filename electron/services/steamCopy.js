'use strict'

// A game played with no launcher (an emulator) and then bought and installed on Steam.
// KoZo kept tracking the old copy: Play started the old file, Steam's achievements were
// never read (games with no launcher skip the Steam sync), and Scan PC called the Steam
// copy a duplicate because it has the same Steam id. The maker: "what if I buy the game
// from Steam and now I want my saves and also my achievements?"
//
// switchOffer: the game page says "You have this game on Steam now" when Steam's own
// appmanifest_<appid>.acf names an install folder that isn't the one KoZo tracks.
// switchToSteam: the same library entry becomes the Steam copy. Its hours, sessions and
// the achievements earned before all stay (an unlock is one row per achievement, so
// Steam's own unlocks are added next to them, never twice). The old copy's save files are
// kept as a restore point first, and the game page then offers to bring that progress
// into Steam's save folder (crackSaves: for a Steam game that is
// Steam\userdata\<account>\<appid>\remote).
// Achievements are never written to the Steam account itself: only the game can do that.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const lower = (p) => String(p || '').replace(/[\/]+$/, '').toLowerCase()

// Pure: should the game page offer the switch?
function shouldOffer({ isCracked, appid, steamDir, installPath, dismissedDir }) {
  if (!isCracked || !appid || !steamDir) return false
  const inside = (p, dir) => lower(p) === lower(dir) || lower(p).startsWith(lower(dir) + '\\') || lower(p).startsWith(lower(dir) + '/')
  if (installPath && inside(installPath, steamDir)) return false
  if (dismissedDir && lower(dismissedDir) === lower(steamDir)) return false
  return true
}

// Pure: the file KoZo watches in the Steam copy. The same file name when the Steam copy
// has it (the usual case), else the scanner's pick among real game files, else none: a
// wrong file is worse than none (Play still goes through Steam, which starts the game).
function pickSteamExe(exes, currentExe, folderName, { isHelperExe, pickBestExe }) {
  const same = exes.find(e => e.name.toLowerCase() === String(currentExe || '').toLowerCase())
  if (same) return same
  const real = exes.filter(e => !isHelperExe(e.name))
  if (!real.length) return null
  const name = pickBestExe(real, folderName)
  return real.find(e => e.name === name) || null
}

function steamDirFor(game) {
  const appid = game?.steam_app_id || game?.manual_appid
  if (!appid) return null
  try { return require('./installCheck').fromSteamManifest(String(appid)) } catch { return null }
}

function dismissed() {
  try { return JSON.parse(require('../db/queries/settings').getSetting('steam_copy_dismissed') || '{}') } catch { return {} }
}

function switchOffer(game) {
  if (!game) return null
  const steamDir = steamDirFor(game)
  const ok = shouldOffer({ isCracked: !!game.is_cracked, appid: game.steam_app_id || game.manual_appid, steamDir, installPath: game.install_path, dismissedDir: dismissed()[game.id] })
  return ok ? { steamDir } : null
}

function dismissOffer(game) {
  const steamDir = steamDirFor(game)
  if (!steamDir) return
  const all = dismissed()
  all[game.id] = steamDir
  require('../db/queries/settings').setSetting('steam_copy_dismissed', JSON.stringify(all))
}

async function switchToSteam(gameId) {
  const gamesQ = require('../db/queries/games')
  const game = gamesQ.getGame(gameId)
  if (!game) throw new Error('Game not found.')
  try {
    if (require('./processWatcher').getActiveSessions().has(game.id)) throw new Error(`Close ${game.name} first, then switch.`)
  } catch (e) { if (/^Close /.test(e.message)) throw e }
  const steamDir = steamDirFor(game)
  if (!steamDir) throw new Error(`Steam doesn't list ${game.name} as installed on this PC.`)

  // 1. The old copy's save files, kept as a restore point (they also feed "Bring it over").
  try {
    const crackSaves = require('./crackSaves')
    const saveDetect = require('./saveDetect')
    const vault = require('./saveVault')
    const old = crackSaves.currentCloudFolder(game)
    const folders = [...new Set([...(saveDetect.detect(game) || []).map(f => f.path), ...(old ? [old] : [])])].filter(d => { try { return fs.existsSync(d) } catch { return false } })
    if (folders.length) vault.snapshot(game, folders, 'before-steam')
  } catch (e) { logger.warn('steamCopy: restore point before the switch failed', { message: e.message }) }

  // 2. The same entry becomes the Steam copy.
  const scanner = require('./pcScanner')
  const exe = pickSteamExe(scanner.collectExes(steamDir, 4), game.exe_name, path.basename(steamDir), scanner)
  gamesQ.updateGame(game.id, {
    is_cracked: 0,
    source: 'steam',
    steam_app_id: game.steam_app_id || game.manual_appid,
    install_path: exe ? exe.dir : steamDir,
    exe_name: exe ? exe.name : '',
    launch_file: null,
    is_installed: 1,
  })
  logger.info('steamCopy: switched to the Steam copy', { game: game.name, exe: exe?.name || null })

  // 3. Steam's own unlocks, now that it's a Steam game (in the background).
  setTimeout(() => {
    try { require('./achievementSync').syncPlayerUnlocks?.(game.id)?.catch?.(() => {}) } catch {}
  }, 500)
  return { steamDir, exe: exe ? exe.name : null }
}

module.exports = { shouldOffer, pickSteamExe, switchOffer, dismissOffer, switchToSteam, steamDirFor }
