import React, { useEffect, useRef, useState } from 'react'
import { IconStar, IconEye, IconEyeOff, IconCircleOff } from '@tabler/icons-react'
import { STATUS_META } from '../GameCard'
import s from './CardContextMenu.module.css'

/**
 * Right-click menu for library game cards: set status, hide/unhide, favorite.
 * Positioned at the cursor, clamped to the viewport; closes on outside click,
 * Escape, or scroll.
 */
export default function CardContextMenu({ x, y, game, onSetStatus, onToggleHidden, onToggleFavorite, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useEffect(() => {
    // Clamp inside the viewport once we know the menu's real size.
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8),
    })
  }, [x, y])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  if (!game) return null

  return (
    <div className={s.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div ref={ref} className={s.menu} style={{ left: pos.left, top: pos.top }} onClick={e => e.stopPropagation()}>
        <div className={s.header}>{game.name}</div>

        <div className={s.sectionLabel}>Status</div>
        {Object.entries(STATUS_META).map(([key, st]) => (
          <button
            key={key}
            className={`${s.item} ${game.completion_status === key ? s.itemActive : ''}`}
            onClick={() => { onSetStatus(game, game.completion_status === key ? null : key); onClose() }}
          >
            <st.Icon size={13} style={{ color: st.color }} />
            {st.label}
          </button>
        ))}
        {game.completion_status && (
          <button className={s.item} onClick={() => { onSetStatus(game, null); onClose() }}>
            <IconCircleOff size={13} />
            Clear status
          </button>
        )}

        <div className={s.divider} />

        <button className={s.item} onClick={() => { onToggleFavorite(game); onClose() }}>
          <IconStar size={13} style={{ color: '#fbbf24' }} fill={game.is_favorite ? 'currentColor' : 'none'} />
          {game.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
        </button>
        <button className={s.item} onClick={() => { onToggleHidden(game); onClose() }}>
          {game.is_hidden ? <IconEye size={13} /> : <IconEyeOff size={13} />}
          {game.is_hidden ? 'Unhide from library' : 'Hide from library'}
        </button>
        {!game.is_hidden && (
          <div className={s.hint}>Hidden games keep tracking time, achievements and XP.</div>
        )}
      </div>
    </div>
  )
}
