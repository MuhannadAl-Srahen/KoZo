'use strict'

// Open KoZo from the controller: hold a button combo for one second, from
// anywhere, even while KoZo sits closed in the tray. The combo is the setting
// `pad_wake_combo` (Settings > Shortcuts): the Xbox button (default),
// LB + RB + Menu, View + Menu, or off. The Xbox button is only reported by the
// undocumented XInputGetStateEx (ordinal 100); where that call is missing the
// Xbox choice falls back to LB + RB + Menu.
//
// The renderer Gamepad API can't see a pad while the window is hidden (or
// destroyed after 60s in the tray), so the reading happens in desktopProbe.js,
// which reports "WAKE" once per one-second hold.

const logger = require('../logger')

const MENU  = 0x0010
const VIEW  = 0x0020
const LB    = 0x0100
const RB    = 0x0200
const GUIDE = 0x0400

const COMBOS = {
  guide:    GUIDE,
  lbrbmenu: LB | RB | MENU,
  viewmenu: VIEW | MENU,
}
const DEFAULT_COMBO = 'guide'
let combo = DEFAULT_COMBO
let onWake = null

function readCombo() {
  try {
    const v = require('../db/queries/settings').getSetting('pad_wake_combo')
    if (v === 'off' || COMBOS[v]) return v
  } catch {}
  return DEFAULT_COMBO
}

function start(handler) {
  if (process.platform !== 'win32') return   // XInput is Windows-only
  onWake = handler
  combo = readCombo()
  require('./desktopProbe').start()
}

// Settings > Shortcuts changed the combo: restart the probe with it.
function setCombo(v) {
  if (process.platform !== 'win32') return
  const next = (v === 'off' || COMBOS[v]) ? v : DEFAULT_COMBO
  if (next === combo) return
  combo = next
  require('./desktopProbe').restart()
}

function stop() {
  require('./desktopProbe').stop()
}

function isOn() { return !!COMBOS[combo] }

function masks() {
  return { mask: COMBOS[combo] || 0, fallback: combo === 'guide' ? COMBOS.lbrbmenu : 0 }
}

function fire() {
  try { onWake?.() } catch (e) { logger.warn('controllerWake: ' + e.message) }
}

module.exports = { start, stop, setCombo, isOn, masks, fire }
