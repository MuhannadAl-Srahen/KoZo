// The saved look ({ appearance, accent }: the raw settings), read once and synchronously
// (preload ui.bootLook -> ipc 'look:boot') so the first frame already has the user's theme
// and accent. Read later, KoZo opened in the default purple for a moment on every start.
// Never read at import time: the overlay imports the accent code and has no use for it.
let cached

export function bootLook() {
  if (cached !== undefined) return cached
  try { cached = window.kozo?.ui?.bootLook?.() || null } catch { cached = null }
  return cached
}
