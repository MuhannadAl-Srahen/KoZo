import React, { useEffect, useState } from 'react'
import s from './GamepadHints.module.css'

// The controller legend at the bottom of the window, shown while a controller
// is driving KoZo (lib/gamepadNav.js sends `kozo:gamepad`). It changes with
// what's open: the page, a dialog or a right-click menu.
const HINTS = {
  page:   [['A', 'Select'], ['B', 'Back'], ['X', 'Options'], ['Y', 'Search'], ['LB RB', 'Tabs'], ['LT RT', 'Views']],
  dialog: [['A', 'Select'], ['B', 'Close']],
  menu:   [['A', 'Select'], ['B', 'Close']],
}

function Glyph({ k }) {
  if (k.includes(' ')) return <span className={s.pair}>{k.split(' ').map(x => <span key={x} className={s.bumper}>{x}</span>)}</span>
  return <span className={`${s.face} ${s['face' + k]}`}>{k}</span>
}

export default function GamepadHints() {
  const [state, setState] = useState({ active: false, scope: 'page' })
  useEffect(() => {
    const on = (e) => setState(e.detail || { active: false, scope: 'page' })
    window.addEventListener('kozo:gamepad', on)
    return () => window.removeEventListener('kozo:gamepad', on)
  }, [])
  if (!state.active) return null
  return (
    <div className={s.bar} role="note" aria-label="Controller buttons">
      {(HINTS[state.scope] || HINTS.page).map(([k, label]) => (
        <span key={k} className={s.hint}><Glyph k={k} />{label}</span>
      ))}
    </div>
  )
}
