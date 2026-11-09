import React, { useEffect, useState } from 'react'
import { IconListCheck, IconTrophy, IconCircleX, IconPlayerPause, IconBookmark, IconTrash, IconLoader2 } from '@tabler/icons-react'
import Modal from './ui/Modal'
import s from './KeptOnListPrompt.module.css'

// A game was deleted from the Library, but its Game List entry stays (it has a Steam page, art
// or a rating) and still says Playing. The maker deleted Need for Speed Most Wanted and it sat
// on the Game List as Playing, so KoZo asks what it should say now. ipc.js deleteGames sends
// `gameList:keptPlaying` with the entries.
const CHOICES = [
  { status: 'finished',     label: 'Finished',     Icon: IconTrophy },
  { status: 'dropped',      label: 'Dropped',      Icon: IconCircleX },
  { status: 'on_hold',      label: 'On hold',      Icon: IconPlayerPause },
  { status: 'want_to_play', label: 'Want to play', Icon: IconBookmark },
]

export default function KeptOnListPrompt() {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    const off = window.kozo?.events?.onKeptPlaying?.((list) => { if (Array.isArray(list) && list.length) setRows(list) })
    return () => { try { off?.() } catch {} }
  }, [])

  if (!rows) return null
  const one = rows.length === 1
  const what = one ? rows[0].name : `${rows.length} games`

  async function apply(status) {
    setBusy(status || 'remove')
    for (const r of rows) {
      if (status) await window.kozo?.api?.gameList?.update?.(r.id, { status })
      else await window.kozo?.api?.gameList?.delete?.(r.id)
    }
    setBusy(null)
    setRows(null)
  }

  return (
    <Modal title="Still on your Game List" icon={<IconListCheck size={16} />} onClose={() => setRows(null)} width={460}>
      <div className={s.body} data-kept-prompt="">
        <p className={s.text}>
          <b>{what}</b> {one ? 'is' : 'are'} gone from the Library, but {one ? 'its Game List entry still says' : 'their Game List entries still say'} <b>Playing</b>. What should {one ? 'it' : 'they'} say now?
        </p>
        {!one && <ul className={s.names}>{rows.map(r => <li key={r.id}>{r.name}</li>)}</ul>}
        <div className={s.choices}>
          {CHOICES.map(({ status, label, Icon }) => (
            <button key={status} type="button" className={s.choice} data-gpnav data-kept-status={status} disabled={!!busy} onClick={() => apply(status)}>
              {busy === status ? <IconLoader2 size={15} className="spin" /> : <Icon size={15} stroke={1.8} />} {label}
            </button>
          ))}
        </div>
        <div className={s.foot}>
          <button type="button" className={s.remove} data-gpnav data-kept-remove disabled={!!busy} onClick={() => apply(null)}>
            {busy === 'remove' ? <IconLoader2 size={14} className="spin" /> : <IconTrash size={14} stroke={1.8} />} Remove from the Game List too
          </button>
          <button type="button" className={s.keep} data-gpnav data-kept-keep disabled={!!busy} onClick={() => setRows(null)}>Leave it as Playing</button>
        </div>
      </div>
    </Modal>
  )
}
