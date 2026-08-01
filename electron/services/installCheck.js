'use strict'

// Reconcile games.is_installed against what's actually on disk.
//
// Why this exists: KoZo set is_installed when a game was added or scanned and
// then never revisited it. After a drive swap or a reinstall the library was
// full of games flagged installed whose folders were long gone — 15 of 24 in
// the case that prompted this. That's not cosmetic: the card stays bright, the
// Play button stays enabled, and clicking it either fails or hands a dead path
// to Steam. The UI already renders is_installed=0 correctly (dimmed card, "not
// installed" badge, no Play button) — it was just never being told the truth.
//
// Deliberately conservative:
//   • only ever flips the is_installed flag, never touches install_path,
//     exe_name, playtime, achievements or anything else;
//   • a game on a disconnected drive flips to not-installed and flips straight
//     back when the drive returns, which is exactly what "not available right
//     now" should look like;
//   • games with no install_path at all are left alone (nothing to check —
//     Steam-only entries are legitimately launchable via steam://).
//
// PERF: async fs.access, one per game, and gated on no session running (see
// main.js) — it must never walk the disk while a game is playing.

const fs = require('fs')
const logger = require('../logger')

async function exists(p) {
  try { await fs.promises.access(p); return true } catch { return false }
}

/**
 * Check every library game's install folder. Returns
 * { checked, nowMissing, nowFound, missing: [{id, name, install_path}] }.
 */
async function reconcile() {
  const { getDb } = require('../db/database')
  let db
  try { db = getDb() } catch { return { checked: 0, nowMissing: 0, nowFound: 0, missing: [] } }

  let games = []
  try {
    games = db.prepare(
      "SELECT id, name, install_path, exe_name, is_installed FROM games WHERE install_path IS NOT NULL AND install_path != ''"
    ).all()
  } catch { return { checked: 0, nowMissing: 0, nowFound: 0, missing: [] } }

  const setFlag = db.prepare('UPDATE games SET is_installed = ? WHERE id = ?')
  const changed = []
  const missing = []

  for (const g of games) {
    const there = await exists(g.install_path)
    if (!there) missing.push({ id: g.id, name: g.name, install_path: g.install_path })
    const want = there ? 1 : 0
    if ((g.is_installed === 1 ? 1 : 0) === want) continue
    try { setFlag.run(want, g.id); changed.push({ id: g.id, name: g.name, want }) } catch {}
  }

  const nowMissing = changed.filter(c => c.want === 0).length
  const nowFound   = changed.filter(c => c.want === 1).length

  if (changed.length) {
    logger.info(
      `installCheck: ${nowMissing} game(s) marked not-installed (folder gone), ` +
      `${nowFound} marked installed again`,
      { games: changed.map(c => `${c.name}${c.want ? '' : ' (missing)'}`) }
    )
    // Refresh every window so the Library re-renders with honest state.
    try {
      const { BrowserWindow } = require('electron')
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) for (const c of changed) w.webContents.send('game:updated', c.id)
      }
    } catch {}
  }

  return { checked: games.length, nowMissing, nowFound, missing }
}

module.exports = { reconcile }
