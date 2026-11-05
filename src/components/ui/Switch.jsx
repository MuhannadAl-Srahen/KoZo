import React from 'react'
import s from './Switch.module.css'

// An on/off switch that looks like the ones in Settings.
export default function Switch({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-label={label}
      disabled={disabled}
      className={`${s.track} ${checked ? s.on : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className={s.thumb} />
    </button>
  )
}
