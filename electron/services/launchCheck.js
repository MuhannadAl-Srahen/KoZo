'use strict'

// "Which program is the game?" Play was pressed and something started, but the file KoZo
// watches never showed up, so the play isn't being counted. This is how tracking fails:
// a launcher that starts a game under another name, or a wrong exe. After a wait, KoZo asks
// in a card in its own window (components/LaunchMissCard), plus a toast when another window
// is in front, because that may be the game.
//
// Nothing here runs while a session is active. ps-list is the process list every watcher
// tick already uses; asking for a path (PowerShell) only happens when someone picks a program.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const delays = { local: 45000, store: 120000 }   // a store launcher can sit on its own sign-in
const LOCAL = new Set(['spawn', 'launcher', 'shell-elevated'])
const MAX_ASKS = 2   // "Not now" twice for a game: it starts slowly, stop asking
const MAX_SHOWN = 5

const timers = new Map()      // gameId -> timeout
let pending = null            // what the card is asking now
let listening = false

const lower = (s) => String(s || '').toLowerCase()

function send(channel, payload) {
  const { BrowserWindow } = require('electron')
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, payload) } catch {}
  }
}

function setPending(next) {
  pending = next
  send('launch:miss', next)
}

// Pure: the programs worth suggesting: running, in the game's own folder, and showing signs of
// being a game. "Whatever started since Play" was offered once, and that suggested
// smartscreen.exe, which Windows starts for a permission prompt, and an online client. Anything
// else is under All programs, where it's the person's own choice.
//   running: [{ name }], inFolder: [{ name, dir }], deny: Set of lowercase names,
//   isHelper: (name) => bool, isGame: (file) => bool
function candidatesFor({ running, inFolder, watched, deny, isHelper, isGame }) {
  const on = new Set((running || []).map(p => lower(p.name)))
  const out = [], seen = new Set()
  for (const f of inFolder || []) {
    const l = lower(f.name)
    if (seen.has(l) || !on.has(l) || !l.endsWith('.exe') || l === lower(watched) || deny.has(l) || isHelper(f.name)) continue
    if (/crash(handler|reporter|report|dump)/i.test(f.name) || !isGame(path.join(f.dir, f.name))) continue
    seen.add(l)
    out.push({ exe_name: f.name, install_path: f.dir })
  }
  return out.slice(0, MAX_SHOWN)
}

// Pure: after a pick. What KoZo started keeps being started when it did something (a launcher
// that opened the game), so only the watched name changes. Not when it's gone or a tool.
function launchAfterPick({ oldFile, oldExists, newFile, oldIsTool, hasLauncher }) {
  if (hasLauncher || !oldExists || oldIsTool) return null
  if (lower(oldFile) === lower(newFile)) return null
  return oldFile
}

function asks() {
  try { return JSON.parse(require('../db/queries/settings').getSetting('launch_miss_dismissed') || '{}') || {} } catch { return {} }
}

// Called once the launch went through.
function arm(game, result) {
  if (!game?.exe_name || !result?.launched) return
  const local = LOCAL.has(result.launched)
  if (!local && result.launched !== 'store') return   // Steam starts it when it's ready
  if ((asks()[game.id] || 0) >= MAX_ASKS) return
  clearTimeout(timers.get(game.id))
  if (pending?.gameId === game.id) setPending(null)
  listen()
  timers.set(game.id, setTimeout(() => {
    timers.delete(game.id)
    check(game.id).catch(e => logger.warn('launchCheck failed', { message: e.message }))
  }, local ? delays.local : delays.store))
}

// Once the game is detected there's nothing to ask, even if it closes again before the wait
// is over: it did start. A card that's already up goes away by itself.
function listen() {
  if (listening) return
  listening = true
  require('./processWatcher').onChange(() => {
    const pw = require('./processWatcher')
    const seen = (id) => pw.getActiveSessions().has(id) || pw.getDetectingGames().has(id)
    for (const [id, t] of timers) if (seen(id)) { clearTimeout(t); timers.delete(id) }
    if (pending && seen(pending.gameId)) setPending(null)
  })
}

async function check(gameId) {
  const pw = require('./processWatcher')
  // Tracked, or another game is being played: nothing to ask.
  if (pw.isSessionActive()) return
  const game = require('../db/queries/games').getGame(gameId)
  if (!game?.exe_name) return
  const running = await pw.getRunningProcesses()
  if (running.some(p => lower(p.name) === lower(game.exe_name))) { pw.nudge(); return }

  const scanner = require('./pcScanner')
  const { looksLikeGame } = require('./exeCheck')
  // KoZo watches a real game file and started a launcher: it's waiting in the launcher's menu,
  // and nothing is wrong.
  const watchedFile = game.install_path ? path.join(game.install_path, game.exe_name) : null
  if (game.launch_file && watchedFile && fs.existsSync(watchedFile) && looksLikeGame(watchedFile)) return
  const folders = [...new Set([game.install_path, game.launch_file && path.dirname(game.launch_file)].filter(Boolean))]
  const candidates = candidatesFor({
    running,
    inFolder: folders.flatMap(f => scanner.collectExes(f, 4)),
    watched: game.exe_name,
    deny: pw.HARD_DENY,
    isHelper: scanner.isHelperExe,
    isGame: looksLikeGame,
  })
  logger.info(`launchCheck: "${game.exe_name}" never started for "${game.name}", ${candidates.length} likely program(s)`)
  setPending({ gameId, name: game.name, exe_name: game.exe_name, candidates })

  const win = require('../main').getMainWindow()
  const inFront = !!win && !win.isDestroyed() && win.isVisible() && win.isFocused()
  if (!inFront) { try { require('../overlayWindow').sendLaunchMiss({ gameId, name: game.name }) } catch {} }
}

function current() { return pending }

function dismiss(gameId) {
  const s = require('../db/queries/settings')
  const seen = asks()
  seen[gameId] = (seen[gameId] || 0) + 1
  s.setSetting('launch_miss_dismissed', JSON.stringify(seen))
  if (pending?.gameId === gameId) setPending(null)
}

// The user said which program it is: watch that from now on.
async function choose(gameId, proc) {
  const gamesQ = require('../db/queries/games')
  const pw = require('./processWatcher')
  const game = gamesQ.getGame(gameId)
  const exe = String(proc?.exe_name || '').trim()
  if (!game || !exe) throw new Error('Nothing to save')
  if (pw.HARD_DENY.has(lower(exe))) throw new Error(`${exe} is a Windows program, not a game.`)
  let folder = proc.install_path || null
  if (!folder) {
    const paths = await pw.getProcessPathsBatch([exe])
    const full = paths?.get(lower(exe))
    if (full) folder = path.dirname(full)
  }
  const oldFile = game.install_path && game.exe_name ? path.join(game.install_path, game.exe_name) : null
  const patch = { exe_name: exe }
  if (folder) patch.install_path = folder
  const keep = oldFile && launchAfterPick({
    oldFile,
    oldExists: fs.existsSync(oldFile),
    newFile: path.join(folder || game.install_path || '', exe),
    oldIsTool: require('./pcScanner').isHelperExe(game.exe_name),
    hasLauncher: !!(game.launch_file || game.launch_uri),
  })
  if (keep) patch.launch_file = keep
  gamesQ.updateGame(gameId, patch)
  const seen = asks()
  if (seen[gameId]) { delete seen[gameId]; require('../db/queries/settings').setSetting('launch_miss_dismissed', JSON.stringify(seen)) }
  if (pending?.gameId === gameId) setPending(null)
  logger.info(`launchCheck: "${game.name}" now watches ${exe}`)
  pw.nudge()
  return gamesQ.getGame(gameId)
}

module.exports = { arm, check, current, dismiss, choose, candidatesFor, launchAfterPick, delays }
