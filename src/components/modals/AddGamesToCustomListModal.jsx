import React, { useState, useEffect } from 'react'
import { IconPlaylistAdd, IconSearch, IconCheck, IconDeviceGamepad2 } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './AddGameModal.module.css'

// Multi-select picker: add existing Game List entries to a custom list without
// opening each game one by one. Shows only items NOT already in the list.
export default function AddGamesToCustomListModal({ list, onClose, onAdded }) {
  const [candidates, setCandidates] = useState(null)   // null = loading
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(new Set())
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [allRes, memberRes] = await Promise.all([
        window.kozo?.api?.gameList?.list({ limit: 10000, offset: 0 }),
        window.kozo?.api?.gameList?.list({ listId: list.id, limit: 10000, offset: 0 }),
      ])
      if (cancelled) return
      const all = allRes?.ok ? (allRes.data?.items ?? []) : []
      const memberIds = new Set((memberRes?.ok ? (memberRes.data?.items ?? []) : []).map(i => i.id))
      setCandidates(all.filter(i => !memberIds.has(i.id)))
    }
    load()
    return () => { cancelled = true }
  }, [list.id])

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleAdd() {
    setAdding(true)
    for (const id of selected) {
      await window.kozo?.api?.customLists?.addGame(list.id, id)
    }
    setAdding(false)
    onAdded?.()
  }

  const shown = (candidates ?? []).filter(i =>
    !query.trim() || i.name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <Modal
      title={`Add games to "${list.name}"`}
      icon={<IconPlaylistAdd size={17} stroke={1.6} />}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className={ms.btnCancel} onClick={onClose}>Cancel</button>
          <button className={ms.btnPrimary} onClick={handleAdd} disabled={adding || selected.size === 0}>
            {adding ? 'Adding…' : `Add ${selected.size || ''} game${selected.size === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className={s.field}>
        <div style={{ position: 'relative' }}>
          <IconSearch size={13} stroke={1.6} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            className={s.input}
            style={{ paddingLeft: 30 }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search your game list…"
            autoFocus
          />
        </div>
      </div>

      <div style={{ maxHeight: '46vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {candidates === null && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '14px 4px' }}>Loading…</div>
        )}
        {candidates !== null && shown.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '14px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconDeviceGamepad2 size={16} stroke={1.5} />
            {candidates.length === 0
              ? 'Every game in your Game List is already in this list.'
              : 'No games match your search.'}
          </div>
        )}
        {shown.map(item => {
          const on = selected.has(item.id)
          return (
            <button
              key={item.id}
              onClick={() => toggle(item.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 9px', borderRadius: 'var(--r-input)',
                border: `1px solid ${on ? 'var(--a)' : 'var(--border)'}`,
                background: on ? 'var(--ab)' : 'var(--surface-2)',
                color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13,
                textAlign: 'left', cursor: 'pointer',
              }}
            >
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                  border: `1px solid ${on ? 'var(--a)' : 'var(--border)'}`,
                  background: on ? 'var(--a)' : 'transparent', color: '#09090f',
                }}
              >
                {on && <IconCheck size={11} stroke={3} />}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </span>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
