import React, { useState, useEffect } from 'react'
import {
  IconSearch, IconLoader2, IconDeviceGamepad2, IconX,
} from '@tabler/icons-react'
import s from './RunningProcessPicker.module.css'

/**
 * Inline picker that lists currently-running .exe processes
 * so the user can choose the right one without guessing its name.
 * Called from AddGameModal and EditGameModal.
 */
export default function RunningProcessPicker({ onPick, onClose }) {
  const [procs, setProcs]     = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery]     = useState('')

  async function load() {
    setLoading(true)
    const res = await window.kozo?.api?.processes?.listRunning()
    setProcs(res?.ok ? (res.data ?? []) : [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? procs.filter(p =>
        p.exe_name.toLowerCase().includes(q) ||
        (p.install_path || '').toLowerCase().includes(q)
      )
    : procs

  return (
    <div className={s.popover}>
      <div className={s.header}>
        <div className={s.searchRow}>
          <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
          <input
            className={s.searchInput}
            placeholder="Filter running processes…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
          <button className={s.refreshBtn} onClick={load} title="Refresh">
            <IconLoader2 size={13} stroke={1.8} className={loading ? s.spinning : ''} />
          </button>
          <button className={s.closeBtn} onClick={onClose} title="Close">
            <IconX size={13} stroke={2} />
          </button>
        </div>
        <div className={s.hint}>
          Start your game first, then pick its process here. Highlighted items look like games.
        </div>
      </div>

      <div className={s.list}>
        {loading && (
          <div className={s.loading}>
            <IconLoader2 size={20} stroke={1.5} className={s.spinning} />
            <span>Reading running processes…</span>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className={s.empty}>
            <IconDeviceGamepad2 size={28} stroke={1.2} style={{ color: 'var(--text-muted)' }} />
            <span>No matching processes</span>
          </div>
        )}

        {!loading && filtered.map((p) => (
          <button
            key={p.exe_name + p.install_path}
            className={`${s.item} ${p.is_likely_game ? s.itemGame : ''}`}
            onClick={() => onPick(p)}
          >
            <div className={s.itemMain}>
              <code className={s.exe}>{p.exe_name}</code>
              {p.is_likely_game && <span className={s.gameTag}>likely game</span>}
            </div>
            {p.install_path && (
              <div className={s.path}>{p.install_path}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
