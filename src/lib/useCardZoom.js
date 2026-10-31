import { useEffect, useState } from 'react'

// Ctrl + mouse wheel resizes the cards of a grid (Library, Game List, Upcoming,
// Steam calendar, Achievements, Profile). The grids read the column floor from
// --card-min, so the size is just a CSS variable; it is remembered per page and
// per view in localStorage. Limits default to 0.6x..1.7x of the view's default
// size, so small posters and wide cards both stay usable.
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)) }

// How many card grids are listening right now. Pages without one get the
// App-wide fallback instead: Ctrl + wheel changes the UI scale (App.jsx).
let activeGrids = 0
export function cardZoomActive() { return activeGrids > 0 }

function read(key, min, max) {
  try {
    const n = parseInt(localStorage.getItem(key), 10)
    return Number.isFinite(n) ? clamp(n, min, max) : null
  } catch { return null }
}

export default function useCardZoom(pageKey, view, defaults = { big: 220, small: 168 }, opts = {}) {
  const base = defaults[view]
  const min = opts.min ?? Math.round((base || 160) * 0.6)
  const max = opts.max ?? Math.round((base || 160) * 1.7)
  const step = opts.step ?? Math.max(8, Math.round((base || 160) / 14))
  const storageKey = `kozo:cardsize:${pageKey}:${view}`
  const [size, setSize] = useState(() => read(storageKey, min, max))
  useEffect(() => { setSize(read(storageKey, min, max)) }, [storageKey])

  useEffect(() => {
    if (!base) return   // list view has no card grid
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()   // also stops Chromium's own Ctrl+wheel page zoom
      if (document.querySelector('[role="dialog"]')) return
      setSize(prev => {
        const next = clamp((prev ?? base) + (e.deltaY < 0 ? step : -step), min, max)
        try { localStorage.setItem(storageKey, String(next)) } catch {}
        return next
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    activeGrids++
    return () => { activeGrids--; window.removeEventListener('wheel', onWheel) }
  }, [storageKey, base, min, max, step])

  return size ? { '--card-min': `${size}px` } : undefined
}
