import React, { useEffect, useState } from 'react'
import s from './GamepadHints.module.css'

// The controller legend at the bottom of the window, shown while a controller
// is driving KoZo (lib/gamepadNav.js sends `kozo:gamepad`). It changes with
// what's open: the page, a dialog or a right-click menu.
const HINTS = {
  page:   [['A', 'Select'], ['B', 'Back'], ['X', 'Options'], ['Y', 'Search'], ['LB RB', 'Tabs'], ['LT RT', 'Views']],
  dialog: [['A', 'Select'], ['B', 'Close']],
  menu:   [['A', 'Select'], ['B', 'Close']],
  big:    [['A', 'Open'], ['X', 'Options'], ['B', 'Back'], ['Y', 'Search'], ['LB RB', 'Tabs']],   // Big Picture
}

// Appearance > Big Picture > Buttons: PlayStation draws the same buttons as its own
// shapes (the cross is where A is), and the bumpers and triggers as L1 R1 L2 R2.
const PS = { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2' }
const ps = () => document.documentElement.dataset.padGlyphs === 'playstation'

function Glyph({ k }) {
  const name = (x) => (ps() ? PS[x] || x : x)
  if (k.includes(' ')) return <span className={s.pair}>{k.split(' ').map(x => <span key={x} className={s.bumper}>{name(x)}</span>)}</span>
  return <span className={`${s.face} ${s[(ps() ? 'ps' : 'face') + k]}`}>{name(k)}</span>
}

export default function GamepadHints() {
  const [state, setState] = useState({ active: false, scope: 'page' })
  useEffect(() => {
    const on = (e) => setState(e.detail || { active: false, scope: 'page' })
    window.addEventListener('kozo:gamepad', on)
    return () => window.removeEventListener('kozo:gamepad', on)
  }, [])
  // Big Picture's Customize (button shapes, hint bar) applies the moment it changes.
  const [, redraw] = useState(0)
  useEffect(() => {
    const mo = new MutationObserver(() => redraw(n => n + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-pad-glyphs', 'data-bp-hints'] })
    return () => mo.disconnect()
  }, [])
  if (!state.active) return null
  // Big Picture's Customize can turn the bar off.
  if (document.documentElement.hasAttribute('data-bigpicture') && document.documentElement.dataset.bpHints === 'off') return null
  return (
    <div className={s.bar} role="note" aria-label="Controller buttons">
      {(HINTS[state.scope === 'page' && document.documentElement.hasAttribute('data-bigpicture') ? 'big' : state.scope] || HINTS.page).map(([k, label]) => (
        <span key={k} className={s.hint}><Glyph k={k} />{label}</span>
      ))}
    </div>
  )
}
