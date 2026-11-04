'use strict'

// Which app is in front? desktopProbe.js reports it with a line when it changes,
// plus a heartbeat so a stuck process can't look like "still away". Two uses:
//   - stop counting playtime when the player switched away from the game (setting
//     `away_pause_sec`). AFK can't catch this: using another app is still input.
//   - tell the main window it isn't in front (main.js). The window's own focus
//     events can't be trusted for that: one opened while a game had focus never
//     gets a blur, so its animations kept drawing behind the game.
//
// Every failure means "keep counting": no process, no report or a stale report all
// answer null, and an unknown front app never takes playtime away.

let front = null        // { pid, name, path, since }
let lastLineAt = 0
const listeners = new Set()
const STALE_MS = 90 * 1000

// One line from the probe. Returns the front app, or null for anything else.
function parseLine(line, now = Date.now()) {
  const [kind, pid, name, exePath] = String(line).split('\t')
  if (kind !== 'F') return null
  const n = Number(pid)
  if (!n) return null
  return { pid: n, name: String(name || '').trim().toLowerCase(), path: String(exePath || '').trim(), since: now }
}

function onLine(line, now = Date.now()) {
  lastLineAt = now
  const f = parseLine(line, now)
  if (!f) return
  front = f
  for (const cb of listeners) { try { cb(f) } catch {} }
}

function reset() { front = null }

function onChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// The app in front, or null when that isn't known right now.
function current(now = Date.now()) {
  if (!front || now - lastLineAt > STALE_MS) return null
  return front
}

// Is this front app the game? Its own process, its exe name (launchers restart
// games under a new pid), or anything inside its install folder.
function isGameWindow(fg, session, game) {
  if (!fg) return false
  if (session?.pid && fg.pid === session.pid) return true
  const exe = String(game?.exe_name || '').toLowerCase().replace(/\.exe$/, '')
  if (exe && fg.name === exe) return true
  const dir = String(game?.install_path || '').toLowerCase().replace(/[\\/]+$/, '')
  const exePath = String(fg.path || '').toLowerCase()
  return !!dir && (exePath.startsWith(dir + '\\') || exePath.startsWith(dir + '/'))
}

// Seconds the player has been away from this game, counted once it has reached
// `limitSec`; 0 otherwise. Moving between other apps keeps the same start time.
//
// A game KoZo never saw in front can't pause: some run inside a host process
// (Xbox games under ApplicationFrameHost) and would otherwise look "away" for
// their whole session, and losing real playtime is worse than counting too much.
function awaySeconds(session, game, fg, limitSec, now = Date.now()) {
  if (isGameWindow(fg, session, game)) {
    session._seenInFront = true
    session._awaySince = 0
    return 0
  }
  if (!fg || !limitSec || !session._seenInFront) {
    session._awaySince = 0
    return 0
  }
  if (!session._awaySince) session._awaySince = fg.since
  const sec = Math.floor((now - session._awaySince) / 1000)
  return sec >= limitSec ? sec : 0
}

module.exports = { parseLine, onLine, reset, onChange, current, isGameWindow, awaySeconds }
