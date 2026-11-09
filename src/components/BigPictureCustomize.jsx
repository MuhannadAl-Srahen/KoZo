import React, { useEffect } from 'react'
import { IconX, IconMinus, IconPlus, IconRotate } from '@tabler/icons-react'
import { useAppearance, DEFAULT_BIG_PICTURE } from '../context/AppearanceContext'
import s from './BigPictureCustomize.module.css'

// Big Picture > Customize: its look, saved in appearance.bigPicture. A drawer on the
// right, so Big Picture behind it is the live preview; every change applies at once.
// Works with a controller (plain buttons, B closes).

const FOCUS = [null, '#ffffff', '#7dd3fc', '#4ade80', '#fbbf24', '#f472b6', '#a78bfa']

function Choice({ label, value, options, onPick }) {
  return (
    <div className={s.row}>
      <span className={s.label}>{label}</span>
      <div className={s.options} role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={String(v)} type="button" role="radio" aria-checked={value === v}
            className={`${s.opt} ${value === v ? s.optOn : ''}`} onClick={() => onPick(v)}>{text}</button>
        ))}
      </div>
    </div>
  )
}

function Stepper({ label, value, min, max, step, unit, onPick }) {
  return (
    <div className={s.row}>
      <span className={s.label}>{label}</span>
      <div className={s.stepper}>
        <button type="button" className={s.stepBtn} onClick={() => onPick(Math.max(min, value - step))} disabled={value <= min} aria-label={`Less ${label.toLowerCase()}`}><IconMinus size={16} /></button>
        <span className={s.stepValue}>{value}{unit}</span>
        <button type="button" className={s.stepBtn} onClick={() => onPick(Math.min(max, value + step))} disabled={value >= max} aria-label={`More ${label.toLowerCase()}`}><IconPlus size={16} /></button>
      </div>
    </div>
  )
}

export default function BigPictureCustomize({ onClose }) {
  const { prefs, setPrefs } = useAppearance()
  const bp = { ...DEFAULT_BIG_PICTURE, ...(prefs.bigPicture || {}) }
  const set = (patch) => setPrefs(p => ({ ...p, bigPicture: { ...DEFAULT_BIG_PICTURE, ...(p.bigPicture || {}), ...patch } }))

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className={s.scrim} onClick={onClose}>
      <aside className={s.drawer} role="dialog" aria-label="Customize Big Picture" onClick={e => e.stopPropagation()} data-bp-customize>
        <div className={s.head}>
          <h2 className={s.title}>Customize</h2>
          <button type="button" className={s.close} onClick={onClose} aria-label="Close" data-gpautofocus><IconX size={20} /></button>
        </div>
        <p className={s.lead}>Changes show at once, behind this panel.</p>

        <Choice label="Layout" value={bp.layout} onPick={v => set({ layout: v })}
          options={[['shelves', 'Shelves'], ['spotlight', 'Spotlight'], ['grid', 'Grid']]} />
        <div className={s.row}>
          <span className={s.label}>Focus color</span>
          <div className={s.swatches} role="radiogroup" aria-label="Focus color">
            {FOCUS.map(c => (
              <button key={c || 'accent'} type="button" role="radio" aria-checked={bp.focus === c}
                className={`${s.swatch} ${bp.focus === c ? s.swatchOn : ''}`}
                style={{ '--sw': c || 'var(--a-bright, var(--a))' }} title={c ? c : 'Your accent color'} onClick={() => set({ focus: c })} />
            ))}
          </div>
        </div>
        <Choice label="Covers" value={bp.shape} onPick={v => set({ shape: v })} options={[['tall', 'Tall'], ['wide', 'Wide']]} />
        <Choice label="Size" value={bp.size} onPick={v => set({ size: v })} options={[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]} />
        <Choice label="Corners" value={bp.corners} onPick={v => set({ corners: v })} options={[['square', 'Square'], ['soft', 'Soft'], ['round', 'Round']]} />
        <Choice label="Background" value={bp.bg} onPick={v => set({ bg: v })} options={[['art', 'Game art'], ['blur', 'Blurred'], ['plain', 'Plain']]} />
        <Stepper label="Darken" value={bp.darken} min={0} max={80} step={10} unit="%" onPick={v => set({ darken: v })} />
        <Stepper label="Blur" value={bp.blur} min={0} max={40} step={8} unit=" px" onPick={v => set({ blur: v })} />
        <Choice label="Buttons" value={bp.buttons} onPick={v => set({ buttons: v })} options={[['xbox', 'Xbox'], ['playstation', 'PlayStation']]} />
        <Choice label="Hint bar" value={bp.hints} onPick={v => set({ hints: v })} options={[[true, 'Shown'], [false, 'Hidden']]} />

        <button type="button" className={s.reset} onClick={() => set(DEFAULT_BIG_PICTURE)}>
          <IconRotate size={16} /> Back to the usual look
        </button>
      </aside>
    </div>
  )
}
