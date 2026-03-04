import React, { useState, useEffect } from 'react'
import { IconEdit, IconTrash, IconStar, IconBrandSteam } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import SearchableSelect from '../ui/SearchableSelect'
import s from './AddGameModal.module.css'

const STATUS_OPTIONS = [
  { value: 'want_to_play', label: 'Want to play' },
  { value: 'playing',      label: 'Playing' },
  { value: 'finished',     label: 'Finished' },
  { value: 'dropped',      label: 'Dropped' },
  { value: 'upcoming',     label: 'Upcoming' },
]

export default function EditGameListModal({ item, categories: initialCategories, onClose, onSaved, onDeleted }) {
  const [name, setName]             = useState(item.name)
  const [status, setStatus]         = useState(item.status)
  const [categoryId, setCategoryId] = useState(item.category_id ? String(item.category_id) : '')
  const [rating, setRating]         = useState(item.rating != null ? String(item.rating) : '')
  const [saving, setSaving]         = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [errors, setErrors]         = useState({})
  const [localCategories, setLocalCategories] = useState(initialCategories || [])

  useEffect(() => {
    window.kozo?.api?.categories?.list().then(res => {
      if (res?.ok) setLocalCategories(res.data ?? [])
    })
  }, [])

  const categoryOptions = localCategories.map(c => ({
    value: String(c.id),
    label: (c.emoji ? `${c.emoji} ` : '') + c.name,
  }))

  function clampRating(val) {
    const n = parseFloat(val)
    if (isNaN(n)) return val
    return String(Math.min(10, Math.max(0, Math.round(n * 10) / 10)))
  }

  async function handleSave() {
    const newErrors = {}
    if (!name.trim()) newErrors.name = 'Game name is required'
    const ratingNum = rating !== '' ? Number(rating) : null
    if (status === 'finished' && ratingNum !== null && (isNaN(ratingNum) || ratingNum < 0 || ratingNum > 10)) {
      newErrors.rating = 'Rating must be between 0 and 10'
    }
    if (Object.keys(newErrors).length) { setErrors(newErrors); return }

    setSaving(true)
    const res = await window.kozo?.api?.gameList?.update(item.id, {
      name: name.trim(),
      status,
      category_id: categoryId ? Number(categoryId) : null,
      rating: status === 'finished' && rating !== '' ? Number(rating) : null,
    })
    setSaving(false)
    if (res?.ok) {
      onSaved?.()
    } else {
      setErrors({ save: res?.error || 'Failed to save' })
    }
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
      width={460}
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
              <button className={ms.btnCancel} onClick={onClose}>Cancel</button>
              <button className={ms.btnPrimary} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      }
    >
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

      {status === 'finished' && (
        <div className={s.field}>
          <label className={s.label}>
            <IconStar size={12} stroke={1.6} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
            Rating <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(0–10)</span>
          </label>
          <input
            type="number"
            className={`${s.input} ${errors.rating ? s.inputError : ''}`}
            min={0}
            max={10}
            step={0.1}
            value={rating}
            onChange={e => { setRating(e.target.value); setErrors(p => ({ ...p, rating: '' })) }}
            onBlur={e => setRating(e.target.value !== '' ? clampRating(e.target.value) : '')}
            placeholder="e.g. 8.5"
          />
          {errors.rating && <div className={s.errorText}>{errors.rating}</div>}
          {!errors.rating && rating !== '' && (
            <div className={s.inputHint}>★ {Number(rating).toFixed(1)} / 10</div>
          )}
        </div>
      )}

      <div className={s.field}>
        <label className={s.label}>Category</label>
        <SearchableSelect
          value={categoryId}
          onChange={setCategoryId}
          options={categoryOptions}
          placeholder="No category"
          width="100%"
        />
      </div>

      {errors.save && <div className={s.errorText} style={{ marginTop: 6 }}>{errors.save}</div>}
    </Modal>
  )
}
