'use strict'

// Open KoZo from the controller: hold a button combo, from anywhere, even while KoZo
// sits closed in the tray. The combo is the setting `pad_wake_combo` (Settings >
// Shortcuts): the Xbox button (default), LB + RB + Menu, View + Menu, a combo the user
// recorded (`custom:<buttons>`), or off. The hold time is `pad_wake_hold_ms` (500,
// 1000 or 2000; 1000 by default).
//
// The Xbox button is only reported by the undocumented XInputGetStateEx (ordinal 100),
// and a quick press of it belongs to Game Bar or Steam, which can take it. So with the
// Xbox button, LB + RB + Menu always works too (the probe accepts either). It used to
// apply only when XInputGetStateEx was missing, which never happens on Windows 10/11,
// so a pad that didn't report the Xbox button couldn't open KoZo at all.
//
// The renderer Gamepad API can't see a pad while the window is hidden (or
// destroyed after 60s in the tray), so the reading happens in desktopProbe.js,
// which reports "WAKE" once per hold. It also reports connected slots (P+/P-) and,
// while Settings records a combo, the held buttons (B).

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
const HOLDS = [500, 1000, 2000]
const DEFAULT_HOLD = 1000
// XInput's button bits (d-pad, Menu, View, sticks, bumpers, Xbox, A B X Y). Triggers
// aren't buttons in XInput, so they can't be part of a combo.
const BUTTON_BITS = 0xF7FF

let combo = DEFAULT_COMBO
let holdMs = DEFAULT_HOLD
let onWake = null
let testUntil = 0
let recordTimer = null
const slots = new Set()

// Pure: a saved combo value into its button mask, or 0 for none.
function comboMask(v) {
  if (COMBOS[v]) return COMBOS[v]
  const m = /^custom:(\d+)$/.exec(String(v || ''))
  if (!m) return 0
  const mask = Number(m[1]) & BUTTON_BITS
  // At least two buttons, so a single press never opens KoZo by accident
  // (the Xbox button alone is the one exception, and has its own choice).
  return mask && (mask & (mask - 1)) ? mask : 0
}

function normalize(v) {
  if (v === 'off') return 'off'
  return comboMask(v) ? String(v) : DEFAULT_COMBO
}

function readSettings() {
  try {
    const q = require('../db/queries/settings')
    combo = normalize(q.getSetting('pad_wake_combo') || DEFAULT_COMBO)
    const h = parseInt(q.getSetting('pad_wake_hold_ms'))
    holdMs = HOLDS.includes(h) ? h : DEFAULT_HOLD
  } catch {}
}

function start(handler) {
  if (process.platform !== 'win32') return   // XInput is Windows-only
  onWake = handler
  readSettings()
  require('./desktopProbe').start()
}

// Settings > Shortcuts changed the combo or the hold time: the probe takes them over
// stdin, no restart (a restart compiles its C# again).
function apply() {
  require('./desktopProbe').setMasks(masks())
}
function setCombo(v) {
  if (process.platform !== 'win32') return
  const next = normalize(v)
  if (next === combo) return
  combo = next
  logger.info('controllerWake: combo set', { combo })
  apply()
}
function setHold(ms) {
  if (process.platform !== 'win32') return
  const next = HOLDS.includes(Number(ms)) ? Number(ms) : DEFAULT_HOLD
  if (next === holdMs) return
  holdMs = next
  apply()
}

function stop() {
  require('./desktopProbe').stop()
}

function isOn() { return combo !== 'off' && !!comboMask(combo) }

function masks() {
  if (!isOn()) return { mask: 0, fallback: 0, holdMs }
  return { mask: comboMask(combo), fallback: combo === 'guide' ? COMBOS.lbrbmenu : 0, holdMs }
}

function broadcast(channel, payload) {
  for (const w of require('electron').BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, payload) } catch {}
  }
}

function fire() {
  // Settings' "Test your combo": tell the page, don't open Big Picture over it.
  if (Date.now() < testUntil) {
    testUntil = 0
    logger.info('controllerWake: test combo held')
    broadcast('controller:wakeTest', { ok: true })
    return
  }
  logger.info('controllerWake: wake combo held')
  try { onWake?.() } catch (e) { logger.warn('controllerWake: ' + e.message) }
}

// Settings: the next hold within 20 s is a test.
function test() {
  testUntil = Date.now() + 20000
  if (!require('./desktopProbe').isRunning()) require('./desktopProbe').refresh()
  return { until: testUntil, running: require('./desktopProbe').isRunning() }
}

// Settings: report the held buttons for 20 s (or until stopped) to record a combo.
function record(on) {
  clearTimeout(recordTimer)
  require('./desktopProbe').setRecording(!!on)
  if (on) recordTimer = setTimeout(() => record(false), 20000)
  return true
}

function onButtons(buttons) {
  broadcast('controller:buttons', Number(buttons) & BUTTON_BITS)
}

function onSlot(slot, connected) {
  const had = slots.has(slot)
  if (connected) slots.add(slot); else slots.delete(slot)
  if (had !== connected) {
    logger.info(`controller ${connected ? 'connected' : 'disconnected'}`, { slot: slot + 1 })
    broadcast('controller:slots', [...slots].sort())
  }
}

// A wake that opened (or created) the main window. The window's page asks for it once it
// has loaded (App.jsx via gamepadNav), so a window made from scratch can't miss it: the
// event sent at did-finish-load could arrive before React's listener existed.
let pendingWake = null
function setPendingWake(info) { pendingWake = { ...info, at: Date.now() } }
function takeWake() {
  const w = pendingWake
  pendingWake = null
  return w && Date.now() - w.at < 5000 ? w : null
}

function status() {
  return {
    combo, holdMs, on: isOn(),
    slots: [...slots].sort(),
    probe: require('./desktopProbe').isRunning(),
  }
}

module.exports = {
  start, stop, setCombo, setHold, isOn, masks, fire, test, record, onButtons, onSlot, status,
  setPendingWake, takeWake,
  comboMask, BUTTON_BITS,
}
