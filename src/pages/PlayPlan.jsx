import React, { useEffect, useMemo, useState } from 'react'
import {
  IconCalendarEvent, IconPlus, IconSearch, IconCalendarOff, IconCheck, IconChevronLeft, IconChevronRight,
  IconPlayerPlayFilled, IconListCheck, IconDeviceGamepad2, IconFlag, IconStarFilled, IconClock,
  IconPencil, IconBrandSteam, IconX, IconArrowRight, IconCalendarMonth, IconGripVertical, IconDots,
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

// Play Plan: what you mean to play, month by month. A month reads top to
// bottom: what you're Playing now (wide cards), the Up next queue (numbered,
// drag to reorder), and what you finished. Drag a game between the three to
// change its status (Done marks it Finished, which asks for a rating), or onto
// a month pill to move it. The plan lives on the Game List row
// (planned_month), the same field Plan for month sets from the Library and the
// Game List; the queue order is the row's display_order.

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

// Wide art for the Playing cards: Steam's hero/header (asked once per game,
// remembered), else the cover blurred behind itself.
const wideArt = new Map()
function useWideArt(item) {
  const [, bump] = useState(0)
  const id = item.steam_app_id
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

// What you're playing this month: a wide card with the game's art.
function PlayingCard({ item, onOpen, onContextMenu, onPlay, onDone }) {
  const wide = useWideArt(item)
  const cover = coverOf(item)
  return (
    <div
      className={s.playCard}
      {...dragProps(item)}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
      data-gpnav=""
      title={item.name}
    >
      {wide ? <img className={s.playArt} src={wide} alt="" />
        : cover ? <img className={`${s.playArt} ${s.playArtSoft}`} src={cover} alt="" />
        : <GeneratedCover name={item.name} />}
      <span className={s.playShade} />
      <div className={s.playBody}>
        <span className={s.playCover}><Thumb item={item} /></span>
        <div className={s.playText}>
          <span className={s.playName}>{item.name}</span>
          <span className={s.playMeta}>
            <IconClock size={13} /> {item.month_seconds > 0 ? `${formatPlaytime(item.month_seconds)} this month` : 'Not played this month yet'}
          </span>
        </div>
        <div className={s.playActions} onClick={e => e.stopPropagation()}>
          {item.game_id && (
            <button type="button" className={s.playBtn} onClick={() => onPlay(item)} data-gpclick="">
              <IconPlayerPlayFilled size={14} /> Play
            </button>
          )}
          <button type="button" className={s.doneBtn} onClick={() => onDone(item)} title="Finished it">
            <IconFlag size={14} /> Done
          </button>
        </div>
      </div>
    </div>
  )
}

// One game in the Up next queue: its place, cover, name and genres, then
// Start (moves it to Playing) and Play.
function QueueRow({ item, n, dropMark, onOpen, onContextMenu, onPlay, onStart, onDragOverRow, onDropRow }) {
  const st = LIST_STATUSES[item.status]
  const tag = ['on_hold', 'upcoming'].includes(item.status) ? st : null
  const genres = parseGenres(item).slice(0, 3)
  return (
    <div
      className={`${s.qRow} ${dropMark === 'before' ? s.qDropBefore : ''} ${dropMark === 'after' ? s.qDropAfter : ''}`}
      {...dragProps(item)}
      onDragOver={(e) => onDragOverRow(e, item)}
      onDrop={(e) => onDropRow(e, item)}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
      data-gpnav=""
    >
      <span className={s.qGrip} aria-hidden="true"><IconGripVertical size={15} /></span>
      <span className={s.qNum}>{n}</span>
      <span className={s.qCover}><Thumb item={item} /></span>
      <span className={s.qText}>
        <span className={s.qName}>{item.name}</span>
        <span className={s.qSub}>
          {tag && <span className={s.qTag} style={{ '--tc': tag.color }}>{tag.label}</span>}
          {genres.length > 0 ? genres.join(' · ') : 'No genres yet'}
        </span>
      </span>
      <span className={s.qActions} onClick={e => e.stopPropagation()}>
        <button type="button" className={s.qStart} onClick={() => onStart(item)} title="Move to Playing">
          <IconDeviceGamepad2 size={14} /> Start
        </button>
        {item.game_id && (
          <button type="button" className={s.qIcon} onClick={() => onPlay(item)} title="Play" aria-label={`Play ${item.name}`}>
            <IconPlayerPlayFilled size={14} />
          </button>
        )}
        <button type="button" className={s.qIcon} onClick={(e) => onContextMenu(e, item)} title="More" aria-label="More">
          <IconDots size={15} />
        </button>
      </span>
    </div>
  )
}

// Finished this month: a small cover with the score.
function DoneTile({ item, onOpen, onContextMenu }) {
  const score = item.rating ? Math.round(item.rating) : null
  return (
    <div
      className={`${s.doneTile} ${item.status === 'dropped' ? s.doneDropped : ''}`}
      {...dragProps(item)}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
      data-gpnav=""
      title={item.name}
    >
      <span className={s.doneCover}><Thumb item={item} /></span>
      <span className={s.doneText}>
        <span className={s.doneName}>{item.name}</span>
        {item.status === 'dropped'
          ? <span className={s.doneSub}>Dropped</span>
          : score
            ? <span className={s.doneScore} style={{ '--rc': ratingColor(score) }}><IconStarFilled size={11} /> {score}/10</span>
            : <span className={s.doneSub}>Not rated</span>}
      </span>
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
  const [queueMark, setQueueMark] = useState(null)   // { id, pos } drop line in the queue
  const [launchError, setLaunchError] = useState(null)
  const zoomStyle = useCardZoom('plan', 'grid', { grid: 200 }, { min: 140, max: 380 })   // Ctrl + mouse wheel (Not planned grid)

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

  // Up next queue order = display_order. The whole month is rewritten in its
  // shown order (Playing, then the queue, then Done) so nothing else moves.
  async function saveQueue(nextIds) {
    const byLane = (k) => (items || []).filter(i => laneOf(i.status) === k).map(i => i.id)
    const all = [...byLane('playing'), ...nextIds, ...byLane('done')]
    await window.kozo?.api?.gameList?.reorderPage?.({ month }, 0, all)
    reload()
  }
  function onDragOverRow(e, target) {
    e.preventDefault()
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after'
    setQueueMark(m => (m?.id === target.id && m.pos === pos ? m : { id: target.id, pos }))
    setDropOn('lane:next')
  }
  async function onDropRow(e, target) {
    e.preventDefault()
    e.stopPropagation()
    const id = dropId(e)
    const mark = queueMark
    setQueueMark(null); setDropOn(null)
    if (!id || id === target.id) return
    const queue = (items || []).filter(i => laneOf(i.status) === 'next').map(i => i.id).filter(x => x !== id)
    let at = queue.indexOf(target.id)
    if (mark?.pos === 'after') at += 1
    queue.splice(Math.max(0, at), 0, id)
    const item = (items || []).find(i => i.id === id)
    if (item && laneOf(item.status) !== 'next') {
      setItems(prev => prev.map(i => (i.id === id ? { ...i, status: 'want_to_play' } : i)))
      await window.kozo?.api?.gameList?.update?.(id, { status: 'want_to_play' })
    }
    saveQueue(queue)
  }
  const laneDrop = (key) => ({
    onDragOver: (e) => { e.preventDefault(); setDropOn('lane:' + key) },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setDropOn(d => (d === 'lane:' + key ? null : d)); setQueueMark(null) } },
    onDrop: (e) => { e.preventDefault(); setDropOn(null); setQueueMark(null); const id = dropId(e); if (id) dropInLane(id, key) },
  })

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
  const lanes = LANES.map(l => ({ ...l, items: (items || []).filter(i => laneOf(i.status) === l.key) }))
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
            {/* The month at a glance */}
            <div className={s.monthHead}>
              <button className={s.navBtn} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><IconChevronLeft size={18} /></button>
              <div className={s.monthHeadMain}>
                <div className={s.heroTitle}>
                  {label}
                  {month === thisMonth && <span className={s.nowTag}>This month</span>}
                </div>
                <div className={s.heroStats}>
                  <span><strong>{done}</strong> of <strong>{total}</strong> done</span>
                  {playedSec > 0 && <span><IconClock size={13} /> {formatPlaytime(playedSec)} played</span>}
                  {total > 0 && done === total && <span className={s.allDone}><IconCheck size={13} /> All done</span>}
                </div>
              </div>
              <div className={s.ring} style={{ '--pct': `${pct}%` }} title={`${pct}% done`}><span>{pct}%</span></div>
              <button className={s.navBtn} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month"><IconChevronRight size={18} /></button>
            </div>

            {items && total === 0 ? (
              <EmptyState
                Icon={IconCalendarEvent}
                title={`Nothing planned for ${label}`}
                desc="Add the games you want to play this month, then move them along as you go: Up next, Playing, Done."
                action={{ label: 'Add games', Icon: IconPlus, onClick: () => setAdding(true) }}
              />
            ) : (
              <>
                {/* Playing now */}
                <section className={`${s.block} ${dropOn === 'lane:playing' ? s.blockDrop : ''}`} {...laneDrop('playing')}>
                  <div className={s.blockHead}>
                    <IconDeviceGamepad2 size={15} className={s.iconPlaying} />
                    <span>Playing now</span>
                    <span className={s.laneCount}>{lanes[1].items.length}</span>
                  </div>
                  {lanes[1].items.length ? (
                    <div className={s.playGrid}>
                      {lanes[1].items.map(i => (
                        <PlayingCard key={i.id} item={i} onOpen={setEdit} onContextMenu={openCtx} onPlay={play}
                          onDone={(it) => dropInLane(it.id, 'done')} />
                      ))}
                    </div>
                  ) : (
                    <div className={s.emptyDrop}>
                      {items === null ? 'Loading…' : 'Nothing started yet. Press Start on a game below, or drag one here.'}
                    </div>
                  )}
                </section>

                {/* Up next queue */}
                <section className={`${s.block} ${dropOn === 'lane:next' ? s.blockDrop : ''}`} {...laneDrop('next')}>
                  <div className={s.blockHead}>
                    <IconListCheck size={15} className={s.iconNext} />
                    <span>Up next</span>
                    <span className={s.laneCount}>{lanes[0].items.length}</span>
                    <span className={s.blockHint}>Drag to change the order</span>
                  </div>
                  {lanes[0].items.length ? (
                    <div className={s.queue}>
                      {lanes[0].items.map((i, n) => (
                        <QueueRow key={i.id} item={i} n={n + 1}
                          dropMark={queueMark?.id === i.id ? queueMark.pos : null}
                          onOpen={setEdit} onContextMenu={openCtx} onPlay={play}
                          onStart={(it) => dropInLane(it.id, 'playing')}
                          onDragOverRow={onDragOverRow} onDropRow={onDropRow} />
                      ))}
                    </div>
                  ) : (
                    <div className={s.emptyDrop}>
                      {items === null ? 'Loading…' : <>Nothing waiting. <button type="button" className={s.linkBtn} onClick={() => setAdding(true)}>Add games</button></>}
                    </div>
                  )}
                </section>

                {/* Done this month */}
                <section className={`${s.block} ${dropOn === 'lane:done' ? s.blockDrop : ''}`} {...laneDrop('done')}>
                  <div className={s.blockHead}>
                    <IconFlag size={15} className={s.iconDone} />
                    <span>Done this month</span>
                    <span className={s.laneCount}>{lanes[2].items.length}</span>
                  </div>
                  {lanes[2].items.length ? (
                    <div className={s.doneRow}>
                      {lanes[2].items.map(i => <DoneTile key={i.id} item={i} onOpen={setEdit} onContextMenu={openCtx} />)}
                    </div>
                  ) : (
                    <div className={s.emptyDrop}>Drag a game here when you finish it.</div>
                  )}
                </section>
              </>
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
