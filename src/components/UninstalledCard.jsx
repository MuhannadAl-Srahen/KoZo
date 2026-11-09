import React, { useEffect, useState } from 'react'
import { IconPackageOff, IconTrophy, IconCircleX, IconPlayerPause, IconArchive, IconTrash, IconLoader2 } from '@tabler/icons-react'
import GeneratedCover from './GeneratedCover'
import { fileUrl } from '../lib/utils'
import s from './UninstalledCard.module.css'

// A game was uninstalled (services/uninstalled.js): a card in the corner asks what to do with
// it, the maker's pick over a bar or a window. Before, the game only went dim and stayed
// "Playing", on the Game List too. One game at a time; each is asked once.
const STATUS_WORD = { playing: 'Playing', finished: 'Finished', dropped: 'Dropped', on_hold: 'On hold', want_to_play: 'Want to play' }
const CHOICES = [
  { key: 'finished', label: 'Finished', Icon: IconTrophy },
  { key: 'dropped',  label: 'Dropped',  Icon: IconCircleX },
  { key: 'on_hold',  label: 'On hold',  Icon: IconPlayerPause },
]

export default function UninstalledCard() {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState(null)
  const [artFailed, setArtFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => window.kozo?.api?.games?.uninstalled?.().then(r => { if (alive && r?.ok) setList(r.data || []) })
    load()
    const off = window.kozo?.events?.onUninstalledChanged?.(load)
    return () => { alive = false; off?.() }
  }, [])

  const game = list[0]
  useEffect(() => { setConfirmDelete(false); setError(null); setArtFailed(false) }, [game?.id])
  if (!game) return null

  async function answer(action) {
    setBusy(action); setError(null)
    const r = await window.kozo?.api?.games?.uninstalledAnswer?.(game.id, action)
    setBusy(null)
    if (r?.ok) setList(l => l.filter(g => g.id !== game.id))
    else setError(r?.error || 'That could not be saved.')
  }

  const status = game.completion_status || game.list_status
  const playing = status === 'playing'
  const art = !artFailed && (game.banner_local_path ? fileUrl(game.banner_local_path, null, { card: true }) : game.banner_url)

  return (
    <div className={s.card} role="status" data-uninstalled={game.id}>
      <div className={s.head}>
        <span className={s.art}>
          {art ? <img src={art} alt="" onError={() => setArtFailed(true)} /> : <GeneratedCover name={game.name} compact />}
        </span>
        <div className={s.headText}>
          <div className={s.title}><IconPackageOff size={15} stroke={1.8} /> Uninstalled</div>
          <div className={s.name} title={game.name}>{game.name}</div>
          {list.length > 1 && <div className={s.count}>1 of {list.length}</div>}
        </div>
      </div>

      <p className={s.text}>
        Its folder is gone from this PC.{status ? <> In KoZo it's still <b>{STATUS_WORD[status] || status}</b>.</> : ''} What should KoZo do with it?
      </p>

      {confirmDelete ? (
        <div className={s.confirm}>
          <p className={s.text}>Delete it from KoZo with its hours, sessions and achievements, and its Game List entry? This can't be undone.</p>
          <div className={s.row}>
            <button type="button" className={s.btn} data-gpnav onClick={() => setConfirmDelete(false)} disabled={!!busy}>Cancel</button>
            <button type="button" className={`${s.btn} ${s.danger}`} data-gpnav data-uninstalled-delete-yes onClick={() => answer('delete')} disabled={!!busy}>
              {busy === 'delete' ? <IconLoader2 size={13} className="spin" /> : <IconTrash size={13} />} Delete
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={s.label}>Mark it</div>
          <div className={s.chips}>
            {CHOICES.filter(c => c.key !== status).map(({ key, label, Icon }) => (
              <button key={key} type="button" className={s.chip} data-gpnav data-uninstalled-status={key} onClick={() => answer(key)} disabled={!!busy}>
                {busy === key ? <IconLoader2 size={13} className="spin" /> : <Icon size={13} stroke={1.8} />} {label}
              </button>
            ))}
          </div>
          <button type="button" className={s.option} data-gpnav data-uninstalled-remove onClick={() => answer('remove')} disabled={!!busy}>
            <IconArchive size={15} stroke={1.7} />
            <span>
              <b>Remove from Library</b>
              <small>Keeps its hours and achievements{playing ? ', and sets it On hold' : ''}</small>
            </span>
          </button>
          <button type="button" className={`${s.option} ${s.optionDanger}`} data-gpnav data-uninstalled-delete onClick={() => setConfirmDelete(true)} disabled={!!busy}>
            <IconTrash size={15} stroke={1.7} />
            <span>
              <b>Delete from KoZo</b>
              <small>With its history and its Game List entry</small>
            </span>
          </button>
        </>
      )}

      {error && <p className={s.error}>{error}</p>}
      {!confirmDelete && (
        <div className={s.foot}>
          <button type="button" className={s.link} data-gpnav data-uninstalled-keep onClick={() => answer('keep')} disabled={!!busy}>Keep it, I'll reinstall</button>
        </div>
      )}
    </div>
  )
}
