import React, { createContext, useContext, useEffect, useState } from 'react'
import { bgTone, bgToneHex } from '../lib/bgTone'
import { reapplyAccent } from './AccentColorContext'

// Settings → Appearance beyond the accent color: UI scale, spacing, corners,
// what game cards show, sidebar order and start page, and a background
// picture. Stored as one JSON setting (`appearance`) and applied to <html> as
// data attributes the stylesheets react to (styles/variables.css,
// GameCard.module.css, GameList.module.css, motion.css), plus the preload
// zoom factor.

export const NAV_PATHS = ['/', '/game-list', '/plan', '/finished', '/upcoming', '/like', '/deals', '/activity']

// Big Picture's own look (its Customize panel, components/BigPictureCustomize.jsx). The
// defaults are the look it always had.
export const DEFAULT_BIG_PICTURE = {
  layout: 'shelves',   // shelves | spotlight (one big game, two rows) | grid (every game under the banner)
  focus: null,         // ring color, null = the accent
  shape: 'tall',       // tall (covers) | wide (the game's wide art)
  size: 'medium',      // small | medium | large
  corners: 'soft',     // square | soft | round
  bg: 'art',           // art | blur | plain
  darken: 0,           // extra darkness over the art, 0 to 80 (%)
  blur: 0,             // extra blur on the art, 0 to 40 (px)
  buttons: 'xbox',     // xbox | playstation: how controller buttons are drawn
  hints: true,         // the controller hint bar
}

export const DEFAULT_APPEARANCE = {
  scale: 1,                       // 0.8 to 1.5 (Settings presets, or Ctrl + wheel in 5% steps)
  density: 'comfortable',         // 'comfortable' | 'compact'
  corners: 'default',             // 'sharp' | 'default' | 'round'
  cards: { genres: true, stats: true, progress: true, statusDot: true, planChip: true },
  nav: NAV_PATHS.map(path => ({ path, hidden: false })),
  startPage: '/',
  sidebar: 'full',                // 'full' | 'rail' (icons only; the button by the logo switches)
  motion: 'soft',                 // 'heavy' | 'soft' | 'off' (styles/motion.css)
  bg: { mode: 'off', image: null, gameId: null, gameArt: null, blur: 8, dim: 55 },
  theme: 'midnight',              // midnight | light | system | tint | custom | oled | slate | nord | mocha | forest | crimson (styles/customize.css)
  bgColor: '#1a1030',             // the Custom theme's color (any hex; a very light one gives a light KoZo, see bgTone)
  textColor: null,                // the main text color (any hex) or null = the theme's own
  gamePage: 'store',              // Game Detail layout: store | cinematic
  gameListEdit: 'tab',            // Game List window: tab (all in an Edit tab) | overview (status and plan on the Overview)
  upcomingLayout: 'weeks',        // Upcoming's Steam view: weeks (Steam's calendar, Monday to Friday) | classic (the look before, days with releases in a grid)
  font: 'dm',                     // FONTS key, the whole app
  cardStyle: 'classic',           // classic | poster | glass | minimal (GameCard / GameList css)
  textScale: 1,                   // 0.9 to 1.2, scales every --fs-* token
  accent2: null,                  // second color for gradients (progress, XP ring, glow) or null
  cardBorder: 'subtle',           // none | subtle | accent
  cardGlow: 'soft',               // off | soft | strong (hover glow)
  cardShadow: 'normal',           // flat | normal | deep
  glow: 'soft',                   // accent glow everywhere: off | soft | strong
  sidebarSide: 'left',            // left | right
  sidebarWidth: 205,              // px, full sidebar
  pageWidth: 'full',              // full | centered
  scrollbar: 'thin',              // thin | hidden (an older 'wide' reads as thin)
  ambient: 'off',                 // off | on (slow accent glow behind the app)
  hideLibraryStats: false,
  hideUpcomingHero: false,
  bigPicture: DEFAULT_BIG_PICTURE,
}

// The app's font, one for everything (bundled with @fontsource, styles/
// customize.css). Every face is fitted to the same letter height
// (font-size-adjust in customize.css), so a tall or small face never breaks a
// layout; `track` tightens or loosens the wide and narrow ones.
export const FONTS = {
  dm:       { label: 'DM Sans', css: "'DM Sans', system-ui, sans-serif" },
  inter:    { label: 'Inter', css: "'Inter', system-ui, sans-serif" },
  poppins:  { label: 'Poppins', css: "'Poppins', system-ui, sans-serif" },
  nunito:   { label: 'Nunito', css: "'Nunito', system-ui, sans-serif" },
  atkinson: { label: 'Atkinson', note: 'Easy to read', css: "'Atkinson Hyperlegible', system-ui, sans-serif" },
  system:   { label: 'Segoe UI', note: 'Windows', css: "'Segoe UI', system-ui, sans-serif" },
  mono:     { label: 'JetBrains Mono', css: "'JetBrains Mono', ui-monospace, monospace", track: '-0.02em' },
  orbitron: { label: 'Orbitron', note: 'Gaming', css: "'Orbitron', system-ui, sans-serif", track: '-0.01em' },
  rajdhani: { label: 'Rajdhani', note: 'Gaming', css: "'Rajdhani', system-ui, sans-serif", track: '0.01em' },
  chakra:   { label: 'Chakra Petch', note: 'Gaming', css: "'Chakra Petch', system-ui, sans-serif" },
  exo:      { label: 'Exo 2', note: 'Gaming', css: "'Exo 2', system-ui, sans-serif" },
  oxanium:  { label: 'Oxanium', note: 'Gaming', css: "'Oxanium', system-ui, sans-serif" },
}

// The Custom theme: any color becomes a dark background in its hue, so text,
// cards and every page keep the same contrast as the stock themes (styles/
// customize.css builds the surfaces from these three numbers).
export { bgTone, bgToneHex }

// Old or partial saved values never break the app: fill in every missing key.
function normalize(saved) {
  const d = DEFAULT_APPEARANCE
  const p = { ...d, ...(saved || {}) }
  p.cards = { ...d.cards, ...(saved?.cards || {}) }
  p.bg = { ...d.bg, ...(saved?.bg || {}) }
  p.bigPicture = { ...DEFAULT_BIG_PICTURE, ...(saved?.bigPicture || {}) }
  if (p.scrollbar === 'wide') p.scrollbar = 'thin'
  // The short-lived separate heading font: a chosen gaming face becomes the font.
  if (saved?.displayFont && saved.displayFont !== 'same' && FONTS[saved.displayFont]) p.font = saved.displayFont
  delete p.displayFont
  if (!FONTS[p.font]) p.font = 'dm'
  if (!['store', 'cinematic'].includes(p.gamePage)) p.gamePage = 'store'
  if (!['tab', 'overview'].includes(p.gameListEdit)) p.gameListEdit = 'tab'
  if (!['weeks', 'classic'].includes(p.upcomingLayout)) p.upcomingLayout = 'weeks'
  // 75% was the first default darkness and hid most of the picture.
  if (saved?.bg?.dim === 75 && !saved?.bg?.image && !saved?.bg?.gameArt) p.bg.dim = d.bg.dim
  // Saved order first; a tab added in a later version slots in right after the
  // tab it follows by default (not at the end), and removed tabs drop out.
  const nav = Array.isArray(saved?.nav) ? saved.nav.filter(n => NAV_PATHS.includes(n?.path)) : []
  NAV_PATHS.forEach((path, i) => {
    if (nav.some(n => n.path === path)) return
    const before = NAV_PATHS.slice(0, i).reverse().find(x => nav.some(n => n.path === x))
    const at = before ? nav.findIndex(n => n.path === before) + 1 : 0
    nav.splice(at, 0, { path, hidden: false })
  })
  p.nav = nav
  p.nav = p.nav.map(n => (n.path === '/' ? { ...n, hidden: false } : n))   // Library always shows
  return p
}

// UI scale. The chosen scale is capped so a page always keeps about 1000
// CSS px of width (a big scale in a small window squeezed every layout), and
// Big Picture locks its own size (setZoomLock), whatever the app's scale.
let zoomPref = 1
let zoomNow = 1
let zoomLock = null
function applyZoom() {
  const current = window.kozo?.ui?.getZoom?.() || zoomNow || 1
  const physical = window.innerWidth * current
  const z = zoomLock ?? Math.min(zoomPref, Math.max(0.8, physical / 1000))
  const next = Math.round(z * 100) / 100
  if (next === zoomNow) return
  zoomNow = next
  window.kozo?.ui?.setZoom?.(next)
}
export function setZoomLock(v) { zoomLock = v; applyZoom() }
let resizeT = null
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(applyZoom, 150) })

// 'system' (Match Windows): Windows' own colors, light or dark with Windows' app mode
// ("windark" is the gray of Windows' dark apps). Custom with a very light pick is Light
// with the picked color (bgTone), so everything made for Light applies to it too.
const LIGHT_QUERY = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null
export function windowsIsLight() { return !!LIGHT_QUERY?.matches }
function effectiveTheme(p) {
  if (p.theme === 'system') return windowsIsLight() ? 'light' : 'windark'
  if (p.theme === 'custom' && bgTone(p.bgColor).light) return 'light'
  return p.theme
}
let appliedPrefs = null
LIGHT_QUERY?.addEventListener?.('change', () => { if (appliedPrefs?.theme === 'system') apply(appliedPrefs) })

function apply(p) {
  appliedPrefs = p
  const el = document.documentElement
  el.dataset.density = p.density
  el.dataset.corners = p.corners
  const hide = { genres: 'hideGenres', stats: 'hideStats', progress: 'hideProgress', statusDot: 'hideStatusDot', planChip: 'hidePlanChip' }
  for (const [k, attr] of Object.entries(hide)) {
    if (p.cards[k]) delete el.dataset[attr]
    else el.dataset[attr] = ''
  }
  el.dataset.sidebar = p.sidebar
  el.dataset.motion = ['heavy', 'soft', 'off'].includes(p.motion) ? p.motion : 'soft'
  // Customization (styles/customize.css): attributes for the switches,
  // variables for the values.
  const attrs = { theme: effectiveTheme(p), cardStyle: p.cardStyle, cardBorder: p.cardBorder, cardGlow: p.cardGlow, cardShadow: p.cardShadow, glow: p.glow, sidebarSide: p.sidebarSide, pageWidth: p.pageWidth, scrollbar: p.scrollbar, ambient: p.ambient }
  for (const [k, v] of Object.entries(attrs)) {
    if (v && v !== DEFAULT_APPEARANCE[k]) el.dataset[k] = v
    else delete el.dataset[k]
  }
  // The accent is darkened on white and brightened on dark (AccentColorContext).
  reapplyAccent()
  // Controller buttons drawn as PlayStation's, and Big Picture's hint bar (GamepadHints).
  if (p.bigPicture?.buttons === 'playstation') el.dataset.padGlyphs = 'playstation'; else delete el.dataset.padGlyphs
  if (p.bigPicture?.hints === false) el.dataset.bpHints = 'off'; else delete el.dataset.bpHints
  if (p.hideLibraryStats) el.dataset.hideLibraryStats = ''; else delete el.dataset.hideLibraryStats
  if (p.hideUpcomingHero) el.dataset.hideUpcomingHero = ''; else delete el.dataset.hideUpcomingHero
  const font = FONTS[p.font] || FONTS.dm
  if (p.font && p.font !== 'dm') { el.style.setProperty('--font', font.css); el.dataset.font = p.font } else { el.style.removeProperty('--font'); delete el.dataset.font }
  if (font.track) el.style.setProperty('--font-tracking', font.track); else el.style.removeProperty('--font-tracking')
  if (p.textScale && p.textScale !== 1) el.style.setProperty('--text-scale', String(p.textScale)); else el.style.removeProperty('--text-scale')
  if (p.sidebarWidth && p.sidebarWidth !== 205) el.style.setProperty('--sidebar-width', `${p.sidebarWidth}px`); else el.style.removeProperty('--sidebar-width')
  if (p.accent2) el.style.setProperty('--accent-2', p.accent2); else el.style.removeProperty('--accent-2')
  if (p.theme === 'system') el.dataset.windows = ''; else delete el.dataset.windows
  if (p.theme === 'custom' && bgTone(p.bgColor).light) el.dataset.customBg = ''; else delete el.dataset.customBg
  // Text color: the main text, with the quieter ones mixed toward the background. Things
  // on pictures and Big Picture in Light keep their own (.kz-dark sets them again).
  if (/^#[0-9a-f]{6}$/i.test(p.textColor || '')) {
    el.style.setProperty('--text-primary', p.textColor)
    el.style.setProperty('--text-secondary', `color-mix(in srgb, ${p.textColor} 76%, var(--bg))`)
    el.style.setProperty('--text-muted', `color-mix(in srgb, ${p.textColor} 58%, var(--bg))`)
  } else for (const v of ['--text-primary', '--text-secondary', '--text-muted']) el.style.removeProperty(v)
  if (p.theme === 'custom') {
    const t = bgTone(p.bgColor)
    el.style.setProperty('--cbg-h', String(t.h)); el.style.setProperty('--cbg-s', `${t.s}%`); el.style.setProperty('--cbg-l', `${t.l}%`)
  } else for (const v of ['--cbg-h', '--cbg-s', '--cbg-l']) el.style.removeProperty(v)
  zoomPref = p.scale || 1
  zoomNow = 0   // force the first apply
  applyZoom()
}

const AppearanceContext = createContext({ prefs: DEFAULT_APPEARANCE, loaded: false, setPrefs: () => {} })

export function AppearanceProvider({ children }) {
  const [prefs, setPrefsState] = useState(DEFAULT_APPEARANCE)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    window.kozo?.api?.settings?.get?.('appearance').then(res => {
      if (!alive) return
      let saved = null
      try { saved = res?.ok && res.data ? JSON.parse(res.data) : null } catch {}
      const p = normalize(saved)
      setPrefsState(p)
      apply(p)
      setLoaded(true)
      // "Match background to accent" used to be a switch; it is the Accent
      // tint theme now (one theme at a time, no inline colors fighting it).
      window.kozo?.api?.settings?.get?.('bg_tint').then(r => {
        if (!alive || r?.data !== '1') return
        window.kozo.api.settings.set('bg_tint', '0')
        const next = { ...p, theme: 'tint' }
        setPrefsState(next); apply(next)
        window.kozo.api.settings.set('appearance', JSON.stringify(next))
      })
    }).catch(() => setLoaded(true))
    return () => { alive = false }
  }, [])

  // setPrefs(patch | fn): applies at once (live preview) and saves.
  function setPrefs(update) {
    setPrefsState(prev => {
      const next = normalize(typeof update === 'function' ? update(prev) : { ...prev, ...update })
      apply(next)
      window.kozo?.api?.settings?.set?.('appearance', JSON.stringify(next))
      return next
    })
  }

  return (
    <AppearanceContext.Provider value={{ prefs, loaded, setPrefs }}>
      {children}
    </AppearanceContext.Provider>
  )
}

export function useAppearance() {
  return useContext(AppearanceContext)
}
