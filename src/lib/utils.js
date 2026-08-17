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
  const diff = Math.floor((now - d) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7)   return `${diff}d ago`
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
