import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronLeft, IconChevronRight, IconX, IconMaximize } from '@tabler/icons-react'
import s from './MediaGallery.module.css'

// Game media: a big viewer, a clickable thumbnail strip, and a full-screen
// lightbox (click the big image, ←/→ to browse, Esc to close).
// `items` = [{ thumb, full }]; the first item is shown first.
export default function MediaGallery({ items = [], height }) {
  const list = items.filter(m => m && (m.full || m.thumb))
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(false)
  const [broken, setBroken] = useState(() => new Set())
  useEffect(() => { setIndex(0) }, [list.length && list[0].full])

  const shown = list.filter(m => !broken.has(m.full || m.thumb))
  if (!shown.length) return null
  const i = Math.min(index, shown.length - 1)
  const cur = shown[i]
  const step = (d) => setIndex((i + d + shown.length) % shown.length)
  const markBroken = (m) => setBroken(prev => new Set(prev).add(m.full || m.thumb))

  return (
    <div className={s.gallery}>
      <div
        className={s.viewer}
        style={height ? { height } : undefined}
        tabIndex={0}
        onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
          if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
        }}
      >
        <img
          key={cur.full || cur.thumb}
          className={s.viewerImg}
          src={cur.full || cur.thumb}
          alt=""
          onClick={() => setZoom(true)}
          onError={() => markBroken(cur)}
        />
        {shown.length > 1 && (
          <>
            <button className={`${s.arrow} ${s.arrowLeft}`} onClick={() => step(-1)} aria-label="Previous"><IconChevronLeft size={18} /></button>
            <button className={`${s.arrow} ${s.arrowRight}`} onClick={() => step(1)} aria-label="Next"><IconChevronRight size={18} /></button>
          </>
        )}
        <button className={s.expand} onClick={() => setZoom(true)} aria-label="View full screen"><IconMaximize size={14} /></button>
        {shown.length > 1 && <span className={s.counter}>{i + 1} / {shown.length}</span>}
      </div>

      {shown.length > 1 && (
        <div className={s.strip}>
          {shown.map((m, k) => (
            <button key={m.full || m.thumb} className={`${s.thumb} ${k === i ? s.thumbActive : ''}`} onClick={() => setIndex(k)}>
              <img src={m.thumb || m.full} alt="" loading="lazy" onError={() => markBroken(m)} />
            </button>
          ))}
        </div>
      )}

      {zoom && <Lightbox items={shown} index={i} onIndex={setIndex} onClose={() => setZoom(false)} />}
    </div>
  )
}

export function Lightbox({ items, index, onIndex, onClose }) {
  const step = (d) => onIndex((index + d + items.length) % items.length)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  const cur = items[index]
  return createPortal(
    <div className={s.lightbox} onClick={onClose}>
      <img className={s.lightboxImg} src={cur.full || cur.thumb} alt="" onClick={(e) => e.stopPropagation()} />
      {items.length > 1 && (
        <>
          <button className={`${s.lbArrow} ${s.arrowLeft}`} onClick={(e) => { e.stopPropagation(); step(-1) }} aria-label="Previous"><IconChevronLeft size={26} /></button>
          <button className={`${s.lbArrow} ${s.arrowRight}`} onClick={(e) => { e.stopPropagation(); step(1) }} aria-label="Next"><IconChevronRight size={26} /></button>
          <span className={s.lbCounter}>{index + 1} / {items.length}</span>
        </>
      )}
      <button className={s.lbClose} onClick={onClose} aria-label="Close"><IconX size={20} /></button>
    </div>,
    document.body
  )
}
