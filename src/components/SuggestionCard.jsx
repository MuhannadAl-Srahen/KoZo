import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { IconCalendarPlus, IconPlayerPlay, IconCalendarEvent, IconPlayerPause, IconLoader2, IconArrowBackUp } from '@tabler/icons-react'
import GeneratedCover from './GeneratedCover'
import { fileUrl } from '../lib/utils'
import s from './SuggestionCard.module.css'

// Smart suggestions (electron/services/suggestions.js), one at a time in KoZo's corner, like
// UninstalledCard: plan a game you set Playing for this month, start the next game in your plan,
// carry last month's unfinished plan over, move games you stopped playing to On hold. Never in
// Big Picture, never over another question or an open window, never during a game.
const KIND = {
  plan:  { label: 'Play Plan', Icon: IconCalendarPlus },
  next:  { label: 'Up next', Icon: IconPlayerPlay },
  carry: { label: 'New month', Icon: IconCalendarEvent },
  stale: { label: 'Tidy up', Icon: IconPlayerPause },
}

export default function SuggestionCard() {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)      // { text, undo? } after an answer
  const [artFailed, setArtFailed] = useState(false)
  const noteTimer = useRef(null)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    const load = () => window.kozo?.api?.suggestions?.list?.().then(r => { if (alive && r?.ok) setList(r.data || []) })
    load()
    const offs = [
      window.kozo?.events?.onSuggestionsChanged?.(load),
      window.kozo?.events?.onSessionStarted?.(load),
      window.kozo?.events?.onSessionEnded?.(load),
    ]
    return () => { alive = false; offs.forEach(off => off?.()) }
  }, [])
  useEffect(() => () => clearTimeout(noteTimer.current), [])

  const item = list[0]
  useEffect(() => { setArtFailed(false) }, [item?.key])

  function showNote(n, ms = 6000) {
    clearTimeout(noteTimer.current)
    setNote(n)
    noteTimer.current = setTimeout(() => setNote(null), ms)
  }

  async function answer(action) {
    if (!item) return
    if (action === 'openPlan') navigate('/plan')
    setBusy(action)
    const r = await window.kozo?.api?.suggestions?.answer?.(item.key, action === 'openPlan' ? 'later' : action)
    setBusy(null)
    setList(l => l.filter(x => x.key !== item.key))
    const res = r?.ok ? r.data : null
    if (action === 'off') showNote({ text: 'Turned off. Turn it back on in Settings, General.' })
    else if (action === 'hold' && res?.undo?.length) {
      const before = res.undo
      showNote({ text: `Moved ${before.length === 1 ? '1 game' : `${before.length} games`} to On hold.`, undo: () => window.kozo?.api?.games?.bulkRestore?.(before) }, 20000)
    }
  }

  if (location.pathname.startsWith('/big')) return null

  // What the last answer did (and its Undo), on its own or above the next suggestion.
  const noteRow = note && (
    <div className={s.foot} data-suggestion-note>
      <p className={s.note}>{note.text}</p>
      {note.undo && (
        <button type="button" className={s.btn} data-gpnav data-suggestion-undo
          onClick={async () => { await note.undo(); clearTimeout(noteTimer.current); setNote(null) }}>
          <IconArrowBackUp size={13} /> Undo
        </button>
      )}
    </div>
  )

  if (!item) {
    if (!note) return null
    return <div className={s.card} role="status">{noteRow}</div>
  }

  const meta = KIND[item.kind] || KIND.plan
  const art = !artFailed && (item.coverPath ? fileUrl(item.coverPath, null, { card: true }) : item.coverUrl)

  return (
    <div className={s.card} role="status" data-suggestion={item.kind}>
      {noteRow}
      <div className={s.head}>
        <span className={s.art}>
          {art ? <img src={art} alt="" onError={() => setArtFailed(true)} /> : <GeneratedCover name={item.name || item.title} compact />}
        </span>
        <div className={s.headText}>
          <div className={s.kind}><meta.Icon size={14} stroke={1.8} /> {meta.label}</div>
          <div className={s.title}>{item.title}</div>
          {list.length > 1 && <div className={s.count}>1 of {list.length}</div>}
        </div>
      </div>
      <p className={s.text}>{item.text}</p>
      <div className={s.row}>
        <button type="button" className={`${s.btn} ${s.primary}`} data-gpnav data-suggestion-yes onClick={() => answer(item.primary.action)} disabled={!!busy}>
          {busy === item.primary.action && <IconLoader2 size={13} className="spin" />} {item.primary.label}
        </button>
        {item.secondary && (
          <button type="button" className={s.btn} data-gpnav onClick={() => answer(item.secondary.action)} disabled={!!busy}>
            {item.secondary.label}
          </button>
        )}
        <button type="button" className={s.btn} data-gpnav data-suggestion-later onClick={() => answer('later')} disabled={!!busy}>Not now</button>
      </div>
      <div className={s.foot}>
        <span />
        <button type="button" className={s.link} data-gpnav data-suggestion-off onClick={() => answer('off')} disabled={!!busy}>Don't ask again</button>
      </div>
    </div>
  )
}
