// Controller navigation v2: drive all of KoZo from the couch.
//
//   D-pad / left stick : move the focus ring (cards, buttons, tabs, fields)
//   A                  : select (a text field gets focus)
//   B                  : close the open menu or dialog, else go back
//   X                  : options (the focused card's right-click menu)
//   Y                  : jump to the page's search box
//   LB / RB            : previous / next sidebar tab
//   LT / RT            : previous / next tab inside the page
//   Right stick        : scroll
//   Menu               : Settings
//
// Targets are cards carrying `data-gpnav` plus ordinary focusable controls;
// a control inside a card is skipped so each card is one stop. While a menu
// or dialog is open only its controls count. The ring is the `data-gpfocus`
// attribute (not a class: React rewrites className on re-render and would drop
// it); real mouse or keyboard input hides it and the hint bar. Polling runs
// ONLY after the first `gamepadconnected` (or a View + Menu wake from the
// main process), and pauses while the window is hidden or unfocused.

const POLL_MS = 90
const FIRST_REPEAT_MS = 350
const REPEAT_MS = 140
const STICK_THRESHOLD = 0.55
const SCROLL_DEADZONE = 0.2
const SCROLL_SPEED = 26        // px per poll at full tilt

const SELECTOR = [
  '[data-gpnav]', 'button', 'a[href]', 'input:not([type="hidden"])', 'textarea', 'select',
  '[role="tab"]', '[role="radio"]', '[role="option"]', '[tabindex="0"]',
].join(',')

const B = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9 }

let _interval = null
let _navigate = null
let _focused = null
let _heldDir = null
let _nextRepeatAt = 0
let _prevButtons = []
let _scopeEl = null            // the menu/dialog (or null = page) targets come from
let _active = false            // controller in use: ring + hint bar shown
// Set by the first `gamepadconnected` event, which Chromium fires on a pad's
// first button press. Until then KoZo never calls navigator.getGamepads():
// calling it makes Chromium start polling every controller (virtual ones from
// Steam Input or DS4Windows included) for the rest of the session.
let _padSeen = false

function connected() {
  try {
    return Array.from(navigator.getGamepads?.() || []).some(g => g && g.connected)
  } catch { return false }
}

// The hint bar (components/GamepadHints.jsx) follows this.
function announce() {
  const kind = !_scopeEl ? 'page' : _scopeEl.getAttribute('role') === 'menu' ? 'menu' : 'dialog'
  window.dispatchEvent(new CustomEvent('kozo:gamepad', { detail: { active: _active, scope: kind } }))
}

function setActive(on) {
  if (_active === on) return
  _active = on
  document.documentElement.toggleAttribute('data-gamepad', on)
  announce()
}

function clearFocus() {
  if (_focused) {
    _focused.removeAttribute('data-gpfocus')
    _focused = null
  }
}

function setFocus(el) {
  clearFocus()
  if (!el) return
  _focused = el
  el.setAttribute('data-gpfocus', '')
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }) } catch {}
}

// The open menu (its flyout first) or the top dialog; null for the page.
function currentScope() {
  const menus = document.querySelectorAll('[role="menu"]')
  if (menus.length) return menus[menus.length - 1]
  const dialogs = document.querySelectorAll('[role="dialog"]')
  if (dialogs.length) return dialogs[dialogs.length - 1]
  return null
}

function isShown(el) {
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return false
  const cs = getComputedStyle(el)
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none'
}

function visibleTargets() {
  const root = _scopeEl || document
  return Array.from(root.querySelectorAll(SELECTOR)).filter(el => {
    const card = el.parentElement?.closest('[data-gpnav]')
    if (card && card !== el && root.contains(card)) return false   // one stop per card
    return isShown(el)
  })
}

// Keep the scope in step with what's open; a new menu or dialog takes the
// ring to its first control, closing one puts it back on the page.
function syncScope() {
  const scope = currentScope()
  if (scope === _scopeEl) return
  _scopeEl = scope
  announce()
  if (!_active) return
  if (scope) {
    const t = visibleTargets()
    setFocus(t.find(el => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true') || t[0] || null)
  } else if (_focused && !document.contains(_focused)) {
    clearFocus()
  }
}

// Geometric nearest neighbour in `dir` from the current focus rect.
function moveFocus(dir) {
  const targets = visibleTargets()
  if (!targets.length) return
  if (!_focused || !document.contains(_focused) || !targets.includes(_focused)) {
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
  if (best) { setFocus(best); return }
  // Left from a flyout with nothing further left: back to its parent menu.
  if (dir === 'left' && document.querySelectorAll('[role="menu"]').length > 1) pressEscape()
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
  return !!gp.buttons[index]?.pressed && !_prevButtons[index]
}

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
}

function activate() {
  if (!_focused || !document.contains(_focused)) { moveFocus('down'); return }
  const tag = _focused.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { _focused.focus(); return }
  // A card's own click target (cover button) when it marks one.
  const inner = _focused.matches('[data-gpnav]') ? _focused.querySelector('[data-gpclick]') : null
  ;(inner || _focused).click()
}

// X: the focused card's right-click menu, opened at its centre.
function openOptions() {
  const el = _focused?.closest?.('[data-gpnav]') || _focused
  if (!el || !document.contains(el)) return
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2,
    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + Math.min(r.height / 2, 80)),
  }))
}

function focusSearch() {
  const box = document.querySelector('.app-main input[type="search"], .app-main input[placeholder^="Search" i]')
  if (box) { setFocus(box); box.focus() }
}

function cycleSidebar(step) {
  const links = Array.from(document.querySelectorAll('aside a[data-tour^="nav-"]'))
    .filter(a => a.dataset.tour !== 'nav-settings' && isShown(a))
  if (!links.length) return
  const cur = links.findIndex(a => a.classList.contains('active') || a.getAttribute('aria-current') === 'page')
  const next = links[(Math.max(0, cur) + step + links.length) % links.length]
  next.click()
  clearFocus()
}

function cycleInPageTabs(step) {
  const lists = Array.from(document.querySelectorAll('.app-main [role="tablist"]')).filter(isShown)
  const list = lists[0]
  if (!list) return
  const tabs = Array.from(list.querySelectorAll('[role="tab"]')).filter(isShown)
  if (!tabs.length) return
  const cur = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true')
  const next = tabs[(Math.max(0, cur) + step + tabs.length) % tabs.length]
  next.click()
  setFocus(next)
}

function scrollable(n) {
  return n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)
}

// Right stick: scroll the open dialog, else the panel around the ring, else
// the first scrolling panel of the page.
function scrollBy(dy) {
  let el = null
  if (_scopeEl) el = scrollable(_scopeEl) ? _scopeEl : Array.from(_scopeEl.querySelectorAll('*')).find(scrollable)
  if (!el) {
    let p = _focused?.parentElement
    while (p && p !== document.body) { if (scrollable(p)) { el = p; break } p = p.parentElement }
  }
  if (!el) el = Array.from(document.querySelectorAll('.app-main *')).find(scrollable)
  el?.scrollBy({ top: dy })
}

function poll() {
  const gp = Array.from(navigator.getGamepads?.() || []).find(g => g && g.connected)
  if (!gp) return
  syncScope()

  const pressedAny = gp.buttons.some(b => b?.pressed) || (gp.axes || []).some(a => Math.abs(a) > STICK_THRESHOLD)
  if (pressedAny && !_active) {
    setActive(true)
    if (!_focused) { _prevButtons = gp.buttons.map(x => !!x?.pressed); moveFocus('down'); return }
  }

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

  const ry = gp.axes?.[3] ?? 0
  if (Math.abs(ry) > SCROLL_DEADZONE) scrollBy(ry * SCROLL_SPEED)

  if (justPressed(gp, B.A)) activate()
  if (justPressed(gp, B.B)) {
    if (_scopeEl) pressEscape()
    else { _navigate?.(-1); clearFocus() }
  }
  if (justPressed(gp, B.X)) openOptions()
  if (justPressed(gp, B.Y) && !_scopeEl) focusSearch()
  if (!_scopeEl) {
    if (justPressed(gp, B.LB)) cycleSidebar(-1)
    if (justPressed(gp, B.RB)) cycleSidebar(1)
    if (justPressed(gp, B.LT)) cycleInPageTabs(-1)
    if (justPressed(gp, B.RT)) cycleInPageTabs(1)
    if (justPressed(gp, B.MENU)) { _navigate?.('/settings'); clearFocus() }
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
}

export function initGamepadNav({ navigate }) {
  _navigate = navigate

  const onConnect = () => { _padSeen = true; if (document.visibilityState === 'visible') startPolling() }
  const onDisconnect = () => { if (!connected()) { stopPolling(); clearFocus(); setActive(false); _padSeen = false } }
  // Real mouse or keyboard input hides the ring and the hint bar. Our own
  // synthetic Escape / contextmenu events are untrusted and don't count.
  const onHumanInput = (e) => { if (!e.isTrusted) return; clearFocus(); setActive(false) }
  // Chromium sends a trusted "fake" mousemove whenever the page scrolls or
  // reflows under a still cursor (which moving the ring does), so only a real
  // movement of a few pixels counts.
  let lastX = null, lastY = null
  const onMouseMove = (e) => {
    const moved = lastX == null || Math.abs(e.screenX - lastX) + Math.abs(e.screenY - lastY) > 3
    lastX = e.screenX; lastY = e.screenY
    if (moved) onHumanInput(e)
  }
  // The window is very often hidden behind a fullscreen game while a
  // controller stays connected; no reason to poll for navigation nobody can
  // see. Pause on hide/blur, resume on show/focus (only if a pad is there).
  const onHidden = () => stopPolling()
  const onVisible = () => { if (_padSeen && connected()) startPolling() }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') onVisible()
    else onHidden()
  }
  // View + Menu held while KoZo was in the tray (main process): the pad is
  // certainly there, so start driving at once.
  const offWake = window.kozo?.events?.onGamepadWake?.(() => {
    _padSeen = true
    startPolling()
    setActive(true)
    setTimeout(() => { if (!_focused) moveFocus('down') }, 300)
  })

  window.addEventListener('gamepadconnected', onConnect)
  window.addEventListener('gamepaddisconnected', onDisconnect)
  window.addEventListener('mousemove', onMouseMove, { passive: true })
  window.addEventListener('mousedown', onHumanInput, { passive: true })
  window.addEventListener('keydown', onHumanInput, { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('blur', onHidden)
  window.addEventListener('focus', onVisible)

  return () => {
    stopPolling()
    clearFocus()
    _navigate = null
    offWake?.()
    window.removeEventListener('gamepadconnected', onConnect)
    window.removeEventListener('gamepaddisconnected', onDisconnect)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mousedown', onHumanInput)
    window.removeEventListener('keydown', onHumanInput)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('blur', onHidden)
    window.removeEventListener('focus', onVisible)
  }
}
