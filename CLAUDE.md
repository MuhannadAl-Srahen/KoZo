# KoZo — project map for Claude

Local-first Windows game tracker: Electron 41 (main, CommonJS) + React 19 / Vite 8 (renderer, ESM) + better-sqlite3. Tracks playtime, sessions and achievements (Steam + cracked-game emulators), with a game overlay. Read this first; open only the files a task needs.

## Commands
- `npm run dev`: Vite on :5173 + Electron (`concurrently`). Electron runs through `scripts/dev-electron.js`, which restarts it (clean quit via the `kozo:dev-restart` IPC message) whenever a file in `electron/` changes, so main/preload edits always apply.
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
| controllerInput | PowerShell XInput probe, so controller play doesn't count as AFK. AFK (`idle_pause_min`, default 5) is applied in `processWatcher.heartbeatSession`: the tick that first flags AFK subtracts the whole quiet span since the last input, not only the part past the threshold. |
| controllerWake | Always-on PowerShell XInput loop (120 ms): View + Menu held 1s calls `showFromAnywhere({ gamepad: true })` in main.js (also bound to Ctrl+Shift+K), which brings KoZo to front and sends `gamepad:wake`. |
| appUpdater | electron-updater: broadcasts `app:update` state for `UpdateBanner`, and `app:whatsNew` shows release notes once after an update. |
| trackingSelfTest, notifications | Settings → "Test achievement tracking"; notifications is a no-op. |

## Renderer
| Route | Page |
|---|---|
| `/` | Library |
| `/game/:id` | GameDetail |
| `/game-list` | GameList (paged, 20 per page) |
| `/plan` | PlayPlan: month board with lanes Up next / Playing / Done (drag across lanes sets the status; Done = finished, which opens the rating), progress and hours this month (`gameList:planBoard`), coming months and past recap (`gameList:planSummary`); drag a card onto a month chip to re-plan |
| `/finished` | Finished (Library + Game List finished games by year, with ratings; `games:finished`); a card opens `FinishedGameModal` (stats, rating, game page, Play again) |
| `/upcoming` | Upcoming = `components/SteamCalendar.jsx` only (data from `steam:comingSoon`). Layouts Steam (default, day columns from today), Strip, Week, Month; TBA and Tracked shelves; "Picked for you" keeps 4 per day scored by taste (`steam:tasteProfile` + GetItems tag ids) and popularity (`wishRank`/`popRank`) |
| `/activity` | Activity: `?tab=overview` (Statistics), `sessions` (Sessions), `achievements` (AchievementsHub). `/statistics`, `/sessions`, `/achievements` redirect here |
| `/profile` | Profile |
| `/settings` | Settings (tabs) |

- Pages keep **module-level caches** (`libraryCache`, `pageCache`, `profileCache`, `*TabCache`) so a revisit paints instantly, then refetch. Invalidate them when you change data.
- Live updates come from `window.kozo.events.on*` inside `useEffect`. Always return the unsubscribe.
- Window-level custom events: `kozo:profile-updated`, `kozo:show-onboarding`.

**Reuse before writing new code**
- `components/ui/Modal.jsx`: renders into `<body>`, Escape closes the top modal only, `onRequestClose` for "unsaved changes?" guards. Use its exported `modalStyles` for footer buttons.
- `ui/InfoModal` instead of `alert()`.
- `ui/SearchableSelect` for every dropdown.
- `ui/ContextMenu` for right-click menus (cover header, rows, `sub` flyouts, `confirm` rows; pages build their own items). `ui/CardContextMenu` wraps it for Library/Game List cards.
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
- Release tracking is `game_list.release_watch` (not the status); a game released over 14 days ago is never watched or announced (`releaseWatch.isLongReleased`): Track / status Upcoming set it, other statuses keep it, `gameList:untrack` clears it (deleting the row only if still Upcoming). releaseWatch selects `release_watch = 1`.
- Marking a game Finished (statusSync `setGameStatus` or `gameList:update`) broadcasts `game:finished`; App.jsx opens `RateGameModal` (1 to 10, `gameList:rate`, stored on the Game List row).
- Ctrl + mouse wheel depends on the pointer: over a card grid (any element with the `useCardZoom` style, which always sets `--zoom-grid`) it resizes the cards; anywhere else, or over `[data-zoom-ignore]`, it changes the UI scale (`CtrlWheelZoom` in App.jsx, 80 to 150% in 5% steps). Ratings use `ui/RatingPicker` (fixed heights, hover from pointer x) in RateGameModal and FinishedGameModal.
- Library and Game List have only Big grid and List views; the month filter lives in Play Plan.
- The wallpaper (`Wallpaper` in App.jsx) is fixed behind the whole window; with it on, `.app-main` and the sidebar turn see-through.
- Resource rules (keep them): autoBackup only writes after `markDirty()` (30 min safety net); idle process scans relax 20s → 45s after 10 quiet minutes; the controller PowerShell probe starts at most once per session; in-session Steam Web API polls every 60s when `steamStatsWatcher.isWatching(game)`; Steam caches go through `capSet`; stored covers are shrunk to 600 px wide (`steamApi.shrinkCover`). Renderer: `html[data-inactive]` pauses every animation while KoZo is hidden or unfocused; gamepad polling starts only after the first `gamepadconnected`; no `backdrop-filter` on repeated chips; wide calendar art uses the 616px capsule (hero only for Featured).
- Remove from library offers Keep history (`games:archive`) or Delete with history (`games:delete`, accepts an id or array, also deletes the banner/hero files).
- Card grids size their columns from `--card-min` (Ctrl + mouse wheel via `lib/useCardZoom.js`, saved per page and view). Keep new grids on the same variable.
- `GeneratedCover` (name-hued gradient + icon, never text) renders ONLY when a card has no image or it failed to load; never stack it under real art. Dimmed cards use `filter`, not opacity.
- Demos/playtests have hidden store pages: `steamApi.parentArtAppId` strips the suffix and uses the full game's art (downloadBanner/downloadHero/resolveBannerUrl). `fillMissingArt` (ipc.js) retries coverless games on every launch when idle (Steam, then SteamGridDB by appid or name), throttled 3 days per game via setting `art_missing_tried`.
- Scan PC: `scanner:scan` runs `pcScanner.scanFolder` per root in a worker (`services/scanWorker.js`, falls back in-process), drops missing and nested roots, name-matches only games not in the library, and broadcasts `scanner:progress`.
- Library month filter = the Game List play plan: `listGamesWithStats` returns `planned_month` from the linked `game_list` row; `games:planMonth` creates the row if needed. Same `PlanMonthModal` as Game List.
- `preload.js` exposes `kozo.rev`; `UpdateBanner` (PRELOAD_REV) shows a "quit and reopen" bar when the main process is older than the UI. Bump both together whenever preload or IPC changes.
- Add Game / Add to Game List also search SteamGridDB (`sgdb:searchGames`) and list non-Steam hits with covers; the pick travels as `sgdb_id`/`sgdb_cover` to `addLibraryGame`. `applyArt` also sets the linked `game_list.banner_url`, and Game List rows expose `game_banner_local_path` as a cover fallback.
- Settings → Appearance customization lives in `context/AppearanceContext.jsx` (setting `appearance`, JSON): UI scale via `kozo.ui.setZoom` (preload webFrame), `data-density` / `data-corners` token overrides at the end of `styles/variables.css`, `data-hide-*` card-detail attributes (rules at the end of GameCard/GameList css), sidebar order + hidden tabs (`Sidebar.jsx` reads `prefs.nav`), start page (`StartPage` in App.jsx), wallpaper (`Wallpaper` in App.jsx, picked via `appearance:pickWallpaper`).
- Adult (18+) toggle is behind a password: `RestrictedContent` (Settings → About → Dev) compares a SHA-256 hash; turning it off never asks.
- Settings → Features rows are links: each `FEATURE_GROUPS` item has `go` (a route, `tab:<settings tab>`, or `overlay:test`). Library opens Scan PC on `/?scan=1` and Add Game on `/?add=1`.
- Add Game search ranks Steam + SteamGridDB hits together (`lib/searchRank.js`).
- `MediaGallery` shows the cached thumbnail first and fades the full image in, and preloads neighbours; calendar `Cover` shows a shimmer until art arrives and never crops wide-only art.
- Text fields draw focus rings inset (global.css) so scroll panels can't clip them. Card grids use container queries for small sizes.
- Non-Steam covers come from SteamGridDB (`services/steamGridDb.js`, key in setting `steamgriddb_key`, never backed up). Auto-applied on add and from Refresh images; Edit → Find cover (`CoverPickerModal`) lets the user pick. With no art at all, `GeneratedCover` draws a name-based poster under every card.
- Setting `show_adult_games` adds `ignore_preferences` + the age-gate cookie to Steam store search and the calendar feeds (`adultSearchOpts` in steamApi.js).
- First-run walkthrough = `components/Tour.jsx`: steps spotlight real controls tagged `data-tour="…"` (Library `scan-pc`/`add-game`/`library-stats`, sidebar `nav-*`, Game List `month-filter`, Upcoming `upcoming-tabs`). Renaming or removing a tagged control breaks its step. Store-style game popup = `components/SteamGameModal.jsx` (gallery via `ui/MediaGallery.jsx`).
- Controller: `lib/gamepadNav.js` drives every page (cards with `data-gpnav` plus normal focusables, scoped to the open menu or dialog). A select, B close/back, X right-click menu, Y search, LB/RB sidebar tabs, LT/RT in-page tabs, right stick scroll. The ring is the `data-gpfocus` attribute (React would wipe a class); `components/GamepadHints.jsx` shows the legend. Chromium's fake mousemoves on scroll must not count as mouse input.
- Games can start from a launcher file: `games.launch_file` (.bat/.cmd/.lnk) wins in `doLaunch`; `exe_name` stays the watched process. `dialog:pickExe` accepts launchers and returns `candidates` (.exe files nearby, `dialog:exeCandidates`); `ui/LauncherNote` shows the choice in Add/Edit Game and MakePlayableModal. Move to Library is quick (`addLibraryGame(..., { quick: true })`), never announces Finished, then App opens `MakePlayableModal` via the `kozo:make-playable` window event.
- App text never uses em/en dashes (user preference): write commas, colons or periods instead.
- Steam art: newer titles keep portrait/hero under hashed paths, so `steam/apps/<id>/library_600x900_2x.jpg` 404s. `steamApi.getAppAssets(appIds)` (IStoreBrowseService/GetItems, keyless, batched, cached 24h; IPC `steam:appAssets`) returns the real `portrait`/`hero`/`header`/`capsule` URLs. `downloadBanner`, `resolveBannerUrl` and `downloadHero` use it. Cards always `object-fit: cover`.
- Every library game has a Game List row: `gameListQ.ensureListRowForGame` runs from `addLibraryGame` (ipc.js, shared by `games:add` and `gameList:moveToLibrary`) and the Scan PC add path, plus a one-time startup backfill (setting `migrated_library_to_list`). Rows link by `game_id`, else Steam appid, else name, the same rules as `statusSync`.
- Games are never deleted from the UI: "Remove from library" sets `games.is_archived = 1` (`games:archive`/`games:unarchive`), so sessions, achievements and XP survive. Library shows finished/dropped, hidden and archived games in collapsible shelves. Launching an archived game un-archives it.
- The overlay is a separate BrowserWindow running the same bundle (`OverlayApp.jsx`). It queues messages until it calls `overlay:ready`.
- The tray popup is also a separate window (`electron/trayWindow.js` → `?tray=1` → `src/TrayApp.jsx`): right-click the tray icon. Data comes from `tray:data`, buttons go through `tray:action`. The native menu in `tray.js` is only a fallback.
- Game List sort is `is_favorite DESC`, then `display_order`, then the default order. Drag-reorder rewrites `display_order` for the whole filtered list.
- `games:add` only downloads banner art and genres when there's a `steam_app_id`.
- Settings `steam_api_key` and per-machine paths (`sync_folder`, `auto_backup_dir`, `saves_backup_dir`) are not exported to or restored from backups.
