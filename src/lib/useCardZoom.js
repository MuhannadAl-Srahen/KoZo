import { useEffect, useState } from 'react'

// Ctrl + mouse wheel resizes the cards of a grid (Library, Game List). The
// grids read the column floor from --card-min, so the size is just a CSS
// variable; it is remembered per page and per view in localStorage.
const MIN = 120
const MAX = 380
const STEP = 16

function read(key) {
  try {
    const n = parseInt(localStorage.getItem(key), 10)
    return Number.isFinite(n) ? Math.min(MAX, Math.max(MIN, n)) : null
  } catch { return null }
}

export default function useCardZoom(pageKey, view, defaults = { big: 220, small: 168 }) {
  const storageKey = `kozo:cardsize:${pageKey}:${view}`
  const [size, setSize] = useState(() => read(storageKey))
  useEffect(() => { setSize(read(storageKey)) }, [storageKey])

  useEffect(() => {
    if (!(view in defaults)) return   // list view has no card grid
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()   // also stops Chromium's own Ctrl+wheel page zoom
      if (document.querySelector('[role="dialog"]')) return
      setSize(prev => {
        const base = prev ?? defaults[view]
        const next = Math.min(MAX, Math.max(MIN, base + (e.deltaY < 0 ? STEP : -STEP)))
        try { localStorage.setItem(storageKey, String(next)) } catch {}
        return next
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [storageKey, view])

  return size ? { '--card-min': `${size}px` } : undefined
}
