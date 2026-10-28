# KoZo — project map for Claude

Local-first Windows game tracker: Electron 41 (main, CommonJS) + React 19 / Vite 8 (renderer, ESM) + better-sqlite3. Tracks playtime, sessions and achievements (Steam + cracked-game emulators), with a game overlay. Read this first; open only the files a task needs.

## Commands
- `npm run dev`: Vite on :5173 + Electron (`concurrently`).
- `npm run rebuild`: rebuild better-sqlite3 for Electron 41.7.1. Run it after `npm install` or the DB won't load.
- `npm run build`: `scripts/gen-icon.js`, then `vite build` (into `renderer-dist/`), then electron-builder (into `release/`).
- The builder config is `package.json` `"build"` (the only one; it sets the NSIS desktop shortcut and the GitHub publish target that electron-updater reads).
- `node scripts/test-parsers.js`: unit checks for the crack and achievement file parsers.
- CI: `.github/workflows/release.yml`. Runs on `v*` tags, using bun on windows-latest, and publishes a GitHub release that electron-updater reads.

## Layout
```
electron/            main process (CommonJS)
  main.js            boot, main window, kozo:// protocol, hotkeys, quit flush
  ipc.js             ALL ipcMain handlers (require-time registration)
  preload.js         contextBridge → window.kozo.api / window.kozo.events
  overlayWindow.js   transparent always-on-top overlay window (?overlay=1)
  tray.js, appIcon.js, logger.js
  db/database.js     open/recover DB, runMigrations()
  db/schema.sql      CREATE TABLE IF NOT EXISTS …
  db/queries/*.js    games, sessions, achievements, gameList, customLists, settings
  services/*.js      background services (see below)
src/                 renderer (React)
  main.jsx           ?overlay=1 → OverlayApp, else App
  App.jsx            HashRouter + Sidebar + global prompts/modals
  pages/  components/{ui,modals}/  context/  lib/  styles/
```

## Main process
**Boot (`main.js` `whenReady`):** register `kozo://`, then `initDatabase()`, then `require('./ipc')`, then `createWindow()`. After that it starts processWatcher and crackWatcher, registers the Alt+K / Alt+J hotkeys, and starts `autoBackup.startPeriodic()`. Delayed jobs are gated by `processWatcher.runWhenIdle` (they never run while a game is running): genre backfill, install check, privacy recheck, startup catch-up. Then releaseWatch, appUpdater, and the tray.
**Quit:** `will-quit` (and the window `session-end` event, for Windows shutdown) stops the watchers, flushes autoBackup and autoSaveBackup, then closes the DB.
**Main window** only hides on close, and is destroyed after 60s hidden to free RAM. Get it with `getOrCreateMainWindow()`; never keep a reference to it.

**IPC conventions**
- Channels are named `domain:action` (`games:add`, `steam:refresh`).
- Register a handler with `handle(channel, fn)` in `ipc.js`. It always resolves to `{ ok: true, data }` or `{ ok: false, error }` and never rejects, so renderer code must check `res?.ok`.
- Push events with `broadcast(channel, payload)`, which goes to all windows.
- **Adding an API = a handler in `ipc.js` + a method in `preload.js`** (`api.<domain>.<method>` → `ipcRenderer.invoke`). Event subscriptions are `events.onX(cb)` and return their own unsubscribe function.

**Database:** `%APPDATA%\KoZo\kozo.db`, WAL, `foreign_keys=ON`. Logs go to `%APPDATA%\KoZo\logs`.
- Tables: games, sessions, achievements, achievement_unlocks, game_list, custom_lists, custom_list_games, settings (key/value), scan_folders, categories (legacy).
- Migrations have no version number. `runMigrations()` runs `ALTER TABLE … ADD COLUMN` statements in try/catch, plus one-time steps guarded by flags stored in settings. **New column → add it as an `ALTER TABLE … ADD COLUMN` in `runMigrations()`** (`schema.sql` holds only the original columns).
- better-sqlite3 refuses JS booleans, so flags must be 0/1 (`flag()` in `queries/games.js`). Named params (`@x`) throw if the key is missing.

**Services (`electron/services/`)**

`processWatcher` is the hub. Every unlock source ends up in `achievementSync.emitNewUnlocks()`, which updates the DB, the overlay toast, XP and the backup. Disk-heavy work checks `processWatcher.isSessionActive()` first, or wraps itself in `runWhenIdle`.

| Service | Role |
|---|---|
| processWatcher | Polling loop: 5s while playing, 20s idle. Detects games, opens and ends sessions, AFK/idle pause, sleep gaps, crash recovery, unknown-exe prompt. Events: `session:*`. |
| achievementSync | Steam unlock sync: on launch, every 10s while playing, and on session end with retries. Achievement list (schema) fetch, private-profile state. |
| steamApi / steamOpenId | Steam Store and Web API (axios), banner download, genres; Steam login on a local 127.0.0.1 listener. |
| steamStatsWatcher, binaryKV | Read local `appcache\stats\UserGameStats_*.bin` (binary KeyValues format). |
| crackWatcher, crackDiscovery | Emulator achievement files (Goldberg, CODEX, …): chokidar per game, a 60s safety net, a deep scan when idle. |
| xp, xpTracker | XP is a pure function of the DB; the tracker emits `xp:levelup` and the overlay toast. |
| saveFinder, saveBackup, autoSaveBackup | Find save folders; manual backups are timestamped, auto backups keep two slots (`auto-latest` / `auto-prev`) under `saves_backup_dir`. |
| autoBackup | JSON dump of the DB tables to `auto_backup_dir`. Debounced after changes, every 5 min, and a synchronous flush on quit. |
| statusSync, installCheck | Keep game status and list status in step; update the installed flag and relocate moved games. |
| releaseWatch | Refreshes tracked upcoming games' Steam dates (delays), then flags released ones: overlay toast once, plus the `unseen_releases` setting behind the "Now out" panel (`ReleasedPanel`) and the Upcoming sidebar badge. Runs at startup, every 6h, and when the main window is shown. |
| statusFlash (Alt+K), achievementListFlash (Alt+J) | Overlay info panels. |
| controllerInput | PowerShell XInput probe, so controller play doesn't count as AFK. |
| appUpdater | electron-updater: broadcasts `app:update` state for `UpdateBanner`, and `app:whatsNew` shows release notes once after an update. |
| trackingSelfTest, notifications | Settings → "Test achievement tracking"; notifications is a no-op. |

## Renderer
| Route | Page |
|---|---|
| `/` | Library |
| `/game/:id` | GameDetail |
| `/game-list` | GameList (paged, 20 per page) |
| `/achievements` | AchievementsHub |
| `/upcoming` | Upcoming (My upcoming + Steam calendar tab: `components/SteamCalendar.jsx`, data from `steam:comingSoon`) |
| `/sessions` | Sessions |
| `/statistics` | Statistics |
| `/profile` | Profile |
| `/settings` | Settings (tabs) |

- Pages keep **module-level caches** (`libraryCache`, `pageCache`, `profileCache`, `*TabCache`) so a revisit paints instantly, then refetch. Invalidate them when you change data.
- Live updates come from `window.kozo.events.on*` inside `useEffect`. Always return the unsubscribe.
- Window-level custom events: `kozo:profile-updated`, `kozo:show-onboarding`.

**Reuse before writing new code**
- `components/ui/Modal.jsx`: renders into `<body>`, Escape closes the top modal only, `onRequestClose` for "unsaved changes?" guards. Use its exported `modalStyles` for footer buttons.
- `ui/InfoModal` instead of `alert()`.
- `ui/SearchableSelect` for every dropdown.
- `ui/CardContextMenu` for right-click menus.
- `ui/Skeleton` (`CardSkeletonGrid`, `RowSkeleton`, …) and `ui/EmptyState`.
- `ui/RunningProcessPicker`.
- `lib/utils.js`:
  - `formatPlaytime` (returns `'—'` for 0, so it is truthy), `formatDate`, `formatDateTime`, `localDayKey` (use it to group by local day; don't slice ISO strings)
  - `fileUrl(path)` turns a local file into `kozo://local/…`
  - `parseGenres`, `getBannerBg`, `rarityLabel`, `isSteamTracked`, `deriveGameNameFromPath`, `timeAgo`
- `lib/cardModel.js`: `LIBRARY_STATUSES`, `LIST_STATUSES`, `sourceOf`, `accentOf`.
- `lib/gamepadNav.js`: add `data-gpnav` to make an element a controller target. "A" clicks it, or its `[data-gpclick]` child.
- `context/AccentColorContext.jsx`: `useAccentColor()`.

**Styling:** CSS Modules next to each component. Layout composes from `styles/page.module.css`, controls from `styles/controls.module.css`, surfaces from `styles/surface.module.css`. All tokens live in `styles/variables.css` (`--a` accent, `--status-*`, `--rarity-*`, `--sp-*`, `--r-*`, `--fs-*`, `--z-*`). For accent-derived colours use `color-mix(in srgb, var(--a) N%, transparent)`; never append hex alpha to a `var()`. No UI framework; icons come from `@tabler/icons-react`.

## Gotchas
- Card grids size their columns from `--card-min` (Ctrl + mouse wheel via `lib/useCardZoom.js`, saved per page and view). Keep new grids on the same variable.
- Non-Steam covers come from SteamGridDB (`services/steamGridDb.js`, key in setting `steamgriddb_key`, never backed up). Auto-applied on add and from Refresh images; Edit → Find cover (`CoverPickerModal`) lets the user pick. With no art at all, `GeneratedCover` draws a name-based poster under every card.
- Setting `show_adult_games` adds `ignore_preferences` + the age-gate cookie to Steam store search and the calendar feeds (`adultSearchOpts` in steamApi.js).
- First-run walkthrough = `components/Tour.jsx`: steps spotlight real controls tagged `data-tour="…"` (Library `scan-pc`/`add-game`/`library-stats`, sidebar `nav-*`, Game List `month-filter`, Upcoming `upcoming-tabs`). Renaming or removing a tagged control breaks its step. Store-style game popup = `components/SteamGameModal.jsx` (gallery via `ui/MediaGallery.jsx`).
- App text never uses em/en dashes (user preference): write commas, colons or periods instead.
- Steam art: newer titles keep portrait/hero under hashed paths, so `steam/apps/<id>/library_600x900_2x.jpg` 404s. `steamApi.getAppAssets(appIds)` (IStoreBrowseService/GetItems, keyless, batched, cached 24h; IPC `steam:appAssets`) returns the real `portrait`/`hero`/`header`/`capsule` URLs. `downloadBanner`, `resolveBannerUrl` and `downloadHero` use it. Cards always `object-fit: cover`.
- Every library game has a Game List row: `gameListQ.ensureListRowForGame` runs from `addLibraryGame` (ipc.js, shared by `games:add` and `gameList:moveToLibrary`) and the Scan PC add path, plus a one-time startup backfill (setting `migrated_library_to_list`). Rows link by `game_id`, else Steam appid, else name, the same rules as `statusSync`.
- Games are never deleted from the UI: "Remove from library" sets `games.is_archived = 1` (`games:archive`/`games:unarchive`), so sessions, achievements and XP survive. Library shows finished/dropped, hidden and archived games in collapsible shelves. Launching an archived game un-archives it.
- The overlay is a separate BrowserWindow running the same bundle (`OverlayApp.jsx`). It queues messages until it calls `overlay:ready`.
- The tray popup is also a separate window (`electron/trayWindow.js` → `?tray=1` → `src/TrayApp.jsx`): right-click the tray icon. Data comes from `tray:data`, buttons go through `tray:action`. The native menu in `tray.js` is only a fallback.
- Game List sort is `is_favorite DESC`, then `display_order`, then the default order. Drag-reorder rewrites `display_order` for the whole filtered list.
- `games:add` only downloads banner art and genres when there's a `steam_app_id`.
- Settings `steam_api_key` and per-machine paths (`sync_folder`, `auto_backup_dir`, `saves_backup_dir`) are not exported to or restored from backups.
