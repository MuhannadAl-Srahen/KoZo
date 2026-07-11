import React, { createContext, useContext, useEffect, useState } from 'react'

const AccentColorContext = createContext(null)

const PRESET_ACCENTS = [
  { label: 'Purple',        value: '#a78bfa' },
  { label: 'Electric Blue', value: '#60a5fa' },
  { label: 'Crimson Red',   value: '#f87171' },
  { label: 'Neon Green',    value: '#4ade80' },
  { label: 'Amber',         value: '#fbbf24' },
  { label: 'Hot Pink',      value: '#f472b6' },
  { label: 'Teal',          value: '#2dd4bf' },
  { label: 'Tangerine',     value: '#fb923c' },
  { label: 'Indigo',        value: '#818cf8' },
  { label: 'Lime',          value: '#a3e635' },
  { label: 'Sky',           value: '#38bdf8' },
  { label: 'Rose',          value: '#fda4af' },
]

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Ensure accent is bright enough to be visible on the dark app background.
// Converts to HSL, clamps lightness to minimum 38%, converts back.
function ensureMinContrast(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return hex
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (l >= 0.38) return hex  // Already bright enough
  const d = max - min
  const s = d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min))
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
  }
  const nl = 0.42
  const q = nl < 0.5 ? nl * (1 + s) : nl + s - nl * s
  const p = 2 * nl - q
  const hue2rgb = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1/6) return p + (q - p) * 6 * t
    if (t < 1/2) return q
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
    return p
  }
  const to2 = v => Math.round(hue2rgb(v) * 255).toString(16).padStart(2, '0')
  return `#${to2(h + 1/3)}${to2(h)}${to2(h - 1/3)}`
}

export function applyAccent(rawHex) {
  const hex = ensureMinContrast(rawHex)
  const root = document.documentElement
  root.style.setProperty('--a', hex)
  root.style.setProperty('--ad', hexToRgba(hex, 0.10))
  root.style.setProperty('--ab', hexToRgba(hex, 0.22))
}

function hexHue(hex) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return 250
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 250
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return Math.round(h * 360)
}

// "Match background to accent": re-hue the dark surfaces with the accent's
// hue at the same near-black lightness the stock theme uses — a subtly tinted
// dark theme instead of the fixed blue-violet one.
export function applyBackgroundTint(accentHex, enabled) {
  const root = document.documentElement
  const vars = ['--bg', '--surface-1', '--surface-2', '--surface-3']
  if (!enabled) {
    for (const v of vars) root.style.removeProperty(v)
    return
  }
  const h = hexHue(accentHex)
  root.style.setProperty('--bg',        `hsl(${h}, 28%, 4.7%)`)
  root.style.setProperty('--surface-1', `hsl(${h}, 26%, 6.9%)`)
  root.style.setProperty('--surface-2', `hsl(${h}, 25%, 7.8%)`)
  root.style.setProperty('--surface-3', `hsl(${h}, 22%, 10%)`)
}

export function AccentColorProvider({ children }) {
  const [accent, setAccentState] = useState('#a78bfa')
  const [bgTint, setBgTintState] = useState(false)

  useEffect(() => {
    const load = async () => {
      if (window.kozo?.api) {
        const [res, tintRes] = await Promise.all([
          window.kozo.api.settings.get('accent_color'),
          window.kozo.api.settings.get('bg_tint'),
        ])
        const hex = (res?.ok && res.data) ? res.data : accent
        const tint = tintRes?.ok && tintRes.data === '1'
        setAccentState(hex)
        setBgTintState(tint)
        applyAccent(hex)
        applyBackgroundTint(hex, tint)
      } else {
        applyAccent(accent)
      }
    }
    load()
  }, [])

  const setAccent = async (hex) => {
    setAccentState(hex)
    applyAccent(hex)
    applyBackgroundTint(hex, bgTint)
    if (window.kozo?.api) {
      await window.kozo.api.settings.set('accent_color', hex)
      // Push to the overlay window too — it's a separate BrowserWindow that won't
      // pick up the main app's CSS-var change on its own.
      window.kozo.api.overlay?.applyAccent?.(hex)
    }
  }

  const setBgTint = async (on) => {
    setBgTintState(on)
    applyBackgroundTint(accent, on)
    if (window.kozo?.api) {
      await window.kozo.api.settings.set('bg_tint', on ? '1' : '0')
    }
  }

  return (
    <AccentColorContext.Provider value={{ accent, setAccent, presets: PRESET_ACCENTS, bgTint, setBgTint }}>
      {children}
    </AccentColorContext.Provider>
  )
}

export function useAccentColor() {
  const ctx = useContext(AccentColorContext)
  if (!ctx) throw new Error('useAccentColor must be used inside AccentColorProvider')
  return ctx
}
