// Synthesized notification chimes for the overlay window (Web Audio — no
// bundled audio assets). Each play* is fire-and-forget and can never throw:
// sound is decoration, a broken AudioContext must not break a toast.

let _ctx = null
let _held = false
let _closeTimer = null

// Measured over a game: frames drop for a few seconds some 15 s after audio
// starts, and restarting a suspended context for each chime cost even more. So
// audio stays open for a whole game (holdAudio), started while it loads. It is
// closed between games: an open audio stream can keep Windows from sleeping.
function closeSoon() {
  clearTimeout(_closeTimer)
  _closeTimer = setTimeout(() => {
    if (_held || !_ctx) return
    _ctx.close().catch(() => {})
    _ctx = null
  }, 8000)
}

function ctx() {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!_ctx) _ctx = new AC()
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})
  if (!_held) closeSoon()   // a chime with no game running (a level-up after one)
  return _ctx
}

export function holdAudio() {
  _held = true
  clearTimeout(_closeTimer)
  try { ctx() } catch { /* sound is decoration */ }
}

export function releaseAudio() {
  _held = false
  closeSoon()
}

// One enveloped note: quick attack, exponential decay. A quiet triangle layer
// an octave up rounds out the plain sine so it reads as a "chime", not a beep.
function tone(c, t0, freq, dur, peak) {
  for (const [type, mult, gainMult] of [['sine', 1, 1], ['triangle', 2, 0.25]]) {
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq * mult, t0)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(peak * gainMult, t0 + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g).connect(c.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.05)
  }
}

// Achievement unlocked: bright two-note rise (A5 → E6).
export function playAchievement() {
  try {
    const c = ctx(); if (!c) return
    const t = c.currentTime
    tone(c, t, 880.0, 0.30, 0.10)
    tone(c, t + 0.10, 1318.5, 0.55, 0.12)
  } catch { /* never let sound break a toast */ }
}

// Level up: ascending E-major arpeggio with a held top note — more of a fanfare.
export function playLevelUp() {
  try {
    const c = ctx(); if (!c) return
    const t = c.currentTime
    tone(c, t, 659.3, 0.22, 0.09)
    tone(c, t + 0.12, 830.6, 0.22, 0.09)
    tone(c, t + 0.24, 987.8, 0.22, 0.09)
    tone(c, t + 0.36, 1318.5, 0.70, 0.12)
  } catch { /* ignore */ }
}

// Session started: soft low-key "game on" blip (C5 → G5), quieter than the rest.
export function playSessionStart() {
  try {
    const c = ctx(); if (!c) return
    const t = c.currentTime
    tone(c, t, 523.3, 0.18, 0.07)
    tone(c, t + 0.10, 784.0, 0.35, 0.08)
  } catch { /* ignore */ }
}
