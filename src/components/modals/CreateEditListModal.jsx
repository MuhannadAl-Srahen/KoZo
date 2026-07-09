import React, { useState } from 'react'
import { IconPlaylist, IconTrash } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './AddGameModal.module.css'

const EMOJI_SUGGESTIONS = ['🎮', '⭐', '🔥', '🏆', '💀', '🧘', '🚀', '❤️', '📦', '🕹️', '👻', '⚔️']
const COLOR_SUGGESTIONS = ['#8b5cf6', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#14b8a6']
const HEX_RE = /^#[0-9a-fA-F]{6}$/

// Create or edit a custom game list (the Spotify-playlist analogue).
// Pass `list` to edit/delete an existing one; omit it to create.
export default function CreateEditListModal({ list, onClose, onSaved, onDeleted }) {
  const isEdit = !!list
  const [name, setName]   = useState(list?.name || '')
  const [emoji, setEmoji] = useState(list?.emoji || '')
  const [color, setColor] = useState(list?.color || '')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!name.trim()) { setError('List name is required'); return }
    setSaving(true)
    const payload = {
      name: name.trim(),
      emoji: emoji.trim() || null,
      color: HEX_RE.test(color.trim()) ? color.trim().toLowerCase() : null,
    }
    const res = isEdit
      ? await window.kozo?.api?.customLists?.update(list.id, payload)
      : await window.kozo?.api?.customLists?.create(payload)
    setSaving(false)
    if (res?.ok) onSaved?.(res.data)
    else setError(res?.error || 'Failed to save list')
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    await window.kozo?.api?.customLists?.delete(list.id)
    setDeleting(false)
    onDeleted?.()
  }

  return (
    <Modal
      title={isEdit ? 'Edit List' : 'New List'}
      icon={<IconPlaylist size={17} stroke={1.6} />}
      onClose={onClose}
      width={400}
      footer={
        <div style={{ display: 'flex', gap: 8, width: '100%', alignItems: 'center' }}>
          {isEdit && (
            <button
              className={confirmDelete ? ms.btnDanger : ms.btnGhost}
              onClick={handleDelete}
              disabled={deleting}
              style={{ marginRight: 'auto' }}
              title="Deleting a list never deletes the games in it"
            >
              <IconTrash size={14} stroke={1.6} />
              {confirmDelete ? (deleting ? 'Deleting…' : 'Confirm delete') : 'Delete'}
            </button>
          )}
          <button className={ms.btnCancel} onClick={onClose}>Cancel</button>
          <button className={ms.btnPrimary} onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : (isEdit ? 'Save' : 'Create list')}
          </button>
        </div>
      }
    >
      <div className={s.field}>
        <label className={`${s.label} ${s.labelRequired}`}>List name</label>
        <input
          className={`${s.input} ${error ? s.inputError : ''}`}
          value={name}
          onChange={e => { setName(e.target.value); setError('') }}
          placeholder='e.g. "New PC games", "No-soul games"'
          autoFocus
        />
        {error && <div className={s.errorText}>{error}</div>}
      </div>

      <div className={s.field}>
        <label className={s.label}>Emoji <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
        <input
          className={s.input}
          value={emoji}
          onChange={e => setEmoji(e.target.value)}
          placeholder="Pick one below or type your own"
          maxLength={4}
        />
        <div className={s.pills} style={{ marginTop: 8 }}>
          {EMOJI_SUGGESTIONS.map(e => (
            <button
              key={e}
              className={`${s.pill} ${emoji === e ? s.pillActive : ''}`}
              onClick={() => setEmoji(e)}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className={s.field}>
        <label className={s.label}>Color <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional — tints the list chip)</span></label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className={s.pills} style={{ flex: 1 }}>
            {COLOR_SUGGESTIONS.map(c => (
              <button
                key={c}
                className={s.pill}
                onClick={() => setColor(color === c ? '' : c)}
                title={c}
                style={{
                  width: 24, height: 24, padding: 0, borderRadius: '50%',
                  background: c,
                  border: color === c ? '2px solid var(--text-primary)' : '2px solid transparent',
                }}
              />
            ))}
          </div>
          <input
            className={s.input}
            value={color}
            onChange={e => setColor(e.target.value)}
            placeholder="#8b5cf6"
            maxLength={7}
            style={{ width: 90, flexShrink: 0, borderColor: color && !HEX_RE.test(color.trim()) ? 'var(--status-dropped)' : undefined }}
          />
        </div>
      </div>
    </Modal>
  )
}
