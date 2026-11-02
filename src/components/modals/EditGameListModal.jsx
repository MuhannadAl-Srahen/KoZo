import React, { useState, useEffect } from 'react'
import { IconEdit, IconTrash, IconStar, IconBrandSteam, IconCheck } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import { LIST_STATUSES, LIST_STATUS_ORDER } from '../../lib/cardModel'
import MonthPicker from '../ui/MonthPicker'
import MediaGallery from '../ui/MediaGallery'
import RatingPicker from '../ui/RatingPicker'
import { useSteamArt } from '../../lib/steamArt'
import { formatMonthKey } from '../../lib/utils'
import s from './AddGameModal.module.css'

const STATUS_OPTIONS = LIST_STATUS_ORDER.map(value => ({ value, label: LIST_STATUSES[value].label }))

export default function EditGameListModal({ item, onClose, onSaved, onDeleted }) {
  const [name, setName]             = useState(item.name)
  const [status, setStatus]         = useState(item.status)
  const [rating, setRating]         = useState(item.rating != null ? String(item.rating) : '')
  const [saving, setSaving]         = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [errors, setErrors]         = useState({})
  const [plannedMonth, setPlannedMonth] = useState(item.planned_month || null)   // play plan 'YYYY-MM'
  const [pickingMonth, setPickingMonth] = useState(false)
  // Game media for the header gallery: trailers first, then Steam art (the
  // same art the cards use, lib/steamArt) and the store screenshots.
  const art = useSteamArt(item.steam_app_id)
  const [details, setDetails] = useState(null)
  useEffect(() => {
    const appId = item.steam_app_id
    if (!appId) return
    let alive = true
    window.kozo?.api?.steam?.storeDetails?.(appId).then(r => { if (alive && r?.ok) setDetails(r.data) })
    return () => { alive = false }
  }, [item.steam_app_id])
  const lead = art?.hero || art?.capsule || art?.header
  const media = [
    ...(details?.videos || []).map(v => ({ thumb: v.thumb, video: v })),
    ...(lead ? [{ thumb: art.capsule || art.header || lead, full: lead }] : []),
    ...(details?.media || []),
  ]
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

  function toggleList(listId) {
    setMemberIds(prev => {
      const next = new Set(prev)
      next.has(listId) ? next.delete(listId) : next.add(listId)
      return next
    })
  }

  const dirty =
    name !== item.name ||
    status !== item.status ||
    rating !== (item.rating != null ? String(item.rating) : '') ||
    (plannedMonth || null) !== (item.planned_month || null) ||
    memberIds.size !== initialMemberIds.size ||
    [...memberIds].some(id => !initialMemberIds.has(id))

  // Backdrop / Escape / X — confirm before dropping unsaved edits.
  function requestClose() {
    if (dirty) setConfirmingClose(true)
    else onClose()
  }

  async function handleSave() {
    const newErrors = {}
    if (!name.trim()) newErrors.name = 'Game name is required'
    if (Object.keys(newErrors).length) { setErrors(newErrors); return }

    setSaving(true)
    const res = await window.kozo?.api?.gameList?.update(item.id, {
      name: name.trim(),
      // Only send status when the user actually changed it. gameList:update runs
      // statusSync on ANY truthy status, and re-asserting an unchanged
      // want_to_play/upcoming clears the linked library game's Finished flag —
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
    // Apply list-membership diff — only once the row itself saved.
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

  function openOnSteam() {
    if (item.steam_app_id) {
      window.kozo?.api?.shell?.openExternal(`https://store.steampowered.com/app/${item.steam_app_id}`)
    }
  }

  return (
    <Modal
      title="Edit Game"
      icon={<IconEdit size={17} stroke={1.6} />}
      onClose={onClose}
      onRequestClose={requestClose}
      width={media.length ? 760 : 560}
      footer={
        <div style={{ display: 'flex', gap: 8, width: '100%', alignItems: 'center' }}>
          <button
            className={confirmDelete ? ms.btnDanger : ms.btnGhost}
            onClick={handleDelete}
            disabled={deleting}
            style={{ marginRight: 'auto' }}
          >
            <IconTrash size={14} stroke={1.6} />
            {confirmDelete ? (deleting ? 'Removing…' : 'Confirm remove') : 'Remove'}
          </button>
          {confirmDelete && (
            <button className={ms.btnCancel} onClick={() => setConfirmDelete(false)}>Cancel</button>
          )}
          {!confirmDelete && (
            <>
              {item.steam_app_id && (
                <button
                  className={ms.btnCancel}
                  onClick={openOnSteam}
                  title="View this game on the Steam Store"
                >
                  <IconBrandSteam size={14} stroke={1.6} />
                  View on Steam
                </button>
              )}
              <button className={ms.btnCancel} onClick={requestClose}>Cancel</button>
              <button className={ms.btnPrimary} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      }
    >
      {media.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <MediaGallery items={media} />
        </div>
      )}

      <div className={s.field}>
        <label className={`${s.label} ${s.labelRequired}`}>Game name</label>
        <input
          className={`${s.input} ${errors.name ? s.inputError : ''}`}
          value={name}
          onChange={e => { setName(e.target.value); setErrors(p => ({ ...p, name: '' })) }}
        />
        {errors.name && <div className={s.errorText}>{errors.name}</div>}
      </div>

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

      {/* The same 1 to 10 picker as Finished games. An older decimal score
          (8.5) shows rounded and is only replaced when a new one is picked. */}
      {status === 'finished' && (
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
      )}

      {errors.save && <div className={s.errorText} style={{ marginTop: 6 }}>{errors.save}</div>}

      {confirmingClose && (
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
      )}
    </Modal>
  )
}
