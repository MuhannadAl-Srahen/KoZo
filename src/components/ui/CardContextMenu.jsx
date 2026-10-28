import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconStar, IconEye, IconEyeOff, IconCircleOff, IconPencil, IconTrash, IconBrandSteam, IconArchive, IconArrowBackUp } from '@tabler/icons-react'
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
  steamAppId,              // optional — "Open Steam page" item when set
  onDelete,                // optional — danger item with two-click confirm
  deleteLabel = 'Remove',
  deleteHint = '',
  deleteConfirmLabel = 'Confirm remove',
  deleteIsArchive = false,   // archive icon + non-destructive wording
  onRestore,               // optional — "Restore to library" (archived games)
  onDeleteForever,         // optional — with deleteIsArchive: a second choice that deletes the history too
  extraItems = [],         // optional — [{ label, Icon, onClick }] plain actions
  statuses = STATUS_META,
  statusField = 'completion_status',
  clearable = true,        // whether clicking the active status clears it
}) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [confirmDel, setConfirmDel] = useState(false)

  // Keep the whole menu on screen, measured before paint and again whenever it
  // grows (the Remove choices expand it). Opens upward when there's no room
  // below the cursor; never above the top edge either.
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
  }, [x, y, confirmDel])

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

  // Portal to <body> like Modal/SearchableSelect — this is a fixed-position
  // overlay, and any transformed ancestor (cards use `transform` on hover) would
  // become its containing block and clip it to that ancestor's box.
  return createPortal(
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
        {steamAppId && (
          <button
            className={s.item}
            onClick={() => {
              window.kozo?.api?.shell?.openExternal(`https://store.steampowered.com/app/${steamAppId}`)
              onClose()
            }}
          >
            <IconBrandSteam size={13} />
            Open Steam page
          </button>
        )}
        {onToggleHidden && (
          <>
            <button className={s.item} onClick={() => { onToggleHidden(game); onClose() }}>
              {game.is_hidden ? <IconEye size={13} /> : <IconEyeOff size={13} />}
              {game.is_hidden ? 'Unhide from library' : 'Hide from library'}
            </button>
          </>
        )}

        {extraItems.map(({ label, Icon, onClick }) => (
          <button key={label} className={s.item} onClick={() => { onClick(game); onClose() }}>
            {Icon && <Icon size={13} />}
            {label}
          </button>
        ))}

        {onRestore && (
          <button className={s.item} onClick={() => { onRestore(game); onClose() }}>
            <IconArrowBackUp size={13} />
            Restore to library
          </button>
        )}

        {onDelete && (
          <>
            <div className={s.divider} />
            {deleteIsArchive && onDeleteForever && confirmDel ? (
              // Remove from library: keep the history (archive) or delete it too.
              <div className={s.choice}>
                <button className={s.item} onClick={() => { onDelete(game); onClose() }}>
                  <IconArchive size={13} />
                  Keep history
                </button>
                <button className={`${s.item} ${s.itemDanger}`} onClick={() => { onDeleteForever(game); onClose() }}>
                  <IconTrash size={13} />
                  Delete with history
                </button>
              </div>
            ) : (
              <button
                className={`${s.item} ${deleteIsArchive ? '' : s.itemDanger}`}
                onClick={() => {
                  if (!confirmDel) { setConfirmDel(true); return }
                  onDelete(game)
                  onClose()
                }}
              >
                {deleteIsArchive ? <IconArchive size={13} /> : <IconTrash size={13} />}
                {confirmDel ? deleteConfirmLabel : deleteLabel}
              </button>
            )}
            {confirmDel && deleteHint && !(deleteIsArchive && onDeleteForever) && <div className={s.hint}>{deleteHint}</div>}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
