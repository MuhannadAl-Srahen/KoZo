import React, { useState, useEffect } from 'react'
import { IconPlus, IconTrash, IconPencil, IconCheck, IconX, IconTag } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './ManageCategoriesModal.module.css'

function CategoryRow({ cat, onEdit, onDelete }) {
  const [editing, setEditing]   = useState(false)
  const [name, setName]         = useState(cat.name)
  const [emoji, setEmoji]       = useState(cat.emoji || '')
  const [saving, setSaving]     = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [reassignTo, setReassignTo] = useState('')

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await window.kozo?.api?.categories?.update(cat.id, { name: name.trim(), emoji: emoji.trim() || null })
    setSaving(false)
    onEdit()
    setEditing(false)
  }

  async function doDelete() {
    if (cat.game_count > 0 && !confirmDel) {
      setConfirmDel(true)
      return
    }
    await window.kozo?.api?.categories?.delete({
      id: cat.id,
      reassignToId: reassignTo ? Number(reassignTo) : null,
    })
    onDelete()
  }

  return (
    <div className={s.row}>
      {editing ? (
        <div className={s.editRow}>
          <input
            className={s.emojiInput}
            value={emoji}
            onChange={e => setEmoji(e.target.value)}
            placeholder="emoji"
            maxLength={4}
          />
          <input
            className={s.nameInput}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }}
            autoFocus
          />
          <button className={s.iconBtn} onClick={save} disabled={saving || !name.trim()}>
            <IconCheck size={14} stroke={2} style={{ color: 'var(--status-playing)' }} />
          </button>
          <button className={s.iconBtn} onClick={() => { setEditing(false); setName(cat.name); setEmoji(cat.emoji || '') }}>
            <IconX size={14} stroke={2} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>
      ) : confirmDel ? (
        <div className={s.confirmRow}>
          <span className={s.confirmText}>
            {cat.game_count} game{cat.game_count !== 1 ? 's' : ''} in this category. Remove tag or reassign?
          </span>
          <button className={s.delBtn} onClick={doDelete}>Remove tag</button>
          <button className={s.iconBtn} onClick={() => setConfirmDel(false)}>
            <IconX size={14} stroke={2} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>
      ) : (
        <div className={s.viewRow}>
          <span className={s.emoji}>{cat.emoji || '🏷️'}</span>
          <span className={s.name}>{cat.name}</span>
          {cat.game_count > 0 && (
            <span className={s.count}>{cat.game_count}</span>
          )}
          <div className={s.actions}>
            <button className={s.iconBtn} onClick={() => setEditing(true)}>
              <IconPencil size={13} stroke={1.6} />
            </button>
            <button className={s.iconBtn} onClick={doDelete}>
              <IconTrash size={13} stroke={1.6} style={{ color: 'var(--status-dropped)' }} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ManageCategoriesModal({ onClose }) {
  const [categories, setCategories] = useState([])
  const [loading, setLoading]       = useState(true)
  const [newName, setNewName]       = useState('')
  const [newEmoji, setNewEmoji]     = useState('')
  const [adding, setAdding]         = useState(false)
  const [showAddRow, setShowAddRow] = useState(false)

  async function load() {
    const res = await window.kozo?.api?.categories?.list()
    if (res?.ok) setCategories(res.data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function addCategory() {
    if (!newName.trim()) return
    setAdding(true)
    await window.kozo?.api?.categories?.add({ name: newName.trim(), emoji: newEmoji.trim() || null })
    setNewName('')
    setNewEmoji('')
    setShowAddRow(false)
    setAdding(false)
    load()
  }

  return (
    <Modal
      title="Manage Categories"
      icon={<IconTag size={17} stroke={1.6} />}
      onClose={onClose}
      width={420}
      footer={
        <button className={ms.btnCancel} onClick={onClose}>Done</button>
      }
    >
      {loading ? (
        <div className={s.loading}>Loading…</div>
      ) : (
        <>
          <div className={s.list}>
            {categories.length === 0 && (
              <div className={s.empty}>No categories yet. Add one below.</div>
            )}
            {categories.map(cat => (
              <CategoryRow
                key={cat.id}
                cat={cat}
                onEdit={load}
                onDelete={load}
              />
            ))}
          </div>

          <div className={s.addSection}>
            {!showAddRow ? (
              <button className={s.addBtn} onClick={() => setShowAddRow(true)}>
                <IconPlus size={14} stroke={2} />
                Add category
              </button>
            ) : (
              <div className={s.addRow}>
                <input
                  className={s.emojiInput}
                  value={newEmoji}
                  onChange={e => setNewEmoji(e.target.value)}
                  placeholder="emoji"
                  maxLength={4}
                />
                <input
                  className={s.nameInput}
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Category name"
                  onKeyDown={e => { if (e.key === 'Enter') addCategory() }}
                  autoFocus
                />
                <button className={s.iconBtn} onClick={addCategory} disabled={adding || !newName.trim()}>
                  <IconCheck size={14} stroke={2} style={{ color: 'var(--status-playing)' }} />
                </button>
                <button className={s.iconBtn} onClick={() => { setShowAddRow(false); setNewName(''); setNewEmoji('') }}>
                  <IconX size={14} stroke={2} style={{ color: 'var(--text-muted)' }} />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}
