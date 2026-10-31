import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronRight } from '@tabler/icons-react'
import GeneratedCover from '../GeneratedCover'
import s from './ContextMenu.module.css'

/**
 * The app's right-click menu. A header with the game's cover, name and a short
 * subtitle, then rows. Every page builds its own `items`, so a menu only shows
 * what makes sense where it was opened.
 *
 * items: falsy entries are skipped, so callers can write `cond && {...}`.
 *   { label, Icon, color, onClick, active, danger, disabled, hint }
 *   { label, Icon, sub: [items] }      side flyout (hover or click)
 *   { label, Icon, confirm: 'Sure?' }  first click arms it, second runs onClick
 *   { divider: true } / { section: 'Label' }
 *
 * Portalled to <body> (a transformed card ancestor would otherwise clip it),
 * clamped to the window, closes on outside click, Escape and scroll.
 */
export default function ContextMenu({ x, y, header, items, onClose }) {
  const ref = useRef(null)
  const flyRef = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [sub, setSub] = useState(null)        // { i, rect } of the open flyout
  const [flyPos, setFlyPos] = useState(null)
  const [armed, setArmed] = useState(null)    // label of a confirm item waiting for its second click

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    const top = y + r.height + 8 > vh ? y - r.height : y
    setPos({
      left: Math.max(8, Math.min(x, vw - r.width - 8)),
      top: Math.max(8, Math.min(top, vh - r.height - 8)),
    })
  }, [x, y, armed])

  // The flyout opens beside its row: right if it fits, else left.
  useLayoutEffect(() => {
    if (!sub || !flyRef.current) { setFlyPos(null); return }
    const f = flyRef.current.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    const left = sub.rect.right + 4 + f.width <= vw - 8 ? sub.rect.right + 4 : Math.max(8, sub.rect.left - f.width - 4)
    setFlyPos({ left, top: Math.max(8, Math.min(sub.rect.top - 5, vh - f.height - 8)) })
  }, [sub])

  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return
      if (sub) setSub(null); else onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose, sub])

  const list = (items || []).filter(Boolean)

  function run(it) {
    if (it.disabled) return
    if (it.confirm && armed !== it.label) { setArmed(it.label); return }
    onClose()
    it.onClick?.()
  }

  function row(it, i, inFlyout) {
    if (it.divider) return <div key={`d${i}`} className={s.divider} />
    if (it.section) return <div key={`s${i}`} className={s.section}>{it.section}</div>
    const hasSub = !inFlyout && Array.isArray(it.sub)
    const open = hasSub && sub?.i === i
    return (
      <button
        key={it.label}
        type="button"
        className={`${s.item} ${it.active ? s.itemActive : ''} ${it.danger ? s.itemDanger : ''} ${open ? s.itemOpen : ''}`}
        disabled={it.disabled}
        onMouseEnter={inFlyout ? undefined : (e) => setSub(hasSub ? { i, rect: e.currentTarget.getBoundingClientRect() } : null)}
        onClick={(e) => {
          if (hasSub) { setSub(open ? null : { i, rect: e.currentTarget.getBoundingClientRect() }); return }
          run(it)
        }}
      >
        <span className={s.icon} style={it.color ? { color: it.color } : undefined}>
          {it.Icon ? <it.Icon size={15} stroke={1.7} /> : null}
        </span>
        <span className={s.label}>{it.confirm && armed === it.label ? it.confirm : it.label}</span>
        {it.hint && <span className={s.hint}>{it.hint}</span>}
        {inFlyout && it.active && <IconCheck size={14} className={s.check} />}
        {hasSub && <IconChevronRight size={14} className={s.chev} />}
      </button>
    )
  }

  const flyItems = sub ? (list[sub.i]?.sub || []).filter(Boolean) : null

  return createPortal(
    <div className={s.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div ref={ref} className={s.menu} style={{ left: pos.left, top: pos.top }} onClick={e => e.stopPropagation()} role="menu">
        {header && (
          <div className={s.header}>
            <span className={s.cover}>
              {header.cover ? <img src={header.cover} alt="" /> : <GeneratedCover name={header.name} compact />}
            </span>
            <span className={s.headText}>
              <span className={s.name} title={header.name}>{header.name}</span>
              {header.sub && <span className={s.sub}>{header.sub}</span>}
            </span>
          </div>
        )}
        <div className={s.rows}>{list.map((it, i) => row(it, i, false))}</div>
      </div>
      {flyItems && (
        <div
          ref={flyRef}
          className={`${s.menu} ${s.flyout}`}
          style={flyPos ? { left: flyPos.left, top: flyPos.top } : { left: -9999, top: 0 }}
          onClick={e => e.stopPropagation()}
          role="menu"
        >
          {flyItems.map((it, i) => row(it, i, true))}
        </div>
      )}
    </div>,
    document.body
  )
}
