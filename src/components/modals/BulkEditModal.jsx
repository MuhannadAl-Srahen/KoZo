import React, { useState } from 'react'
import { IconEdit } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import SearchableSelect from '../ui/SearchableSelect'
import { LIBRARY_STATUSES } from '../../lib/cardModel'
import s from './AddGameModal.module.css'

// Library > Select > Edit: the same change for every selected game (games:bulkUpdate).
// Anything left on "Leave as is" isn't touched. Library shows an Undo bar after.
const KEEP = '__keep'
const STATUS_OPTIONS = [
  { value: KEEP, label: 'Leave as is' },
  { value: 'none', label: 'No status' },
  ...Object.entries(LIBRARY_STATUSES).map(([value, m]) => ({ value, label: m.label })),
]
const FAVORITE_OPTIONS = [{ value: KEEP, label: 'Leave as is' }, { value: '1', label: 'Favorite' }, { value: '0', label: 'Not favorite' }]
const HIDDEN_OPTIONS = [{ value: KEEP, label: 'Leave as is' }, { value: '1', label: 'Hidden from the Library' }, { value: '0', label: 'Shown in the Library' }]

export default function BulkEditModal({ count, onClose, onSave }) {
  const [status, setStatus] = useState(KEEP)
  const [favorite, setFavorite] = useState(KEEP)
  const [hidden, setHidden] = useState(KEEP)
  const [saving, setSaving] = useState(false)

  const patch = {}
  if (status !== KEEP) patch.completion_status = status === 'none' ? null : status
  if (favorite !== KEEP) patch.is_favorite = favorite === '1' ? 1 : 0
  if (hidden !== KEEP) patch.is_hidden = hidden === '1' ? 1 : 0
  const changes = Object.keys(patch).length

  async function save() {
    setSaving(true)
    await onSave(patch)
    setSaving(false)
  }

  return (
    <Modal
      title={`Edit ${count} game${count !== 1 ? 's' : ''}`}
      icon={<IconEdit size={17} stroke={1.6} />}
      onClose={onClose}
      width={420}
      footer={
        <div style={{ display: 'flex', gap: 8, width: '100%', justifyContent: 'flex-end' }}>
          <button className={ms.btnCancel} onClick={onClose}>Cancel</button>
          <button className={ms.btnPrimary} onClick={save} disabled={saving || !changes}>
            {saving ? 'Saving…' : `Change ${count} game${count !== 1 ? 's' : ''}`}
          </button>
        </div>
      }
    >
      <div className={s.field}>
        <label className={s.label}>Status</label>
        <SearchableSelect value={status} onChange={v => setStatus(v || KEEP)} options={STATUS_OPTIONS} searchable={false} clearable={false} width="100%" />
      </div>
      <div className={s.field}>
        <label className={s.label}>Favorite</label>
        <SearchableSelect value={favorite} onChange={v => setFavorite(v || KEEP)} options={FAVORITE_OPTIONS} searchable={false} clearable={false} width="100%" />
      </div>
      <div className={s.field}>
        <label className={s.label}>In the Library</label>
        <SearchableSelect value={hidden} onChange={v => setHidden(v || KEEP)} options={HIDDEN_OPTIONS} searchable={false} clearable={false} width="100%" />
        <div className={s.inputHint}>You can undo it for a few seconds after.</div>
      </div>
    </Modal>
  )
}
