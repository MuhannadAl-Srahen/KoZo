import { useEffect, useState } from 'react'

// Steam art for a game (steamApi.getAppAssets via `steam:appAssets`): the real
// header / hero / capsule / portrait URLs, hashed paths included. Shared by
// every page and popup, so a card and the window it opens always show the
// same art. Requests are batched (one call for a whole Play Plan month, not
// one per card), and a failed call is retried instead of remembered as "no art".
const cache = new Map()      // appid -> art object | null (Steam has none)
const waiting = new Map()    // appid -> Set of callbacks
let queue = new Set()
let timer = null

function deliver(id, art) {
  cache.set(id, art)
  for (const cb of waiting.get(id) || []) cb(art)
  waiting.delete(id)
}

async function flush(ids, attempt = 0) {
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    let res = null
    try { res = await window.kozo?.api?.steam?.appAssets?.(batch) } catch {}
    if (!res?.ok) {
      // Busy or offline: try again later, never cache the failure.
      if (attempt < 2) setTimeout(() => flush(batch, attempt + 1), 1500 * (attempt + 1))
      else for (const id of batch) waiting.delete(id)
      continue
    }
    for (const id of batch) {
      const a = res.data?.[id] || res.data?.[String(id)] || null
      deliver(id, a ? { header: a.header || null, hero: a.hero || null, capsule: a.capsule || null, portrait: a.portrait || null } : null)
    }
  }
}

export function loadSteamArt(appId, cb) {
  const id = Number(appId)
  if (!id) return () => {}
  if (cache.has(id)) { cb(cache.get(id)); return () => {} }
  if (!waiting.has(id)) waiting.set(id, new Set())
  waiting.get(id).add(cb)
  queue.add(id)
  clearTimeout(timer)
  timer = setTimeout(() => { const ids = [...queue]; queue = new Set(); flush(ids) }, 30)
  return () => waiting.get(id)?.delete(cb)
}

export function steamArtNow(appId) { return cache.get(Number(appId)) || null }

// The art for one game, or null while loading / when Steam has none.
export function useSteamArt(appId) {
  const [art, setArt] = useState(() => steamArtNow(appId))
  useEffect(() => {
    setArt(steamArtNow(appId))
    return loadSteamArt(appId, setArt)
  }, [appId])
  return art
}
