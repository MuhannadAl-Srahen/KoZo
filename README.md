<div align="center">

# KoZo

**A local-first desktop game tracker for Windows.**

Track playtime, sessions and achievements for every game you play — including cracked and offline titles that Steam can't see. Everything stays on your PC.

</div>

---

## ✨ Features

### 🎮 Automatic tracking
- **Playtime & sessions** — KoZo detects running games and records sessions automatically. No manual timers.
- **Sessions timeline** — every play session grouped by day, with durations and achievements earned.
- **Idle / AFK pause** — optionally stop counting when you step away, so leaving a game open overnight doesn't inflate your stats.

### 🏆 Achievements (Steam *and* cracked games)
- **Steam sync** — imports your unlocks through the official Steam Web API.
- **Cracked-game sync** — reads achievement files from popular emulators: **Goldberg, CODEX, EMPRESS, RUNE, SKIDROW, ALI213, SmartSteamEmu, CreamAPI, Reloaded/3DM, online-fix** and more.
- **Automatic, no setup** — syncs the moment a game launches, on a fast background check (~10s) while you play, and again when the session ends. There's no interval to configure (Steam caches freshly-unlocked achievements server-side for a minute or two, which is the only delay no client can avoid). Cracked games are watched **live** via a file-watcher, so their unlocks appear instantly.
- **Live game overlay** — a Steam-style toast pops up *over your game* the instant you unlock something, themed to your accent color.
- **Any launcher** — Xbox/Epic/GOG/other games auto-match a Steam achievement list by name on add, so you can tick off what you've earned.

### 📚 Library
- **Add games** two ways: **Scan PC** (a button right on the Library toolbar that finds installed Steam/Epic/GOG/Xbox/cracked games across your drives), or add any `.exe` manually.
- **Game List** — a backlog / wishlist with statuses (playing, finished, dropped, want to play, upcoming) and custom categories.
- **Favorites** — star a game to pin it to the top of your Library and Game List.
- **Rich cards** — portrait cover art with a blurred-fill background, source badges, a LIVE badge while playing, and quick launch.

### 💾 Saves & backups
- **Save-file finder** — locates each game's real save folder, even tricky publisher paths (e.g. `Documents\…`, `AppData\Local\Pearl Abyss\CD\save`).
- **Per-game save backup & restore** — snapshot and roll back any game's saves. Restores auto-snapshot the current state first, so they're always reversible.
- **Back up all saves at once** — one click backs up every game's saves to a discoverable `Documents\KoZo Saves` folder. Perfect before formatting or moving PCs. Optionally auto-snapshots a game's saves after each session.
- **App-data backup** — a live, **always-synced** backup of your whole KoZo library (games, sessions, achievements, game list, settings) to a folder you choose, kept current on every change and on quit, with one-click **restore**.

### 📊 Insights & profile
- **Statistics** — playtime trends with an hourly 24-hour view, daily/monthly charts, and click-a-day (or hour) to focus it; playtime by game, longest sessions, recent unlocks.
- **Profile, XP & levels** — earn XP from playtime, rare unlocks, day streaks and finished games; level up through tiers from Rookie to Mythic, with a customizable profile (avatar, banner, title, favorite-game showcase).

### 🎨 The app itself
- Runs quietly in the **system tray**, can **launch on startup**, and start minimized.
- **Custom accent color** that themes the entire app and the overlay.
- **In-game status (Alt+K)** — flash your live session time + achievement progress over the game.
- A friendly **first-run walkthrough** that shows you how KoZo works and helps you connect Steam.

---

## 🔒 Privacy

KoZo is **local-first**. All your data lives in a local SQLite database on your machine. The internet is only used to fetch game art, achievement schemas, and your Steam unlocks — and only when you ask it to. Nothing is uploaded anywhere.

---

## 🚀 Getting started (development)

### Prerequisites
- **Windows 10/11**
- **Node.js 18+**
- A **Steam Web API key** (free) and your **Steam ID** if you want Steam features — KoZo walks you through this on first run.

### Setup
```bash
git clone <your-repo-url> kozo
cd kozo
npm install

# Rebuild the native SQLite module against Electron's ABI
npm run rebuild

# Start the app (Vite dev server + Electron)
npm run dev
```

### Build a Windows installer
```bash
npm run build
```
This regenerates the app icon, builds the renderer with Vite, and packages a Windows installer with `electron-builder`. The output lands in `dist/` (or the configured `electron-builder` output folder). The packaged app runs as `KoZo.exe`.

---

## 🔑 Connecting Steam

Steam features (achievement sync + cover art) need two things:

1. **A Steam Web API key** — grab one for free at <https://steamcommunity.com/dev/apikey>.
2. **Your Steam profile** — in **Settings → Steam**, paste your **profile URL**, custom name, or 17-digit SteamID64. KoZo resolves it to your ID for you (no third-party websites).

> For achievement sync to work, your Steam **profile and game details must be set to Public**.

The first-run walkthrough (or **Settings → About → Show the walkthrough**) guides you through both.

---

## 🛠️ Tech stack

| Layer | Tech |
|-------|------|
| Desktop shell | Electron 41 |
| UI | React 19 + Vite 8 |
| Styling | CSS Modules + CSS variables (no UI framework) |
| Database | SQLite via `better-sqlite3` |
| HTTP | axios |
| Process detection | `ps-list` |
| File watching | `chokidar` |
| Icons | `@tabler/icons-react` |
| Font | DM Sans |
| Packaging | `electron-builder` |

---

## 📁 Project structure

```
kozo/
├── electron/                  # Main process (Node)
│   ├── main.js                # Window, tray, single-instance lock, app lifecycle
│   ├── preload.js             # contextBridge — exposes window.kozo.api / .events
│   ├── ipc.js                 # All IPC handlers
│   ├── tray.js                # System tray + honeycomb icon
│   ├── overlayWindow.js       # Transparent always-on-top game overlay window
│   ├── appIcon.js             # Programmatic honeycomb icon generator
│   ├── db/                    # SQLite schema, migrations, queries
│   └── services/
│       ├── processWatcher.js  # Detects games, manages sessions + idle pause
│       ├── steamApi.js        # Steam Store + Web API
│       ├── achievementSync.js # Achievement import/sync logic
│       ├── crackWatcher.js    # Reads crack emulator achievement files
│       ├── pcScanner.js       # PC folder scanner
│       ├── saveFinder.js      # Locates game save folders
│       ├── saveBackup.js      # Per-game save backup/restore
│       └── autoBackup.js      # Automatic app-data backup
├── src/                       # Renderer (React)
│   ├── pages/                 # Library, GameDetail, GameList, Sessions, Statistics, Profile, Settings
│   ├── components/            # Cards, modals, overlay, onboarding, sidebar
│   ├── context/               # Accent color provider
│   └── styles/                # Global CSS + design tokens
└── scripts/gen-icon.js        # Builds the app icon at package time
```

---

## 🧩 Supported crack emulators

Achievement files are read from the standard locations used by:

**Goldberg SteamEmu · CODEX · EMPRESS · RUNE · SKIDROW · ALI213 · SmartSteamEmu · CreamAPI · Reloaded / 3DM (RLD!) · PLAZA · online-fix**

KoZo also recursively scans the game's install folder (and parent folders) for `achievements.json` / `achievements.ini` / `stats.bin` style files.

---

## ⚠️ Disclaimer

KoZo is not affiliated with Valve or Steam. "Steam" and related marks are trademarks of Valve Corporation. KoZo supports tracking achievements for games you own; please respect the terms of the software and storefronts you use.

---

## 📄 License

Released under the MIT License. See `LICENSE` for details.
