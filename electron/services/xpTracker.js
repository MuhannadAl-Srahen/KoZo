const logger = require('../logger')

// ── Level-up / XP-gain detection ─────────────────────────────────────────────
// XP itself is always derived on read (services/xp.js) — this module just
// remembers the last total/level seen (settings table) and diffs after every
// XP-earning event (session end, achievement unlock, game finished). A level-up
// fires ONE overlay toast + ONE in-app broadcast; the "+N XP" gain is returned
// to the caller (processWatcher shows it in the session-end overlay summary).

function settingsQ() { return require('../db/queries/settings') }

function readLast() {
  try {
    const total = parseInt(settingsQ().getSetting('xp_last_total'))
    const level = parseInt(settingsQ().getSetting('xp_last_level'))
    return {
      total: Number.isFinite(total) ? total : null,
      level: Number.isFinite(level) ? level : null,
    }
  } catch { return { total: null, level: null } }
}

function writeLast(total, level) {
  try {
    settingsQ().setSetting('xp_last_total', String(total))
    settingsQ().setSetting('xp_last_level', String(level))
  } catch {}
}

function broadcast(channel, payload) {
  try {
    const { BrowserWindow } = require('electron')
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  } catch {}
}

/**
 * Recompute XP, diff against the last-seen values, persist, and notify on
 * level-up. Returns { gained, totalXp, level, tier, leveledUp, toNextLevel,
 * nextTier } for the caller. `reason` is for logs; `gameName` flavors the toast.
 */
function check({ reason = 'unknown', gameName = null, artPath = null, artUrl = null } = {}) {
  let xp
  try { xp = require('./xp').computeXp() } catch (e) {
    logger.warn('xpTracker: computeXp failed', { message: e.message })
    return null
  }

  const last = readLast()
  writeLast(xp.totalXp, xp.level)

  // First run ever — establish the baseline silently (no retroactive toasts).
  if (last.total == null || last.level == null) {
    return { gained: 0, totalXp: xp.totalXp, level: xp.level, tier: xp.tier, leveledUp: false, toNextLevel: xp.toNextLevel, nextTier: xp.nextTier }
  }

  const gained = Math.max(0, xp.totalXp - last.total)
  const leveledUp = xp.level > last.level

  if (leveledUp) {
    const payload = {
      level: xp.level,
      previousLevel: last.level,
      tier: xp.tier,
      totalXp: xp.totalXp,
      toNextLevel: xp.toNextLevel,
      gameName,
      artPath,
      artUrl,
    }
    logger.info(`Level up! ${last.level} → ${xp.level} (${xp.tier})`, { reason })
    try { require('../overlayWindow').sendLevelUp(payload) } catch {}
    broadcast('xp:levelup', payload)
  }

  return { gained, totalXp: xp.totalXp, level: xp.level, tier: xp.tier, leveledUp, toNextLevel: xp.toNextLevel, nextTier: xp.nextTier }
}

module.exports = { check }
