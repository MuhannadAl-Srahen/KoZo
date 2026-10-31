import React from 'react'
import { IconStar, IconEye, IconEyeOff, IconCircleOff, IconPencil, IconTrash, IconBrandSteam, IconArchive, IconArrowBackUp, IconCircleDot } from '@tabler/icons-react'
import { STATUS_META } from '../GameCard'
import { fileUrl } from '../../lib/utils'
import ContextMenu from './ContextMenu'

/**
 * Right-click menu for Library and Game List cards, drawn by ui/ContextMenu:
 * a cover header, a Status flyout, then the card's actions. Defaults fit the
 * Library (completion_status + STATUS_META + hide toggle); the Game List passes
 * its own `statuses`/`statusField` and adds Edit/Remove actions.
 */
export default function CardContextMenu({
  x, y, game, onClose,
  onSetStatus,
  onToggleFavorite,
  onToggleHidden,          // optional: hide item rendered only when provided
  onEdit,                  // optional: "Edit…" item
  steamAppId,              // optional: "Open Steam page" item when set
  onDelete,                // optional: danger item with two-click confirm
  deleteLabel = 'Remove',
  deleteConfirmLabel = 'Confirm remove',
  deleteIsArchive = false,   // archive icon + non-destructive wording
  onRestore,               // optional: "Restore to library" (archived games)
  onDeleteForever,         // optional: with deleteIsArchive, a second choice that deletes the history too
  extraItems = [],         // optional: [{ label, Icon, onClick }] plain actions
  statuses = STATUS_META,
  statusField = 'completion_status',
  clearable = true,        // whether clicking the active status clears it
  cover,                   // optional: header art URL (else the card's own)
}) {
  if (!game) return null
  const current = game[statusField]
  const art = cover ?? (game.banner_local_path ? fileUrl(game.banner_local_path, game.banner_rev) : (game.banner_url || (game.game_banner_local_path ? fileUrl(game.game_banner_local_path) : null)))

  const statusItems = [
    ...Object.entries(statuses).map(([key, st]) => ({
      label: st.label,
      Icon: st.Icon || IconCircleDot,
      color: st.color,
      active: current === key,
      onClick: () => onSetStatus(game, clearable && current === key ? null : key),
    })),
    clearable && current && { divider: true },
    clearable && current && { label: 'Clear status', Icon: IconCircleOff, onClick: () => onSetStatus(game, null) },
  ]

  const items = [
    onSetStatus && { label: 'Status', Icon: statuses[current]?.Icon || IconCircleDot, color: statuses[current]?.color, sub: statusItems, hint: statuses[current]?.label },
    onToggleFavorite && {
      label: game.is_favorite ? 'Remove from favorites' : 'Add to favorites',
      Icon: IconStar, color: '#fbbf24', onClick: () => onToggleFavorite(game),
    },
    onEdit && { label: 'Edit…', Icon: IconPencil, onClick: () => onEdit(game) },
    ...extraItems.map(({ label, Icon, onClick }) => ({ label, Icon, onClick: () => onClick(game) })),
    steamAppId && {
      label: 'Open Steam page', Icon: IconBrandSteam,
      onClick: () => window.kozo?.api?.shell?.openExternal(`https://store.steampowered.com/app/${steamAppId}`),
    },
    onToggleHidden && {
      label: game.is_hidden ? 'Unhide from library' : 'Hide from library',
      Icon: game.is_hidden ? IconEye : IconEyeOff, onClick: () => onToggleHidden(game),
    },
    onRestore && { label: 'Restore to library', Icon: IconArrowBackUp, onClick: () => onRestore(game) },
    onDelete && { divider: true },
    onDelete && (deleteIsArchive && onDeleteForever
      // Remove from library: keep the history (archive) or delete it too.
      ? { label: deleteLabel, Icon: IconArchive, sub: [
          { label: 'Keep history', Icon: IconArchive, onClick: () => onDelete(game) },
          { label: 'Delete with history', Icon: IconTrash, danger: true, onClick: () => onDeleteForever(game) },
        ] }
      : { label: deleteLabel, confirm: deleteConfirmLabel, Icon: deleteIsArchive ? IconArchive : IconTrash, danger: !deleteIsArchive, onClick: () => onDelete(game) }),
  ]

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      header={{ cover: art, name: game.name, sub: statuses[current]?.label || null }}
      items={items}
    />
  )
}
