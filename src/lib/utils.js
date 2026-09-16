import {
  IconSkull, IconSword, IconRobot, IconTrees, IconCar,
  IconWand, IconCrosshair, IconDeviceGamepad2,
} from '@tabler/icons-react'

const BANNER_COLORS = [
  '#1a0f2e', '#0f1e3a', '#0f2a1e',
  '#2a1a0a', '#2a0f0f', '#1e1a0a',
]

export function getBannerBg(id) {
  return BANNER_COLORS[(id || 0) % BANNER_COLORS.length]
}

// Genre column is stored as a JSON array string (see electron/db/database.js).
export function parseGenres(item) {
  try { return JSON.parse(item?.genres || '[]') } catch { return [] }
}

export function getBannerIcon(name = '') {
  const n = name.toLowerCase()
  if (n.match(/dead|evil|horror|skull|fear|silent|alien/)) return IconSkull
  if (n.match(/cyber|robot|space|sci|star|mech/))          return IconRobot
  if (n.match(/elden|ring|sword|god|war|knight|armor/))    return IconSword
  if (n.match(/car|race|driver|nfs|speed|formula/))        return IconCar
  if (n.match(/far cry|open|world|forest|tree/))           return IconTrees
  if (n.match(/baldur|rpg|wizard|magic|mage/))             return IconWand
  if (n.match(/call|duty|halo|fps|sniper|shoot/))          return IconCrosshair
  return IconDeviceGamepad2
}

export function formatPlaytime(seconds) {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h${m}m`
}

export function formatDate(ts) {
  if (!ts) return '—'
  const d   = new Date(ts)
  const now = new Date()
  // Calendar days, not elapsed 24h blocks. Dividing the millisecond gap by
  // 86400000 called 11pm-last-night "Today" until 11pm tonight, and this hour
  // this morning "Yesterday" — disagreeing with the day-keyed charts and the
  // Sessions timeline on the same screen, which both group by localDayKey.
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate())
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return `${diff}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: diff > 365 ? 'numeric' : undefined })
}

// Local calendar day key, "YYYY-MM-DD". started_at is stored as a UTC ISO
// string, so slicing it (toISOString().slice(0,10)) files a session played after
// local midnight under the previous day while the row still shows a local clock
// time. Every day-grouping surface (Statistics chart, Sessions timeline,
// GameDetail's 7-day chart) must key off THIS, and the stats IPCs group by
// DATE(...,'localtime') so the keys match on both sides.
export function localDayKey(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  const p = n => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`
}

export function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

// Convert a local absolute path to a secure kozo:// URL the renderer can load
// (served by the custom protocol in electron/main.js). This keeps webSecurity
// ON — we no longer load file:// images directly. Optional `bust` query param
// defeats the renderer image cache after a refresh.
export function fileUrl(winPath, bust) {
  if (!winPath) return null
  const url = 'kozo://local/' + encodeURIComponent(winPath.replace(/\\/g, '/'))
  return bust ? `${url}?v=${bust}` : url
}

// ── Launchers / sources ─────────────────────────────────────────────────────
// One source of truth for badge labels + colors. Steam achievements come from
// the Steam Web API and cracked from emulator files; the other launchers have
// no achievement source KoZo can read.
export const LAUNCHERS = {
  steam:   { label: 'Steam',   color: '#60a5fa' },
  cracked: { label: 'Cracked', color: '#fbbf24' },
  epic:    { label: 'Epic',    color: '#d1d5db' },
  gog:     { label: 'GOG',     color: '#c084fc' },
  xbox:    { label: 'Xbox',    color: '#4ade80' },
  ea:      { label: 'EA',      color: '#f87171' },
  ubisoft: { label: 'Ubisoft', color: '#38bdf8' },
  manual:  { label: 'Manual',  color: '#8080a8' },
}

// Foreign launchers: even if such a game carries a stray steam_app_id, KoZo must
// NOT treat it as a Steam-tracked game (no Steam sync UI / diagnostics).
export const FOREIGN_LAUNCHERS = new Set(['epic', 'gog', 'xbox', 'ea', 'ubisoft'])

export function launcherLabel(source) {
  return (LAUNCHERS[source] || LAUNCHERS.manual).label
}

// True only when this game's achievements genuinely come from the Steam Web API.
export function isSteamTracked(game) {
  return !!game?.steam_app_id && game.is_cracked !== 1 && !FOREIGN_LAUNCHERS.has(game.source)
}

// Map an install/exe path to a launcher source key (mirrors the scanner's
// detectType, kept in sync). Returns null when no known launcher path matches.
export function detectLauncherFromPath(p) {
  if (!p) return null
  const l = p.toLowerCase()
  if (l.includes('steamapps\\common\\') || l.includes('steamapps/common/')) return 'steam'
  if (l.includes('\\epic games\\') || l.includes('/epic games/')) return 'epic'
  if (l.includes('\\gog games\\') || l.includes('/gog games/') ||
      l.includes('\\gog galaxy\\') || l.includes('/gog galaxy/')) return 'gog'
  if (l.includes('\\windowsapps\\') || l.includes('/windowsapps/') ||
      l.includes('\\xboxgames\\') || l.includes('/xboxgames/')) return 'xbox'
  if (l.includes('\\origin games\\') || l.includes('/origin games/') ||
      l.includes('\\ea games\\') || l.includes('/ea games/')) return 'ea'
  if (l.includes('\\ubisoft game launcher\\') || l.includes('\\ubisoft connect\\')) return 'ubisoft'
  return null
}

export function rarityLabel(pct) {
  if (pct == null) return ''
  if (pct < 5)    return 'Ultra Rare'
  if (pct < 15)   return 'Very Rare'
  if (pct < 30)   return 'Rare'
  if (pct < 50)   return 'Uncommon'
  return 'Common'
}

// ── Game name ↔ install path ────────────────────────────────────────────────
// A game's own internal folders. These are never its title: picking an exe at
// "…\007 First Light\Retail\007FirstLight.exe" hands us "Retail" as the leaf,
// so the real name is the nearest ancestor that isn't one of these.
// Mirrors pcScanner's STRUCT_FOLDERS — keep the two in sync.
export const STRUCTURAL_FOLDERS = new Set([
  'retail', 'game', 'client', 'application', 'app', 'program', 'launcher',
  'binaries', 'bin', 'win64', 'win32', 'x64', 'x86', 'win', 'windows',
  'shipping', 'build', 'release', 'dist', 'data', 'content', 'plugins',
  'saved', 'config', 'engine', 'redist', '_commonredist', 'commonredist',
  'soundbanks', 'movies', 'locales', 'resources', 'system', 'exe',
])

// Library roots that hold OTHER games. Climbing past one of these means we have
// left the game's own folder, so the walk stops rather than naming a game after
// the Steam library it lives in.
const PATH_STOPS = new Set([
  'common', 'steamapps', 'steamlibrary', 'steamlibrary2', 'epic games',
  'epicgames', 'xboxgames', 'gog games', 'gog galaxy', 'windowsapps',
  'program files', 'program files (x86)', 'games', 'mygames', 'my games',
  'gamelibrary', 'game library', 'users', 'documents', 'riot games',
])

const tidyName = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()

// Best-effort game title for an install folder. Walks up out of structural
// subfolders so "…\StellarBlade\Binaries\Win64" still reads "StellarBlade".
export function deriveGameNameFromPath(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]+/).filter(Boolean)
  // Tolerate being handed the exe itself rather than its folder.
  if (parts.length > 1 && /\.[a-z0-9]{1,5}$/i.test(parts[parts.length - 1])) parts.pop()
  for (let i = parts.length - 1; i > 0; i--) {
    const low = parts[i].toLowerCase()
    if (PATH_STOPS.has(low)) break
    if (!STRUCTURAL_FOLDERS.has(low)) return tidyName(parts[i])
  }
  return tidyName(parts[parts.length - 1] || '')
}

// Helper/handler executables that ship alongside a game but are not the game.
// The scanner's NOT_GAME_EXES is an exact-name list, which missed abbreviated
// forms like "crs-handler.exe" (it only denied "crash…"). This is the pattern
// form. Mirrors pcScanner's HELPER_EXE_RE — keep the two in sync.
export const HELPER_EXE_RE = new RegExp([
  'cr[as]?sh(pad)?[-_. ]?(handler|report(er)?|dump(er)?)', // crashhandler, crashpad_handler
  '^crs[-_. ]',                                  // Crash Reporting Service: crs-handler, crs-uploader
  '[-_. ](handler|uploader)[-_. 0-9]*\\.exe$',   // anything-handler.exe
  '^(launcher|updater|update|patcher|installer|setup|service|helper|daemon|' +
    'watchdog|telemetry|activation|cleanup|redist\\w*|prereq\\w*)[-_. 0-9]*\\.exe$',
  'anticheat|battleye|vcredist|dxsetup|dotnetfx',
].join('|'), 'i')

export function isHelperExe(name) {
  return HELPER_EXE_RE.test(String(name || '').toLowerCase())
}

// Filler that may legitimately separate a game's title from its folder name.
const EDITION_WORDS = /^(goty|gameoftheyear|definitive|deluxe|ultimate|complete|remastered|remaster|remake|edition|directorscut|enhanced|standard|premium|gold|anniversary|hd|vr|the|a|an|of|and|ii|iii|iv|pc)+$/

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Do two names plausibly refer to the same game? Containment alone is NOT
// enough — "Ruined King: A League of Legends Story" contains "League of
// Legends", which is a different game. This is the same collision guard
// saveFinder uses to keep "Hollow Knight" and "Hollow Knight Silksong" apart.
function namesRelated(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < 3 || !long.includes(short)) return false
  // Containment alone is not enough — the leftover has to be filler, not
  // another game's title. "hollowknight" sits inside "hollowknightsilksong"
  // leaving "silksong", which is a different game; "outlast" inside
  // "outlastcompleteedition" leaves only edition words, which is the same one.
  const rest = long.replace(short, '')
  return rest.length <= 2 || EDITION_WORDS.test(rest)
}

/**
 * True when a game is pointed at an executable that looks like it belongs to
 * something else. Advisory only — plenty of real games ship an exe whose name
 * resembles nothing (BBQ-Win64-Shipping.exe), so this warns, never blocks.
 */
export function exeLooksUnrelated(gameName, installPath, exeName) {
  const name = slug(gameName)
  if (!name || name.length < 3) return false
  const folder = slug(deriveGameNameFromPath(installPath))
  const exe    = slug(String(exeName || '').replace(/\.exe$/i, ''))
  if (!folder && !exe) return false
  if (namesRelated(name, folder) || namesRelated(name, exe)) return false
  // Acronym launchers: "Lies of P" → LOP.exe, "StellarBlade" → SB.exe.
  const acro = String(gameName).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map(w => w[0]).join('').toLowerCase()
  if (acro.length >= 2 && exe && (exe.startsWith(acro) || acro.startsWith(exe))) return false
  return true
}
