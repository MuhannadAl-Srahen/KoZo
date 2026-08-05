const { ipcMain, shell, dialog, BrowserWindow } = require('electron')
const path = require('path')
const gamesQ = require('./db/queries/games')
const sessionsQ = require('./db/queries/sessions')
const achievementsQ = require('./db/queries/achievements')
const gameListQ = require('./db/queries/gameList')
const customListsQ = require('./db/queries/customLists')
const settingsQ = require('./db/queries/settings')
const logger = require('./logger')

function ok(data) { return { ok: true, data } }
function fail(err) {
  logger.error('IPC error', { message: err.message, stack: err.stack })
  return { ok: false, error: err.message }
}

// Flag the dataset as changed so auto-backup (if enabled) writes a fresh copy.
function bk() { try { require('./services/autoBackup').markDirty() } catch {} }

// Send an event to EVERY open renderer. Using getAllWindows()[0] alone was unsafe:
// after the app minimizes to tray and the window is recreated, [0] can be the
// overlay window, so the main window never received game:updated (favorites/edits
// then only refreshed after switching tabs). Broadcast to all to be safe.
function broadcast(channel, payload) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  } catch {}
}

// SQL predicate for games whose install status is MANAGED BY STEAM. A game must
// have a steam_app_id, not be cracked, AND not belong to a foreign launcher —
function handle(channel, fn) {
  ipcMain.handle(channel, async (_, ...args) => {
    try {
      return ok(await fn(...args))
    } catch (err) {
      return fail(err)
    }
  })
}

// ── Games ────────────────────────────────────────────────────────────────────
handle('games:list', () => gamesQ.listGamesWithStats())
handle('games:get', (id) => gamesQ.getGame(id))
handle('games:add', async (data) => {
  // capsule_fallback is a transport-only hint for banner download — not a column.
  const { capsule_fallback, ...gameData } = data || {}
  const game = gamesQ.addGame(gameData)

  if (game?.steam_app_id) {
    // Download the banner NOW so it shows immediately when Library refreshes after add.
    // This is why Game List never has this problem — it stores a CDN URL instantly.
    try {
      const { downloadBanner } = require('./services/steamApi')
      const fallback = capsule_fallback ? [capsule_fallback] : []
      const bannerPath = await downloadBanner(game.steam_app_id, game.id, fallback)
      gamesQ.updateGame(game.id, { banner_local_path: bannerPath })
      game.banner_local_path = bannerPath
    } catch (e) {
      // No appid art exists (e.g. unreleased) — fall back to the hashed capsule
      // as the remote banner so the card isn't blank.
      if (capsule_fallback) {
        gamesQ.updateGame(game.id, { banner_url: capsule_fallback })
        game.banner_url = capsule_fallback
      } else {
        const { storeRemoteFallback } = require('./services/steamApi')
        const url = await storeRemoteFallback(game.id, game.steam_app_id)
        if (url) game.banner_url = url
      }
      logger.warn(`Banner download failed for game ${game.id}`, { message: e.message })
    }

    // Steam store genres — power auto-grouping on the Game List and genre chips.
    try {
      const { getStoreArt } = require('./services/steamApi')
      const art = await getStoreArt(game.steam_app_id)
      if (art?.genres?.length) {
        gamesQ.updateGame(game.id, { genres: JSON.stringify(art.genres) })
        game.genres = JSON.stringify(art.genres)
      }
    } catch (e) {
      logger.warn(`Genre fetch failed for game add`, { gameId: game.id, message: e.message })
      // The self-healing backfill will pick this game up shortly.
      require('./services/steamApi').runGenreBackfill().catch(() => {})
    }

    // Achievements sync in background — doesn't block the add response
    const { fetchAndStoreAchievements } = require('./services/achievementSync')
    setImmediate(async () => {
      await fetchAndStoreAchievements(game.id)
      try {
        broadcast('game:updated', game.id)
      } catch {}
    })
  } else if (!game?.is_cracked) {
    // No Steam appid (Xbox/Epic/manual) → auto-resolve by name and import the
    // achievement LIST so it appears automatically, no App ID typing needed.
    const { autoImportSchemaByName } = require('./services/achievementSync')
    setImmediate(() => autoImportSchemaByName(game.id).catch(() => {}))
  }

  bk()
  return game
})
handle('games:update', (id, data) => {
  // Status changes go through statusSync so linked Game List rows stay in step.
  const { completion_status, ...rest } = data || {}
  let r = null
  if (Object.keys(rest).length) r = gamesQ.updateGame(id, rest)
  if (completion_status !== undefined) {
    r = require('./services/statusSync').setGameStatus(id, completion_status)
  }
  bk()
  // Broadcast so Library/GameDetail/Achievements re-render (e.g. favorite toggle, edits)
  broadcast('game:updated', id)
  return r || gamesQ.getGame(id)
})
handle('shell:openExternal', (url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url)
  }
  return true
})
handle('games:delete', (id) => { gamesQ.deleteGame(id); bk(); return true })

// Persist a full drag-and-drop ordering: display_order = index in the given array.
handle('games:reorder', (orderedIds) => {
  if (!Array.isArray(orderedIds) || !orderedIds.length) return false
  const db = require('./db/database').getDb()
  const stmt = db.prepare('UPDATE games SET display_order = ? WHERE id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, i) => stmt.run(i, id))
  })()
  bk()
  return true
})

// Locate a game's save files across the standard Windows/Steam locations.
handle('saves:find', (gameId) => {
  const game = gamesQ.getGame(gameId)
  if (!game) throw new Error('Game not found')
  const { findSaveLocations } = require('./services/saveFinder')
  return { game: game.name, locations: findSaveLocations(game) }
})

// Save backup / restore (folders keyed by game NAME, see saveBackup.js)
function gameNameOf(gameId) {
  const game = gamesQ.getGame(gameId)
  if (!game) throw new Error('Game not found')
  return game.name
}
handle('saves:backup', (gameId, sourcePath) =>
  require('./services/saveBackup').backupSave(gameNameOf(gameId), sourcePath))
handle('saves:listBackups', (gameId) =>
  require('./services/saveBackup').listBackups(gameNameOf(gameId)))
handle('saves:restore', (gameId, backupId, target) =>
  require('./services/saveBackup').restoreBackup(gameNameOf(gameId), backupId, target))
handle('saves:deleteBackup', (gameId, backupId) =>
  require('./services/saveBackup').deleteBackup(gameNameOf(gameId), backupId))
handle('saves:backupsDir', () => require('./services/saveBackup').rootPath())

// Per-game backup overview for the Backups tab — count + newest snapshot, so
// the user can see at a glance what's protected and what isn't.
handle('saves:overview', () => {
  const { listBackups } = require('./services/saveBackup')
  const db = require('./db/database').getDb()
  const games = db.prepare('SELECT id, name FROM games ORDER BY name COLLATE NOCASE').all()
  return games.map(g => {
    let backups = []
    try { backups = listBackups(g.name) } catch {}
    return {
      id: g.id,
      name: g.name,
      count: backups.length,
      latestAt: backups[0]?.createdAt || null,
    }
  })
})

// Auto-backup of game saves after each session (mirrors the app-data auto-backup).
handle('saves:getAutoBackup', () => settingsQ.getSetting('auto_save_backup_enabled') === '1')
handle('saves:setAutoBackup', (enabled) => {
  settingsQ.setSetting('auto_save_backup_enabled', enabled ? '1' : '0')
  return true
})

// Back up the best-found save location for EVERY game in the library at once
// (e.g. before formatting the PC). Returns a per-game summary.
handle('saves:backupAll', () => {
  const db = require('./db/database').getDb()
  const { findSaveLocations } = require('./services/saveFinder')
  const { backupSave } = require('./services/saveBackup')
  const games = db.prepare('SELECT * FROM games').all()
  const results = []
  for (const g of games) {
    let locs = []
    try { locs = findSaveLocations(g) } catch {}
    if (!locs.length) { results.push({ name: g.name, status: 'no_saves' }); continue }
    try {
      const meta = backupSave(g.name, locs[0].path)
      results.push({ name: g.name, status: 'ok', files: meta.files })
    } catch (e) {
      results.push({ name: g.name, status: 'error', error: e.message })
    }
  }
  return {
    backedUp: results.filter(r => r.status === 'ok').length,
    noSaves:  results.filter(r => r.status === 'no_saves').length,
    failed:   results.filter(r => r.status === 'error').length,
    results,
    dir: require('./services/saveBackup').rootPath(),
  }
})

// Open a folder in Windows Explorer (used by the save-file finder).
handle('shell:openPath', async (p) => {
  if (typeof p !== 'string' || !p) return false
  const err = await shell.openPath(p)
  if (err) throw new Error(err)
  return true
})

// Launch the game. Steam-linked games go through `steam://run/<appid>` which
// uses the Steam client (handles auth, cloud saves, achievements). Manual games
// fall back to spawning the .exe directly from install_path.
// Is a process with this exe name running right now? Returns null when we
// genuinely can't tell (PowerShell unavailable/blocked), so callers can
// distinguish "definitely not running" from "no idea". One spawn, only ever on
// an explicit Play click — never on the in-session polling cadence.
async function isExeRunning(exeName) {
  const base = String(exeName || '').replace(/\.exe$/i, '').replace(/'/g, "''")
  if (!base) return null
  try {
    const { stdout } = await require('util').promisify(require('child_process').exec)(
      `powershell.exe -NoProfile -NonInteractive -Command "@(Get-Process -Name '${base}' -ErrorAction SilentlyContinue).Count"`,
      { timeout: 5000, windowsHide: true }
    )
    const n = parseInt(String(stdout).trim(), 10)
    return Number.isFinite(n) ? n > 0 : null
  } catch { return null }
}

// One launch in flight per game. Without this, a Play click that appears to do
// nothing (an elevated launch waiting on the UAC prompt, or a slow-starting
// game) invites more clicks — and each one raised ANOTHER consent dialog. The
// logs show seven inside two seconds. Repeat clicks now join the first attempt.
const launchInFlight = new Map()   // gameId → Promise

handle('games:launch', async (id) => {
  const existing = launchInFlight.get(id)
  if (existing) return existing
  const p = (async () => doLaunch(id))()
  launchInFlight.set(id, p)
  try {
    const r = await p
    // Pull the next process scan forward so "Now Playing" lights up in a couple
    // of seconds instead of waiting out the idle poll.
    try { require('./services/processWatcher').nudge() } catch {}
    return r
  } finally { launchInFlight.delete(id) }
})

async function doLaunch(id) {
  const game = gamesQ.getGame(id)
  if (!game) throw new Error('Game not found')

  const fs = require('fs')

  // Decide launch method. The local exe wins whenever it's a real file —
  // this is what lets you mark a cracked game as Steam-linked (for the schema
  // + cover art) and still launch the patched copy on disk instead of Steam.
  // Steam URI is only the fallback for owned-but-not-installed Steam games
  // where we have no executable to spawn directly.
  const hasUsableLocalExe =
    !!game.install_path &&
    !!game.exe_name &&
    !/^steam_\d+\.exe$/i.test(game.exe_name) &&   // sync placeholder
    fs.existsSync(path.join(game.install_path, game.exe_name))

  if (hasUsableLocalExe) {
    const fullPath = path.join(game.install_path, game.exe_name)
    const { spawn } = require('child_process')

    // ShellExecute with -Verb RunAs — the only way to force the UAC elevation
    // prompt regardless of the exe's own manifest. Needed because a plain
    // CreateProcess (what spawn() uses) never shows that prompt itself: if the
    // manifest demands elevation it just fails, and if it doesn't but the exe
    // still needs admin (common with repacks writing into Program Files) it
    // launches "successfully" and then silently does nothing — which is what
    // made Play look like a dead button instead of an error.
    //
    // This USED to resolve the moment powershell.exe itself spawned, with
    // stdio ignored — so it reported success no matter what happened next.
    // Declining the UAC prompt, a blocked elevation, or a broken path all came
    // back as "launched" and Play looked dead (the logs show seven Play clicks
    // in two seconds). Now we run PowerShell to completion, ask Start-Process
    // for the real process via -PassThru, and report what actually happened.
    async function launchElevated() {
      logger.warn(`launching elevated (UAC) via ShellExecute: ${fullPath}`)
      const psPath = fullPath.replace(/'/g, "''")
      const psCwd  = game.install_path.replace(/'/g, "''")
      const script =
        `$ErrorActionPreference='Stop'; ` +
        `try { ` +
          `$p = Start-Process -FilePath '${psPath}' -WorkingDirectory '${psCwd}' -Verb RunAs -PassThru; ` +
          `if ($p) { [Console]::Out.WriteLine('KOZO_PID=' + $p.Id) }; exit 0 ` +
        `} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`

      const { code, out, err } = await new Promise((resolve, reject) => {
        const ps = spawn('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
          { windowsHide: true })
        let out = '', err = ''
        ps.stdout.on('data', d => { out += d })
        ps.stderr.on('data', d => { err += d })
        // The UAC consent dialog blocks Start-Process until the user answers,
        // so this genuinely can sit for a while. Cap it, and treat a timeout as
        // "probably fine, prompt still open" rather than an error.
        const t = setTimeout(() => { resolve({ code: null, out, err, timedOut: true }) }, 90_000)
        ps.once('close', c => { clearTimeout(t); resolve({ code: c, out, err }) })
        ps.once('error', e => { clearTimeout(t); reject(e) })
      })

      if (code === 0 || code === null) {
        const pid = out.match(/KOZO_PID=(\d+)/)?.[1]
        return { launched: 'shell-elevated', path: fullPath, pid: pid ? Number(pid) : undefined }
      }

      // Win32 error 1223 = ERROR_CANCELLED, i.e. the user dismissed the prompt.
      // Worth naming exactly: it's the single most common reason Play "does
      // nothing", and it's not a bug the user can fix by clicking again.
      const msg = String(err || '').trim()
      logger.warn(`elevated launch failed for "${game.name}": ${msg || 'exit ' + code}`)
      if (/cancell?ed by the user|operation was cancell?ed|1223/i.test(msg)) {
        throw new Error(
          `"${game.name}" needs administrator rights, and the Windows permission prompt was dismissed. ` +
          'Click Play again and choose Yes. If no prompt appears at all, your account may not be allowed to elevate.'
        )
      }
      throw new Error(
        `Windows refused to start "${game.name}" with administrator rights.\n\n${msg || `PowerShell exited with code ${code}.`}`
      )
    }

    // Remembered from a previous launch that needed elevation — skip straight
    // to it instead of repeating a doomed plain launch every time.
    if (game.run_as_admin) return await launchElevated()

    try {
      await new Promise((resolve, reject) => {
        const child = spawn(fullPath, [], {
          detached: true,
          stdio: 'ignore',
          cwd: game.install_path,
        })
        let settled = false
        child.once('spawn', () => {
          // Don't resolve yet — an elevation-requiring exe can still spawn
          // "successfully" via CreateProcess and then exit right back out
          // with no window ever shown and no 'error' event. Give it a beat
          // to prove it's actually staying up.
          setTimeout(() => {
            if (!settled) { settled = true; child.unref(); resolve() }
          }, 1200)
        })
        child.once('exit', async (code) => {
          if (settled) return
          settled = true
          // It exited within 1.2s. That's either (a) a launcher stub that
          // handed off to the real game exe and quit — completely normal, lots
          // of repacks do this — or (b) the game dying instantly because it
          // couldn't write where it needed to without admin. Exit code doesn't
          // distinguish them (a silent admin-death is usually code 0), so ask
          // Windows whether anything named like this game is actually running.
          const alive = await isExeRunning(game.exe_name).catch(() => null)
          child.unref()
          if (alive !== false) resolve()   // running, or we couldn't tell — assume fine
          else reject(Object.assign(
            new Error(`exited immediately (code ${code}) and no "${game.exe_name}" process is running`),
            { code: 'EARLY_EXIT' }))
        })
        child.once('error', (e) => {
          if (settled) return
          settled = true
          reject(e)
        })
      })
      return { launched: 'spawn', path: fullPath }
    } catch (e) {
      // EACCES/EPERM/EARLY_EXIT all point the same way here: the exe needs
      // admin rights. Fall back to the elevated launch now, and remember it
      // so future Play clicks go straight there.
      logger.warn(`spawn failed (${e.code || e.message}) — retrying elevated: ${fullPath}`)
      const result = await launchElevated()
      try { gamesQ.updateGame(game.id, { run_as_admin: 1 }) } catch {}
      return result
    }
  }

  // Cracked games: never fall back to Steam — that's the wrong client.
  if (game.is_cracked) {
    // Distinguish "never configured" from "was configured but the file is
    // gone now" (moved install, renamed exe after an update, or the drive
    // it lives on isn't connected) — the generic message reads like Play is
    // just broken when really the path on disk changed out from under it.
    if (!game.install_path || !game.exe_name) {
      throw new Error(
        'No executable is set for this game. Edit the game → Browse to point at the .exe.'
      )
    }
    if (!fs.existsSync(game.install_path)) {
      throw new Error(
        `Can't find the game's folder anymore: ${game.install_path} — the game may have been moved/uninstalled, ` +
        'or it lives on a drive that isn\'t connected right now. Edit the game → Browse to re-point it.'
      )
    }
    throw new Error(
      `Found the folder, but not "${game.exe_name}" inside it: ${game.install_path} — ` +
      'the game may have been updated/reinstalled with a different exe. Edit the game → Browse to re-point it.'
    )
  }

  if (game.steam_app_id) {
    await shell.openExternal(`steam://run/${game.steam_app_id}`)
    // steam://run always "succeeds" from KoZo's side — Electron hands the URI
    // to the OS and gets no feedback on whether Steam actually found/launched
    // anything, so a game that isn't really there any more looks exactly like
    // Play doing nothing. When KoZo's OWN cached path is also stale (not just
    // unset — the folder/exe genuinely isn't there), surface that as a soft
    // heads-up rather than silence: Steam has its own install tracking and
    // may well launch it fine regardless, but if nothing happens this is why.
    const pathWasConfigured = !!game.install_path && !!game.exe_name
    const pathIsStale = pathWasConfigured && !fs.existsSync(game.install_path)
    const warning = pathIsStale
      ? `Sent to Steam. Heads up: KoZo's saved path for this game (${game.install_path}) no longer exists — if nothing launches, the game may need reinstalling, or its files moved to a new location. Try Scan PC, or Edit → Browse to re-point it.`
      : undefined
    return { launched: 'steam', via: 'steam://run', warning }
  }

  throw new Error('No way to launch — set the install path and executable (Edit → Browse).')
}

// ── Crack discovery ──────────────────────────────────────────────────────────
// Games with emulator achievement data on this PC that aren't in the library.
// Read-only: it lists what it found, the user decides what (if anything) to add.
handle('crack:discover', async () => {
  return require('./services/crackDiscovery').discover()
})

handle('crack:dismissDiscovered', (appId) => {
  return require('./services/crackDiscovery').dismiss(appId)
})

// ── Sessions ─────────────────────────────────────────────────────────────────
handle('sessions:list', (filters) => sessionsQ.listSessions(filters))
handle('sessions:get', (id) => sessionsQ.getSession(id))
handle('sessions:getForGame', (gameId) => sessionsQ.listSessions({ gameId }))

// ── Achievements ──────────────────────────────────────────────────────────────
handle('achievements:listForGame', (gameId) => achievementsQ.listAchievementsForGame(gameId))
handle('achievements:listAll', (filters) => achievementsQ.listAllAchievements(filters))
handle('achievements:listUnlocksForGame', (gameId) => achievementsQ.listAchievementsForGame(gameId))
handle('achievements:addUnlock', (data) => { achievementsQ.addUnlock(data); bk(); return true })
handle('achievements:removeUnlock', (id) => { achievementsQ.removeUnlock(id); bk(); return true })
// Manual unlock toggle — the fallback for cracks whose emulator never persists
// unlocks to disk. Unlocking routes through emitNewUnlocks so the overlay toast,
// notification and XP check all fire exactly like a real detected unlock.
handle('achievements:toggleManual', (achievementId) => {
  const db = require('./db/database').getDb()
  const ach = db.prepare('SELECT * FROM achievements WHERE id = ?').get(achievementId)
  if (!ach) throw new Error('Achievement not found')
  const existing = db.prepare('SELECT id FROM achievement_unlocks WHERE achievement_id = ?').get(achievementId)

  if (existing) {
    achievementsQ.removeUnlock(achievementId)
    // Silent XP re-check so totals stay consistent (check only toasts on level UP).
    try { require('./services/xpTracker').check({ reason: 'manual_lock' }) } catch {}
    bk()
    broadcast('game:updated', ach.game_id)
    return { unlocked: false }
  }

  const unlocked_at = new Date().toISOString()
  achievementsQ.addUnlock({ achievement_id: achievementId, session_id: null, unlocked_at, source: 'manual' })
  const game = gamesQ.getGame(ach.game_id)
  try {
    require('./services/achievementSync').emitNewUnlocks(game, [{ ...ach, unlocked_at }])
  } catch (e) {
    logger.warn('toggleManual emit failed', { message: e.message })
  }
  bk()
  broadcast('game:updated', ach.game_id)
  return { unlocked: true, unlocked_at }
})
// Automatically resolve a Steam appid by name and import the achievement list
// (for Xbox/Epic/etc.) — no App ID typing. Used on add and from GameDetail.
handle('achievements:autoImport', async (gameId) => {
  const { autoImportSchemaByName } = require('./services/achievementSync')
  // Explicit user action — force so "Re-import" refreshes an existing list
  // instead of bailing with reason 'already'.
  const res = await autoImportSchemaByName(gameId, { force: true })
  bk()
  return res
})

// Everything the Achievements hub tab needs in one round-trip: totals, the
// recent-unlocks feed, rarest unlocked trophies, and per-game completion.
handle('achievements:hub', () => {
  const db = require('./db/database').getDb()

  const totals = db.prepare(`
    SELECT COUNT(a.id) AS total, COUNT(au.id) AS unlocked
    FROM achievements a
    LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
  `).get()

  const recent = db.prepare(`
    SELECT au.unlocked_at, au.source,
           a.display_name, a.description, a.icon_url, a.global_unlock_percent,
           g.id AS game_id, g.name AS game_name
    FROM achievement_unlocks au
    JOIN achievements a ON a.id = au.achievement_id
    JOIN games g ON g.id = a.game_id
    ORDER BY au.unlocked_at DESC
    LIMIT 60
  `).all()

  const rarest = db.prepare(`
    SELECT a.display_name, a.description, a.icon_url, a.global_unlock_percent,
           au.unlocked_at, g.id AS game_id, g.name AS game_name
    FROM achievement_unlocks au
    JOIN achievements a ON a.id = au.achievement_id
    JOIN games g ON g.id = a.game_id
    WHERE a.global_unlock_percent IS NOT NULL
    ORDER BY a.global_unlock_percent ASC
    LIMIT 12
  `).all()

  const perGame = db.prepare(`
    SELECT g.id, g.name, g.banner_local_path, g.banner_url,
           COUNT(a.id) AS total, COUNT(au.id) AS unlocked
    FROM games g
    JOIN achievements a ON a.game_id = g.id
    LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
    GROUP BY g.id
    HAVING total > 0
    ORDER BY (CAST(COUNT(au.id) AS REAL) / COUNT(a.id)) DESC, g.name
  `).all()

  return { totals, recent, rarest, perGame }
})

// ── Game List ─────────────────────────────────────────────────────────────────
handle('gameList:list', (filters) => gameListQ.listGameListItems(filters))
handle('gameList:get', (id) => gameListQ.getGameListItem(id))
handle('gameList:add', async (data) => {
  // Game List cards are remote-only (no local download), so make sure the
  // stored banner_url is one that actually exists — the appid portrait 404s for
  // newer/unreleased titles. Resolve to the real art when needed.
  if (data?.steam_app_id) {
    try {
      const { resolveBannerUrl, getStoreArt } = require('./services/steamApi')
      const [bannerUrl, art] = await Promise.all([
        resolveBannerUrl(data.steam_app_id),
        getStoreArt(data.steam_app_id),
      ])
      data = { ...data, banner_url: bannerUrl }
      if (art?.genres?.length) data.genres = JSON.stringify(art.genres)
      if (art?.release_date) data.release_date = art.release_date
    } catch (e) {
      logger.warn(`Banner/genre resolve failed for game list add`, { steamAppId: data.steam_app_id, message: e.message })
      require('./services/steamApi').runGenreBackfill().catch(() => {})
    }
  }
  const r = gameListQ.addGameListItem(data); bk(); return r
})
handle('gameList:update', (id, data) => {
  const r = gameListQ.updateGameListItem(id, data)
  // Mirror a status change onto the linked library game (and vice versa elsewhere).
  if (data?.status) { try { require('./services/statusSync').syncFromGameList(id, data.status) } catch (e) { logger.warn('statusSync from game list failed', { message: e.message }) } }
  // Newly marked "upcoming" with no stored release date → fetch it right away so
  // the Upcoming tab shows the countdown immediately (not on the next backfill).
  if (data?.status === 'upcoming' && r?.steam_app_id && !r?.release_date) {
    setImmediate(async () => {
      try {
        const art = await require('./services/steamApi').getStoreArt(r.steam_app_id)
        if (art?.release_date) {
          gameListQ.updateGameListItem(id, { release_date: art.release_date })
          broadcast('game:updated', null)
        }
      } catch {}
    })
  }
  bk(); broadcast('game:updated', null); return r
})
handle('gameList:delete', (id) => { gameListQ.deleteGameListItem(id); bk(); return true })

// ── Custom lists (Spotify-playlist-style game lists) ─────────────────────────
handle('customLists:list', () => customListsQ.listLists())
handle('customLists:create', (data) => { const r = customListsQ.createList(data); bk(); return r })
handle('customLists:update', (id, data) => { const r = customListsQ.updateList(id, data); bk(); return r })
handle('customLists:delete', (id) => { customListsQ.deleteList(id); bk(); return true })
handle('customLists:addGame', (listId, itemId) => { customListsQ.addGameToList(listId, itemId); bk(); return true })
handle('customLists:removeGame', (listId, itemId) => { customListsQ.removeGameFromList(listId, itemId); bk(); return true })
handle('customLists:listsForItem', (itemId) => customListsQ.listIdsForItem(itemId))

// ── Genres ────────────────────────────────────────────────────────────────────
handle('genres:distinct', () => gameListQ.distinctGenres())
// Genre backfill now runs on its own (app startup + after a backup restore —
// see runGenreBackfill() in services/steamApi.js). No manual UI trigger.

// ── Settings ──────────────────────────────────────────────────────────────────
handle('settings:get', (key) => settingsQ.getSetting(key))
handle('settings:set', (key, value) => { settingsQ.setSetting(key, value); return true })
handle('settings:getAll', () => settingsQ.getAllSettings())

// ── Active sessions (from process watcher) ───────────────────────────────────
// Cross-check each entry against the games table so a stale in-memory session
// for a deleted game can never bleed into the UI.
handle('sessions:active', () => {
  const { getActiveSessions, getDetectingGames } = require('./services/processWatcher')
  const map = getActiveSessions()
  const out = []
  for (const [gameId, session] of map.entries()) {
    const game = gamesQ.getGame(gameId)
    if (!game) continue   // game was removed from library, skip
    out.push({ gameId, ...session, game_name: session.game_name || game.name })
  }
  // Optimistic "Now Playing": games detected but whose session hasn't officially
  // started yet (still inside the sensitivity window) — shown as `pending` so the
  // sidebar card + cover LIVE badge appear ~one poll after launch.
  for (const [gameId, info] of getDetectingGames().entries()) {
    if (map.has(gameId)) continue
    const game = gamesQ.getGame(gameId)
    if (!game) continue
    out.push({ gameId, game_name: info.game_name || game.name, started_at: info.started_at, pending: true, idle: false, idle_seconds: 0 })
  }
  return out
})

handle('watcher:pause',  () => { require('./services/processWatcher').pause();  return true })
handle('watcher:resume', () => { require('./services/processWatcher').resume(); return true })

// ── File picker for game executable ─────────────────────────────────────────
handle('dialog:pickExe', async (defaultPath) => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    title: 'Select the game executable',
    properties: ['openFile'],
    filters: [
      { name: 'Executables', extensions: ['exe'] },
      { name: 'All files', extensions: ['*'] },
    ],
  }
  if (defaultPath && typeof defaultPath === 'string') opts.defaultPath = defaultPath
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (result.canceled || !result.filePaths?.[0]) return null
  const full = result.filePaths[0]
  return {
    exe_name: path.basename(full),
    install_path: path.dirname(full),
    full_path: full,
  }
})

// Pick an image and return its bytes as a data: URL so the renderer can load it
// into a <canvas> WITHOUT cross-origin canvas tainting (the kozo:// protocol is a
// different origin, which would taint the canvas and break toDataURL()). Used by
// the crop modal as its source image.
const PICK_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}
handle('image:pickData', async () => {
  const fs = require('fs')
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    title: 'Select an image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (result.canceled || !result.filePaths?.[0]) return null
  const src = result.filePaths[0]
  const ext = (path.extname(src) || '.png').toLowerCase()
  const mime = PICK_MIME[ext] || 'image/png'
  const buf = fs.readFileSync(src)
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
})

// Persist a cropped image (data: URL from the crop modal's canvas) into userData.
// Always writes a .png/.jpg for predictable, high-quality output.
handle('image:saveCropped', async ({ kind, dataUrl } = {}) => {
  const { app } = require('electron')
  const fs = require('fs')
  if (!dataUrl || typeof dataUrl !== 'string') throw new Error('No image data')
  const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/)
  if (!m) throw new Error('Unsupported image data')
  const ext = m[1] === 'jpeg' ? '.jpg' : `.${m[1]}`
  const dir = path.join(app.getPath('userData'), 'profile')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const safeKind = ['banner', 'avatar', 'cover'].includes(kind) ? kind : 'image'
  const dest = path.join(dir, `${safeKind}-${Date.now()}${ext}`)
  fs.writeFileSync(dest, Buffer.from(m[2], 'base64'))
  return { path: dest }
})

// ── List currently running processes (for AddGame/EditGame exe picker) ─────
handle('processes:listRunning', async () => {
  const { listRunningProcesses } = require('./services/processWatcher')
  return listRunningProcesses()
})

// ── Steam (stub — wired in Steam API step) ────────────────────────────────────
handle('steam:testKey', async (key) => {
  const { testApiKey } = require('./services/steamApi')
  return testApiKey(key)
})

handle('steam:search', async (query) => {
  const { searchGames } = require('./services/steamApi')
  return searchGames(query)
})

handle('steam:getStoreArt', async (appId) => {
  const { getStoreArt } = require('./services/steamApi')
  return getStoreArt(appId)
})

// Privacy-class failure from the game's last Steam sync, so GameDetail can show
// an inline "profile is private" warning without a manual diagnose.
// Re-test whether Steam will serve unlocks and correct the stored privacy flag.
// Used by the Settings banner's re-check button.
handle('steam:recheckPrivacy', () =>
  require('./services/achievementSync').revalidateProfilePrivacy())

handle('steam:lastSyncError', (gameId) =>
  require('./services/achievementSync').getLastSyncError(gameId))

// End-to-end tracking self-test: synthetic crack file → real scanner → real DB
// unlock → real overlay toast. Push-button proof the critical pipeline works.
handle('tracking:selfTest', () => require('./services/trackingSelfTest').runSelfTest())

// ── App version / updates ─────────────────────────────────────────────────────
handle('app:getVersion', () => require('electron').app.getVersion())
handle('app:checkForUpdates', () => require('./services/appUpdater').checkForUpdates())

// Resolve a SteamID64 from a profile URL / custom name / raw ID. Uses the passed
// key if given (onboarding, before it's saved), else the stored key.
handle('steam:resolveId', async (input, apiKeyOverride) => {
  const { resolveSteamId } = require('./services/steamApi')
  const apiKey = apiKeyOverride || settingsQ.getSetting('steam_api_key')
  return resolveSteamId(input, apiKey)
})

// Lightweight "what does Steam say about this game right now" probe.
// Lets the UI prove that achievement sync is reaching Steam and surfaces
// the actual failure reason (private profile, missing schema, etc).
handle('steam:diagnose', async (gameId) => {
  const steamApi = require('./services/steamApi')
  const game = gamesQ.getGame(gameId)
  if (!game) return { error: 'game_not_found' }
  if (!game.steam_app_id) return { error: 'not_steam_linked' }
  const apiKey  = settingsQ.getSetting('steam_api_key')
  const steamId = settingsQ.getSetting('steam_user_id')
  if (!steamId) return { error: 'no_steam_id' }

  // Keyless diagnose — probe the public community XML feed instead.
  if (!apiKey) {
    const xml = await steamApi.getPlayerAchievementsXml(game.steam_app_id, steamId)
    const db = require('./db/database').getDb()
    const local = db.prepare(`
      SELECT COUNT(a.id) AS total, COUNT(au.id) AS unlocked
      FROM achievements a
      LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
      WHERE a.game_id = ?
    `).get(gameId)
    return {
      ok: !xml.error,
      keyless: true,
      steam_app_id: game.steam_app_id,
      schema_count: xml.error ? 0 : xml.schema.length,
      steam_unlocks: xml.error ? 0 : xml.unlocks.length,
      local_total: local.total,
      local_unlocked: local.unlocked,
      error: xml.error,
    }
  }

  const profile = await steamApi.getPlayerSummary(apiKey, steamId)
  if (!profile) return { error: 'profile_not_found' }

  let schemaCount = 0
  try {
    const schema = await steamApi.getSchemaForGame(game.steam_app_id, apiKey)
    schemaCount = schema.length
  } catch (e) {
    return { error: 'schema_fetch_failed', detail: e.message }
  }

  const player = await steamApi.getPlayerAchievements(game.steam_app_id, apiKey, steamId)
  const db = require('./db/database').getDb()
  const local = db.prepare(`
    SELECT
      COUNT(a.id) AS total,
      COUNT(au.id) AS unlocked
    FROM achievements a
    LEFT JOIN achievement_unlocks au ON au.achievement_id = a.id
    WHERE a.game_id = ?
  `).get(gameId)

  return {
    ok: !player.error,
    profile_name: profile.persona_name,
    steam_app_id: game.steam_app_id,
    schema_count: schemaCount,
    steam_unlocks: player.unlocks.length,
    local_total: local.total,
    local_unlocked: local.unlocked,
    error: player.error,
  }
})

handle('steam:refresh', async (gameId) => {
  const { refreshGameData } = require('./services/steamApi')
  const { syncPlayerUnlocks } = require('./services/achievementSync')
  const { scanGameForCrackAchievements } = require('./services/crackWatcher')

  const game = gamesQ.getGame(gameId)

  // For cracked games: schema fetch is best-effort (needed to populate the
  // achievement list). If Steam rejects it (403, no key, etc.) we continue
  // anyway — the crack file scan is the real source of truth for unlocks.
  let result = {}
  try {
    result = await refreshGameData(gameId) || {}
  } catch (schemaErr) {
    if (!game?.is_cracked) throw schemaErr   // real failure for official games
    logger.warn(`steam:refresh: schema skipped for cracked game "${game?.name}": ${schemaErr.message}`)
    result = { schemaSkipped: true, schemaError: schemaErr.message }
  }

  let playerSync = { added: 0 }
  if (!game?.is_cracked) {
    playerSync = await syncPlayerUnlocks(gameId).catch(() => ({ added: 0 }))
  }

  const crackScan = await scanGameForCrackAchievements(gameId, { fresh: true })
    .catch(() => ({ added: 0, hits: [], scannedPaths: [] }))

  return {
    ...result,
    playerUnlocksAdded: playerSync.added,
    playerSyncReason: playerSync.reason,
    crackUnlocksAdded: crackScan.added,
    crackHits: crackScan.hits,
    crackScannedPaths: crackScan.scannedPaths,
    isCracked: !!game?.is_cracked,
  }
})

handle('crack:scanGame', async (gameId) => {
  const { scanGameForCrackAchievements } = require('./services/crackWatcher')
  // Manual check from the UI — bypass the failed-schema-fetch backoff AND the
  // poll's cached directory walk.
  return scanGameForCrackAchievements(gameId, { forceSchema: true, fresh: true })
})
handle('crack:scanAll', async () => {
  const { scanAllCrackedGames } = require('./services/crackWatcher')
  return scanAllCrackedGames()
})

// Structured diagnosis: emulator family, config vs stored appid, every existing
// candidate file with its parsed unlock count, and a plain-language verdict.
handle('crack:diagnose', (gameId) => {
  const { diagnoseGame } = require('./services/crackWatcher')
  return diagnoseGame(gameId)
})

// Write the achievement list into a Goldberg crack's steam_settings so the
// emulator starts tracking and saving unlocks (some repacks ship without it —
// the game then never records ANY achievement, however long it's played).
handle('crack:enableAchievements', async (gameId) => {
  const { enableGoldbergAchievements } = require('./services/crackWatcher')
  return enableGoldbergAchievements(gameId)
})

// ── PC Scanner ────────────────────────────────────────────────────────────────
handle('scanner:getDefaultPaths', () => {
  const { getDefaultScanPaths } = require('./services/pcScanner')
  return getDefaultScanPaths()
})

handle('scanner:scan', async (paths) => {
  const { scanFolder } = require('./services/pcScanner')
  const { findAppByName } = require('./services/steamApi')
  const db = require('./db/database').getDb()

  // Existing library: track both install paths AND steam appids for dedup
  const existingRows = db.prepare('SELECT install_path, steam_app_id FROM games').all()
  const existingPaths = new Set(existingRows.filter(g => g.install_path).map(g => g.install_path.toLowerCase()))
  const existingAppIds = new Set(existingRows.filter(g => g.steam_app_id).map(g => String(g.steam_app_id)))

  const results = []
  const seenPath = new Set()
  const seenAppId = new Set()
  for (const p of (paths || [])) {
    for (const g of scanFolder(p)) {
      const pathKey = g.install_path.toLowerCase()
      if (seenPath.has(pathKey)) continue
      // Dedup duplicate appid within the same scan (e.g. same game in two folders)
      if (g.steam_app_id && seenAppId.has(String(g.steam_app_id))) continue
      seenPath.add(pathKey)
      if (g.steam_app_id) seenAppId.add(String(g.steam_app_id))
      results.push({ ...g, isInstalled: true })
    }
  }

  // Enrich cracked games (no appid) by matching their name to a Steam title —
  // gives them real cover art + a clean name, just like Add Game. Done with a
  // small concurrency pool so a big scan doesn't fire hundreds of requests.
  const toMatch = results.filter(g => !g.steam_app_id && g.name)
  let idx = 0
  async function worker() {
    while (idx < toMatch.length) {
      const g = toMatch[idx++]
      try {
        const match = await findAppByName(g.name)
        if (match && !seenAppId.has(String(match.steam_app_id))) {
          seenAppId.add(String(match.steam_app_id))
          g.steam_app_id = match.steam_app_id
          g.name = match.name                 // use Steam's canonical title
          g.matched_from_name = true          // (cracked copy keeps is_cracked = 1)
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, toMatch.length) }, worker))

  // Mark which results are already in the library (after appid enrichment).
  for (const g of results) {
    g.alreadyInLibrary = existingPaths.has(g.install_path.toLowerCase()) ||
      (g.steam_app_id && existingAppIds.has(String(g.steam_app_id)))
  }

  // Re-point games that MOVED. A scan that finds a library game at a new path
  // used to just flag it "already in library" and walk away, leaving the dead
  // path in place — so a game you relocated stayed dimmed and unplayable no
  // matter how many times you rescanned. Match on appid (exact) or name, and
  // only ever rewrite a path that is genuinely gone from disk, so this can
  // never move a game that's sitting happily where it is.
  try {
    const fsx = require('fs')
    const rows = db.prepare('SELECT id, name, install_path, exe_name, steam_app_id FROM games').all()
    const setPath = db.prepare('UPDATE games SET install_path = ?, exe_name = COALESCE(?, exe_name), is_installed = 1 WHERE id = ?')
    const norm = (s) => String(s || '').trim().toLowerCase()
    const relocated = []

    for (const row of rows) {
      // Adopt a path for a game that has NONE as well as re-pointing one whose
      // path died. A game added from crack discovery arrives with an app id and
      // no exe (its unlocks are read by app id), so this is how a later scan
      // gives it an executable and makes it session-trackable.
      if (row.install_path && fsx.existsSync(row.install_path)) continue   // still there — leave alone
      const hit = results.find(g =>
        (row.steam_app_id && g.steam_app_id && String(g.steam_app_id) === String(row.steam_app_id)) ||
        norm(g.name) === norm(row.name))
      if (!hit || norm(hit.install_path) === norm(row.install_path)) continue
      setPath.run(hit.install_path, hit.exe_name || null, row.id)
      hit.relocatedGameId = row.id
      hit.alreadyInLibrary = true
      relocated.push(row.install_path
        ? `${row.name}: ${row.install_path} -> ${hit.install_path}`
        : `${row.name}: (no path) -> ${hit.install_path}`)
      broadcast('game:updated', row.id)
    }
    if (relocated.length) {
      logger.info(`scanner: re-pointed ${relocated.length} moved game(s)`, { moves: relocated })
    }
  } catch (e) {
    logger.warn('scanner: relocate pass failed', { message: e.message })
  }

  return results
})

// Map the scanner's detected launcher to the persisted `source` so the library
// shows a correct Steam/Epic/GOG/Xbox/EA/Ubisoft badge (not a generic "Manual").
const TYPE_TO_SOURCE = {
  Steam: 'steam', Epic: 'epic', GOG: 'gog',
  Xbox: 'xbox', EA: 'ea', Ubisoft: 'ubisoft', Cracked: 'cracked',
}

handle('scanner:addGames', async (games) => {
  const { downloadBanner } = require('./services/steamApi')
  const db = require('./db/database').getDb()

  // Re-check dedup at add time (the modal data could be stale)
  const existingRows = db.prepare('SELECT install_path, steam_app_id FROM games').all()
  const existingPaths = new Set(existingRows.filter(g => g.install_path).map(g => g.install_path.toLowerCase()))
  const existingAppIds = new Set(existingRows.filter(g => g.steam_app_id).map(g => String(g.steam_app_id)))

  const added = []
  const bannerJobs = []
  for (const g of (games || [])) {
    try {
      // Skip true duplicates
      if (g.install_path && existingPaths.has(g.install_path.toLowerCase())) continue
      if (g.steam_app_id && existingAppIds.has(String(g.steam_app_id))) continue

      const game = gamesQ.addGame({
        name: g.name,
        exe_name: g.exe_name || (g.steam_app_id ? `steam_${g.steam_app_id}.exe` : null),
        install_path: g.install_path || null,
        steam_app_id: g.steam_app_id || null,
        source: TYPE_TO_SOURCE[g.detected_type] || (g.steam_app_id ? 'steam' : 'manual'),
        is_cracked: g.is_cracked ? 1 : 0,
        is_installed: g.isInstalled === false ? 0 : 1,
        banner_url: g.steam_app_id
          ? `https://cdn.akamai.steamstatic.com/steam/apps/${g.steam_app_id}/library_600x900_2x.jpg`
          : null,
        banner_local_path: null,
      })
      added.push(game)
      if (game.steam_app_id) existingAppIds.add(String(game.steam_app_id))
      if (game.install_path) existingPaths.add(game.install_path.toLowerCase())

      // Download banner now so the library shows cover art immediately
      if (game.steam_app_id) {
        bannerJobs.push(
          downloadBanner(game.steam_app_id, game.id)
            .then(p => gamesQ.updateGame(game.id, { banner_local_path: p }))
            .catch(() => {})
        )
        // Steam store genres for auto-grouping — non-fatal on failure
        const { getStoreArt } = require('./services/steamApi')
        bannerJobs.push(
          getStoreArt(game.steam_app_id)
            .then(art => {
              if (art?.genres?.length) gamesQ.updateGame(game.id, { genres: JSON.stringify(art.genres) })
            })
            .catch(() => {})
        )
        const { fetchAndStoreAchievements } = require('./services/achievementSync')
        setImmediate(() => fetchAndStoreAchievements(game.id).catch(() => {}))
      } else {
        // No appid detected (Xbox/Epic/manual, or an unzipped/cracked game whose
        // folder had no steam_appid.txt) → auto-resolve the appid by name and
        // import the achievement list. For cracked games this stores manual_appid,
        // which the crack watcher and schema loader now use as a fallback — so
        // game3rb/AnkerGames-style unzipped games get achievement tracking too.
        const { autoImportSchemaByName } = require('./services/achievementSync')
        setImmediate(() => autoImportSchemaByName(game.id).catch(() => {}))
      }
    } catch (e) {
      logger.warn('scanner:addGames failed for one game', { message: e.message, name: g.name })
    }
  }
  if (bannerJobs.length) await Promise.allSettled(bannerJobs)
  if (added.length) broadcast('game:updated', null)
  return { added: added.length }
})

// Look up the Steam profile for the saved (or supplied) Steam ID + API key.
// Auto-detect the logged-in Steam account from Steam's local loginusers.vdf —
// no more typing the SteamID64 by hand. Picks the MostRecent account, falling
// back to the newest Timestamp when several are saved.
handle('steam:detectUser', () => require('./services/steamStatsWatcher').detectLoggedInUser())

// Real browser "Sign in with Steam" (OpenID) — fallback / account switching.
handle('steam:signIn', () => require('./services/steamOpenId').signIn())

// Store-page details (description, developers, screenshots) for the Upcoming popup.
handle('steam:storeDetails', (appId) => require('./services/steamApi').getStoreDetails(appId))

// Called when the Upcoming tab opens: warms the store-details cache for every
// upcoming game (so popups open instantly) AND backfills missing release dates
// — fixes released games (e.g. Dead Cells added long ago) sitting in "No date
// yet" forever. Serialized with a small delay to respect Steam's rate limits.
let _upcomingRefreshing = false
handle('gameList:refreshUpcomingInfo', async () => {
  if (_upcomingRefreshing) return { skipped: true }
  _upcomingRefreshing = true
  try {
    const { getStoreDetails } = require('./services/steamApi')
    const db = require('./db/database').getDb()
    const rows = db.prepare("SELECT id, steam_app_id, release_date, genres FROM game_list WHERE status = 'upcoming' AND steam_app_id IS NOT NULL").all()
    let filled = 0
    for (const row of rows) {
      const d = await getStoreDetails(row.steam_app_id)
      if (d) {
        if (!row.release_date && d.release_date) {
          gameListQ.updateGameListItem(row.id, { release_date: d.release_date })
          filled++
        }
        if ((!row.genres || row.genres === '[]') && d.genres?.length) {
          gameListQ.updateGameListItem(row.id, { genres: JSON.stringify(d.genres) })
        }
      }
      await new Promise(r => setTimeout(r, 250))
    }
    if (filled > 0) { bk(); broadcast('game:updated', null) }
    return { filled, checked: rows.length }
  } finally {
    _upcomingRefreshing = false
  }
})

// Returns persona name and avatar so the user can confirm the right account is loaded.
handle('steam:getProfile', async (overrides) => {
  const { getPlayerSummary } = require('./services/steamApi')
  const apiKey  = overrides?.apiKey  ?? settingsQ.getSetting('steam_api_key')
  const steamId = overrides?.steamId ?? settingsQ.getSetting('steam_user_id')
  if (!apiKey)  return { ok: false, reason: 'no_api_key' }
  if (!steamId) return { ok: false, reason: 'no_steam_id' }
  const profile = await getPlayerSummary(apiKey, steamId)
  if (!profile) return { ok: false, reason: 'not_found' }
  return { ok: true, profile }
})

// Re-download banners for all Steam games at 2x quality, plus re-resolve the
// remote cover URLs for Game List rows. Progress lives in main-process state so
// the Settings tab can leave/return mid-run and still show the live counter.
const bannerRefreshState = { running: false, done: 0, total: 0 }
handle('banners:refreshStatus', () => ({ ...bannerRefreshState }))
handle('steam:refreshAllBanners', async () => {
  if (bannerRefreshState.running) return { alreadyRunning: true }

  const { refreshBanners, resolveBannerUrl } = require('./services/steamApi')
  const db = require('./db/database').getDb()
  const games = db.prepare('SELECT id FROM games WHERE steam_app_id IS NOT NULL').all()
  const listRows = db.prepare('SELECT id, steam_app_id FROM game_list WHERE steam_app_id IS NOT NULL').all()

  bannerRefreshState.running = true
  bannerRefreshState.done = 0
  bannerRefreshState.total = games.length + listRows.length
  broadcast('banners:refreshProgress', { ...bannerRefreshState })

  let upgraded = 0
  const queue = [
    ...games.map(g => ({ kind: 'game', id: g.id })),
    ...listRows.map(r => ({ kind: 'list', id: r.id, appId: r.steam_app_id })),
  ]
  async function worker() {
    for (;;) {
      const job = queue.shift()
      if (!job) return
      try {
        if (job.kind === 'game') {
          await refreshBanners(job.id)
        } else {
          const url = await resolveBannerUrl(job.appId)
          if (url) gameListQ.updateGameListItem(job.id, { banner_url: url })
        }
        upgraded++
      } catch {}
      bannerRefreshState.done++
      broadcast('banners:refreshProgress', { ...bannerRefreshState })
    }
  }
  // Small parallelism — 3 workers keep it much faster than the old sequential
  // loop without hammering Steam's CDN/rate limits.
  await Promise.all([worker(), worker(), worker()])

  bannerRefreshState.running = false
  broadcast('banners:refreshProgress', { ...bannerRefreshState })
  bk()
  broadcast('game:updated', null)
  return { upgraded }
})

// ── App system settings (startup, minimize) ───────────────────────────────────
const TASK_NAME = 'KoZo_AutoStart'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

// Every Run-key value that could be KoZo, found by ENUMERATING the key rather
// than guessing names.
//
// This is why "turn startup off" didn't work: Electron names the Run value after
// the AppUserModelID when one is set, so the real entry was
// `com.kozo.gametracker`, while the cleanup only ever tried deleting "KoZo" and
// app.getName(). It also verified only the registry, never Task Scheduler, so it
// happily reported success while the entry sat there and the app kept starting.
// Names differ between dev and packaged builds too (electron.app.* forms), so
// matching on a fixed list can never be reliable — read what's actually there.
function findRunEntries() {
  const { app } = require('electron')
  const { execSync } = require('child_process')
  const out = []
  let raw = ''
  try { raw = execSync(`reg query "${RUN_KEY}"`, { encoding: 'utf8', stdio: 'pipe' }) } catch { return out }

  const selfExe  = String(process.execPath || '').toLowerCase()
  const selfPath = String(app.getAppPath?.() || '').toLowerCase()
  const knownNames = new Set([
    'kozo', String(app.getName?.() || '').toLowerCase(),
    'com.kozo.gametracker',                        // the AppUserModelID (main.js)
    'electron.app.kozo', 'electron.app.electron',  // Electron's default naming
  ].filter(Boolean))

  for (const line of raw.split(/\r?\n/)) {
    // "    <name>    REG_SZ    <data>"
    const m = line.match(/^\s{4}(.+?)\s{4,}REG_[A-Z_]+\s{4,}(.*)$/)
    if (!m) continue
    const name = m[1].trim()
    const data = String(m[2] || '').toLowerCase()
    const isOurs =
      knownNames.has(name.toLowerCase()) ||
      (selfExe && data.includes(selfExe)) ||
      (selfPath && data.includes(selfPath)) ||
      /\bkozo\.exe/.test(data)
    if (isOurs) out.push(name)
  }
  return out
}

function hasScheduledTask() {
  try {
    require('child_process').execSync(`schtasks /query /tn "${TASK_NAME}"`, { stdio: 'ignore' })
    return true
  } catch { return false }
}

handle('app:getStartup', () => {
  // Report the union of both mechanisms. Checking only one is how the toggle
  // ended up disagreeing with what Windows actually does at boot.
  const task = hasScheduledTask()
  const runValues = findRunEntries()
  return {
    openAtLogin: task || runValues.length > 0,
    method: task ? 'task_scheduler' : (runValues.length ? 'registry' : 'none'),
    entries: runValues,
  }
})

handle('app:setStartup', (enable) => {
  const { app } = require('electron')
  const { execSync } = require('child_process')

  // In a packaged build process.execPath is KoZo.exe → launching it bare starts
  // the app. In dev it is electron.exe, and launching THAT bare opens Electron's
  // default "run a local app" welcome window (a confusing ghost window at boot).
  // So in dev we must also pass the app directory as an argument.
  const execPath = process.execPath
  const launchArgs = app.isPackaged ? [] : [app.getAppPath()]

  if (!enable) {
    // Remove EVERY entry that is actually there, then verify BOTH mechanisms.
    // The old version guessed at value names and only re-checked the registry,
    // so a surviving scheduled task — or a Run value under a name it didn't
    // guess — reported "off" while Windows kept starting the app.
    try { execSync(`schtasks /delete /tn "${TASK_NAME}" /f`, { stdio: 'pipe' }) } catch {}
    try { app.setLoginItemSettings({ openAtLogin: false, path: execPath, args: launchArgs }) } catch {}
    for (const name of findRunEntries()) {
      try { execSync(`reg delete "${RUN_KEY}" /v "${name}" /f`, { stdio: 'pipe' }) } catch {}
    }

    const stillTask = hasScheduledTask()
    const stillRun  = findRunEntries()
    const stillOn   = stillTask || stillRun.length > 0
    if (stillOn) {
      logger.warn('app:setStartup(false): entries survived removal', { task: stillTask, run: stillRun })
    }
    return {
      ok: !stillOn,
      openAtLogin: stillOn,
      // A scheduled task created with /rl HIGHEST can need elevation to delete;
      // say so instead of silently claiming success.
      error: stillOn
        ? (stillTask
            ? 'A Windows scheduled task for KoZo could not be removed — it may need administrator rights.'
            : `Windows startup entries could not be removed: ${stillRun.join(', ')}`)
        : undefined,
    }
  }

  // Try Task Scheduler — works even when app runs as admin, no UAC at boot.
  try {
    // The /tr value is "<exe>" "<arg>" — each path independently quoted, with the
    // surrounding schtasks quotes escaped.
    const tr = [execPath, ...launchArgs].map(p => `\\"${p.replace(/"/g, '')}\\"`).join(' ')
    execSync(
      `schtasks /create /tn "${TASK_NAME}" /tr "${tr}" /sc ONLOGON /rl HIGHEST /f`,
      { stdio: 'pipe', timeout: 5000 }
    )
    return { ok: true, method: 'task_scheduler' }
  } catch (taskErr) {
    // Fall back to the standard Electron registry approach
    try {
      app.setLoginItemSettings({ openAtLogin: true, path: execPath, args: launchArgs })
      return { ok: true, method: 'registry' }
    } catch (regErr) {
      return { ok: false, error: regErr.message }
    }
  }
})

handle('app:getStartMinimized', () => {
  const settingsQ = require('./db/queries/settings')
  return settingsQ.getSetting('start_minimized') === '1'
})

handle('app:setStartMinimized', (enable) => {
  const settingsQ = require('./db/queries/settings')
  settingsQ.setSetting('start_minimized', enable ? '1' : '0')
  return true
})

// ── Folder picker ──────────────────────────────────────────────────────────────
handle('dialog:pickFolder', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    title: 'Select a folder',
    properties: ['openDirectory'],
  }
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (result.canceled || !result.filePaths?.[0]) return null
  return result.filePaths[0]
})

// ── Overlay window ────────────────────────────────────────────────────────────
handle('overlay:hide', () => {
  try { require('./overlayWindow').hideOverlay() } catch {}
  return true
})

// The achievement-list toast went away — by its safety timeout, a click, or the
// X. Alt+Down / Alt+Up are only bound while it's on screen (they're far too
// common to hold globally), so this is what releases them. Must fire for EVERY
// close route, not just the hotkey one.
handle('overlay:achListClosed', () => {
  try { require('./services/achievementListFlash').markClosed() } catch {}
  return true
})

// The overlay renderer calls this once its listeners are attached so queued
// messages flush safely (avoids a load-vs-listener race that dropped toasts).
handle('overlay:ready', () => {
  try { require('./overlayWindow').markReady() } catch {}
  return true
})

// Renderer toggles click capture as the cursor enters/leaves a toast, so the
// overlay only intercepts clicks over a toast and stays click-through elsewhere.
handle('overlay:setInteractive', (interactive) => {
  try { require('./overlayWindow').setInteractive(!!interactive) } catch {}
  return true
})

// Push a live accent change to the overlay window so its toasts match the app.
handle('overlay:applyAccent', (hex) => {
  try { require('./overlayWindow').applyAccent(hex) } catch {}
  return true
})

// "Add to library" on the overlay's New-Game-Detected notification: bring the
// main window to the front and hand the exe to its add-game flow (the renderer
// prefills the Add modal from this event).
handle('overlay:addUnknownGame', (data) => {
  // getOrCreateMainWindow (not a getAllWindows() scan) — the main window may
  // have been unloaded while sitting hidden in the tray to save RAM, and this
  // click comes from the OVERLAY window, which is always alive independently
  // of it. Recreates on demand and waits for it to finish loading before the
  // renderer's prefill listener could possibly miss the send.
  require('./main').getOrCreateMainWindow((win) => {
    win.webContents.send('unknown-process:add', data || {})
  })
  return true
})

// Fire a sample achievement so the user can verify the overlay + in-app toast
// work, independent of Steam (used by the Settings "Test notification" button).
handle('overlay:test', () => {
  const payload = {
    gameId: 0,
    gameName: 'KoZo',
    achievements: [{
      display_name: 'It works!',
      description: 'Your achievement notifications are set up correctly.',
      icon_url: null,
    }],
  }
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send('achievement:unlocked', payload)
  })
  const ow = require('./overlayWindow')
  try { ow.sendAchievements(payload) } catch {}
  // Also preview the session toast with cover art (first game that has one).
  try {
    const g = require('./db/database').getDb()
      .prepare('SELECT name, banner_local_path, banner_url FROM games WHERE banner_local_path IS NOT NULL OR banner_url IS NOT NULL LIMIT 1').get()
    if (g) ow.sendSessionStarted({ gameName: g.name, gameId: 0, artPath: g.banner_local_path || null, artUrl: g.banner_url || null })
  } catch {}
  return true
})

// ── Auto-backup config ────────────────────────────────────────────────────────

// ── Backup / Restore (Import) ─────────────────────────────────────────────────
// The "always-synced" auto-backup (services/autoBackup.js) IS the export now —
// it keeps kozo-autobackup.json current. Restores from any such file — via the
// file picker (backup:import) or straight from the sync folder (sync:restore).
async function importBackupFile(filePath) {
  const db = require('./db/database').getDb()
  const fs = require('fs')

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (data.app !== 'kozo' || !Array.isArray(data.games)) throw new Error('Not a valid KoZo backup file')

  // Build safe upsert for each table using only columns that exist in the current schema
  function getColSet(tableName) {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name))
  }

  function upsertRows(tableName, rows) {
    if (!rows?.length) return 0
    const cols = getColSet(tableName)
    const useCols = Object.keys(rows[0]).filter(c => cols.has(c))
    if (!useCols.length) return 0
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO ${tableName} (${useCols.join(', ')}) VALUES (${useCols.map(() => '?').join(', ')})`
    )
    let n = 0
    for (const row of rows) { try { stmt.run(useCols.map(c => row[c] ?? null)); n++ } catch {} }
    return n
  }

  const TABLES = ['categories', 'games', 'game_list', 'custom_lists', 'custom_list_games', 'sessions', 'achievements', 'achievement_unlocks', 'settings']
  const counts = {}
  const doImport = db.transaction(() => {
    for (const t of TABLES) counts[t] = upsertRows(t, data[t])
  })
  doImport()

  broadcast('game:updated', null)

  // A backup only exports DB rows, never the local `banners` image files those
  // rows' banner_local_path points at — on a fresh machine/reinstall those
  // files never existed, so covers would render blank. Repair silently in the
  // background: clear any stale local path (falls back to the remote banner_url
  // immediately) and re-download it for Steam games, same as `steam:refreshAllBanners`.
  setImmediate(async () => {
    try {
      const { refreshBanners, runGenreBackfill } = require('./services/steamApi')

      // Portrait banners (Library/Sessions cards)
      const bannerRows = db.prepare(
        "SELECT id, banner_local_path FROM games WHERE steam_app_id IS NOT NULL AND banner_local_path IS NOT NULL"
      ).all()
      const staleBanner = bannerRows.filter(r => !fs.existsSync(r.banner_local_path))
      if (staleBanner.length) {
        const clearStmt = db.prepare('UPDATE games SET banner_local_path = NULL WHERE id = ?')
        for (const r of staleBanner) clearStmt.run(r.id)
      }

      // Hero banners (GameDetail / Profile showcase backdrop)
      const heroRows = db.prepare(
        "SELECT id, hero_local_path FROM games WHERE steam_app_id IS NOT NULL AND hero_local_path IS NOT NULL"
      ).all()
      const staleHero = heroRows.filter(r => !fs.existsSync(r.hero_local_path))
      if (staleHero.length) {
        const clearStmt = db.prepare('UPDATE games SET hero_local_path = NULL WHERE id = ?')
        for (const r of staleHero) clearStmt.run(r.id)
      }

      // Profile avatar/banner images live outside the DB — clear stale paths so
      // the Profile page shows initials/gradient instead of a broken image.
      for (const key of ['profile_avatar_path', 'profile_banner_path']) {
        const p = settingsQ.getSetting(key)
        if (p && !fs.existsSync(p)) settingsQ.setSetting(key, '')
      }

      const staleIds = [...new Set([...staleBanner, ...staleHero].map(r => r.id))]
      if (staleIds.length) {
        broadcast('game:updated', null)   // remote banner_url fallback shows immediately
        for (const id of staleIds) {
          try { await refreshBanners(id) } catch (e) { logger.warn(`Post-restore banner repair failed for game ${id}`, { message: e.message }) }
        }
        broadcast('game:updated', null)
      }
      await runGenreBackfill()
    } catch (e) {
      logger.warn('Post-restore repair pass failed', { message: e.message })
    }
  })

  return {
    games: counts.games || 0,
    sessions: counts.sessions || 0,
    achievements: counts.achievements || 0,
    gameList: counts.game_list || 0,
  }
}

handle('backup:import', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showOpenDialog(win, {
    title: 'Import KoZo backup',
    filters: [{ name: 'KoZo Backup', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (res.canceled || !res.filePaths?.[0]) return null
  return importBackupFile(res.filePaths[0])
})

// ── Sync folder ("sign in" without an account) ───────────────────────────────
// Point KoZo's app-data auto-backup + game-save backups at one folder — put it
// inside OneDrive/Google Drive/Dropbox and everything follows the user to any
// PC. Restore = read the auto-backup JSON straight from that folder.
handle('sync:setup', async () => {
  const fs = require('fs')
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a sync folder (put it inside OneDrive / Google Drive / Dropbox)',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths?.[0]) return null

  const folder = res.filePaths[0]
  const appDataDir = path.join(folder, 'app-data')
  const savesDir = path.join(folder, 'saves')
  fs.mkdirSync(appDataDir, { recursive: true })
  fs.mkdirSync(savesDir, { recursive: true })

  // Existing save backups follow the user into the sync folder — otherwise they
  // silently disappear from every game's Save Manager (old folder still has them,
  // nothing reads it anymore).
  const saveBackup = require('./services/saveBackup')
  const oldSavesRoot = saveBackup.rootPath()

  settingsQ.setSetting('sync_folder', folder)
  settingsQ.setSetting('auto_backup_dir', appDataDir)
  settingsQ.setSetting('saves_backup_dir', savesDir)
  settingsQ.setSetting('auto_backup_enabled', '1')
  settingsQ.setSetting('auto_save_backup_enabled', '1')
  saveBackup.migrateRoot(oldSavesRoot, savesDir)
  // force: the user just picked a folder and expects a file to appear in it,
  // so this one bypasses the "don't write while a game is running" gate.
  require('./services/autoBackup').writeNow({ force: true })
  return getSyncStatus()
})

function getSyncStatus() {
  const fs = require('fs')
  const folder = settingsQ.getSetting('sync_folder')
  if (!folder) return { configured: false }
  const jsonPath = path.join(settingsQ.getSetting('auto_backup_dir') || path.join(folder, 'app-data'), 'kozo-autobackup.json')
  let lastBackupAt = null
  try { lastBackupAt = fs.statSync(jsonPath).mtime.toISOString() } catch {}
  return { configured: true, folder, lastBackupAt, hasBackup: lastBackupAt != null }
}

handle('sync:status', () => getSyncStatus())

handle('sync:restore', async () => {
  const fs = require('fs')
  const dir = settingsQ.getSetting('auto_backup_dir')
  if (!dir) return { error: 'not_configured' }
  const jsonPath = path.join(dir, 'kozo-autobackup.json')
  if (!fs.existsSync(jsonPath)) return { error: 'no_backup_found' }
  return importBackupFile(jsonPath)
})

// ── Stats ─────────────────────────────────────────────────────────────────────
handle('stats:get', (period) => {
  const db = require('./db/database').getDb()
  const now = Date.now()
  const periodMs = {
    '1d': 86400000,
    '7d': 7 * 86400000,
    '30d': 30 * 86400000,
  }
  const since = period === 'all'
    ? new Date(0).toISOString()
    : new Date(now - (periodMs[period] || 7 * 86400000)).toISOString()

  const playtime = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds), 0) AS seconds FROM sessions
    WHERE ended_at IS NOT NULL AND started_at >= ?
  `).get(since)

  const topGames = db.prepare(`
    SELECT g.id, g.name, g.banner_local_path, SUM(s.duration_seconds) AS seconds
    FROM sessions s JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NOT NULL AND s.started_at >= ?
    GROUP BY g.id ORDER BY seconds DESC LIMIT 5
  `).all(since)

  const dailyActivity = db.prepare(`
    SELECT DATE(started_at) AS day, SUM(duration_seconds) AS seconds
    FROM sessions WHERE ended_at IS NOT NULL AND started_at >= ?
    GROUP BY day ORDER BY day ASC
  `).all(since)

  // Hourly breakdown of TODAY (local time) — drives the 24h view so it shows a
  // real hour-by-hour chart instead of a lonely single day bar.
  const hourlyActivity = db.prepare(`
    SELECT CAST(strftime('%H', started_at, 'localtime') AS INTEGER) AS hour,
           SUM(duration_seconds) AS seconds
    FROM sessions
    WHERE ended_at IS NOT NULL AND DATE(started_at, 'localtime') = DATE('now', 'localtime')
    GROUP BY hour
  `).all()

  const longestSessions = db.prepare(`
    SELECT s.id, s.duration_seconds, g.name AS game_name, g.banner_local_path, s.started_at
    FROM sessions s JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NOT NULL AND s.started_at >= ?
    ORDER BY s.duration_seconds DESC LIMIT 5
  `).all(since)

  const sessionCount = db.prepare(`
    SELECT COUNT(*) AS count FROM sessions WHERE ended_at IS NOT NULL AND started_at >= ?
  `).get(since)

  const gamesPlayedCount = db.prepare(`
    SELECT COUNT(DISTINCT game_id) AS count FROM sessions WHERE ended_at IS NOT NULL AND started_at >= ?
  `).get(since)

  const recentAchievements = db.prepare(`
    SELECT a.display_name, a.icon_url, g.name AS game_name, au.unlocked_at
    FROM achievement_unlocks au
    JOIN achievements a ON a.id = au.achievement_id
    JOIN games g ON g.id = a.game_id
    WHERE au.unlocked_at >= ?
    ORDER BY au.unlocked_at DESC LIMIT 5
  `).all(since)

  // Period-filtered unlock count so the "Unlocked" stat card shows how many
  // were unlocked in the selected period, not all time.
  const unlockedInPeriod = period === 'all'
    ? db.prepare(`SELECT COUNT(DISTINCT achievement_id) AS n FROM achievement_unlocks`).get().n
    : db.prepare(`SELECT COUNT(DISTINCT achievement_id) AS n FROM achievement_unlocks WHERE unlocked_at >= ? AND unlocked_at IS NOT NULL`).get(since).n
  const achievementCounts = {
    unlocked: unlockedInPeriod || 0,
    total: (achievementsQ.getAchievementCounts()?.total) || 0,
  }
  const weeklyPlaytime = sessionsQ.getWeeklyPlaytime()

  return {
    playtime, topGames, dailyActivity, hourlyActivity, longestSessions,
    achievementCounts, weeklyPlaytime,
    sessionCount, gamesPlayedCount, recentAchievements,
  }
})

// Drill-down for one calendar day (clicked in the Daily Activity chart).
// `day` is a UTC YYYY-MM-DD key (same basis as dailyActivity's DATE(started_at)).
handle('stats:dayActivity', (day) => {
  const db = require('./db/database').getDb()

  // Per-game playtime + session count for that day.
  const games = db.prepare(`
    SELECT g.id, g.name, g.banner_local_path, g.source, g.is_cracked,
           SUM(s.duration_seconds) AS seconds, COUNT(*) AS sessions
    FROM sessions s JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NOT NULL AND DATE(s.started_at) = ?
    GROUP BY g.id ORDER BY seconds DESC
  `).all(day)

  const totalSeconds = games.reduce((a, g) => a + (g.seconds || 0), 0)

  // Achievements unlocked that day.
  const achievements = db.prepare(`
    SELECT a.display_name, a.icon_url, g.name AS game_name, au.unlocked_at
    FROM achievement_unlocks au
    JOIN achievements a ON a.id = au.achievement_id
    JOIN games g ON g.id = a.game_id
    WHERE au.unlocked_at IS NOT NULL AND DATE(au.unlocked_at) = ?
    ORDER BY au.unlocked_at DESC
  `).all(day)

  // Individual sessions that day, longest first (for the Longest Sessions panel).
  const sessions = db.prepare(`
    SELECT s.id, s.duration_seconds, g.name AS game_name, s.started_at
    FROM sessions s JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NOT NULL AND DATE(s.started_at) = ?
    ORDER BY s.duration_seconds DESC LIMIT 8
  `).all(day)

  return { day, totalSeconds, games, achievements, sessions }
})

// Drill-down for one hour of TODAY (clicked in the 24h Hourly Activity chart).
// `hour` is a local-time hour 0–23 (same basis as hourlyActivity's strftime
// '%H','localtime'). Mirrors stats:dayActivity so the lower panels re-scope the
// same way they do for a clicked day.
handle('stats:hourActivity', (hour) => {
  const db = require('./db/database').getDb()
  const h = String(hour).padStart(2, '0')

  const games = db.prepare(`
    SELECT g.id, g.name, g.banner_local_path, g.source, g.is_cracked,
           SUM(s.duration_seconds) AS seconds, COUNT(*) AS sessions
    FROM sessions s JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NOT NULL
      AND DATE(s.started_at, 'localtime') = DATE('now', 'localtime')
      AND strftime('%H', s.started_at, 'localtime') = ?
    GROUP BY g.id ORDER BY seconds DESC
  `).all(h)

  const totalSeconds = games.reduce((a, g) => a + (g.seconds || 0), 0)

  const achievements = db.prepare(`
    SELECT a.display_name, a.icon_url, g.name AS game_name, au.unlocked_at
    FROM achievement_unlocks au
    JOIN achievements a ON a.id = au.achievement_id
    JOIN games g ON g.id = a.game_id
    WHERE au.unlocked_at IS NOT NULL
      AND DATE(au.unlocked_at, 'localtime') = DATE('now', 'localtime')
      AND strftime('%H', au.unlocked_at, 'localtime') = ?
    ORDER BY au.unlocked_at DESC
  `).all(h)

  const sessions = db.prepare(`
    SELECT s.id, s.duration_seconds, g.name AS game_name, s.started_at
    FROM sessions s JOIN games g ON g.id = s.game_id
    WHERE s.ended_at IS NOT NULL
      AND DATE(s.started_at, 'localtime') = DATE('now', 'localtime')
      AND strftime('%H', s.started_at, 'localtime') = ?
    ORDER BY s.duration_seconds DESC LIMIT 8
  `).all(h)

  return { hour, totalSeconds, games, achievements, sessions }
})

// ── XP / Level system ─────────────────────────────────────────────────────────
// The computation lives in services/xp.js (shared with xpTracker, which detects
// level-ups after sessions/unlocks/finishes). These handlers just delegate.
handle('stats:xp', () => require('./services/xp').computeXp())
handle('stats:xpHistory', (limit) => require('./services/xp').xpHistory(limit || 25))
