import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCalendar, IconChevronLeft, IconChevronRight, IconX } from '@tabler/icons-react'
import { localDayKey } from '../../lib/utils'
import s from './DatePicker.module.css'

// KoZo's own date field (the Windows one looked foreign, like the color picker before it):
// a button that opens a month in a popover. Value is 'YYYY-MM-DD' or ''. Arrow keys move
// by day, Page Up and Down by month, Enter picks, Escape closes. min and max grey out days.

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const parse = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? new Date(`${v}T00:00:00`) : null)
const shown = (v) => parse(v)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) || ''

// Six rows from the Monday on or before the 1st, so the height never jumps.
function monthCells(view) {
  const first = new Date(view.getFullYear(), view.getMonth(), 1)
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - ((first.getDay() + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
}

export default function DatePicker({ value, onChange, label = 'Date', placeholder = 'Pick a date', min = '', max = '' }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState(() => parse(value) || new Date())
  const [cursor, setCursor] = useState(() => value || localDayKey(new Date()))
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btn = useRef(null)
  const pop = useRef(null)
  const today = localDayKey(new Date())

  useEffect(() => {
    if (!open) return
    const place = () => {
      const r = btn.current.getBoundingClientRect()
      const w = 268, hgt = pop.current?.offsetHeight || 330
      const below = r.bottom + 6
      const top = below + hgt <= window.innerHeight - 8 ? below : Math.max(8, r.top - hgt - 6)
      setPos({ left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)), top })
    }
    place()
    const raf = requestAnimationFrame(place)
    const down = (e) => { if (!pop.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false) }
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true) }
  }, [open])

  // The keyboard's day has the focus, whichever month it moved to.
  useEffect(() => {
    if (open) pop.current?.querySelector(`[data-day="${cursor}"]`)?.focus({ preventScroll: true })
  }, [open, cursor, view])

  function openIt() {
    const start = parse(value) || new Date()
    setView(start)
    setCursor(value || today)
    setOpen(o => !o)
  }
  const allowed = (k) => !(min && k < min) && !(max && k > max)
  function pick(k) {
    if (!allowed(k)) return
    onChange(k)
    setOpen(false)
    btn.current?.focus()
  }
  function move(days, months = 0) {
    const d = parse(cursor) || new Date()
    const next = months
      ? new Date(d.getFullYear(), d.getMonth() + months, Math.min(d.getDate(), 28))
      : new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
    setCursor(localDayKey(next))
    setView(new Date(next.getFullYear(), next.getMonth(), 1))
  }
  function onKey(e) {
    const step = { ArrowLeft: [-1], ArrowRight: [1], ArrowUp: [-7], ArrowDown: [7], PageUp: [0, -1], PageDown: [0, 1] }[e.key]
    if (!step) return
    e.preventDefault()
    move(step[0], step[1] || 0)
  }

  return (
    <>
      <button ref={btn} type="button" className={s.trigger} onClick={openIt} aria-haspopup="dialog" aria-expanded={open}
        aria-label={value ? `${label}: ${shown(value)}` : label} title={label} data-date-picker="">
        <IconCalendar size={14} stroke={1.7} className={s.icon} />
        <span className={value ? s.value : s.placeholder}>{value ? shown(value) : placeholder}</span>
        {value && (
          <span className={s.clear} title="Clear" onClick={(e) => { e.stopPropagation(); setOpen(false); onChange('') }}>
            <IconX size={11} stroke={2} />
          </span>
        )}
      </button>
      {open && createPortal(
        <div ref={pop} className={s.pop} style={{ top: pos.top, left: pos.left }} role="dialog" aria-label={label} onKeyDown={onKey} data-date-popover="">
          <div className={s.head}>
            <button type="button" className={s.nav} aria-label="Previous month" onClick={() => setView(v => new Date(v.getFullYear(), v.getMonth() - 1, 1))}><IconChevronLeft size={15} /></button>
            <span className={s.month}>{view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <button type="button" className={s.nav} aria-label="Next month" onClick={() => setView(v => new Date(v.getFullYear(), v.getMonth() + 1, 1))}><IconChevronRight size={15} /></button>
          </div>
          <div className={s.grid}>
            {WEEKDAYS.map(d => <span key={d} className={s.weekday}>{d}</span>)}
            {monthCells(view).map(d => {
              const k = localDayKey(d)
              const cls = [s.day, d.getMonth() !== view.getMonth() ? s.dayOutside : '', k === today ? s.dayToday : '', k === value ? s.dayOn : ''].join(' ')
              return (
                <button key={k} type="button" className={cls} data-day={k} disabled={!allowed(k)} tabIndex={k === cursor ? 0 : -1}
                  aria-pressed={k === value} onClick={() => pick(k)}>{d.getDate()}</button>
              )
            })}
          </div>
          <div className={s.foot}>
            <button type="button" className={s.footBtn} disabled={!allowed(today)} onClick={() => pick(today)}>Today</button>
            {value && <button type="button" className={s.footBtn} onClick={() => { onChange(''); setOpen(false); btn.current?.focus() }}>Clear</button>}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
