import React, { createContext, useContext, useEffect, useState } from 'react'

// Settings → Appearance beyond the accent color: UI scale, spacing, corners,
// what game cards show, sidebar order and start page, and a background
// picture. Stored as one JSON setting (`appearance`) and applied to <html> as
// data attributes the stylesheets react to (styles/variables.css,
// GameCard.module.css, GameList.module.css, motion.css), plus the preload
// zoom factor.

export const NAV_PATHS = ['/', '/game-list', '/plan', '/finished', '/upcoming', '/activity']

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
  theme: 'midnight',              // midnight | oled | slate | nord | mocha | forest | crimson (styles/customize.css)
  font: 'dm',                     // FONTS key
  textScale: 1,                   // 0.9 to 1.2, scales every --fs-* token
  accent2: null,                  // second accent for the ambient glow (hex) or null
  cardBorder: 'subtle',           // none | subtle | accent
  cardGlow: 'soft',               // off | soft | strong (hover glow)
  cardShadow: 'normal',           // flat | normal | deep
  glow: 'soft',                   // accent glow everywhere: off | soft | strong
  sidebarSide: 'left',            // left | right
  sidebarWidth: 205,              // px, full sidebar
  pageWidth: 'full',              // full | centered
  scrollbar: 'thin',              // thin | wide | hidden
  ambient: 'off',                 // off | on (slow accent glow behind the app)
  hideLibraryStats: false,
  hideUpcomingHero: false,
}

// Fonts you can pick (bundled with @fontsource, styles/customize.css).
export const FONTS = {
  dm:       { label: 'DM Sans', css: "'DM Sans', system-ui, sans-serif" },
  inter:    { label: 'Inter', css: "'Inter', system-ui, sans-serif" },
  poppins:  { label: 'Poppins', css: "'Poppins', system-ui, sans-serif" },
  nunito:   { label: 'Nunito', css: "'Nunito', system-ui, sans-serif" },
  atkinson: { label: 'Atkinson (easy to read)', css: "'Atkinson Hyperlegible', system-ui, sans-serif" },
  mono:     { label: 'JetBrains Mono', css: "'JetBrains Mono', ui-monospace, monospace" },
  system:   { label: 'Windows (Segoe UI)', css: "'Segoe UI', system-ui, sans-serif" },
}

// Old or partial saved values never break the app: fill in every missing key.
function normalize(saved) {
  const d = DEFAULT_APPEARANCE
  const p = { ...d, ...(saved || {}) }
  p.cards = { ...d.cards, ...(saved?.cards || {}) }
  p.bg = { ...d.bg, ...(saved?.bg || {}) }
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

function apply(p) {
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
  const attrs = { theme: p.theme, cardBorder: p.cardBorder, cardGlow: p.cardGlow, cardShadow: p.cardShadow, glow: p.glow, sidebarSide: p.sidebarSide, pageWidth: p.pageWidth, scrollbar: p.scrollbar, ambient: p.ambient }
  for (const [k, v] of Object.entries(attrs)) {
    if (v && v !== DEFAULT_APPEARANCE[k]) el.dataset[k] = v
    else delete el.dataset[k]
  }
  if (p.hideLibraryStats) el.dataset.hideLibraryStats = ''; else delete el.dataset.hideLibraryStats
  if (p.hideUpcomingHero) el.dataset.hideUpcomingHero = ''; else delete el.dataset.hideUpcomingHero
  const font = FONTS[p.font] || FONTS.dm
  if (p.font && p.font !== 'dm') el.style.setProperty('--font', font.css); else el.style.removeProperty('--font')
  if (p.textScale && p.textScale !== 1) el.style.setProperty('--text-scale', String(p.textScale)); else el.style.removeProperty('--text-scale')
  if (p.sidebarWidth && p.sidebarWidth !== 205) el.style.setProperty('--sidebar-width', `${p.sidebarWidth}px`); else el.style.removeProperty('--sidebar-width')
  if (p.accent2) el.style.setProperty('--accent-2', p.accent2); else el.style.removeProperty('--accent-2')
  window.kozo?.ui?.setZoom?.(p.scale)
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
