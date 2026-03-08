const { BrowserWindow, powerMonitor } = require('electron')
const EventEmitter = require('events')
const { exec } = require('child_process')
const { promisify } = require('util')
const execP = promisify(exec)
const logger = require('../logger')
const sessionsQ = require('../db/queries/sessions')
const gamesQ    = require('../db/queries/games')
const settingsQ = require('../db/queries/settings')

const emitter = new EventEmitter()

const POLL_MS              = 5000
const ORPHAN_CAP_MS        = 4 * 60 * 60 * 1000
const SLEEP_GAP_MS         = 5 * 60 * 1000

// How often to check for new unlocks while a game is running. No longer user-
// configurable — we just poll fast (30s). Cracked games are also caught instantly
// by the live file-watcher; Steam's Web API caches a fresh unlock ~1–2 min on its
// own servers, which is the only delay we can't beat. This poll + the on-launch
// and session-end syncs surface unlocks as soon as they're available.
// In-session Steam poll cadence. Steam's GetPlayerAchievements Web API caches a
// freshly-unlocked achievement server-side for a while, so the only lever we have
// is to poll often and grab it the instant the cache exposes it. 10s (vs the old
// 30s) cuts the worst-case in-app lag by ~20s; the GET is cheap (one request) and
// well under Steam's rate limits even with several games running.
const ACHIEVEMENT_SYNC_MS = 10 * 1000
function getAchievementSyncMs() {
  return ACHIEVEMENT_SYNC_MS
}

// Runs both unlock sources for one game: Steam Web API + local crack files.
// Crack files update instantly on unlock; the Steam Web API has its own
// server-side cache (a freshly unlocked achievement can take a short while to
// appear), so frequent polling catches it as soon as Steam exposes it. Errors
// are logged, never swallowed silently, so sync problems are diagnosable.
function runAchievementSync(gameId, gameName) {
  setImmediate(async () => {
    try {
      const { syncPlayerUnlocks } = require('./achievementSync')
      const r = await syncPlayerUnlocks(gameId)
      if (r?.added > 0) logger.info(`achievement sync: +${r.added} Steam unlock(s) for "${gameName}"`)
      else if (r?.reason && r.reason !== 'no_steam_app_id' && r.reason !== 'foreign_launcher') logger.debug(`achievement sync (Steam) "${gameName}": ${r.reason}`)
    } catch (e) {
      logger.warn(`achievement sync (Steam) failed for "${gameName}"`, { message: e.message })
    }
    try {
      const { scanGameForCrackAchievements } = require('./crackWatcher')
      const r = await scanGameForCrackAchievements(gameId)
      if (r?.added > 0) logger.info(`achievement sync: +${r.added} crack unlock(s) for "${gameName}"`)
    } catch (e) {
      logger.warn(`achievement sync (crack) failed for "${gameName}"`, { message: e.message })
    }
  })
}

// Idle/AFK pause: if the OS reports no input for this many seconds, the time is
// not counted as playtime. 0 = disabled. Setting is in MINUTES.
function getIdlePauseSec() {
  try {
    const min = parseInt(settingsQ.getSetting('idle_pause_min'))
    if (Number.isFinite(min) && min > 0) return min * 60
  } catch {}
  return 0  // disabled by default
}

// Controller tracking is implied by AFK being enabled — there's no separate setting.
// When the user turns on idle/AFK pause, KoZo also watches the gamepad so that
// controller-only play isn't mistaken for being away (Windows doesn't report
// gamepad input to the OS idle timer). AFK off → no controller probe.
function controllerTrackingOn() {
  return getIdlePauseSec() > 0
}

// Effective idle seconds = time since the most recent input from ANY tracked
// source. Always counts keyboard/mouse; also counts the gamepad when controller
// tracking is on and the probe is running (otherwise the controller is ignored).
function effectiveIdleSeconds() {
  let idle = powerMonitor.getSystemIdleTime()
  if (controllerTrackingOn()) {
    const ctrlIdle = require('./controllerInput').msSinceInput() / 1000
    idle = Math.min(idle, ctrlIdle)
  }
  return idle
}

// gameId → last achievement sync timestamp
const midSessionSyncAt = new Map()

let pollTimer       = null
let lastTickAt      = Date.now()
let paused          = false

// gameId → { ticks, firstSeen }
const detectionBuffer = new Map()
// gameId → enriched session row, with `last_seen_at` (ms epoch) updated every tick
const activeSessions  = new Map()
// gameId → { game_name, started_at } for games whose process was just detected
// but whose session hasn't officially started yet (still inside the sensitivity
// window). Surfaced as an optimistic "Now Playing" so the indicator appears ~one
// poll after launch instead of waiting the full sensitivity delay.
const detectingGames  = new Map()

// ── Unknown process detection (game not in library) ──────────────────────────
// exe_name → tick count
const unknownExeBuffer = new Map()
// exe names we've already evaluated this session (avoid re-checking)
const evaluatedExes = new Set()

// Quick reject — these are NEVER games. Saves expensive PowerShell path lookups.
const HARD_DENY = new Set([
  'svchost.exe','csrss.exe','winlogon.exe','dwm.exe','lsass.exe','services.exe',
  'smss.exe','wininit.exe','explorer.exe','taskhostw.exe','runtimebroker.exe',
  'sihost.exe','ctfmon.exe','dllhost.exe','conhost.exe','fontdrvhost.exe',
  'audiodg.exe','spoolsv.exe','searchindexer.exe','searchhost.exe',
  'msmpeng.exe','wuauclt.exe','msiexec.exe','regsvr32.exe','rundll32.exe',
  'system','registry','memory compression','idle',
  'powershell.exe','pwsh.exe','cmd.exe','bash.exe','wsl.exe',
  'chrome.exe','msedge.exe','firefox.exe','opera.exe','brave.exe',
  'code.exe','cursor.exe','node.exe','electron.exe','claude.exe',
  'kozo.exe',
  // Unity / Unreal engine crash handlers and helpers
  'unityCrashHandler.exe','unityCrashHandler64.exe',
  'crashreportclient.exe','crashreporterclient.exe',
  // Anti-cheat services (run alongside games, not the game)
  'easyanticheat.exe','easyanticheat_eos.exe',
  'beservice.exe','beservice_x64.exe',
  // Store launcher helpers
  'epicwebhelper.exe','originclientservice.exe','origincrashdump.exe',
  'gameoverlayrenderer.exe','gameoverlayrenderer64.exe','gameoverlayui.exe',
  'steamwebhelper.exe','steam_monitor.exe',
  // Other non-game processes that live in game folders
  'vcredist_x64.exe','vcredist_x86.exe','vc_redist.x64.exe','vc_redist.x86.exe',
  'dotnetfx.exe','dotnet.exe','directx_jun2010_redist.exe',
  'physxextensions.exe',
])

// Folder patterns that strongly indicate a game install location.
// Path comparison is case-insensitive with normalised separators.
const GAME_PATH_HINTS = [
  '\\steamapps\\common\\',
  '\\steamlibrary\\',
  '\\epic games\\',
  '\\gog galaxy\\games\\',
  '\\gog games\\',
  '\\ea games\\', '\\ea desktop\\',
  '\\ubisoft\\games\\', '\\ubisoft game launcher\\games\\',
  '\\xboxgames\\',
  '\\amazon games\\',
  '\\battle.net\\',
  '\\rockstar games\\',
  '\\bethesda.net launcher\\games\\',
  '\\riot games\\',
  '\\my games\\',
]

// Paths that DEFINITELY aren't games even if some other hint matches.
const NON_GAME_PATH_HINTS = [
  '\\windows\\', '\\system32\\', '\\syswow64\\',
  '\\windowsapps\\', '\\microsoft\\edge', '\\microsoft\\onedrive',
  '\\common files\\',
  '\\appdata\\local\\microsoft\\',
  '\\appdata\\local\\programs\\microsoft',
  '\\appdata\\local\\programs\\python',
  '\\appdata\\local\\programs\\cursor',
  '\\appdata\\local\\anthropic',
  '\\nvidia corporation\\', '\\program files\\nvidia',
  '\\program files\\common files\\',
  '\\drivers\\', '\\amd\\catalyst\\', '\\intel\\driver',
  '\\realtek\\', '\\dell\\', '\\hp\\', '\\asus\\', '\\lenovo\\',
  '\\python', '\\miniconda', '\\anaconda',
  '\\steam\\bin\\', '\\steam.exe',  // the launcher itself
]

function looksLikeGamePath(exePath) {
  if (!exePath || typeof exePath !== 'string') return false
  const p = exePath.toLowerCase().replace(/\//g, '\\')

  if (NON_GAME_PATH_HINTS.some(s => p.includes(s))) return false
  if (GAME_PATH_HINTS.some(s => p.includes(s))) return true

  // Also accept a path component literally called "Games" / "Game" / "GameLibrary"
  const parts = p.split('\\')
  if (parts.includes('games') || parts.includes('gamelibrary')) return true

  return false
}

/**
 * Look up the executable path of a running process by name.
 * Returns null if not found or query fails. Cached per session.
 */
const pathCache = new Map()  // exe_lower → path (only positives cached forever)
async function getProcessPath(exeName) {
  const key = exeName.toLowerCase()
  const cached = pathCache.get(key)
  if (cached) return cached  // Only cache successful lookups

  const nameNoExt = exeName.replace(/\.exe$/i, '').replace(/'/g, "''")
  const ps = `Get-Process -Name '${nameNoExt}' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path`
  try {
    const { stdout } = await execP(
      `powershell.exe -NoProfile -NonInteractive -Command "${ps}"`,
      { timeout: 4000, windowsHide: true, maxBuffer: 256 * 1024 }
    )
    const path = stdout.trim() || null
    if (path) pathCache.set(key, path)
    return path
  } catch {
    return null
  }
}

function sendToRenderer(channel, data) {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send(channel, data)
  })
}

function getSensitivitySeconds() {
  const val = settingsQ.getSetting('detection_sensitivity')
            ?? settingsQ.getSetting('detection_sensitivity_seconds')
  const parsed = parseInt(val)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15
}

async function getRunningProcesses() {
  // ps-list is pure ESM since v8 — must be loaded via dynamic import() from CJS.
  const mod = await import('ps-list')
  const fn = typeof mod === 'function' ? mod : (mod.default || mod.psList)
  return await fn()
}

async function tick() {
  if (paused) return

  const now           = Date.now()
  const prevTickAt    = lastTickAt
  const gapMs         = now - prevTickAt
  lastTickAt          = now

  // Gap > sleep threshold → the OS was suspended. Don't count the suspended
  // period as playtime. Forcefully end every active session at the timestamp
  // we last confirmed the game was running.
  if (gapMs > SLEEP_GAP_MS) {
    logger.warn('processWatcher: long gap detected, capping active sessions', { gapMs })
    for (const [gameId, session] of activeSessions) {
      const lastSeenMs = session.last_seen_at || prevTickAt
      endSession(gameId, session, new Date(lastSeenMs).toISOString())
    }
    detectionBuffer.clear()
    return
  }

  let procList
  try {
    procList = await getRunningProcesses()
  } catch (err) {
    logger.error('processWatcher: ps-list failed', { message: err.message })
    return
  }

  const runningExes     = new Set(procList.map(p => (p.name || '').toLowerCase()))
  const games           = gamesQ.listGames()
  const knownGameIds    = new Set(games.map(g => g.id))
  const sensitivitySecs = getSensitivitySeconds()
  const ticksNeeded     = Math.max(1, Math.ceil(sensitivitySecs / (POLL_MS / 1000)))

  // ── Track registered games ─────────────────────────────────────────────────
  for (const game of games) {
    const exeLower   = (game.exe_name || '').toLowerCase()
    if (!exeLower) continue   // defensive — empty exe must not match every empty process name
    const isRunning  = runningExes.has(exeLower)
    const hasSession = activeSessions.has(game.id)

    if (isRunning && !hasSession) {
      const buf = detectionBuffer.get(game.id) || { ticks: 0, firstSeen: now }
      buf.ticks++
      detectionBuffer.set(game.id, buf)

      // Optimistic "Now Playing": flag the game live on first detection so the
      // sidebar card + cover LIVE badge appear ~one poll after launch instead of
      // waiting out the whole sensitivity window. The real session still starts
      // below once sensitivity is satisfied (this only affects the indicator).
      if (!detectingGames.has(game.id)) {
        detectingGames.set(game.id, { game_name: game.name, started_at: new Date(now).toISOString() })
        sendToRenderer('session:detected', { gameId: game.id })
      }

      if (buf.ticks >= ticksNeeded) {
        const session = sessionsQ.resumeOrStartSession(game.id)
        const enriched = { ...session, game_name: game.name, exe_name: game.exe_name, last_seen_at: now, idle_seconds: 0 }
        activeSessions.set(game.id, enriched)
        detectionBuffer.delete(game.id)
        detectingGames.delete(game.id)
        logger.info('Session started', { gameId: game.id, name: game.name })
        sendToRenderer('session:started', enriched)
        try { require('./notifications').notifySessionStarted({ gameName: game.name }) } catch {}
        try { require('../overlayWindow').sendSessionStarted({ gameName: game.name, gameId: game.id }) } catch {}
        emitter.emit('change')

        // Sync achievements right away so anything unlocked before/at launch shows
        // immediately, then again on the interval below.
        midSessionSyncAt.set(game.id, now)
        runAchievementSync(game.id, game.name)

        // Cracked game → start a live file watcher so unlocks appear instantly
        // (crack files hit disk the moment you unlock; no Steam API cache lag).
        if (game.is_cracked === 1) {
          try { require('./crackWatcher').watchGame(game.id) } catch {}
        }
      }

    } else if (isRunning && hasSession) {
      // Heartbeat: keep `last_seen_at` fresh so an unexpected crash / sleep
      // still records playtime up to the last successful poll.
      const s = activeSessions.get(game.id)
      s.last_seen_at = now

      // Idle/AFK: if there's been no input (keyboard/mouse, plus gamepad when
      // controller tracking is on) beyond the threshold, count this tick's
      // elapsed time as idle (subtracted from playtime when the session ends).
      const idleThresh = getIdlePauseSec()
      const isIdleNow  = idleThresh > 0 && effectiveIdleSeconds() >= idleThresh
      if (isIdleNow) {
        s.idle_seconds = (s.idle_seconds || 0) + Math.round(gapMs / 1000)
      }
      // Broadcast idle transitions so the "Now Playing" UI can show "Away" the
      // moment AFK kicks in (the time is excluded live, not just at session end).
      if (!!s.idle !== isIdleNow) {
        s.idle = isIdleNow
        sendToRenderer('session:idle', { gameId: game.id, idle: isIdleNow, idle_seconds: s.idle_seconds || 0 })
        logger.info(`Session ${isIdleNow ? 'idle (AFK) — pausing playtime' : 'active again'}`, { gameId: game.id })
      }

      try {
        require('../db/database').getDb()
          .prepare('UPDATE games SET last_played_at = ? WHERE id = ?')
          .run(new Date(now).toISOString(), game.id)
      } catch {}

      // Periodic achievement sync — interval is user-configurable in Settings
      const lastSync = midSessionSyncAt.get(game.id) || 0
      if (now - lastSync >= getAchievementSyncMs()) {
        midSessionSyncAt.set(game.id, now)
        runAchievementSync(game.id, game.name)
      }

    } else if (!isRunning && hasSession) {
      endSession(game.id, activeSessions.get(game.id))

    } else if (!isRunning) {
      detectionBuffer.delete(game.id)
      // Game closed before its session officially started — clear the optimistic
      // "Now Playing" so the indicator doesn't linger.
      if (detectingGames.delete(game.id)) sendToRenderer('session:undetected', { gameId: game.id })
    }
  }

  // Clean up sessions whose game has been removed from the library mid-session.
  for (const [gameId, session] of activeSessions) {
    if (!knownGameIds.has(gameId)) {
      logger.info('Ending orphaned session — game no longer in library', { gameId })
      endSession(gameId, session, new Date(session.last_seen_at || now).toISOString())
    }
  }

  // Run the gamepad activity probe only while a game is being tracked AND the
  // user enabled controller tracking — so it doesn't poll at idle.
  const wantController = controllerTrackingOn() && activeSessions.size > 0
  const ci = require('./controllerInput')
  if (wantController && !ci.isRunning())      ci.start()
  else if (!wantController && ci.isRunning()) ci.stop()

  // ── Detect unknown game-like processes (not in library) ────────────────────
  const gameExeLower = new Set(games.map(g => (g.exe_name || '').toLowerCase()))
  const candidates   = []

  for (const proc of procList) {
    const name = (proc.name || '').toLowerCase()
    if (!name.endsWith('.exe'))   continue
    if (HARD_DENY.has(name))      continue
    // Crash reporters and engine helper processes are never the game itself
    if (/crash(handler|reporter|report|dump)/i.test(name)) continue
    if (gameExeLower.has(name))   continue
    if (evaluatedExes.has(name))  continue

    const count = (unknownExeBuffer.get(name) || 0) + 1
    unknownExeBuffer.set(name, count)
    if (count >= ticksNeeded) candidates.push(proc)
  }

  // Lazy-check candidate paths via PowerShell (one call per never-before-seen exe).
  for (const proc of candidates) {
    const name = (proc.name || '').toLowerCase()
    evaluatedExes.add(name)
    unknownExeBuffer.delete(name)

    const exePath = await getProcessPath(proc.name || name)
    if (looksLikeGamePath(exePath)) {
      logger.info(`Unknown game detected: ${proc.name} @ ${exePath}`)
      emitter.emit('unknownProcess', {
        exe_name: proc.name || name,
        install_path: exePath ? exePath.replace(/\\[^\\]+$/, '') : null,
      })
    } else {
      logger.debug(`Rejected as non-game: ${proc.name} @ ${exePath || '(no path)'}`)
    }
  }

  // Clean up buffer for processes that stopped running
  for (const [name] of unknownExeBuffer) {
    if (!runningExes.has(name)) unknownExeBuffer.delete(name)
  }
}

function endSession(gameId, session, forcedEndAt) {
  if (!activeSessions.has(gameId)) return  // idempotent — guard against double-end
  activeSessions.delete(gameId)
  detectionBuffer.delete(gameId)
  midSessionSyncAt.delete(gameId)
  try { require('./crackWatcher').unwatchGame(gameId) } catch {}

  // Idle/AFK seconds accumulated during the session are NOT playtime.
  const idleSec = Math.max(0, Math.floor(session.idle_seconds || 0))
  const db = require('../db/database').getDb()

  let ended
  if (forcedEndAt) {
    const startMs = new Date(session.started_at).getTime()
    const endMs   = new Date(forcedEndAt).getTime()
    // Forced end must never go backwards in time.
    const safeEndMs = Math.max(endMs, startMs)
    const safeEndIso = new Date(safeEndMs).toISOString()
    const durationSeconds = Math.max(0, Math.floor((safeEndMs - startMs) / 1000) - idleSec)

    db.prepare('UPDATE sessions SET ended_at=?, duration_seconds=? WHERE id=?')
      .run(safeEndIso, durationSeconds, session.id)
    db.prepare(`
      UPDATE games
      SET total_playtime_seconds = total_playtime_seconds + ?,
          last_played_at = ?
      WHERE id = ?
    `).run(durationSeconds, safeEndIso, session.game_id)
    ended = { ...session, ended_at: safeEndIso, duration_seconds: durationSeconds }
  } else {
    ended = sessionsQ.endSession(session.id)
    // Subtract idle time that sessionsQ.endSession counted from the raw timestamps.
    if (ended && idleSec > 0) {
      const newDur = Math.max(0, (ended.duration_seconds || 0) - idleSec)
      const delta  = (ended.duration_seconds || 0) - newDur
      db.prepare('UPDATE sessions SET duration_seconds=? WHERE id=?').run(newDur, session.id)
      db.prepare('UPDATE games SET total_playtime_seconds=MAX(0,total_playtime_seconds-?) WHERE id=?').run(delta, session.game_id)
      ended.duration_seconds = newDur
      logger.info(`Excluded ${idleSec}s idle from "${session.game_name || session.game_id}" session`)
    }
  }

  // We already required the process to run for `sensitivity` seconds before
  // starting a session, so anything reported here is real playtime. Only drop
  // pathologically short rows (clock-skew/system-sleep edge cases) so a quick
  // close after a long session still counts.
  if (ended && (ended.duration_seconds == null || ended.duration_seconds < 3)) {
    require('../db/database').getDb()
      .prepare('DELETE FROM sessions WHERE id=?').run(session.id)
    require('../db/database').getDb()
      .prepare('UPDATE games SET total_playtime_seconds=MAX(0,total_playtime_seconds-?) WHERE id=?')
      .run(ended.duration_seconds || 0, session.game_id)
    logger.debug('Dropped sub-3s session', { id: session.id, duration: ended?.duration_seconds })
    return
  }

  const game = gamesQ.getGame(session.game_id)
  logger.info('Session ended', { gameId: session.game_id, duration: ended?.duration_seconds })
  try { require('./autoBackup').markDirty() } catch {}
  // Auto-snapshot this game's save files (no-op unless the user enabled it).
  try { require('./autoSaveBackup').backupGameAfterSession(game) } catch {}
  sendToRenderer('session:ended', { session: ended, game_name: game?.name })
  try {
    require('./notifications').notifySessionEnded({
      gameName: game?.name || 'Game',
      durationSeconds: ended?.duration_seconds || 0,
    })
  } catch {}
  emitter.emit('change')

  // Trigger post-session achievement sync for Steam games. Steam's Web API caches
  // recently-unlocked achievements server-side, so an unlock from the final minutes
  // of play is often not visible the instant you quit. Sync immediately, then retry
  // on a tightening schedule over the next few minutes to catch them as soon as the
  // cache clears (instead of making the user wait until the next launch). Each retry
  // is a no-op once everything is already synced, so the extra calls are cheap.
  if (game?.steam_app_id) {
    const endedSession = ended
    const gid = session.game_id
    const runSync = () => { try { require('./achievementSync').syncAfterSession(gid, endedSession?.id) } catch {} }
    setImmediate(runSync)
    for (const sec of [20, 45, 90, 150, 240]) setTimeout(runSync, sec * 1000)
  }
}

function start() {
  if (pollTimer) return
  lastTickAt = Date.now()

  // Resolve sessions left open by a previous quit/crash based on whether the
  // game is running RIGHT NOW (not a fixed time window) — see below.
  resolveOrphanSessions().catch(e => logger.warn('resolveOrphanSessions failed', { message: e.message }))

  pollTimer = setInterval(async () => {
    try { await tick() } catch (err) {
      logger.error('processWatcher tick error', { message: err.message })
    }
  }, POLL_MS)
  logger.info('processWatcher started')
}

// On startup, deal with sessions that are still open in the DB (KoZo was quit or
// crashed while a game was running). For each:
//   • game STILL running  → resume it in-memory as ONE continuous session, so
//     "quit KoZo while playing, restart later" never splits into two sessions.
//   • game NOT running     → it closed while KoZo was off; cap the session at the
//     last heartbeat we recorded (games.last_played_at), never counting unobserved time.
async function resolveOrphanSessions() {
  const orphans = sessionsQ.getActiveSessions()   // ended_at IS NULL (+ game_name, exe_name)
  if (!orphans.length) return

  let running = new Set()
  try {
    const procList = await getRunningProcesses()
    running = new Set(procList.map(p => (p.name || '').toLowerCase()))
  } catch (e) {
    logger.warn('resolveOrphanSessions: process list failed', { message: e.message })
  }

  const db  = require('../db/database').getDb()
  const now = Date.now()

  for (const orphan of orphans) {
    if (activeSessions.has(orphan.game_id)) continue
    const exe = (orphan.exe_name || '').toLowerCase()

    if (exe && running.has(exe)) {
      // Still running → resume as one continuous session (keeps original started_at).
      activeSessions.set(orphan.game_id, {
        ...orphan,
        game_name: orphan.game_name,
        exe_name: orphan.exe_name,
        last_seen_at: now,
      })
      midSessionSyncAt.set(orphan.game_id, now)
      try { require('./crackWatcher').watchGame(orphan.game_id) } catch {}
      logger.info(`Resumed open session for "${orphan.game_name}" — still running after KoZo restart`)
    } else {
      // Not running → cap at the last heartbeat (the game closed while KoZo was off).
      const game       = gamesQ.getGame(orphan.game_id)
      const startMs     = new Date(orphan.started_at).getTime()
      const lastSeenMs  = game?.last_played_at ? new Date(game.last_played_at).getTime() : startMs
      const endMs       = Math.max(startMs, lastSeenMs)
      const dur         = Math.max(0, Math.floor((endMs - startMs) / 1000))
      const endIso      = new Date(endMs).toISOString()
      db.prepare('UPDATE sessions SET ended_at = ?, duration_seconds = ? WHERE id = ?').run(endIso, dur, orphan.id)
      db.prepare('UPDATE games SET total_playtime_seconds = total_playtime_seconds + ? WHERE id = ?').run(dur, orphan.game_id)
      if (dur < 3) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(orphan.id)
        db.prepare('UPDATE games SET total_playtime_seconds = MAX(0, total_playtime_seconds - ?) WHERE id = ?').run(dur, orphan.game_id)
      }
      logger.info(`Capped orphan session for "${orphan.game_name}" at ${dur}s (game not running)`)
    }
  }
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  try { require('./controllerInput').stop() } catch {}
  // Leave active sessions OPEN in the DB (do NOT finalize). On next start,
  // resolveOrphanSessions() resumes them if the game is still running, or caps
  // them at the last heartbeat if it isn't. This is what keeps "quit KoZo while
  // playing → restart" a single continuous session. The heartbeat has already
  // kept games.last_played_at fresh, so the cap point is accurate.
  activeSessions.clear()
  detectionBuffer.clear()
  detectingGames.clear()
  midSessionSyncAt.clear()
  logger.info('processWatcher stopped (open sessions left for resume)')
}

function pause()  { paused = true  }
function resume() { paused = false }

function getActiveSessions() { return activeSessions }
function getDetectingGames() { return detectingGames }
function isPaused() { return paused }
function onChange(cb)         { emitter.on('change', cb) }
function onUnknownProcess(cb) { emitter.on('unknownProcess', cb) }

/**
 * Returns all running .exe processes with their disk paths.
 * Used by AddGame/EditGame "Pick running" feature so the user
 * can identify the exact exe name without guessing.
 *
 * Filters out hard-deny system processes. Sorts game-y paths first.
 */
async function listRunningProcesses() {
  const ps = `Get-Process | Where-Object { $_.Path } | Select-Object Name, Path | ConvertTo-Json -Compress`
  try {
    const { stdout } = await execP(
      `powershell.exe -NoProfile -NonInteractive -Command "${ps}"`,
      { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    )
    const raw = stdout.trim()
    if (!raw) return []
    let arr = JSON.parse(raw)
    if (!Array.isArray(arr)) arr = [arr]

    const seen = new Set()
    const results = []
    for (const item of arr) {
      const name = (item.Name || '') + '.exe'
      const key  = name.toLowerCase()
      if (seen.has(key)) continue
      if (HARD_DENY.has(key)) continue
      const path = item.Path || ''
      if (NON_GAME_PATH_HINTS.some(s => path.toLowerCase().replace(/\//g, '\\').includes(s))) continue
      seen.add(key)
      results.push({
        exe_name: name,
        install_path: path.replace(/\\[^\\]+$/, ''),  // strip the exe filename
        is_likely_game: looksLikeGamePath(path),
      })
    }
    // Sort: likely games first, then alphabetically
    results.sort((a, b) => {
      if (a.is_likely_game !== b.is_likely_game) return a.is_likely_game ? -1 : 1
      return a.exe_name.localeCompare(b.exe_name)
    })
    return results
  } catch (e) {
    logger.warn('listRunningProcesses failed', { message: e.message })
    return []
  }
}

module.exports = {
  start, stop, pause, resume,
  getActiveSessions, getDetectingGames, isPaused,
  onChange, onUnknownProcess,
  listRunningProcesses,
}
