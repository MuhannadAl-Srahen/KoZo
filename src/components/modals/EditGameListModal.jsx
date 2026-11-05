import React, { useState, useEffect } from 'react'
import { IconEdit, IconTrash, IconStar } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import SteamGameModal from '../SteamGameModal'
import GamePrices from '../GamePrices'
import { LIST_STATUSES, LIST_STATUS_ORDER } from '../../lib/cardModel'
import MonthPicker from '../ui/MonthPicker'
import RatingPicker from '../ui/RatingPicker'
import { useSteamArt } from '../../lib/steamArt'
import { useAppearance } from '../../context/AppearanceContext'
import { formatMonthKey } from '../../lib/utils'
import sg from '../SteamGameModal.module.css'
import s from './AddGameModal.module.css'

const STATUS_OPTIONS = LIST_STATUS_ORDER.map(value => ({ value, label: LIST_STATUSES[value].label }))

// A Game List game's window. A game on Steam gets the same store window as
// Upcoming (SteamGameModal), at its full size from the first frame, plus what's
// yours to change. Where that goes is Settings > Appearance > Game List window
// (prefs.gameListEdit): all in an Edit tab, or status and play plan on the
// Overview. A game with no Steam page has no store info, so it keeps the small form.
export default function EditGameListModal({ item, onClose, onSaved, onDeleted }) {
  const { prefs } = useAppearance()
  const onOverview = prefs.gameListEdit === 'overview'
  const [tab, setTab]               = useState(item._openTab || 'overview')
  const [name, setName]             = useState(item.name)
  const [status, setStatus]         = useState(item.status)
  const [rating, setRating]         = useState(item.rating != null ? String(item.rating) : '')
  const [saving, setSaving]         = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [errors, setErrors]         = useState({})
  const [plannedMonth, setPlannedMonth] = useState(item.planned_month || null)   // play plan 'YYYY-MM'
  const [pickingMonth, setPickingMonth] = useState(false)
  const art = useSteamArt(item.steam_app_id)
  const [confirmingClose, setConfirmingClose] = useState(false)

  // Custom-list membership (Spotify-playlist style, many-to-many).
  const [lists, setLists]           = useState([])
  const [memberIds, setMemberIds]   = useState(new Set())
  const [initialMemberIds, setInitialMemberIds] = useState(new Set())

  useEffect(() => {
    (async () => {
      const [listsRes, memberRes] = await Promise.all([
        window.kozo?.api?.customLists?.list(),
        window.kozo?.api?.customLists?.listsForItem(item.id),
      ])
      if (listsRes?.ok) setLists(listsRes.data ?? [])
      if (memberRes?.ok) {
        const ids = new Set(memberRes.data ?? [])
        setMemberIds(ids)
        setInitialMemberIds(new Set(ids))
      }
    })()
  }, [item.id])

  const dirty =
    name !== item.name ||
    status !== item.status ||
    rating !== (item.rating != null ? String(item.rating) : '') ||
    (plannedMonth || null) !== (item.planned_month || null) ||
    memberIds.size !== initialMemberIds.size ||
    [...memberIds].some(id => !initialMemberIds.has(id))

  // Backdrop / Escape / X: confirm before dropping unsaved edits.
  function requestClose() {
    if (dirty) setConfirmingClose(true)
    else onClose()
  }

  async function handleSave() {
    const newErrors = {}
    if (!name.trim()) newErrors.name = 'Game name is required'
    if (Object.keys(newErrors).length) { setErrors(newErrors); setTab('edit'); return }

    setSaving(true)
    const res = await window.kozo?.api?.gameList?.update(item.id, {
      name: name.trim(),
      // Only send status when the user actually changed it. gameList:update runs
      // statusSync on ANY truthy status, and re-asserting an unchanged
      // want_to_play/upcoming clears the linked library game's Finished flag,
      // so a rename or a list toggle would silently cost the milestone.
      ...(status !== item.status ? { status } : {}),
      rating: status === 'finished' && rating !== '' ? Number(rating) : null,
      planned_month: plannedMonth || null,
    })
    if (!res?.ok) {
      setSaving(false)
      setErrors({ save: res?.error || 'Failed to save' })
      return
    }
    // Apply list-membership diff, only once the row itself saved.
    for (const l of lists) {
      const now = memberIds.has(l.id)
      const was = initialMemberIds.has(l.id)
      if (now && !was) await window.kozo?.api?.customLists?.addGame(l.id, item.id)
      if (!now && was) await window.kozo?.api?.customLists?.removeGame(l.id, item.id)
    }
    setSaving(false)
    onSaved?.()
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    await window.kozo?.api?.gameList?.delete(item.id)
    setDeleting(false)
    onDeleted?.()
  }

  const nameField = (
    <div className={s.field}>
      <label className={`${s.label} ${s.labelRequired}`}>Game name</label>
      <input
        className={`${s.input} ${errors.name ? s.inputError : ''}`}
        value={name}
        onChange={e => { setName(e.target.value); setErrors(p => ({ ...p, name: '' })) }}
      />
      {errors.name && <div className={s.errorText}>{errors.name}</div>}
    </div>
  )

  const statusField = (
    <div className={s.field}>
      <label className={s.label}>Status</label>
      <div className={s.pills}>
        {STATUS_OPTIONS.map(o => (
          <button
            key={o.value}
            className={`${s.pill} ${status === o.value ? s.pillActive : ''}`}
            onClick={() => setStatus(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )

  const planField = (
    <div className={s.field}>
      <label className={s.label}>Play plan</label>
      <div className={s.pills}>
        <button className={`${s.pill} ${plannedMonth ? s.pillActive : ''}`} onClick={() => setPickingMonth(v => !v)}>
          {plannedMonth ? formatMonthKey(plannedMonth, 'long') : 'Not planned'}
        </button>
        {plannedMonth && (
          <button className={s.pill} onClick={() => { setPlannedMonth(null); setPickingMonth(false) }}>Clear</button>
        )}
      </div>
      {pickingMonth && (
        <div style={{ marginTop: 8 }}>
          <MonthPicker value={plannedMonth} onChange={(k) => { setPlannedMonth(k); setPickingMonth(false) }} />
        </div>
      )}
    </div>
  )

  // The same 1 to 10 picker as Finished games. An older decimal score (8.5)
  // shows rounded and is only replaced when a new one is picked.
  const ratingField = status === 'finished' && (
    <div className={s.field}>
      <label className={s.label}>
        <IconStar size={12} stroke={1.6} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
        Your rating
        {rating !== '' && (
          <button type="button" className={s.labelAction} onClick={() => setRating('')}>Clear</button>
        )}
      </label>
      <RatingPicker
        value={rating !== '' ? Math.min(10, Math.max(1, Math.round(Number(rating)))) : null}
        onChange={(n) => setRating(String(n))}
      />
    </div>
  )

  const saveError = errors.save && <div className={s.errorText} style={{ marginTop: 6 }}>{errors.save}</div>

  const confirmClose = confirmingClose && (
    <div className={s.confirmOverlay} onMouseDown={e => e.stopPropagation()}>
      <div className={s.confirmBox}>
        <div className={s.confirmTitle}>Discard unsaved changes?</div>
        <div className={s.confirmBtns}>
          <button className={ms.btnPrimary} onClick={() => setConfirmingClose(false)}>
            Keep editing
          </button>
          <button className={ms.btnDanger} onClick={onClose}>
            Discard
          </button>
        </div>
      </div>
    </div>
  )

  const removeButtons = (
    <>
      <button className={confirmDelete ? ms.btnDanger : ms.btnGhost} onClick={handleDelete} disabled={deleting}>
        <IconTrash size={14} stroke={1.6} />
        {confirmDelete ? (deleting ? 'Removing...' : 'Confirm remove') : 'Remove'}
      </button>
      {confirmDelete && <button className={ms.btnCancel} onClick={() => setConfirmDelete(false)}>Cancel</button>}
    </>
  )

  const saveButtons = (
    <>
      <button className={ms.btnCancel} onClick={requestClose}>Cancel</button>
      <button className={ms.btnPrimary} onClick={handleSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </>
  )

  // No Steam page: the plain form.
  if (!item.steam_app_id) {
    return (
      <Modal
        title="Edit Game"
        icon={<IconEdit size={17} stroke={1.6} />}
        onClose={onClose}
        onRequestClose={requestClose}
        width={560}
        footer={
          <div style={{ display: 'flex', gap: 8, width: '100%', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 8, marginRight: 'auto' }}>{removeButtons}</div>
            {!confirmDelete && saveButtons}
          </div>
        }
      >
        {nameField}
        {statusField}
        {planField}
        {ratingField}
        {saveError}
        {confirmClose}
      </Modal>
    )
  }

  const onEditTab = tab === 'edit'
  return (
    <SteamGameModal
      appId={item.steam_app_id}
      name={name.trim() || item.name}
      art={art}
      onClose={onClose}
      onRequestClose={requestClose}
      tab={tab}
      onTab={setTab}
      chips={!onOverview && <div className={sg.reviewChip}>{LIST_STATUSES[status]?.label || status}</div>}
      overviewTop={onOverview && <div>{statusField}{planField}{ratingField}{saveError}</div>}
      extraTab={[
        { key: 'prices', label: 'Prices', node: <GamePrices appId={item.steam_app_id} name={item.name} banner={item.banner_url} /> },
        {
          key: 'edit',
          label: 'Edit',
          node: (
            <div style={{ maxWidth: 620 }}>
              {nameField}
              {!onOverview && statusField}
              {!onOverview && planField}
              {!onOverview && ratingField}
              {saveError}
            </div>
          ),
        },
      ]}
      footerLeft={onEditTab ? removeButtons : null}
      actions={confirmDelete ? null : onEditTab || dirty ? saveButtons : null}
    >
      {confirmClose}
    </SteamGameModal>
  )
}
