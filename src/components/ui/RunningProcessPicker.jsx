import React, { useState, useEffect, useRef } from 'react'
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
  // Closing the picker mid-scan unmounts it while listRunning() is still in flight.
  const alive                 = useRef(true)

  async function load() {
    setLoading(true)
    const res = await window.kozo?.api?.processes?.listRunning()
    if (!alive.current) return
    setProcs(res?.ok ? (res.data ?? []) : [])
    setLoading(false)
  }

  useEffect(() => {
    // Re-arm on every setup — StrictMode runs setup → cleanup → setup on mount,
    // so a flag only ever cleared would leave the picker stuck on its spinner
    // (and its Refresh button dead, since load() is also called from there).
    alive.current = true
    load()
    return () => { alive.current = false }
  }, [])

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
        {/* hasRing: the wrapper is the visible control, so the focus ring is
            drawn once around the whole row instead of around the bare input. */}
        <div className={`${s.searchRow} hasRing`}>
          <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
          <input
            className={s.searchInput}
            placeholder="Filter running processes…"
            aria-label="Filter running processes"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
          <button type="button" className={s.refreshBtn} onClick={load} title="Refresh" aria-label="Refresh process list">
            <IconLoader2 size={13} stroke={1.8} className={loading ? 'spin' : ''} />
          </button>
          <button type="button" className={s.closeBtn} onClick={onClose} title="Close" aria-label="Close process picker">
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
            <IconLoader2 size={20} stroke={1.5} className="spin" />
            <span>Reading running processes…</span>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className={s.empty}>
            <IconDeviceGamepad2 size={28} stroke={1.2} className={s.emptyIcon} />
            <span>No matching processes</span>
          </div>
        )}

        {!loading && filtered.map((p) => (
          <button
            key={p.exe_name + p.install_path}
            type="button"
            className={`${s.item} ${p.is_likely_game ? s.itemGame : ''}`}
            onClick={() => onPick(p)}
            title={p.install_path ? `${p.exe_name}\n${p.install_path}` : p.exe_name}
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
