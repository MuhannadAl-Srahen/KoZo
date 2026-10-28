import React, { useEffect, useState } from 'react'
import { IconConfetti, IconBooks, IconBookmark, IconX } from '@tabler/icons-react'
import s from './ReleasedPanel.module.css'

// "Now out" — tracked upcoming games whose release date has passed and that the
// user hasn't acknowledged yet (electron/services/releaseWatch.js keeps the
// list). The overlay toast fires once; this panel makes sure a release that
// happened while KoZo was closed or in the tray is still seen.
export default function ReleasedPanel({ onChanged }) {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    let alive = true
    window.kozo?.api?.releases?.unseen?.().then(res => { if (alive && res?.ok) setList(res.data || []) })
    const off = window.kozo?.events?.onReleasesChanged?.((next) => setList(next || []))
    return () => { alive = false; off?.() }
  }, [])

  if (!list.length) return null

  async function act(r, kind) {
    setBusy(r.id)
    if (kind === 'library') await window.kozo.api.gameList.moveToLibrary([r.id])
    else if (kind === 'want') await window.kozo.api.gameList.update(r.id, { status: 'want_to_play' })
    await window.kozo.api.releases.dismiss([r.id])
    setBusy(null)
    onChanged?.()
  }

  return (
    <div className={s.panel} role="status">
      <div className={s.head}>
        <IconConfetti size={16} stroke={1.7} />
        <span className={s.title}>Now out: {list.length === 1 ? list[0].name : `${list.length} games you track`}</span>
        <button className={s.dismissAll} onClick={() => window.kozo.api.releases.dismiss('all')}>Dismiss all</button>
      </div>
      <div className={s.rows}>
        {list.map(r => (
          <div key={r.id} className={s.row}>
            {r.steam_app_id && (
              <img className={s.art} src={`https://cdn.akamai.steamstatic.com/steam/apps/${r.steam_app_id}/capsule_184x69.jpg`} alt="" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
            )}
            <div className={s.info}>
              <div className={s.name}>{r.name}</div>
              <div className={s.date}>Released {r.release_date}</div>
            </div>
            <button className={s.btn} disabled={busy === r.id} onClick={() => act(r, 'library')}>
              <IconBooks size={13} /> Move to Library
            </button>
            <button className={s.btn} disabled={busy === r.id} onClick={() => act(r, 'want')}>
              <IconBookmark size={13} /> Want to play
            </button>
            <button className={s.close} onClick={() => act(r, 'dismiss')} aria-label="Dismiss"><IconX size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  )
}
