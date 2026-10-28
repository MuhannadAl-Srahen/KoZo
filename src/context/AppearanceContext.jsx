import React, { createContext, useContext, useEffect, useState } from 'react'

// Settings → Appearance beyond the accent color: UI scale, spacing, corners,
// what game cards show, sidebar order and start page, and a background
// picture. Stored as one JSON setting (`appearance`) and applied to <html> as
// data attributes the stylesheets react to (styles/variables.css,
// GameCard.module.css, GameList.module.css), plus the preload zoom factor.

export const NAV_PATHS = ['/', '/game-list', '/achievements', '/upcoming', '/sessions', '/statistics']

export const DEFAULT_APPEARANCE = {
  scale: 1,                       // 0.9 | 1 | 1.1 | 1.25
  density: 'comfortable',         // 'comfortable' | 'compact'
  corners: 'default',             // 'sharp' | 'default' | 'round'
  cards: { genres: true, stats: true, progress: true, statusDot: true, planChip: true },
  nav: NAV_PATHS.map(path => ({ path, hidden: false })),
  startPage: '/',
  bg: { mode: 'off', image: null, gameId: null, gameArt: null, blur: 8, dim: 75 },
}

// Old or partial saved values never break the app: fill in every missing key.
function normalize(saved) {
  const d = DEFAULT_APPEARANCE
  const p = { ...d, ...(saved || {}) }
  p.cards = { ...d.cards, ...(saved?.cards || {}) }
  p.bg = { ...d.bg, ...(saved?.bg || {}) }
  const known = Array.isArray(saved?.nav) ? saved.nav.filter(n => NAV_PATHS.includes(n?.path)) : []
  p.nav = [...known, ...NAV_PATHS.filter(x => !known.some(n => n.path === x)).map(path => ({ path, hidden: false }))]
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
