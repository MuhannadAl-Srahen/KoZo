import React, { useEffect, useState } from 'react'
import { IconPhotoSearch, IconSearch, IconLoader2, IconCheck } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './CoverPickerModal.module.css'

// Pick a cover from SteamGridDB (Settings → Steam → Covers for non-Steam games).
// Search by name, choose the matching game, click a cover to apply it; the
// game's wide SteamGridDB banner is applied too when one exists.
export default function CoverPickerModal({ game, onClose, onApplied }) {
  const [term, setTerm]       = useState(game.name || '')
  const [matches, setMatches] = useState(null)   // null = not searched yet
  const [active, setActive]   = useState(null)   // SteamGridDB game id
  const [grids, setGrids]     = useState(null)
  const [busy, setBusy]       = useState(false)
  const [applying, setApplying] = useState(null)
  const [error, setError]     = useState(null)

  async function search(q = term) {
    setBusy(true); setError(null); setGrids(null)
    const res = await window.kozo?.api?.sgdb?.search?.(q)
    setBusy(false)
    if (!res?.ok) {
      setError(/no_key/.test(res?.error || '')
        ? 'Add your free SteamGridDB key in Settings, Steam, Covers for non-Steam games.'
        : /invalid_key/.test(res?.error || '') ? 'SteamGridDB rejected the saved key. Check it in Settings.' : (res?.error || 'Search failed.'))
      setMatches([])
      return
    }
    setMatches(res.data || [])
    if (res.data?.[0]) pick(res.data[0].id)
  }

  async function pick(id) {
    setActive(id); setGrids(null)
    const res = await window.kozo?.api?.sgdb?.grids?.(id)
    setGrids(res?.ok ? res.data || [] : [])
  }

  async function apply(grid) {
    setApplying(grid.id)
    const heroes = await window.kozo?.api?.sgdb?.heroes?.(active)
    const hero = heroes?.ok ? heroes.data?.[0]?.url : null
    const res = await window.kozo?.api?.sgdb?.apply?.(game.id, grid.url, hero)
    setApplying(null)
    if (res?.ok) onApplied?.(res.data)
    else setError(res?.error || 'Could not download that cover.')
  }

  useEffect(() => { search(game.name || '') }, [])

  return (
    <Modal title="Find a cover" icon={<IconPhotoSearch size={17} stroke={1.6} />} onClose={onClose} width={760}
      footer={<button className={ms.btnCancel} onClick={onClose}>Close</button>}>
      <form className={s.searchRow} onSubmit={(e) => { e.preventDefault(); search() }}>
        <div className={s.searchBox}>
          <IconSearch size={14} />
          <input value={term} onChange={e => setTerm(e.target.value)} placeholder="Game name" autoFocus />
        </div>
        <button type="submit" className={ms.btnPrimary} disabled={busy || !term.trim()}>
          {busy ? <IconLoader2 size={14} className="spin" /> : 'Search'}
        </button>
      </form>

      {error && <div className={s.error}>{error}</div>}

      {matches?.length > 0 && (
        <div className={s.matches}>
          {matches.slice(0, 8).map(m => (
            <button key={m.id} className={`${s.match} ${m.id === active ? s.matchActive : ''}`} onClick={() => pick(m.id)}>
              {m.name}{m.year ? ` (${m.year})` : ''}
            </button>
          ))}
        </div>
      )}
      {matches && !matches.length && !error && <div className={s.muted}>No games found on SteamGridDB for that name.</div>}

      {active && grids === null && <div className={s.muted}><IconLoader2 size={14} className="spin" /> Loading covers…</div>}
      {grids && !grids.length && <div className={s.muted}>No portrait covers for this game yet.</div>}
      {grids?.length > 0 && (
        <div className={s.grid}>
          {grids.slice(0, 30).map(g => (
            <button key={g.id} className={s.cover} onClick={() => apply(g)} disabled={!!applying} title="Use this cover">
              <img src={g.thumb} alt="" loading="lazy" />
              {applying === g.id && <span className={s.applying}><IconLoader2 size={18} className="spin" /></span>}
              <span className={s.use}><IconCheck size={13} /> Use</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
