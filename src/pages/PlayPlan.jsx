import React, { useEffect, useMemo, useState } from 'react'
import {
  IconCalendarEvent, IconPlus, IconSearch, IconCalendarOff, IconCheck, IconChevronLeft, IconChevronRight,
  IconPlayerPlayFilled, IconListCheck, IconDeviceGamepad2, IconFlag, IconStarFilled, IconClock,
  IconPencil, IconBrandSteam, IconX, IconArrowRight, IconCalendarMonth,
} from '@tabler/icons-react'
import { fileUrl, formatMonthKey, formatPlaytime, monthKey, parseGenres } from '../lib/utils'
import { LIST_STATUSES } from '../lib/cardModel'
import GeneratedCover from '../components/GeneratedCover'
import ContextMenu from '../components/ui/ContextMenu'
import EmptyState from '../components/ui/EmptyState'
import InfoModal from '../components/ui/InfoModal'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
import EditGameListModal from '../components/modals/EditGameListModal'
import PlanMonthModal from '../components/modals/PlanMonthModal'
import RateGameModal from '../components/modals/RateGameModal'
import useCardZoom from '../lib/useCardZoom'
import { ratingColor } from '../components/ui/RatingPicker'
import s from './PlayPlan.module.css'

// Play Plan: what you mean to play, month by month. A month is a hero (the
// game in focus on its own art, with the month's progress) over one lineup of
// posters in play order: Playing, then Up next (numbered), then Done. Drag a
// poster to reorder; dropping it among another state's posters changes its
// status (Done marks it Finished, which asks for a rating). Drag onto a month
// pill to move it. The plan lives on the Game List row (planned_month), the
// same field Plan for month sets from the Library and the Game List; the
// lineup order is the row's display_order.

const LANES = [
  { key: 'next',    label: 'Up next', Icon: IconListCheck,      status: 'want_to_play' },
  { key: 'playing', label: 'Playing', Icon: IconDeviceGamepad2, status: 'playing' },
  { key: 'done',    label: 'Done',    Icon: IconFlag,           status: 'finished' },
]
function laneOf(status) {
  if (status === 'playing') return 'playing'
  if (status === 'finished' || status === 'dropped') return 'done'
  return 'next'
}

function monthsAround() {
  const now = new Date()
  return Array.from({ length: 13 }, (_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() - 1 + i, 1)))
}
function shiftMonth(key, by) {
  const [y, m] = key.split('-').map(Number)
  return monthKey(new Date(y, m - 1 + by, 1))
}
// Local month bounds as ISO strings, compared with sessions.started_at.
function monthBounds(key) {
  const [y, m] = key.split('-').map(Number)
  return [new Date(y, m - 1, 1).toISOString(), new Date(y, m, 1).toISOString()]
}

function coverOf(item) {
  return item.banner_url || (item.game_banner_local_path ? fileUrl(item.game_banner_local_path) : null)
}

function Thumb({ item }) {
  const [failed, setFailed] = useState(false)
  const src = coverOf(item)
  return src && !failed
    ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <GeneratedCover name={item.name} compact />
}

function dragProps(item) {
  return {
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.setData('text/kozo-plan', String(item.id)); e.dataTransfer.effectAllowed = 'move' },
  }
}

// Wide art for the hero: Steam's hero/header (asked once per game,
// remembered), else the cover blurred behind itself.
const wideArt = new Map()
function useWideArt(item) {
  const [, bump] = useState(0)
  const id = item?.steam_app_id
  useEffect(() => {
    if (!id || wideArt.has(id)) return
    wideArt.set(id, null)
    window.kozo?.api?.steam?.appAssets?.([id]).then(res => {
      const a = res?.ok ? res.data?.[id] : null
      wideArt.set(id, a?.hero || a?.header || null)
      bump(n => n + 1)
    }).catch(() => {})
  }, [id])
  return (id && wideArt.get(id)) || null
}

// The top of a month: its name and progress on the art of the game in focus
// (the one you're playing, else the next one up).
function MonthHero({ label, isNow, focus, playing, setFocus, stats, onPrev, onNext, onAdd, onOpen, onContextMenu, onPlay, onStart, onDone }) {
  const wide = useWideArt(focus)
  const cover = focus ? coverOf(focus) : null
  const isPlaying = focus?.status === 'playing'
  return (
    <section className={s.hero}>
      {wide ? <img key={wide} className={s.heroArt} src={wide} alt="" />
        : cover ? <img key={cover} className={`${s.heroArt} ${s.heroArtSoft}`} src={cover} alt="" /> : null}
      <span className={s.heroShade} />
      <div className={s.heroMain}>
        <div className={s.heroNav}>
          <button className={s.navBtn} onClick={onPrev} aria-label="Previous month"><IconChevronLeft size={17} /></button>
          <button className={s.navBtn} onClick={onNext} aria-label="Next month"><IconChevronRight size={17} /></button>
          {isNow && <span className={s.nowTag}>This month</span>}
        </div>
        <div className={s.heroTitle}>{stats.total ? <span className={s.cap}>{label}</span> : <>Nothing planned for <span className={s.cap}>{label}</span></>}</div>
        {stats.total > 0 ? (
          <>
            <div className={s.progress}><span style={{ width: `${stats.pct}%` }} /></div>
            <div className={s.heroStats}>
              <span><strong>{stats.done}</strong> of <strong>{stats.total}</strong> done</span>
              {stats.playedSec > 0 && <span><IconClock size={13} /> {formatPlaytime(stats.playedSec)} played</span>}
              {stats.done === stats.total && <span className={s.allDone}><IconCheck size={13} /> All done</span>}
            </div>
          </>
        ) : (
          <>
            <div className={s.heroStats}>Add the games you want to play, then move them along as you go.</div>
            <button className={`${s.btnPrimary} ${s.heroAdd}`} onClick={onAdd}><IconPlus size={14} stroke={2} /> Add games</button>
          </>
        )}
      </div>
      {focus && (
        <div className={s.focus}>
          <div className={s.focusCard} onClick={() => onOpen(focus)} onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, focus) }} data-gpnav="">
            <span className={s.focusCover}><Thumb item={focus} /></span>
            <div className={s.focusText}>
              <span className={s.focusKicker} style={{ '--fc': isPlaying ? 'var(--status-playing)' : 'var(--a)' }}>
                {isPlaying ? <><IconDeviceGamepad2 size={12} /> Playing now</> : <><IconListCheck size={12} /> Up next</>}
              </span>
              <span className={s.focusName}>{focus.name}</span>
              <span className={s.focusMeta}>
                <IconClock size={12} /> {focus.month_seconds > 0 ? `${formatPlaytime(focus.month_seconds)} this month` : 'Not played this month yet'}
              </span>
              <div className={s.focusActions} onClick={e => e.stopPropagation()}>
                {focus.game_id && (
                  <button type="button" className={`${s.pillBtn} ${s.pillMain}`} onClick={() => onPlay(focus)} data-gpclick="">
                    <IconPlayerPlayFilled size={13} /> Play
                  </button>
                )}
                {isPlaying
                  ? <button type="button" className={s.pillBtn} onClick={() => onDone(focus)}><IconFlag size={13} /> Done</button>
                  : <button type="button" className={s.pillBtn} onClick={() => onStart(focus)}><IconDeviceGamepad2 size={13} /> Start</button>}
              </div>
            </div>
          </div>
          {playing.length > 1 && (
            <div className={s.focusDots}>
              {playing.map(p => (
                <button key={p.id} type="button" title={p.name}
                  className={`${s.focusDot} ${p.id === focus.id ? s.focusDotOn : ''}`}
                  onClick={() => setFocus(p.id)}>
                  <Thumb item={p} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// One poster in the month's lineup. Its state sits on the art: Playing glows
// with the month's hours along the bottom, Up next has its place number, Done
// has its score.
function LineupCard({ item, n, maxSec, dropMark, onOpen, onContextMenu, onPlay, onStart, onDone, onRate, onDragOverCard, onDropCard }) {
  const lane = laneOf(item.status)
  const score = item.rating ? Math.round(item.rating) : null
  const genres = parseGenres(item).slice(0, 2)
  const tag = ['on_hold', 'upcoming'].includes(item.status) ? LIST_STATUSES[item.status] : null
  const sub = lane === 'playing'
    ? (item.month_seconds > 0 ? `${formatPlaytime(item.month_seconds)} this month` : 'Not played this month yet')
    : lane === 'done'
      ? (item.status === 'dropped' ? 'Dropped' : score ? 'Finished' : 'Finished, not rated')
      : (tag ? tag.label : genres.length ? genres.join(' · ') : 'Up next')
  return (
    <div
      className={[
        s.lu,
        lane === 'playing' && s.luPlaying,
        lane === 'done' && s.luDone,
        item.status === 'dropped' && s.luDropped,
        n === 1 && s.luFirst,
        dropMark === 'before' && s.luDropBefore,
        dropMark === 'after' && s.luDropAfter,
      ].filter(Boolean).join(' ')}
      {...dragProps(item)}
      onDragOver={(e) => onDragOverCard(e, item)}
      onDrop={(e) => onDropCard(e, item)}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
      data-gpnav=""
      title={item.name}
    >
      <div className={s.luArt}>
        <Thumb item={item} />
        <span className={s.luShade} />
        {lane === 'next' && <span className={s.luNum}>{n}</span>}
        {lane === 'playing' && <span className={`${s.luBadge} ${s.luBadgePlaying}`}><IconDeviceGamepad2 size={12} /> Playing</span>}
        {lane === 'done' && (item.status === 'dropped'
          ? <span className={`${s.luBadge} ${s.luBadgeDropped}`}><IconX size={12} /> Dropped</span>
          : <span className={`${s.luBadge} ${s.luBadgeDone}`}><IconCheck size={12} stroke={2.5} /> Done</span>)}
        {score && <span className={s.luScore} style={{ '--score': ratingColor(score) }}><strong>{score}</strong><span>/10</span></span>}
        {lane === 'playing' && maxSec > 0 && <span className={s.luBar}><span style={{ width: `${Math.round(((item.month_seconds || 0) / maxSec) * 100)}%` }} /></span>}
        <div className={s.luActions} onClick={e => e.stopPropagation()}>
          {lane === 'next' && (
            <button type="button" className={`${s.luBtn} ${s.luBtnMain}`} onClick={() => onStart(item)} title="Move to Playing">
              <IconDeviceGamepad2 size={13} /> Start
            </button>
          )}
          {lane === 'playing' && (
            <button type="button" className={s.luBtn} onClick={() => onDone(item)} title="Finished it">
              <IconFlag size={13} /> Done
            </button>
          )}
          {lane === 'done' && item.status === 'finished' && !score && (
            <button type="button" className={`${s.luBtn} ${s.luBtnMain}`} onClick={() => onRate(item)}>
              <IconStarFilled size={13} /> Rate it
            </button>
          )}
          {lane !== 'done' && item.game_id && (
            <button type="button" className={`${s.luBtn} ${lane === 'playing' ? s.luBtnMain : s.luBtnPlay}`} onClick={() => onPlay(item)} title="Play" aria-label={`Play ${item.name}`} data-gpclick="">
              <IconPlayerPlayFilled size={13} />{lane === 'playing' && ' Play'}
            </button>
          )}
        </div>
      </div>
      <span className={s.luName}>{item.name}</span>
      <span className={s.luSub}>{sub}</span>
    </div>
  )
}

// "Not planned": plain posters, drag one onto a month chip.
function PosterCard({ item, onOpen, onContextMenu }) {
  return (
    <div
      className={s.card}
      {...dragProps(item)}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
      data-gpnav=""
      title={item.name}
    >
      <div className={s.cover}><Thumb item={item} /></div>
      <div className={s.info}>
        <div className={s.name}>{item.name}</div>
        <div className={s.meta}>{LIST_STATUSES[item.status] && <span style={{ color: LIST_STATUSES[item.status].color }}>{LIST_STATUSES[item.status].label}</span>}</div>
      </div>
    </div>
  )
}

// Pick games that have no plan yet and put them in the shown month.
function AddToMonthModal({ month, onClose, onAdded }) {
  const [items, setItems] = useState(null)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  useEffect(() => {
    window.kozo?.api?.gameList?.list?.({ month: 'none', limit: 5000, offset: 0 })
      .then(r => setItems(r?.ok ? (r.data?.items || []).filter(i => i.status !== 'finished' && i.status !== 'dropped') : []))
  }, [])
  const shown = (items || []).filter(i => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200)
  const toggle = (id) => setPicked(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  async function save() {
    if (picked.size) await window.kozo?.api?.gameList?.planMonth?.([...picked], month)
    onAdded()
  }
  return (
    <Modal
      title={`Add games to ${formatMonthKey(month, 'long')}`}
      icon={<IconCalendarEvent size={17} stroke={1.6} />}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className={ms.btnCancel} onClick={onClose}>Cancel</button>
          <button className={ms.btnPrimary} onClick={save} disabled={!picked.size}>
            Add {picked.size || ''} {picked.size === 1 ? 'game' : 'games'}
          </button>
        </>
      }
    >
      <div className={`${s.search} hasRing`}>
        <IconSearch size={14} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search your Game List" autoFocus />
      </div>
      <div className={s.pickList}>
        {items === null && <div className={s.muted}>Loading…</div>}
        {items && !shown.length && <div className={s.muted}>No unplanned games match.</div>}
        {shown.map(i => (
          <button key={i.id} type="button" className={`${s.pickRow} ${picked.has(i.id) ? s.pickRowOn : ''}`} onClick={() => toggle(i.id)}>
            <span className={s.pickThumb}>{coverOf(i) ? <img src={coverOf(i)} alt="" loading="lazy" /> : <GeneratedCover name={i.name} compact />}</span>
            <span className={s.pickName}>{i.name}</span>
            <span className={s.pickStatus}>{LIST_STATUSES[i.status]?.label || ''}</span>
            {picked.has(i.id) && <IconCheck size={15} className={s.pickCheck} />}
          </button>
        ))}
      </div>
    </Modal>
  )
}

export default function PlayPlan() {
  const thisMonth = monthKey(new Date())
  const [month, setMonth] = useState(thisMonth)
  const [summary, setSummary] = useState({})   // 'YYYY-MM' → { total, done }
  const [items, setItems] = useState(null)
  const [ahead, setAhead] = useState({})       // next months' rows, for the preview tiles
  const [dropOn, setDropOn] = useState(null)   // month chip or lane being dragged over
  const [edit, setEdit] = useState(null)
  const [ctx, setCtx] = useState(null)
  const [rateItem, setRateItem] = useState(null)
  const [moveIds, setMoveIds] = useState(null)
  const [adding, setAdding] = useState(false)
  const [dropMark, setDropMark] = useState(null)     // { id, pos } drop bar in the lineup
  const [focusId, setFocusId] = useState(null)       // which Playing game the hero shows
  const [launchError, setLaunchError] = useState(null)
  const zoomStyle = useCardZoom('plan', 'grid', { grid: 180 }, { min: 130, max: 380 })   // Ctrl + mouse wheel

  // The 13-month window, plus any other month that has plans (an old one).
  const months = useMemo(() => [...new Set([...monthsAround(), ...Object.keys(summary)])].sort(), [summary])
  const nextMonths = month === 'none' ? [] : [1, 2, 3].map(i => shiftMonth(month, i))
  const pastMonths = Object.keys(summary).filter(m => m < thisMonth).sort().reverse().slice(0, 6)

  async function loadSummary() {
    const r = await window.kozo?.api?.gameList?.planSummary?.()
    if (r?.ok) setSummary(Object.fromEntries((r.data || []).map(m => [m.month, { total: m.total, done: m.done }])))
  }
  async function board(m) {
    if (m === 'none') {
      const r = await window.kozo?.api?.gameList?.list?.({ month: 'none', limit: 5000, offset: 0 })
      return r?.ok ? (r.data?.items || []) : []
    }
    const r = await window.kozo?.api?.gameList?.planBoard?.(m, ...monthBounds(m))
    return r?.ok ? r.data || [] : []
  }
  async function loadItems(m = month) {
    const rows = await board(m)
    setItems(rows)
    if (m !== 'none') {
      const next = await Promise.all([1, 2, 3].map(i => board(shiftMonth(m, i))))
      setAhead(Object.fromEntries(next.map((rows, i) => [shiftMonth(m, i + 1), rows])))
    }
  }
  const reload = () => { loadSummary(); loadItems() }

  useEffect(() => { loadSummary() }, [])
  useEffect(() => { setItems(null); loadItems(month) }, [month])
  useEffect(() => {
    const offs = [
      window.kozo?.events?.onGameUpdated?.(() => { loadSummary(); loadItems() }),
      window.kozo?.events?.onSessionEnded?.(() => loadItems()),
    ]
    return () => offs.forEach(off => off?.())
  }, [month])

  async function moveTo(ids, target) {
    await window.kozo?.api?.gameList?.planMonth?.(ids, target === 'none' ? null : target)
    reload()
  }

  async function dropInLane(id, laneKey) {
    const item = (items || []).find(i => i.id === id)
    if (!item || laneOf(item.status) === laneKey) return
    const status = LANES.find(l => l.key === laneKey).status
    setItems(prev => prev.map(i => (i.id === id ? { ...i, status } : i)))   // move it at once
    await window.kozo?.api?.gameList?.update?.(id, { status })
    reload()
  }

  // Lineup order = display_order. The whole month is rewritten in its shown
  // order (Playing, Up next, Done) so nothing else moves.
  async function saveOrder(ids) {
    await window.kozo?.api?.gameList?.reorderPage?.({ month }, 0, ids)
    reload()
  }
  function onDragOverCard(e, target) {
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const pos = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
    setDropMark(m => (m?.id === target.id && m.pos === pos ? m : { id: target.id, pos }))
  }
  // Dropped on a poster: it takes that place, and that poster's state.
  async function onDropCard(e, target) {
    e.preventDefault()
    const id = dropId(e)
    const mark = dropMark
    setDropMark(null); setDropOn(null)
    if (!id || id === target.id) return
    const item = (items || []).find(i => i.id === id)
    if (!item) return
    const lane = laneOf(target.status)
    const ids = order.map(i => i.id).filter(x => x !== id)
    let at = ids.indexOf(target.id)
    if (mark?.pos === 'after') at += 1
    ids.splice(Math.max(0, at), 0, id)
    if (laneOf(item.status) !== lane) {
      const status = LANES.find(l => l.key === lane).status
      setItems(prev => prev.map(i => (i.id === id ? { ...i, status } : i)))
      await window.kozo?.api?.gameList?.update?.(id, { status })
    }
    saveOrder(ids)
  }

  async function play(item) {
    const res = await window.kozo?.api?.games?.launch?.(item.game_id)
    if (!res?.ok) setLaunchError(res?.error || 'KoZo could not start this game.')
  }

  const dropId = (e) => Number(e.dataTransfer.getData('text/kozo-plan'))
  const chipDrop = (m) => ({
    onDragOver: (e) => { e.preventDefault(); setDropOn(m) },
    onDragLeave: () => setDropOn(d => (d === m ? null : d)),
    onDrop: (e) => { e.preventDefault(); setDropOn(null); const id = dropId(e); if (id && m !== month) moveTo([id], m) },
  })

  const label = month === 'none' ? 'Not planned' : formatMonthKey(month, 'long')
  const lanes = Object.fromEntries(LANES.map(l => [l.key, (items || []).filter(i => laneOf(i.status) === l.key)]))
  const order = [...lanes.playing, ...lanes.next, ...lanes.done]
  const focus = lanes.playing.find(i => i.id === focusId) || lanes.playing[0] || lanes.next[0] || null
  const maxSec = Math.max(0, ...lanes.playing.map(i => i.month_seconds || 0))
  const total = items?.length || 0
  const done = (items || []).filter(i => i.status === 'finished').length
  const playedSec = (items || []).reduce((a, i) => a + (i.month_seconds || 0), 0)
  const pct = total ? Math.round((done / total) * 100) : 0
  const openCtx = (e, it) => setCtx({ x: e.clientX, y: e.clientY, item: it })

  // Right-click on a plan card: only what fits a plan (no Upcoming status).
  async function setStatus(it, status) {
    await window.kozo?.api?.gameList?.update?.(it.id, { status })
    reload()
  }
  function planMenu(it) {
    const lane = laneOf(it.status)
    const next = lane === 'next' ? { label: 'Start playing', Icon: IconDeviceGamepad2, status: 'playing' }
      : lane === 'playing' ? { label: 'Mark as done', Icon: IconFlag, status: 'finished' } : null
    const here = it.planned_month
    const monthsAhead = Array.from({ length: 6 }, (_, i) => shiftMonth(thisMonth, i))
    return [
      it.game_id && it.status !== 'finished' && it.status !== 'dropped' && { label: 'Play', Icon: IconPlayerPlayFilled, color: 'var(--a)', onClick: () => play(it) },
      next && { label: next.label, Icon: IconArrowRight, onClick: () => setStatus(it, next.status) },
      { label: 'Status', Icon: IconListCheck, hint: it.status === 'dropped' ? 'Dropped' : LANES.find(l => l.key === lane)?.label, sub: [
        { label: 'Up next', Icon: IconListCheck, active: lane === 'next', onClick: () => setStatus(it, 'want_to_play') },
        { label: 'Playing', Icon: IconDeviceGamepad2, color: 'var(--status-playing)', active: it.status === 'playing', onClick: () => setStatus(it, 'playing') },
        { label: 'Done', Icon: IconFlag, color: '#fbbf24', active: it.status === 'finished', onClick: () => setStatus(it, 'finished') },
        { label: 'Dropped', Icon: IconX, color: 'var(--status-dropped)', active: it.status === 'dropped', onClick: () => setStatus(it, 'dropped') },
      ] },
      it.status === 'finished' && { label: it.rating ? `Change rating (${Math.round(it.rating)}/10)` : 'Rate it…', Icon: IconStarFilled, color: '#fbbf24', onClick: () => setRateItem(it) },
      { label: 'Move to month', Icon: IconCalendarMonth, sub: [
        ...monthsAhead.map(m => ({ label: formatMonthKey(m, 'long'), Icon: IconCalendarEvent, active: here === m, onClick: () => moveTo([it.id], m) })),
        { divider: true },
        { label: 'Other month…', Icon: IconCalendarEvent, onClick: () => setMoveIds([it.id]) },
      ] },
      { divider: true },
      { label: 'Edit…', Icon: IconPencil, onClick: () => setEdit(it) },
      it.steam_app_id && { label: 'Steam page', Icon: IconBrandSteam, onClick: () => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${it.steam_app_id}`) },
      here && { label: 'Remove from the plan', Icon: IconCalendarOff, danger: true, onClick: () => moveTo([it.id], 'none') },
    ]
  }

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconCalendarEvent size={16} stroke={1.7} /> Play Plan</h1>
        <div className={s.spacer} />
        {month !== 'none' && (
          <button className={s.btnPrimary} onClick={() => setAdding(true)}>
            <IconPlus size={14} stroke={2} /> Add games
          </button>
        )}
      </div>

      <div className={s.content}>
        {/* Month strip: drop a card on a month to move it there */}
        <div className={s.months} role="tablist" aria-label="Months">
          {months.map(m => {
            const sm = summary[m]
            return (
              <button
                key={m}
                role="tab"
                aria-selected={month === m}
                className={`${s.month} ${month === m ? s.monthOn : ''} ${m === thisMonth ? s.monthNow : ''} ${sm ? s.monthHas : ''} ${dropOn === m ? s.monthDrop : ''}`}
                onClick={() => setMonth(m)}
                {...chipDrop(m)}
              >
                <span className={s.monthName}>{new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' })}</span>
                <span className={s.monthYear}>{m === thisMonth ? 'Now' : m.slice(0, 4)}</span>
                <span className={s.monthCount}>{sm ? `${sm.done}/${sm.total}` : ''}</span>
              </button>
            )
          })}
          <button
            className={`${s.month} ${s.monthNone} ${month === 'none' ? s.monthOn : ''} ${dropOn === 'none' ? s.monthDrop : ''}`}
            onClick={() => setMonth('none')}
            {...chipDrop('none')}
            title="Games without a plan (drop a card here to unplan it)"
          >
            <IconCalendarOff size={16} />
            <span className={s.monthYear}>Not planned</span>
          </button>
        </div>

        {month === 'none' ? (
          <>
            <div className={s.heading}>
              <span className={s.headingMain}>Not planned</span>
              {items && <span className={s.headingCount}>{items.length} {items.length === 1 ? 'game' : 'games'}, drag one onto a month</span>}
            </div>
            {items && items.length === 0 && (
              <EmptyState Icon={IconCalendarOff} title="Everything has a month" desc="Every game on your Game List is planned." />
            )}
            {items && items.length > 0 && (
              <div className={s.grid} style={zoomStyle}>
                {items.map(i => <PosterCard key={i.id} item={i} onOpen={setEdit} onContextMenu={openCtx} />)}
              </div>
            )}
          </>
        ) : (
          <>
            <MonthHero
              label={label}
              isNow={month === thisMonth}
              focus={items ? focus : null}
              playing={lanes.playing}
              setFocus={setFocusId}
              stats={{ total, done, pct, playedSec }}
              onPrev={() => setMonth(shiftMonth(month, -1))}
              onNext={() => setMonth(shiftMonth(month, 1))}
              onAdd={() => setAdding(true)}
              onOpen={setEdit}
              onContextMenu={openCtx}
              onPlay={play}
              onStart={(it) => dropInLane(it.id, 'playing')}
              onDone={(it) => dropInLane(it.id, 'done')}
            />

            {items === null && <div className={s.muted}>Loading…</div>}
            {items && total > 0 && (
              <section className={s.lineup}>
                <div className={s.luHead}>
                  <span className={s.luTitle}>Lineup</span>
                  <span className={s.luLegend}>
                    <span><i style={{ '--dc': 'var(--status-playing)' }} />{lanes.playing.length} playing</span>
                    <span><i style={{ '--dc': 'var(--a)' }} />{lanes.next.length} up next</span>
                    <span><i style={{ '--dc': '#fbbf24' }} />{lanes.done.length} done</span>
                  </span>
                  <span className={s.luHint}>Drag a poster to change the order</span>
                </div>
                <div className={s.luGrid} style={zoomStyle} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropMark(null) }}>
                  {order.map(i => (
                    <LineupCard
                      key={i.id}
                      item={i}
                      n={lanes.next.indexOf(i) + 1}
                      maxSec={maxSec}
                      dropMark={dropMark?.id === i.id ? dropMark.pos : null}
                      onOpen={setEdit}
                      onContextMenu={openCtx}
                      onPlay={play}
                      onStart={(it) => dropInLane(it.id, 'playing')}
                      onDone={(it) => dropInLane(it.id, 'done')}
                      onRate={setRateItem}
                      onDragOverCard={onDragOverCard}
                      onDropCard={onDropCard}
                    />
                  ))}
                </div>
              </section>
            )}

            <div className={s.lower}>
              <section className={s.panel}>
                <div className={s.panelTitle}>Coming up</div>
                <div className={s.aheadRow}>
                  {nextMonths.map(m => {
                    const rows = ahead[m] || []
                    return (
                      <button key={m} className={`${s.aheadTile} ${dropOn === m ? s.monthDrop : ''}`} onClick={() => setMonth(m)} {...chipDrop(m)}>
                        <div className={s.aheadHead}>
                          <span>{formatMonthKey(m, 'long')}</span>
                          <span className={s.aheadCount}>{rows.length ? `${rows.length} ${rows.length === 1 ? 'game' : 'games'}` : 'Empty'}</span>
                        </div>
                        <div className={s.aheadCovers}>
                          {rows.slice(0, 5).map(r => <span key={r.id} className={s.aheadCover}><Thumb item={r} /></span>)}
                          {rows.length > 5 && <span className={s.aheadMore}>+{rows.length - 5}</span>}
                          {rows.length === 0 && <span className={s.aheadEmpty}>Drop a game here to plan it</span>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </section>

              {pastMonths.length > 0 && (
                <section className={s.panel}>
                  <div className={s.panelTitle}>Past months</div>
                  <div className={s.pastList}>
                    {pastMonths.map(m => {
                      const sm = summary[m]
                      const p = sm.total ? Math.round((sm.done / sm.total) * 100) : 0
                      return (
                        <button key={m} className={s.pastRow} onClick={() => setMonth(m)}>
                          <span className={s.pastName}>{formatMonthKey(m, 'long')}</span>
                          <span className={s.pastBar}><span style={{ width: `${p}%` }} /></span>
                          <span className={s.pastText}>{sm.done} of {sm.total} done</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          header={{
            cover: coverOf(ctx.item),
            name: ctx.item.name,
            sub: [LANES.find(l => l.key === laneOf(ctx.item.status))?.label, ctx.item.planned_month && formatMonthKey(ctx.item.planned_month)].filter(Boolean).join(' · '),
          }}
          items={planMenu(ctx.item)}
        />
      )}
      {rateItem && (
        <RateGameModal
          game={{ listId: rateItem.id, gameId: rateItem.game_id, name: rateItem.name, coverUrl: coverOf(rateItem), rating: rateItem.rating }}
          onClose={() => { setRateItem(null); reload() }}
        />
      )}
      {moveIds && (
        <PlanMonthModal
          count={moveIds.length}
          current={month === 'none' ? null : month}
          onClose={() => setMoveIds(null)}
          onSave={async (m) => { setMoveIds(null); await moveTo(moveIds, m || 'none') }}
        />
      )}
      {edit && (
        <EditGameListModal
          item={edit}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); reload() }}
          onDeleted={() => { setEdit(null); reload() }}
        />
      )}
      {adding && (
        <AddToMonthModal month={month} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); reload() }} />
      )}
      {launchError && <InfoModal variant="error" title="Couldn't start the game" message={launchError} onClose={() => setLaunchError(null)} />}
    </div>
  )
}
