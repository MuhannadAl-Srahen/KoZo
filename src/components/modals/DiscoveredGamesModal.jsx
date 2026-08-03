import React, { useState } from 'react'
import { IconSearch, IconTrophy, IconLoader2, IconCheck } from '@tabler/icons-react'
import Modal from '../ui/Modal'
import s from './DiscoveredGamesModal.module.css'

// Games KoZo found achievement data for on disk that aren't in the library.
// Nothing is added without an explicit tick — a stray app id in an emulator
// folder should never quietly become a library entry.

export default function DiscoveredGamesModal({ games, onClose, onAdded }) {
  const [picked, setPicked] = useState(() => new Set(games.filter(g => g.unlocked > 0).map(g => g.appId)))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(0)

  const toggle = (appId) => setPicked(p => {
    const next = new Set(p)
    next.has(appId) ? next.delete(appId) : next.add(appId)
    return next
  })

  async function add() {
    setBusy(true)
    const chosen = games.filter(g => picked.has(g.appId))
    for (const g of chosen) {
      try {
        await window.kozo.api.games.add({
          name: g.name || `App ${g.appId}`,
          steam_app_id: Number(g.appId),
          is_cracked: 1,
          source: 'cracked',
          // No exe yet — its unlocks are read from the emulator folder by app id,
          // which needs no install path. Point it at the game later (Edit →
          // Browse, or a PC scan) to also get playtime tracking.
          install_path: null,
          exe_name: null,
          is_installed: 0,
        })
        setDone(d => d + 1)
      } catch { /* keep going; one bad add shouldn't stop the rest */ }
    }
    // Anything left unticked was a deliberate "no" — don't ask about it again.
    for (const g of games) {
      if (!picked.has(g.appId)) {
        try { await window.kozo.api.crack.dismissDiscovered(g.appId) } catch {}
      }
    }
    setBusy(false)
    onAdded?.()
    onClose()
  }

  return (
    <Modal
      title="Found achievements for games you haven't added"
      icon={<IconSearch size={16} stroke={1.6} />}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className={s.btnGhost} onClick={onClose} disabled={busy}>Cancel</button>
          <button className={s.btnAdd} onClick={add} disabled={busy || picked.size === 0}>
            {busy
              ? <><IconLoader2 size={13} stroke={1.8} className={s.spin} /> Adding {done}/{picked.size}…</>
              : <><IconCheck size={13} stroke={2.4} /> Add {picked.size} game{picked.size === 1 ? '' : 's'}</>}
          </button>
        </>
      }
    >
      <p className={s.intro}>
        These have achievement data from a Steam emulator on this PC, but aren't in your
        library. Ticking one adds it and imports whatever it has already unlocked.
        Anything you leave unticked won't be suggested again.
      </p>

      <div className={s.list}>
        {games.map(g => {
          const on = picked.has(g.appId)
          return (
            <label key={g.appId} className={`${s.row} ${on ? s.rowOn : ''}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(g.appId)} className={s.check} />
              {g.headerImage
                ? <img src={g.headerImage} alt="" className={s.art} onError={e => { e.target.style.visibility = 'hidden' }} />
                : <span className={s.artFallback}><IconTrophy size={16} stroke={1.4} /></span>}
              <span className={s.info}>
                <span className={s.name}>{g.name || `App ${g.appId}`}</span>
                <span className={s.meta}>{g.source} · app {g.appId}</span>
              </span>
              <span className={g.unlocked > 0 ? s.unlocked : s.none}>
                {g.unlocked > 0 ? `${g.unlocked} unlocked` : 'none yet'}
              </span>
            </label>
          )
        })}
      </div>
    </Modal>
  )
}
