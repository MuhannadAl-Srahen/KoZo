// Controller navigation v1 — browse KoZo from the couch.
//
//   D-pad / left stick : move the focus ring across cards & nav items
//   A (button 0)       : activate the focused element (click)
//   B (button 1)       : go back
//   LB / RB (4 / 5)    : cycle main pages
//
// Focusable targets are any visible element carrying `data-gpnav`. The focus
// ring is the `.gpFocus` class; any mouse or keyboard input hides it. Polling
// runs ONLY while a gamepad is connected.

const ROUTES = ['/', '/game-list', '/achievements', '/upcoming', '/sessions', '/statistics', '/profile']

const POLL_MS = 90
const FIRST_REPEAT_MS = 350
const REPEAT_MS = 140
const STICK_THRESHOLD = 0.55

let _interval = null
let _navigate = null
let _focused = null            // currently ringed element
let _heldDir = null            // direction currently held
let _nextRepeatAt = 0
let _prevButtons = []          // previous pressed-state per button index

function connected() {
  try {
    return Array.from(navigator.getGamepads?.() || []).some(g => g && g.connected)
  } catch { return false }
}

function clearFocus() {
  if (_focused) {
    _focused.classList.remove('gpFocus')
    _focused = null
  }
}

function setFocus(el) {
  clearFocus()
  if (!el) return
  _focused = el
  el.classList.add('gpFocus')
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch {}
}

function visibleTargets() {
  return Array.from(document.querySelectorAll('[data-gpnav]'))
    .filter(el => el.offsetParent !== null)
}

// Geometric nearest neighbour in `dir` from the current focus rect.
function moveFocus(dir) {
  const targets = visibleTargets()
  if (!targets.length) return
  if (!_focused || !document.contains(_focused) || _focused.offsetParent === null) {
    setFocus(targets[0])
    return
  }
  const from = _focused.getBoundingClientRect()
  const fx = from.left + from.width / 2
  const fy = from.top + from.height / 2

  let best = null
  let bestScore = Infinity
  for (const el of targets) {
    if (el === _focused) continue
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const dx = cx - fx
    const dy = cy - fy
    let primary, cross
    if (dir === 'left')       { primary = -dx; cross = Math.abs(dy) }
    else if (dir === 'right') { primary = dx;  cross = Math.abs(dy) }
    else if (dir === 'up')    { primary = -dy; cross = Math.abs(dx) }
    else                      { primary = dy;  cross = Math.abs(dx) }
    if (primary < 8) continue                 // must actually be in that direction
    const score = primary + cross * 2         // bias against sideways drift
    if (score < bestScore) { bestScore = score; best = el }
  }
  if (best) setFocus(best)
}

function readDirection(gp) {
  const b = gp.buttons
  if (b[12]?.pressed) return 'up'
  if (b[13]?.pressed) return 'down'
  if (b[14]?.pressed) return 'left'
  if (b[15]?.pressed) return 'right'
  const x = gp.axes?.[0] ?? 0
  const y = gp.axes?.[1] ?? 0
  if (Math.abs(x) >= Math.abs(y)) {
    if (x <= -STICK_THRESHOLD) return 'left'
    if (x >=  STICK_THRESHOLD) return 'right'
  } else {
    if (y <= -STICK_THRESHOLD) return 'up'
    if (y >=  STICK_THRESHOLD) return 'down'
  }
  return null
}

function justPressed(gp, index) {
  const now = !!gp.buttons[index]?.pressed
  const was = !!_prevButtons[index]
  return now && !was
}

function poll() {
  const gp = Array.from(navigator.getGamepads?.() || []).find(g => g && g.connected)
  if (!gp) return

  // Directional movement with hold-repeat.
  const dir = readDirection(gp)
  const now = Date.now()
  if (dir) {
    if (dir !== _heldDir) {
      _heldDir = dir
      moveFocus(dir)
      _nextRepeatAt = now + FIRST_REPEAT_MS
    } else if (now >= _nextRepeatAt) {
      moveFocus(dir)
      _nextRepeatAt = now + REPEAT_MS
    }
  } else {
    _heldDir = null
  }

  // A — activate; B — back; LB/RB — cycle pages.
  if (justPressed(gp, 0) && _focused && document.contains(_focused)) {
    _focused.click()
  }
  if (justPressed(gp, 1)) {
    _navigate?.(-1)
  }
  if (justPressed(gp, 4) || justPressed(gp, 5)) {
    const cur = window.location.hash.replace(/^#/, '') || '/'
    const idx = Math.max(0, ROUTES.indexOf(cur.split('?')[0]))
    const next = justPressed(gp, 5)
      ? ROUTES[(idx + 1) % ROUTES.length]
      : ROUTES[(idx - 1 + ROUTES.length) % ROUTES.length]
    _navigate?.(next)
    clearFocus()
  }

  _prevButtons = gp.buttons.map(x => !!x?.pressed)
}

function startPolling() {
  if (_interval) return
  _interval = setInterval(poll, POLL_MS)
}

function stopPolling() {
  clearInterval(_interval)
  _interval = null
  _prevButtons = []
  _heldDir = null
  clearFocus()
}

export function initGamepadNav({ navigate }) {
  _navigate = navigate

  const onConnect = () => startPolling()
  const onDisconnect = () => { if (!connected()) stopPolling() }
  // Any mouse/keyboard input hides the controller focus ring.
  const onHumanInput = () => clearFocus()

  window.addEventListener('gamepadconnected', onConnect)
  window.addEventListener('gamepaddisconnected', onDisconnect)
  window.addEventListener('mousemove', onHumanInput, { passive: true })
  window.addEventListener('keydown', onHumanInput, { passive: true })

  if (connected()) startPolling()

  return () => {
    stopPolling()
    _navigate = null
    window.removeEventListener('gamepadconnected', onConnect)
    window.removeEventListener('gamepaddisconnected', onDisconnect)
    window.removeEventListener('mousemove', onHumanInput)
    window.removeEventListener('keydown', onHumanInput)
  }
}
