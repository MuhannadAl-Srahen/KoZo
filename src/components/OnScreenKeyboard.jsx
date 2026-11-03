import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { IconBackspace, IconCheck, IconX, IconSpace } from '@tabler/icons-react'
import s from './OnScreenKeyboard.module.css'

// Type with a controller (Big Picture search): a big grid of keys the D-pad
// moves through and A presses (lib/gamepadNav.js treats it as a dialog, so the
// ring stays inside it; B closes). The text filters live behind it.
const ROWS = [
  '1234567890'.split(''),
  'QWERTYUIOP'.split(''),
  'ASDFGHJKL'.split(''),
  'ZXCVBNM'.split(''),
]

export default function OnScreenKeyboard({ value, onChange, onClose }) {
  const type = (k) => onChange(value + k.toLowerCase())
  // Esc (and B on a controller, which sends Esc to an open dialog) closes it.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.panel} role="dialog" aria-label="Keyboard" onClick={e => e.stopPropagation()}>
        <div className={s.field}>
          <span className={s.text}>{value || <span className={s.placeholder}>Search games</span>}</span>
          <span className={s.caret} />
        </div>
        <div className={s.keys}>
          {ROWS.map((row, r) => (
            <div key={r} className={s.row}>
              {row.map((k, i) => (
                <button key={k} type="button" className={s.key} onClick={() => type(k)} data-gpautofocus={r === 1 && i === 0 ? '' : undefined}>{k}</button>
              ))}
            </div>
          ))}
          <div className={s.row}>
            <button type="button" className={`${s.key} ${s.wide}`} onClick={() => type(' ')}><IconSpace size={20} /> Space</button>
            <button type="button" className={`${s.key} ${s.wide}`} onClick={() => onChange(value.slice(0, -1))}><IconBackspace size={20} /> Delete</button>
            <button type="button" className={`${s.key} ${s.wide}`} onClick={() => onChange('')}><IconX size={20} /> Clear</button>
            <button type="button" className={`${s.key} ${s.wide} ${s.done}`} onClick={onClose}><IconCheck size={20} /> Done</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
