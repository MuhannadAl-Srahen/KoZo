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
// How often the in-session heartbeat persists games.last_played_at (each write
// fsyncs SQLite — see heartbeatSession for why this isn't every tick).
const HEARTBEAT_WRITE_MS   = 30 * 1000
// How long lightTick() may reuse a cached games row for the heartbeat.
const GAME_ROW_TTL_MS      = 60 * 1000

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
// Crack files update instantly on unlock via crackWatcher's own live chokidar
// watcher (started alongside the session — see watchGame), and crackWatcher
// also runs its own slower safety-net rescan (scanActiveSessions). So the
// crack-file half of THIS function — a synchronous fs.existsSync/readFileSync
// pass over every candidate path — only needs to run on one-off events (session
// start/end), not on the hot 10s heartbeat cadence too; doing it there on top
// of crackWatcher's own timer was pure redundant disk I/O on a hot path.
// `skipCrackScan` lets the periodic heartbeat caller opt out of that half
// while still polling Steam's Web API every 10s (network-only, no sync fs
// calls, worth keeping fast — see achievement sync docs for why).
// Reasons that will NOT resolve themselves by polling again in 10 seconds:
// the profile is private, the Steam ID is wrong, or the game genuinely has no
// achievement stats. Before this, a private profile meant six failing HTTPS
// requests a minute for the entire session, forever — noise in the log and
// pointless wakeups on the one cadence that must stay quiet. Once a game hits
// one of these, its periodic poll is parked for the rest of the session; the
// session-end sync still runs once (that's where a fixed setting is noticed).
const PERMANENT_SYNC_REASONS = new Set([
  'private', 'private_profile', 'profile_not_found',
  'no_stats_for_game', 'no_steam_id', 'no_steam_app_id', 'foreign_launcher',
])
const syncParked = new Map()   // gameId → reason

function runAchievementSync(gameId, gameName, opts = {}) {
  const { skipCrackScan = false } = opts
  const parked = syncParked.get(gameId)
  setImmediate(async () => {
    if (!parked) try {
      const { syncPlayerUnlocks } = require('./achievementSync')
      const r = await syncPlayerUnlocks(gameId)
      if (r?.added > 0) logger.info(`achievement sync: +${r.added} Steam unlock(s) for "${gameName}"`)
      else if (r?.reason && PERMANENT_SYNC_REASONS.has(r.reason)) {
        syncParked.set(gameId, r.reason)
        logger.info(`achievement sync (Steam) parked for "${gameName}" this session: ${r.reason}`)
      } else if (r?.reason) logger.debug(`achievement sync (Steam) "${gameName}": ${r.reason}`)
    } catch (e) {
      logger.warn(`achievement sync (Steam) failed for "${gameName}"`, { message: e.message })
    }
    if (skipCrackScan) return
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

// gameId → last in-session XP check timestamp. Playtime XP accrues while
// playing (computeXp counts live session seconds), so checking every few
// minutes lets the level-up toast pop DURING the session instead of only
// at session end.
const xpCheckAt = new Map()
const XP_CHECK_MS = 5 * 60_000

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
  // Wallpaper Engine (lives in steamapps\common but is not a game)
  'wallpaper32.exe','wallpaper64.exe','ui32.exe','ui64.exe',
  'webwallpaper32.exe','webwallpaper64.exe','wallpaperservice32_c.exe',
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
  '\\wallpaper_engine\\',
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

// Look up the executable paths of running processes by name — batched, one
// PowerShell spawn resolves every never-before-seen exe name in a single
// tick instead of one spawn per exe. Spawning a process is the expensive part
// (see the fastlist.exe comment above lightTick); doing it once per candidate
// name, sequentially, could mean a dozen spawns back to back right after a
// game's launcher/helper processes all start up at once.
const pathCache = new Map()  // exe_lower → path (only positives cached forever)
async function getProcessPathsBatch(exeNames) {
  const results = new Map()  // exe_lower (with .exe) → path
  if (!exeNames.length) return results
  const nameList = exeNames
    .map(n => n.replace(/\.exe$/i, '').replace(/'/g, "''"))
    .map(n => `'${n}'`)
    .join(',')
  const ps = `Get-Process -Name ${nameList} -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object Name,Path | ConvertTo-Json -Compress`
  try {
    const { stdout } = await execP(
      `powershell.exe -NoProfile -NonInteractive -Command "${ps}"`,
      { timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024 }
    )
    const raw = stdout.trim()
    if (!raw) return results
    let arr = JSON.parse(raw)
    if (!Array.isArray(arr)) arr = [arr]
    for (const item of arr) {
      const key = `${(item.Name || '').toLowerCase()}.exe`
      if (item.Path && !results.has(key)) {
        results.set(key, item.Path)
        pathCache.set(key, item.Path)
      }
    }
  } catch {}
  return results
}

// evaluatedExes persistence — without this, every app restart re-evaluates
// (and re-spawns PowerShell for) every non-game exe already running on the
// machine, all over again. Loaded once in start(), saved debounced whenever
// new entries are added.
const EVALUATED_EXES_SETTING = 'pw_evaluated_exes'
let saveEvaluatedTimer = null
function loadEvaluatedExes() {
  try {
    const raw = settingsQ.getSetting(EVALUATED_EXES_SETTING)
    if (raw) for (const name of JSON.parse(raw)) evaluatedExes.add(name)
  } catch {}
}
function scheduleSaveEvaluatedExes() {
  if (saveEvaluatedTimer) return
  saveEvaluatedTimer = setTimeout(() => {
    saveEvaluatedTimer = null
    try { settingsQ.setSetting(EVALUATED_EXES_SETTING, JSON.stringify([...evaluatedExes])) } catch {}
  }, 5000)
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

// Cross-platform "is this PID still alive" check with no process spawn — signal
// 0 is the documented way to test existence (works on Windows too, via libuv).
// This is what lets lightTick() avoid ps-list's helper-process spawn on most
// ticks (see below).
function isPidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code === 'EPERM' }  // exists, just not signalable by us
}

// Gap > sleep threshold → the OS was suspended. Don't count the suspended
// period as playtime. Forcefully end every active session at the timestamp
// we last confirmed the game was running. Shared by tick() and lightTick().
// Returns true if it fired (caller should bail out of the rest of the tick).
function capSessionsForSleepGap(gapMs, prevTickAt) {
  if (gapMs <= SLEEP_GAP_MS) return false
  logger.warn('processWatcher: long gap detected, capping active sessions', { gapMs })
  for (const [gameId, session] of activeSessions) {
    const lastSeenMs = session.last_seen_at || prevTickAt
    endSession(gameId, session, new Date(lastSeenMs).toISOString())
  }
  detectionBuffer.clear()
  return true
}

// Per-tick heartbeat for a game with an already-active session: idle/AFK
// accounting, last_played_at, and the periodic achievement/XP checks. Shared
// by the full tick() (fresh ps-list every time) and lightTick() (PID-liveness
// only, no spawn) so the two poll paths can't drift out of sync.
function heartbeatSession(game, session, gapMs, now) {
  session.last_seen_at = now

  // Idle/AFK: if there's been no input (keyboard/mouse, plus gamepad when
  // controller tracking is on) beyond the threshold, count this tick's
  // elapsed time as idle (subtracted from playtime when the session ends).
  const idleThresh = getIdlePauseSec()
  const isIdleNow  = idleThresh > 0 && effectiveIdleSeconds() >= idleThresh
  if (isIdleNow) {
    session.idle_seconds = (session.idle_seconds || 0) + Math.round(gapMs / 1000)
  }
  // Broadcast idle state EVERY tick while idle (not just on transitions):
  // the renderer computes the live timer as now − started_at − idle_seconds,
  // so a stale idle_seconds would keep the visible counter climbing during
  // AFK even though the recorded time is correct. Fresh values each tick
  // make the timer visibly freeze. One transition event fires on wake too.
  const wasIdle = !!session.idle
  if (wasIdle !== isIdleNow) {
    session.idle = isIdleNow
    logger.info(`Session ${isIdleNow ? 'idle (AFK) — pausing playtime' : 'active again'}`, { gameId: game.id })
  }
  if (isIdleNow || wasIdle !== isIdleNow) {
    sendToRenderer('session:idle', { gameId: game.id, idle: isIdleNow, idle_seconds: session.idle_seconds || 0 })
  }

  // Persist the heartbeat, but not every tick — each UPDATE fsyncs the DB, and
  // doing that every 5s while the game may be streaming assets from the same
  // disk is needless I/O on a hot path. 30s granularity only matters if KoZo
  // itself hard-crashes mid-session (orphan capping falls back to this value);
  // a clean quit keeps sessions open and resumes them exactly (§ resolveOrphanSessions).
  if (now - (session._lastHeartbeatWriteAt || 0) >= HEARTBEAT_WRITE_MS) {
    session._lastHeartbeatWriteAt = now
    try {
      require('../db/database').getDb()
        .prepare('UPDATE games SET last_played_at = ? WHERE id = ?')
        .run(new Date(now).toISOString(), game.id)
    } catch {}
  }

  // Periodic achievement sync — Steam Web API only (see runAchievementSync
  // for why the crack-file half is skipped here: crackWatcher's own live
  // watch + safety-net timer already cover it without duplicating the
  // sync-fs-I/O pass on this hot cadence).
  const lastSync = midSessionSyncAt.get(game.id) || 0
  if (now - lastSync >= getAchievementSyncMs()) {
    midSessionSyncAt.set(game.id, now)
    runAchievementSync(game.id, game.name, { skipCrackScan: true })
  }

  // Periodic XP check — level-ups from accumulated playtime toast mid-session.
  const lastXp = xpCheckAt.get(game.id) || 0
  if (now - lastXp >= XP_CHECK_MS) {
    xpCheckAt.set(game.id, now)
    try {
      require('./xpTracker').check({
        reason: 'session_tick',
        gameName: game.name,
        artPath: game.banner_local_path || game.hero_local_path || null,
        artUrl: game.banner_url || null,
      })
    } catch {}
  }
}

// Start/stop the gamepad probe. Safe to call from both tick() and lightTick().
//
// The probe is a persistent PowerShell process, so it is started LAZILY: while
// the keyboard/mouse are being used the OS idle timer already proves the player
// is active and the gamepad can't change that answer — running a second process
// for the whole session to learn nothing is exactly the kind of background cost
// that shows up as in-game stutter. It spins up only once input has been quiet
// for half the AFK threshold (still leaving plenty of margin to catch a
// controller-only player before AFK would fire) and is killed the moment real
// keyboard/mouse input returns.
function syncControllerProbe() {
  const ci = require('./controllerInput')
  const threshold = getIdlePauseSec()
  if (threshold <= 0 || activeSessions.size === 0) {
    if (ci.isRunning()) ci.stop()
    return
  }
  const sysIdleSec = powerMonitor.getSystemIdleTime()
  if (!ci.isRunning()) {
    if (sysIdleSec >= Math.max(15, Math.floor(threshold / 2))) {
      // Seed the probe with the keyboard/mouse idle time — see start()'s note.
      ci.start({ idleMs: sysIdleSec * 1000 })
    }
  } else if (sysIdleSec < 2) {
    ci.stop()   // real kb/mouse input is back; the gamepad adds nothing
  }
}

// Cheap heartbeat for ticks between full scans (see FULL_SCAN_EVERY_TICKS):
// no ps-list call at all, just a free PID-liveness check per already-tracked
// session. This is the fix for games stuttering every ~5s while KoZo runs —
// ps-list spawns a helper process (fastlist.exe) to enumerate every running
// process, and creating a process (plus AV real-time scanning it) is enough
// to visibly hitch a fullscreen game's frame pacing on a regular cadence.
// Only known-active sessions are touched here; detecting brand-new games or
// unknown processes still happens on the periodic full tick().
async function lightTick() {
  if (paused) return
  const now        = Date.now()
  const prevTickAt = lastTickAt
  const gapMs      = now - prevTickAt
  lastTickAt       = now

  if (capSessionsForSleepGap(gapMs, prevTickAt)) return

  for (const [gameId, session] of [...activeSessions]) {
    if (!isPidAlive(session.pid)) {
      endSession(gameId, session)
      continue
    }
    // The heartbeat only reads name/art off the row, which never changes
    // mid-session in practice — cache it briefly instead of re-reading every
    // 5s tick. The full tick() below always passes a fresh row.
    let game = session._gameRow
    if (!game || now - (session._gameRowAt || 0) >= GAME_ROW_TTL_MS) {
      game = gamesQ.getGame(gameId)
      if (!game) continue
      session._gameRow = game
      session._gameRowAt = now
    }
    heartbeatSession(game, session, gapMs, now)
  }

  syncControllerProbe()
}

async function tick() {
  if (paused) return

  const now           = Date.now()
  const prevTickAt    = lastTickAt
  const gapMs         = now - prevTickAt
  lastTickAt          = now

  if (capSessionsForSleepGap(gapMs, prevTickAt)) return

  let procList
  try {
    procList = await getRunningProcesses()
  } catch (err) {
    logger.error('processWatcher: ps-list failed', { message: err.message })
    return
  }

  const runningExes     = new Set(procList.map(p => (p.name || '').toLowerCase()))
  // First-seen PID per exe name — lets lightTick() confirm liveness later
  // without spawning anything (see isPidAlive).
  const procByName      = new Map()
  for (const p of procList) {
    const n = (p.name || '').toLowerCase()
    if (n && !procByName.has(n)) procByName.set(n, p)
  }
  const games           = gamesQ.listGames()
  const knownGameIds    = new Set(games.map(g => g.id))
  const sensitivitySecs = getSensitivitySeconds()
  // Detection counts consecutive sightings — base the tick count on the CURRENT
  // poll cadence (adaptive: 5s in-session/detecting, 20s fully idle) so
  // sensitivity stays honest.
  const currentPollMs   = (activeSessions.size > 0 || detectingGames.size > 0) ? POLL_MS : POLL_IDLE_MS
  const ticksNeeded     = Math.max(1, Math.ceil(sensitivitySecs / (currentPollMs / 1000)))

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
        // Cracked game → attach the live achievement file watcher NOW (~one poll
        // after the exe appears) instead of after the sensitivity window, so an
        // unlock in the opening seconds still surfaces instantly. Idempotent —
        // the session-start call below becomes a no-op.
        if (game.is_cracked === 1) {
          try { require('./crackWatcher').watchGame(game.id) } catch {}
        }
      }

      if (buf.ticks >= ticksNeeded) {
        const session = sessionsQ.resumeOrStartSession(game.id)
        const pid = procByName.get(exeLower)?.pid || null
        const enriched = { ...session, game_name: game.name, exe_name: game.exe_name, last_seen_at: now, idle_seconds: 0, pid }
        activeSessions.set(game.id, enriched)
        detectionBuffer.delete(game.id)
        detectingGames.delete(game.id)
        logger.info('Session started', { gameId: game.id, name: game.name })
        sendToRenderer('session:started', enriched)
        try { require('./notifications').notifySessionStarted({ gameName: game.name }) } catch {}
        try {
          require('../overlayWindow').sendSessionStarted({
            gameName: game.name,
            gameId: game.id,
            artPath: game.banner_local_path || game.hero_local_path || null,
            artUrl: game.banner_url || null,
          })
        } catch {}
        // Auto-mark 'playing' (only from no-status/on-hold — never un-finishes).
        try { require('./statusSync').onSessionStarted(game.id) } catch {}
        emitter.emit('change')

        // Sync achievements right away so anything unlocked before/at launch shows
        // immediately, then again on the interval below.
        midSessionSyncAt.set(game.id, now)
        runAchievementSync(game.id, game.name)

        // Cracked game → start a live file watcher so unlocks appear instantly
        // (crack files hit disk the moment you unlock; no Steam API cache lag).
        if (game.is_cracked === 1) {
          try { require('./crackWatcher').watchGame(game.id) } catch {}
        } else if (game.steam_app_id) {
          // Steam game → watch the Steam client's local stats file so unlocks
          // show instantly instead of waiting out the Web API's server cache.
          try { require('./steamStatsWatcher').watchGame(game.id, session.id) } catch {}
        }
      }

    } else if (isRunning && hasSession) {
      // Heartbeat: keep `last_seen_at` fresh so an unexpected crash / sleep
      // still records playtime up to the last successful poll. Also refresh
      // the tracked PID (matched by exe name from this tick's real scan) so
      // lightTick()'s liveness check stays correct even if the game restarted
      // under a new PID without an intervening session end.
      const s = activeSessions.get(game.id)
      s.pid = procByName.get(exeLower)?.pid || s.pid
      s._gameRow = game            // this scan already read a fresh row
      s._gameRowAt = now
      heartbeatSession(game, s, gapMs, now)

    } else if (!isRunning && hasSession) {
      endSession(game.id, activeSessions.get(game.id))

    } else if (!isRunning) {
      detectionBuffer.delete(game.id)
      // Game closed before its session officially started — clear the optimistic
      // "Now Playing" so the indicator doesn't linger, and drop the crack watcher
      // attached at detection (a real session's watcher is detached in endSession;
      // this branch only runs when there is no session).
      if (detectingGames.delete(game.id)) {
        sendToRenderer('session:undetected', { gameId: game.id })
        try { require('./crackWatcher').unwatchGame(game.id) } catch {}
      }
    }
  }

  // Clean up sessions whose game has been removed from the library mid-session.
  for (const [gameId, session] of activeSessions) {
    if (!knownGameIds.has(gameId)) {
      logger.info('Ending orphaned session — game no longer in library', { gameId })
      endSession(gameId, session, new Date(session.last_seen_at || now).toISOString())
    }
  }

  syncControllerProbe()

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

  // Check candidate paths via ONE batched PowerShell call (never one spawn per
  // exe — see getProcessPathsBatch). Deferred entirely while a session is
  // active: this is background bookkeeping, not detection of the game already
  // playing, so it can wait for the next idle full scan rather than spawn a
  // process on top of a running game (perf invariant — nothing on the hot
  // in-session cadence may spawn a process). Left-alone candidates simply stay
  // in unknownExeBuffer and get re-evaluated once the session ends.
  if (candidates.length && activeSessions.size === 0) {
    const pathsByName = await getProcessPathsBatch(candidates.map(p => p.name || ''))
    for (const proc of candidates) {
      const name = (proc.name || '').toLowerCase()
      evaluatedExes.add(name)
      unknownExeBuffer.delete(name)

      const exePath = pathsByName.get(name) || null
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
    scheduleSaveEvaluatedExes()
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
  xpCheckAt.delete(gameId)
  // Un-park the Steam poll: a parked reason (private profile, wrong ID) is
  // usually fixed between sessions, and the session-end sync below is exactly
  // where we want to find out.
  syncParked.delete(gameId)
  try { require('./crackWatcher').unwatchGame(gameId) } catch {}
  try { require('./steamStatsWatcher').unwatchGame(gameId) } catch {}

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
    // Still an end — deferred jobs must be released even for a dropped session,
    // otherwise a stray short launch would strand them until the next real one.
    if (activeSessions.size === 0) emitter.emit('idle')
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
  // Nothing is playing any more — release every job that was deferred to keep
  // the in-session cadence quiet (crack deep scans, the app-data backup flush,
  // the cracked-library catch-up sweep). See isSessionActive().
  if (activeSessions.size === 0) emitter.emit('idle')

  // XP check: award the session's XP visibly. Shows a "+N XP" summary in the
  // overlay (with a near-level nudge when close), and fires the level-up toast
  // from inside xpTracker if this session pushed the player over a boundary.
  try {
    const xp = require('./xpTracker').check({
      reason: 'session_end',
      gameName: game?.name,
      artPath: game?.banner_local_path || game?.hero_local_path || null,
      artUrl: game?.banner_url || null,
    })
    if (xp && xp.gained > 0) {
      require('../overlayWindow').sendSessionEnded({
        gameName: game?.name || 'Game',
        artPath: game?.banner_local_path || game?.hero_local_path || null,
        artUrl: game?.banner_url || null,
        durationSeconds: ended?.duration_seconds || 0,
        gainedXp: xp.gained,
        level: xp.level,
        leveledUp: xp.leveledUp,
        // Nudge only when the next level is genuinely close — not spam.
        toNextLevel: xp.toNextLevel <= 100 ? xp.toNextLevel : null,
      })
    }
  } catch {}

  // Trigger post-session achievement sync for Steam games. Steam's Web API caches
  // recently-unlocked achievements server-side, so an unlock from the final minutes
  // of play is often not visible the instant you quit. Sync immediately, then retry
  // on a tightening schedule over the next few minutes to catch them as soon as the
  // cache clears (instead of making the user wait until the next launch). Each retry
  // is a no-op once everything is already synced, so the extra calls are cheap.
  if (game?.steam_app_id) {
    const endedSession = ended
    const gid = session.game_id
    // Local Steam stats FIRST — the client writes the unlock to disk within
    // seconds, so this catches the last minutes of play immediately and works
    // even when the Web API can't (private profile, no key). The Web API pass
    // below is then reconciliation: it backfills Steam's real unlock times.
    setImmediate(() => {
      require('./steamStatsWatcher').scanGameOnce(gid, endedSession?.id).catch(() => {})
    })
    const runSync = () => { try { require('./achievementSync').syncAfterSession(gid, endedSession?.id) } catch {} }
    setImmediate(runSync)
    for (const sec of [20, 45, 90, 150, 240]) setTimeout(runSync, sec * 1000)
  }
}

// Adaptive polling: every process-list read spawns a helper process on Windows,
// so ticking at full speed 24/7 wastes CPU. Poll fast only while a session is
// live (precise playtime/AFK) or a launch is being confirmed; idle KoZo relaxes
// — detection latency is bounded by the sensitivity window (default 15s) anyway.
const POLL_IDLE_MS = 20000

// While a session is already active, only 1 tick in this many does the real
// ps-list scan (spawns fastlist.exe) — the rest use lightTick()'s free PID
// check instead. This is the actual fix for games stuttering periodically
// while KoZo runs: repeatedly spawning a process every 5s (plus AV scanning
// it) was enough to hitch a fullscreen game's frame pacing on that cadence.
// The schedule stays on POLL_MS so AFK/heartbeat timing is unaffected — only
// the expensive scan itself is throttled.
//
// 12 (= every 60s at the 5s schedule) rather than 4 (= 20s) — 20s was still
// frequent enough to be a noticeable, regular hitch. The real scan's only two
// jobs during an active session are (a) noticing a SECOND game launched while
// the first is still playing, and (b) re-resolving the tracked PID if the
// game's process restarted under a new PID without an intervening session end
// (e.g. a launcher stub that spawns the real game exe as a child) — both are
// rare, and (b)'s worst case is a session ending up to 60s early (lightTick
// sees the old PID die) followed by a fresh detection once the real scan
// catches the new PID — `resumeOrStartSession`'s 3-min reopen window merges
// that gap back into one continuous session either way.
const FULL_SCAN_EVERY_TICKS = 12
let ticksSinceFullScan = 0

function scheduleNextTick() {
  // Fast cadence while a session is live OR a launch is mid-confirmation
  // (detectingGames non-empty) — a just-launched game still gets checked at
  // 5s so its session starts on time even though full idle scans back off.
  const delay = (activeSessions.size > 0 || detectingGames.size > 0) ? POLL_MS : POLL_IDLE_MS
  pollTimer = setTimeout(async () => {
    try {
      const useLight = activeSessions.size > 0 && ticksSinceFullScan < FULL_SCAN_EVERY_TICKS - 1
      if (useLight) {
        ticksSinceFullScan++
        await lightTick()
      } else {
        ticksSinceFullScan = 0
        await tick()
      }
    } catch (err) {
      logger.error('processWatcher tick error', { message: err.message })
    }
    scheduleNextTick()
  }, delay)
}

// Bring the next full scan forward — called right after the user hits Play.
// Without it a launch from inside KoZo can wait out the whole 20s idle poll
// before "Now Playing" lights up, which reads as the app not noticing.
function nudge() {
  if (!pollTimer || paused) return
  clearTimeout(pollTimer)
  ticksSinceFullScan = FULL_SCAN_EVERY_TICKS   // force the real scan, not lightTick
  pollTimer = setTimeout(async () => {
    try { await tick() } catch (err) { logger.error('processWatcher nudge error', { message: err.message }) }
    scheduleNextTick()
  }, 2000)
}

function start() {
  if (pollTimer) return
  lastTickAt = Date.now()
  loadEvaluatedExes()

  // Resolve sessions left open by a previous quit/crash based on whether the
  // game is running RIGHT NOW (not a fixed time window) — see below.
  resolveOrphanSessions().catch(e => logger.warn('resolveOrphanSessions failed', { message: e.message }))

  scheduleNextTick()
  logger.info('processWatcher started (adaptive polling)')
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
  let procByName = new Map()
  try {
    const procList = await getRunningProcesses()
    running = new Set(procList.map(p => (p.name || '').toLowerCase()))
    for (const p of procList) {
      const n = (p.name || '').toLowerCase()
      if (n && !procByName.has(n)) procByName.set(n, p)
    }
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
        pid: procByName.get(exe)?.pid || null,
      })
      midSessionSyncAt.set(orphan.game_id, now)
      try { require('./crackWatcher').watchGame(orphan.game_id) } catch {}
      try { require('./steamStatsWatcher').watchGame(orphan.game_id, orphan.id) } catch {}
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
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
  try { require('./controllerInput').stop() } catch {}
  try { require('./steamStatsWatcher').unwatchAll() } catch {}
  // Leave active sessions OPEN in the DB (do NOT finalize). On next start,
  // resolveOrphanSessions() resumes them if the game is still running, or caps
  // them at the last heartbeat if it isn't. This is what keeps "quit KoZo while
  // playing → restart" a single continuous session. The heartbeat has already
  // kept games.last_played_at fresh, so the cap point is accurate.
  activeSessions.clear()
  detectionBuffer.clear()
  detectingGames.clear()
  midSessionSyncAt.clear()
  ticksSinceFullScan = 0
  logger.info('processWatcher stopped (open sessions left for resume)')
}

function pause()  { paused = true  }
function resume() { paused = false }

function getActiveSessions() { return activeSessions }
function getDetectingGames() { return detectingGames }
function isPaused() { return paused }
function onChange(cb)         { emitter.on('change', cb) }
function onUnknownProcess(cb) { emitter.on('unknownProcess', cb) }

// ── The "nothing expensive while a game runs" invariant ──────────────────────
// A game is playing (or is one poll away from starting) → the main process must
// not spawn a process, walk a directory tree synchronously, or do a blocking
// write. Every background job asks this before running and defers to onIdle()
// if it's true. Detecting games count: a launch is exactly when the machine is
// busiest (shader compilation, asset streaming), and it's the moment the user
// described as laggy.
function isSessionActive() {
  return activeSessions.size > 0 || detectingGames.size > 0
}

// Fires when the last active session ends. Deferred jobs subscribe here.
function onIdle(cb) { emitter.on('idle', cb) }

// Run `fn` now if nothing is playing, otherwise once the last session ends.
// Coalesced: queuing the same job repeatedly during a session runs it once.
const deferredJobs = new Map()   // key → fn
function runWhenIdle(key, fn) {
  if (!isSessionActive()) { fn(); return }
  deferredJobs.set(key, fn)
}
emitter.on('idle', () => {
  if (!deferredJobs.size) return
  // Let the session-end work settle before starting disk-heavy jobs, and
  // re-check: another game may have been detected in the meantime, in which
  // case everything stays queued for the next idle.
  setTimeout(() => {
    if (isSessionActive()) return
    const jobs = [...deferredJobs.entries()]
    deferredJobs.clear()
    for (const [key, fn] of jobs) {
      try { fn() } catch (e) { logger.warn(`deferred job "${key}" failed`, { message: e.message }) }
    }
  }, 3000)
})

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
  start, stop, pause, resume, nudge,
  getActiveSessions, getDetectingGames, isPaused,
  isSessionActive, onIdle, runWhenIdle,
  onChange, onUnknownProcess,
  listRunningProcesses,
}
