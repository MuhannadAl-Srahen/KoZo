# KoZo — project map for Claude

Local-first Windows game tracker: Electron 41 (main, CommonJS) + React 19 / Vite 8 (renderer, ESM) + better-sqlite3. Tracks playtime, sessions and achievements (Steam + cracked-game emulators), with a game overlay. Read this first; open only the files a task needs.

## Commands
- `npm run dev`: Vite on :5173 + Electron (`concurrently`). Electron runs through `scripts/dev-electron.js`, which restarts it (clean quit via the `kozo:dev-restart` IPC message) whenever a file in `electron/` changes, so main/preload edits always apply.
- `npm run rebuild`: rebuild better-sqlite3 for Electron 41.7.1. Run it after `npm install` or the DB won't load.
- `npm run build`: `scripts/gen-icon.js`, then `vite build` (into `renderer-dist/`), then electron-builder (into `release/`).
- The builder config is `package.json` `"build"` (the only one; it sets the NSIS desktop shortcut and the GitHub publish target that electron-updater reads).
- `node scripts/test-parsers.js`: unit checks for the crack and achievement file parsers, the Epic/GOG/Xbox parsers, Pick for me scoring and Discord (against a fake pipe).
- `npm test` = parsers + `vite build` + `electron scripts/smoke-test.js`: the real app on a throwaway profile (own userData, `KOZO_RENDERER=dist` loads `renderer-dist`): every page, right-click menus, narrow width, controller across page changes, Pick for me, Big Picture. CI runs it before publishing.
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
| discordPresence | Discord Rich Presence over the local pipe (no package), settings `discord_presence` + `discord_client_id` (the user's own Discord app). Driven by `processWatcher.onChange`; connects only while a session is active, retries at most once a minute. |
| launcherImport | Reads Epic manifests, the GOG registry (or `goggame-*.info`) and Xbox packages (`powershell.exe` Get-AppxPackage + MicrosoftGame.config). `launchers:scan`; on launch an idle background pass broadcasts `launchers:found` for the Library strip (`launcher_seen` = reviewed keys). |
| controllerWake | Always-on PowerShell XInput loop (120 ms): the combo in setting `pad_wake_combo` (Settings > Shortcuts: `guide` = Xbox button via XInputGetStateEx #100, default, falling back to LB + RB + Menu; `lbrbmenu`; `viewmenu`; `off`) held 1s calls `showFromAnywhere({ gamepad: true })`; `settings:set` restarts it via `setCombo` in main.js (also bound to Ctrl+Shift+K), which brings KoZo to front and sends `gamepad:wake`. |
| appUpdater | electron-updater: broadcasts `app:update` state for `UpdateBanner`, and `app:whatsNew` shows release notes once after an update. |
| trackingSelfTest, notifications | Settings → "Test achievement tracking"; notifications is a no-op. |

## Renderer
| Route | Page |
|---|---|
| `/` | Library |
| `/game/:id` | GameDetail |
| `/game-list` | GameList (paged, 20 per page) |
| `/plan` | PlayPlan: six views (toolbar switch, saved in localStorage `kozo:plan:view`): Timeline (months down a line, posters), Focus (one month, ‹ ›: the Playing game fills a hero with Play / Done, the numbered Up next queue beside it, Done strip below; dropping a game on the hero starts it), Board (one month as Up next / Playing / Done columns; drop on a column sets the state), Wall (a mosaic of Steam header art per month: Playing 2×2, Up next 2×1, Done 1×1), Roadmap (four months side by side, the first wide, ‹ › to shift) and List (a table per month). Each month shows its games in play order: Playing, Up next (numbered), Done (score). Drag onto a game in the same month = reorder (`display_order` via `gameList:reorderPage({ month })`) and take that game's state (Done = finished, opens the rating); onto another month = move it there. Earlier months and Not planned are folded at the bottom. Data: `gameList:planBoard` per month, `gameList:planSummary` |
| `/finished` | Finished (Library + Game List finished games by year, with ratings; `games:finished`); a card opens `FinishedGameModal` (stats, rating, game page, Play again) |
| `/upcoming` | Upcoming = `components/SteamCalendar.jsx` (data from `steam:comingSoon`) with `components/UpcomingHero.jsx` on top (most anticipated of the next 30 days, muted trailer loop from `storeDetails.trailer` = Steam's microtrailer, countdown; then a "This week" row). Layouts Steam (default, day columns from today, endless: a sentinel adds days, then loads more feed pages, MAX_PAGES 20), Strip, Week, Month; TBA and Tracked shelves. Dates come from GetItems `release` (`utils.storeRelease`: the real unlock moment on the LOCAL day; month/quarter/year stay vague), not the search page's US date. "Picked for you" = `lib/tasteMatch.js` over `steam:tasteProfile` (main: Game List rows weighted by rating/status + hours, Steam tags scaled by rarity, cleared on rate/status change): only games with match >= 35%, best 5 per day, match % badge and "Like <game>: tags" reason; All releases = top 8 by popularity per day |
| `/activity` | Activity: `?tab=overview` (Statistics), `sessions` (Sessions), `achievements` (AchievementsHub). `/statistics`, `/sessions`, `/achievements` redirect here |
| `/profile` | Profile |
| `/settings` | Settings, tabs grouped App (General, Appearance, Shortcuts: every keyboard shortcut and controller button, with a live "controller connected" line) / Games (Tracking, Accounts) / Data (Backups) / Help (Features, About); the tab lives in `?tab=<key>` (links can open one), old tab names `steam`/`scan` alias to `accounts`/`tracking`. Every setting saves as it changes (no Save buttons) |
| `/big` | BigPicture: full screen, no sidebar (`Shell` in App.jsx). Tabs Home / Library / Up next (LB/RB via `kozo:bp-tab`), search (Y). Home: hero follows `data-gpfocus`, rows Continue playing / Up next (+ Pick for me) / Favorites / Recently added. A opens the game screen `/big?game=<id>` (Play, Rate, achievements to unlock, recent sessions; B goes back). Play shows "Starting" until `session:detected/started` (then minimizes); when that session ends, `app:bringToFront` and a "Session done" card. `[data-gpautofocus]` marks where the controller ring lands. Sidebar, tray and the controller wake combo (`gamepad:wake` `{ bigPicture }`) open it |

- Pages keep **module-level caches** (`libraryCache`, `pageCache`, `profileCache`, `*TabCache`) so a revisit paints instantly, then refetch. Invalidate them when you change data.
- Live updates come from `window.kozo.events.on*` inside `useEffect`. Always return the unsubscribe.
- Window-level custom events: `kozo:profile-updated`, `kozo:show-onboarding`.

**Reuse before writing new code**
- `components/ui/Modal.jsx`: renders into `<body>`, Escape closes the top modal only, `onRequestClose` for "unsaved changes?" guards. Use its exported `modalStyles` for footer buttons.
- `ui/InfoModal` instead of `alert()`.
- `ui/SearchableSelect` for every dropdown (`clearable={false}` for sorts, which have nothing to clear to).
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
- Sessions under 60 s (`MIN_SESSION_SEC`, queries/sessions.js) are deleted with their playtime at end and in orphan recovery, and send `session:discarded` (no toast, XP or notification).
- Launch order in `doLaunch`: `launch_file`, then `launch_uri` (Epic URI / `shell:AppsFolder\...` for Xbox), then the exe, then Steam.
- Games start through `shellStart` (PowerShell Start-Process = ShellExecute), never a direct `spawn()`: a spawned game inherited KoZo's handles (sockets, pipes) and held them after KoZo quit.
- Settings → General → Graphics acceleration writes `gpu.json` in userData; main.js reads it before ready and calls `app.disableHardwareAcceleration()` (the fix for graphics drivers timing out with KoZo open). Big Picture minimizes KoZo after Play.
- Windows startup passes `--startup`; "Start minimized" applies only then (or uptime < 3 min). The task is created from XML (battery, no time limit, normal priority; HighestAvailable, falling back to LeastPrivilege). The one-time `startup_v2` upgrade runs only when packaged.
- Pick for me = `lib/pickForMe.js` (pure) + `PickForMeModal` (Game List toolbar, Big Picture): all Want to play rows, +1 weight when planned this month.
- Sidebar: Play / Discover group titles (only while the tab order keeps groups together), live Now Playing card with the game's art, XP ring on the avatar. Appearance `sidebar: 'full' | 'rail'` (slim, icons only); the button by the logo switches.
- Release tracking is `game_list.release_watch` (not the status); a game released over 14 days ago is never watched or announced (`releaseWatch.isLongReleased`): Track / status Upcoming set it, other statuses keep it, `gameList:untrack` clears it (deleting the row only if still Upcoming). releaseWatch selects `release_watch = 1`.
- Marking a game Finished (statusSync `setGameStatus` or `gameList:update`) broadcasts `game:finished`; App.jsx opens `RateGameModal` (1 to 10, `gameList:rate`, stored on the Game List row).
- Ctrl + mouse wheel depends on the pointer: over a card grid (any element with the `useCardZoom` style, which always sets `--zoom-grid`) it resizes the cards; anywhere else, or over `[data-zoom-ignore]`, it changes the UI scale (`CtrlWheelZoom` in App.jsx, 80 to 150% in 5% steps). Ratings use `ui/RatingPicker` (fixed heights, hover from pointer x) in RateGameModal and FinishedGameModal.
- Library and Game List have only Big grid and List views; the month filter lives in Play Plan.
- The wallpaper (`Wallpaper` in App.jsx) is fixed behind the whole window; with it on, `.app-main` and the sidebar turn see-through.
- Resource rules (keep them): autoBackup only writes after `markDirty()` (30 min safety net); idle process scans relax 20s → 45s after 10 quiet minutes; the controller PowerShell probe starts at most once per session; in-session Steam Web API polls every 60s when `steamStatsWatcher.isWatching(game)`; Steam caches go through `capSet`; stored covers are shrunk to 600 px wide (`steamApi.shrinkCover`). Renderer: `html[data-inactive]` pauses every animation while KoZo is hidden or unfocused (with a -60s delay, so one-shot fade-ins sit on their visible last frame instead of an invisible first one); gamepad polling starts only after the first `gamepadconnected`; no `backdrop-filter` on repeated chips; wide calendar art uses the 616px capsule (hero only for Featured).
- Remove from library offers Keep history (`games:archive`) or Delete with history (`games:delete`, accepts an id or array, also deletes the banner/hero files).
- Card grids size their columns from `--card-min` (Ctrl + mouse wheel via `lib/useCardZoom.js`, saved per page and view). Keep new grids on the same variable.
- `GeneratedCover` (name-hued gradient + icon, never text) renders ONLY when a card has no image or it failed to load; never stack it under real art. Dimmed cards use `filter`, not opacity.
- Demos/playtests have hidden store pages: `steamApi.parentArtAppId` strips the suffix and uses the full game's art (downloadBanner/downloadHero/resolveBannerUrl). `fillMissingArt` (ipc.js) retries coverless games on every launch when idle (Steam, then SteamGridDB by appid or name), throttled 3 days per game via setting `art_missing_tried`.
- Scan PC: `scanner:scan` runs `pcScanner.scanFolder` per root in a worker (`services/scanWorker.js`, falls back in-process), drops missing and nested roots, name-matches only games not in the library, and broadcasts `scanner:progress`.
- Library month filter = the Game List play plan: `listGamesWithStats` returns `planned_month` from the linked `game_list` row; `games:planMonth` creates the row if needed. Same `PlanMonthModal` as Game List.
- The renderer CSP (index.html) allows media only from Steam's video CDN (Upcoming trailers).
- `preload.js` exposes `kozo.rev`; `UpdateBanner` (PRELOAD_REV) shows a "quit and reopen" bar when the main process is older than the UI. Bump both together whenever preload or IPC changes.
- Add Game / Add to Game List also search SteamGridDB (`sgdb:searchGames`) and list non-Steam hits with covers; the pick travels as `sgdb_id`/`sgdb_cover` to `addLibraryGame`. `applyArt` also sets the linked `game_list.banner_url`, and Game List rows expose `game_banner_local_path` as a cover fallback.
- Animations: Appearance `motion: 'heavy' | 'soft' | 'off'` sets `html[data-motion]`; the rules are `styles/motion.css` (page entrance on `.app-main > *`, heavy card stagger on `[data-gpnav]`, dialogs/menus pop, off kills every animation and transition) and the end of `BigPicture.module.css`. Entrances use fill-mode backwards so no transform stays behind. Never set hover `transform`/`transition`/`filter` on elements in general there: it overrode components' own (blurred art lost its scale-up, lifted cards were cut by scroll panels); hover zoom lives per component under `:global(html[data-motion=…])`. To check a change: hover every `[data-gpnav]` and compare its rect to its clipping ancestor. Windows "Show animations" (prefers-reduced-motion) only applies where `data-motion` isn't set (overlay, tray); it used to switch all of KoZo's motion off. Drag drop sides in Play Plan follow the container's `data-axis="x"`.
- Settings → Appearance customization lives in `context/AppearanceContext.jsx` (setting `appearance`, JSON): UI scale via `kozo.ui.setZoom` (preload webFrame), `data-density` / `data-corners` token overrides at the end of `styles/variables.css`, `data-hide-*` card-detail attributes (rules at the end of GameCard/GameList css), sidebar order + hidden tabs (`Sidebar.jsx` reads `prefs.nav`), start page (`StartPage` in App.jsx), wallpaper (`Wallpaper` in App.jsx, picked via `appearance:pickWallpaper`).
- Adult (18+) toggle is behind a password: `RestrictedContent` (Settings → About → Dev) compares a SHA-256 hash; turning it off never asks.
- Settings → Features rows are links: each `FEATURE_GROUPS` item has `go` (a route, `tab:<settings tab>`, or `overlay:test`). Library opens Scan PC on `/?scan=1` and Add Game on `/?add=1`.
- Add Game search ranks Steam + SteamGridDB hits together (`lib/searchRank.js`).
- `MediaGallery` shows the cached thumbnail first and fades the full image in, and preloads neighbours; calendar `Cover` shows a shimmer until art arrives and never crops wide-only art.
- Text fields draw focus rings inset (global.css) so scroll panels can't clip them. Card grids use container queries for small sizes.
- Non-Steam covers come from SteamGridDB (`services/steamGridDb.js`, key in setting `steamgriddb_key`, never backed up). Auto-applied on add and from Refresh images; Edit → Find cover (`CoverPickerModal`) lets the user pick. With no art at all, `GeneratedCover` draws a name-based poster under every card.
- Setting `show_adult_games` adds `ignore_preferences` + the age-gate cookie to Steam store search and the calendar feeds (`adultSearchOpts` in steamApi.js).
- First-run walkthrough = `components/Tour.jsx`: steps spotlight real controls tagged `data-tour="…"` (Library `scan-pc`/`add-game`/`library-stats`, sidebar `nav-*`, Game List `month-filter`, Upcoming `upcoming-tabs`). Renaming or removing a tagged control breaks its step. Store-style game popup = `components/SteamGameModal.jsx` (gallery via `ui/MediaGallery.jsx`).
- Controller: `lib/gamepadNav.js` (set up once in App; moves are row-first like a TV: up/down take the nearest row with something within 480px sideways, measured to the target's edge, left/right stay on the same line, up/down stay inside the page, the sidebar or a vertical `nav`; then the old edge scoring as fallback) drives every page (cards with `data-gpnav` plus normal focusables, scoped to the open menu or dialog). A select, B close/back, X right-click menu, Y search, LB/RB sidebar tabs (LB, RB and Menu act on release and never when part of a held combo, so the wake combos don't also switch pages), LT/RT in-page tabs, right stick scroll. The ring is the `data-gpfocus` attribute (React would wipe a class): buttons get an outside ring, cards (`:where([data-gpnav])`, lowest priority so a component can override it, e.g. Play Plan rings the art only) an inset ring plus glow, never a scale-up (scroll panels cut it); `components/GamepadHints.jsx` shows the legend. Chromium's fake mousemoves on scroll must not count as mouse input.
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
