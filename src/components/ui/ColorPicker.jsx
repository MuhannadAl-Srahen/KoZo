import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconColorPicker, IconCheck } from '@tabler/icons-react'
import s from './ColorPicker.module.css'

// KoZo's own color picker (the Windows one looked foreign and was easy to
// lose): a swatch button that opens a popover with a saturation/brightness
// square, a hue bar, preset swatches, a hex field and an eyedropper.
// Drags with the pointer; arrow keys nudge. onChange fires as you drag.
// resultOf: when a pick isn't used as it is (the background is made dark), it turns a pick
// into the color really shown, and the box tells the truth.

function hexToHsv(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return { h: 260, s: 0.45, v: 0.98 }
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  return { h, s: max ? d / max : 0, v: max }
}
function hsvToHex({ h, s: sat, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return v - v * sat * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
}
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))

export default function ColorPicker({ value, onChange, presets = [], label = 'Color', allowClear = false, clearLabel = 'None', resultOf = null }) {
  const [open, setOpen] = useState(false)
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hex, setHex] = useState(value || '')
  const btn = useRef(null)
  const pop = useRef(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useEffect(() => { if (!open) { setHsv(hexToHsv(value)); setHex(value || '') } }, [value, open])

  useEffect(() => {
    if (!open) return
    // Below the button when it fits, else above; measured once the popover is
    // drawn so its real height decides.
    btn.current.scrollIntoView({ block: 'nearest' })
    const place = () => {
      const r = btn.current.getBoundingClientRect()
      const w = 260, hgt = pop.current?.offsetHeight || 340
      const below = r.bottom + 8
      const top = below + hgt <= window.innerHeight - 8 ? below : Math.max(8, r.top - hgt - 8)
      setPos({ left: clamp(r.left, 8, window.innerWidth - w - 8), top })
    }
    place()
    const raf = requestAnimationFrame(place)
    const down = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false) }
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [open])

  const commit = (next) => {
    setHsv(next)
    const h = hsvToHex(next)
    setHex(h)
    onChange(h)
  }

  const drag = (el, fn) => (e) => {
    e.preventDefault()
    const move = (ev) => { const r = el.current.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width), clamp((ev.clientY - r.top) / r.height)) }
    move(e)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const area = useRef(null)
  const hue = useRef(null)
  const shown = value && resultOf ? resultOf(value) : value
  // White, gray or black has no hue to change, so moving the bar did nothing: give it color.
  const withHue = (h) => ({ h, s: hsv.s < 0.02 ? 1 : hsv.s, v: hsv.v < 0.02 ? 1 : hsv.v })

  async function eyedrop() {
    try {
      const r = await new window.EyeDropper().open()
      if (r?.sRGBHex) { const h = r.sRGBHex.toLowerCase(); setHsv(hexToHsv(h)); setHex(h); onChange(h) }
    } catch {}
  }

  return (
    <>
      <button ref={btn} type="button" className={s.trigger} onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open} aria-label={label}>
        <span className={`${s.chip} ${value ? '' : s.chipEmpty}`} style={shown ? { background: shown } : undefined} />
        <span className={s.triggerText}>{shown ? shown.toUpperCase() : clearLabel}</span>
      </button>
      {open && createPortal(
        <div ref={pop} className={s.pop} style={{ top: pos.top, left: pos.left }} role="dialog" aria-label={label}>
          <div ref={area} className={s.area} style={{ '--hue': hsv.h }}
            onPointerDown={drag(area, (x, y) => commit({ ...hsv, s: x, v: 1 - y }))}
            tabIndex={0} aria-label="Saturation and brightness"
            onKeyDown={(e) => {
              const d = e.shiftKey ? 0.1 : 0.02
              const m = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key]
              if (m) { e.preventDefault(); commit({ ...hsv, s: clamp(hsv.s + m[0]), v: clamp(hsv.v + m[1]) }) }
            }}>
            <span className={s.areaThumb} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
          </div>
          <div className={s.hueRow}>
            {'EyeDropper' in window && (
              <button type="button" className={s.iconBtn} onClick={eyedrop} title="Pick a color from the screen"><IconColorPicker size={16} /></button>
            )}
            <div ref={hue} className={s.hue} tabIndex={0} aria-label="Hue"
              onPointerDown={drag(hue, (x) => commit(withHue(x * 360)))}
              onKeyDown={(e) => {
                const m = { ArrowLeft: -4, ArrowRight: 4 }[e.key]
                if (m) { e.preventDefault(); commit(withHue((hsv.h + m * (e.shiftKey ? 5 : 1) + 360) % 360)) }
              }}>
              <span className={s.hueThumb} style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
            </div>
          </div>
          {presets.length > 0 && (
            <div className={s.presets}>
              {presets.map(p => {
                const v = p.value || p
                return (
                  <button key={v} type="button" className={s.preset} style={{ background: v }} title={p.label || v}
                    onClick={() => { setHsv(hexToHsv(v)); setHex(v); onChange(v) }}>
                    {value?.toLowerCase() === v.toLowerCase() && <IconCheck size={12} stroke={3} />}
                  </button>
                )
              })}
            </div>
          )}
          <div className={s.hexRow}>
            <span className={s.chip} style={{ background: /^#[0-9a-f]{6}$/i.test(hex) ? hex : 'transparent' }} />
            <input className={s.hex} value={hex} maxLength={7} spellCheck={false} aria-label="Hex color"
              onChange={(e) => {
                let v = e.target.value.trim()
                if (v && !v.startsWith('#')) v = '#' + v
                setHex(v)
                if (/^#[0-9a-f]{6}$/i.test(v)) { setHsv(hexToHsv(v)); onChange(v.toLowerCase()) }
              }} />
            {allowClear && <button type="button" className={s.clear} onClick={() => { onChange(null); setOpen(false) }}>{clearLabel}</button>}
          </div>
          {resultOf && shown && (
            <div className={s.result} data-color-result="">
              <span className={s.chip} style={{ background: shown }} />
              <span>KoZo shows <b>{shown.toUpperCase()}</b></span>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}
