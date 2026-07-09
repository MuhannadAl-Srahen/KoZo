import React, { useEffect, useRef, useState } from 'react'
import { IconStar, IconEye, IconEyeOff, IconCircleOff, IconPencil, IconTrash } from '@tabler/icons-react'
import { STATUS_META } from '../GameCard'
import s from './CardContextMenu.module.css'

/**
 * Right-click menu for game cards. Defaults fit the Library (completion_status
 * + STATUS_META + hide toggle); the Game List reuses it with its own statuses
 * via `statuses`/`statusField` and adds Edit/Remove actions.
 * Positioned at the cursor, clamped to the viewport; closes on outside click,
 * Escape, or scroll.
 */
export default function CardContextMenu({
  x, y, game, onClose,
  onSetStatus,
  onToggleFavorite,
  onToggleHidden,          // optional — hide item rendered only when provided
  onEdit,                  // optional — "Edit…" item
  onDelete,                // optional — danger item with two-click confirm
  deleteLabel = 'Remove',
  deleteHint = '',
  statuses = STATUS_META,
  statusField = 'completion_status',
  clearable = true,        // whether clicking the active status clears it
}) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [confirmDel, setConfirmDel] = useState(false)

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
  const current = game[statusField]

  return (
    <div className={s.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div ref={ref} className={s.menu} style={{ left: pos.left, top: pos.top }} onClick={e => e.stopPropagation()}>
        <div className={s.header}>{game.name}</div>

        <div className={s.sectionLabel}>Status</div>
        {Object.entries(statuses).map(([key, st]) => (
          <button
            key={key}
            className={`${s.item} ${current === key ? s.itemActive : ''}`}
            onClick={() => {
              onSetStatus(game, clearable && current === key ? null : key)
              onClose()
            }}
          >
            {st.Icon
              ? <st.Icon size={13} style={{ color: st.color }} />
              : <span className={s.statusDot} style={{ background: st.color }} />}
            {st.label}
          </button>
        ))}
        {clearable && current && (
          <button className={s.item} onClick={() => { onSetStatus(game, null); onClose() }}>
            <IconCircleOff size={13} />
            Clear status
          </button>
        )}

        <div className={s.divider} />

        {onToggleFavorite && (
          <button className={s.item} onClick={() => { onToggleFavorite(game); onClose() }}>
            <IconStar size={13} style={{ color: '#fbbf24' }} fill={game.is_favorite ? 'currentColor' : 'none'} />
            {game.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
          </button>
        )}
        {onEdit && (
          <button className={s.item} onClick={() => { onEdit(game); onClose() }}>
            <IconPencil size={13} />
            Edit…
          </button>
        )}
        {onToggleHidden && (
          <>
            <button className={s.item} onClick={() => { onToggleHidden(game); onClose() }}>
              {game.is_hidden ? <IconEye size={13} /> : <IconEyeOff size={13} />}
              {game.is_hidden ? 'Unhide from library' : 'Hide from library'}
            </button>
            {!game.is_hidden && (
              <div className={s.hint}>Hidden games keep tracking time, achievements and XP.</div>
            )}
          </>
        )}

        {onDelete && (
          <>
            <div className={s.divider} />
            <button
              className={`${s.item} ${s.itemDanger}`}
              onClick={() => {
                if (!confirmDel) { setConfirmDel(true); return }
                onDelete(game)
                onClose()
              }}
            >
              <IconTrash size={13} />
              {confirmDel ? 'Confirm remove' : deleteLabel}
            </button>
            {confirmDel && deleteHint && <div className={s.hint}>{deleteHint}</div>}
          </>
        )}
      </div>
    </div>
  )
}
