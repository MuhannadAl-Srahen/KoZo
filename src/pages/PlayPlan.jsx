import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconCalendarEvent, IconPlus, IconSearch, IconCalendarOff, IconCheck, IconChevronLeft, IconChevronRight,
  IconPlayerPlayFilled, IconListCheck, IconDeviceGamepad2, IconFlag, IconStarFilled, IconClock,
  IconPencil, IconBrandSteam, IconX, IconArrowRight, IconCalendarMonth, IconTimeline, IconLayoutColumns,
  IconList, IconChevronDown, IconHistory, IconDots, IconFocusCentered, IconLayoutKanban, IconLayoutDashboard,
} from '@tabler/icons-react'
import { fileUrl, formatMonthKey, formatPlaytime, monthKey, parseGenres } from '../lib/utils'
import { LIST_STATUSES } from '../lib/cardModel'
import GeneratedCover from '../components/GeneratedCover'
import ContextMenu from '../components/ui/ContextMenu'
import InfoModal from '../components/ui/InfoModal'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
import EditGameListModal from '../components/modals/EditGameListModal'
import { useSteamArt } from '../lib/steamArt'
import PlanMonthModal from '../components/modals/PlanMonthModal'
import RateGameModal from '../components/modals/RateGameModal'
import useCardZoom from '../lib/useCardZoom'
import SearchableSelect from '../components/ui/SearchableSelect'
import { ratingColor } from '../components/ui/RatingPicker'
import s from './PlayPlan.module.css'

// Play Plan: what you mean to play, month by month, in six views (saved per
// user): Timeline (months down a glowing line, posters beside each), Focus
// (one month: the game you're playing fills a hero, the numbered queue
// beside it), Board (one month as Up next / Playing / Done columns), Wall (a
// mosaic of wide Steam art per month), Roadmap (months side by side, this one
// wide) and List (a table). Every
// view shows each month's games in play order: Playing, Up next (numbered),
// Done. Drag a game onto another in the same month to reorder (taking that
// game's state, so Done marks it Finished and asks for a rating), or onto
// another month to move it there. The plan lives on the Game List row
// (planned_month), the same field Plan for month sets from the Library and the
// Game List; the order is the row's display_order.

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

const VIEWS = [
  { key: 'timeline', label: 'Timeline', Icon: IconTimeline },
  { key: 'focus',    label: 'Focus',    Icon: IconFocusCentered },
  { key: 'board',    label: 'Board',    Icon: IconLayoutKanban },
  { key: 'wall',     label: 'Wall',     Icon: IconLayoutDashboard },
  { key: 'roadmap',  label: 'Roadmap',  Icon: IconLayoutColumns },
  { key: 'list',     label: 'List',     Icon: IconList },
]
const MAIN_VIEWS = VIEWS.slice(0, 3)   // the rest wait under "More views"
const MORE_VIEWS = VIEWS.slice(3)
const VIEW_KEY = 'kozo:plan:view'

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

// The stored cover; if it fails, Steam's real portrait or capsule, then the
// generated cover.
function Thumb({ item }) {
  const [failed, setFailed] = useState(0)
  const stored = coverOf(item)
  const art = useSteamArt(failed || !stored ? item.steam_app_id : null)
  const srcs = [stored, art?.portrait, art?.capsule, art?.header].filter(Boolean)
  const src = srcs[failed]
  return src
    ? <img key={src} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(f => f + 1)} />
    : <GeneratedCover name={item.name} compact />
}

function dragProps(item) {
  return {
    draggable: true,
    onDragStart: (e) => { e.dataTransfer.setData('text/kozo-plan', String(item.id)); e.dataTransfer.effectAllowed = 'move' },
  }
}

// A month's rows in play order, and its numbers.
function monthModel(rows) {
  const lanes = Object.fromEntries(LANES.map(l => [l.key, (rows || []).filter(i => laneOf(i.status) === l.key)]))
  const order = [...lanes.playing, ...lanes.next, ...lanes.done]
  const total = order.length
  const done = order.filter(i => i.status === 'finished').length
  return {
    lanes,
    order,
    total,
    done,
    pct: total ? Math.round((done / total) * 100) : 0,
    playedSec: order.reduce((a, i) => a + (i.month_seconds || 0), 0),
    maxSec: Math.max(0, ...lanes.playing.map(i => i.month_seconds || 0)),
    num: (item) => lanes.next.indexOf(item) + 1,
  }
}

function subLine(item) {
  const lane = laneOf(item.status)
  const score = item.rating ? Math.round(item.rating) : null
  if (lane === 'playing') return item.month_seconds > 0 ? `${formatPlaytime(item.month_seconds)} this month` : 'Not played this month yet'
  if (lane === 'done') return item.status === 'dropped' ? 'Dropped' : score ? 'Finished' : 'Finished, not rated'
  const tag = ['on_hold', 'upcoming'].includes(item.status) ? LIST_STATUSES[item.status] : null
  const genres = parseGenres(item).slice(0, 2)
  return tag ? tag.label : genres.length ? genres.join(' · ') : 'Up next'
}

function Ring({ pct, size = 44 }) {
  return (
    <span className={s.ring} style={{ '--pct': `${pct}%`, '--ring': `${size}px` }} title={`${pct}% done`}>
      <span>{pct}%</span>
    </span>
  )
}

// Hover buttons for a game, by its state: Start / Done / Rate it / Play.
function Actions({ item, h, compact }) {
  const lane = laneOf(item.status)
  const score = item.rating ? Math.round(item.rating) : null
  const cls = (main) => `${compact ? s.miniBtn : s.luBtn} ${main ? s.luBtnMain : ''}`
  return (
    <>
      {lane === 'next' && (
        <button type="button" className={cls(true)} onClick={() => h.start(item)} title="Move to Playing">
          <IconDeviceGamepad2 size={13} />{!compact && ' Start'}
        </button>
      )}
      {lane === 'playing' && (
        <button type="button" className={cls(false)} onClick={() => h.done(item)} title="Finished it">
          <IconFlag size={13} />{!compact && ' Done'}
        </button>
      )}
      {lane === 'done' && item.status === 'finished' && !score && (
        <button type="button" className={cls(true)} onClick={() => h.rate(item)} title="Rate it">
          <IconStarFilled size={13} />{!compact && ' Rate it'}
        </button>
      )}
      {lane !== 'done' && item.game_id && (
        <button type="button" className={`${cls(lane === 'playing')} ${compact ? '' : lane === 'playing' ? '' : s.luBtnPlay}`}
          onClick={() => h.play(item)} title="Play" aria-label={`Play ${item.name}`} data-gpclick="">
          <IconPlayerPlayFilled size={13} />{!compact && lane === 'playing' && ' Play'}
        </button>
      )}
    </>
  )
}

// Shared drag and click wiring for a game in any view.
function itemProps(item, h, dropMark, extraClass) {
  return {
    className: [extraClass, dropMark === 'before' && s.dropBefore, dropMark === 'after' && s.dropAfter].filter(Boolean).join(' '),
    ...dragProps(item),
    onDragOver: (e) => h.dragOverItem(e, item),
    onDrop: (e) => h.dropOnItem(e, item),
    onClick: () => h.open(item),
    onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); h.ctx(e, item) },
    'data-gpnav': '',
    title: item.name,
  }
}

// A poster with its state on the art: Playing glows with the month's hours
// along the bottom, Up next has its place number, Done has its score.
function PlanPoster({ item, n, maxSec, dropMark, h }) {
  const lane = laneOf(item.status)
  const score = item.rating ? Math.round(item.rating) : null
  const cls = [
    s.lu,
    lane === 'playing' && s.luPlaying,
    lane === 'done' && s.luDone,
    item.status === 'dropped' && s.luDropped,
    n === 1 && s.luFirst,
  ].filter(Boolean).join(' ')
  return (
    <div {...itemProps(item, h, dropMark, cls)}>
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
          <Actions item={item} h={h} />
        </div>
      </div>
      <span className={s.luName}>{item.name}</span>
      <span className={s.luSub}>{subLine(item)}</span>
    </div>
  )
}

// A small card for the narrow Roadmap columns: cover, name, state.
function MiniCard({ item, n, dropMark, h }) {
  const lane = laneOf(item.status)
  const score = item.rating ? Math.round(item.rating) : null
  return (
    <div {...itemProps(item, h, dropMark, `${s.mini} ${s['mini_' + lane]} ${item.status === 'dropped' ? s.miniDropped : ''}`)}>
      <span className={s.miniCover}><Thumb item={item} /></span>
      <span className={s.miniText}>
        <span className={s.miniName}>{item.name}</span>
        <span className={s.miniSub}>
          {lane === 'next' && <span className={s.miniNum}>#{n}</span>}
          {lane === 'playing' && <span className={s.miniDot} />}
          {score ? <span className={s.miniScore} style={{ '--score': ratingColor(score) }}>{score}/10</span> : subLine(item)}
        </span>
      </span>
      <span className={s.miniActions} onClick={e => e.stopPropagation()}><Actions item={item} h={h} compact /></span>
    </div>
  )
}

// Steam's wide art for a game: `header` (460px, with the logo) for tiles,
// `hero` (the big library art) for banners. lib/steamArt batches and retries,
// so the art is right from the first paint (it used to stay wrong until the
// game's window was opened once).
function useWideArt(item) {
  return useSteamArt(item?.steam_app_id)
}

function stateOf(item, n) {
  const lane = laneOf(item.status)
  return item.status === 'dropped' ? { label: 'Dropped', color: 'var(--status-dropped)', Icon: IconX }
    : lane === 'playing' ? { label: 'Playing', color: 'var(--status-playing)', Icon: IconDeviceGamepad2 }
    : lane === 'done' ? { label: 'Done', color: '#fbbf24', Icon: IconCheck }
    : { label: n ? `Up next #${n}` : 'Up next', color: 'var(--a)', Icon: IconListCheck }
}

// ‹ November 2026 › for the one-month views (Focus, Board).
function MonthNav({ m, thisMonth, onChange, summary }) {
  const sm = summary[m]
  return (
    <div className={s.rmNav}>
      <button className={s.navBtn} onClick={() => onChange(shiftMonth(m, -1))} aria-label="Previous month"><IconChevronLeft size={17} /></button>
      <span className={`${s.rmRange} ${s.cap}`}>{formatMonthKey(m, 'long')}</span>
      <button className={s.navBtn} onClick={() => onChange(shiftMonth(m, 1))} aria-label="Next month"><IconChevronRight size={17} /></button>
      {m === thisMonth ? <span className={s.nowTag}>This month</span>
        : <button className={s.todayBtn} onClick={() => onChange(thisMonth)}>This month</button>}
      {sm?.total > 0 && <span className={s.navStat}>{sm.done} of {sm.total} done</span>}
    </div>
  )
}

// Focus: the game in the hero, big. Playing first, else the next one up.
function FocusHero({ item, n, model, h, others, onPick, drop }) {
  const art = useWideArt(item)
  const lane = item ? laneOf(item.status) : null
  const genres = item ? parseGenres(item).slice(0, 3) : []
  const bg = art?.hero || art?.header || (item ? coverOf(item) : null)
  const soft = !art?.hero && !art?.header
  const share = item && model.maxSec > 0 ? Math.round(((item.month_seconds || 0) / Math.max(1, model.playedSec)) * 100) : 0
  return (
    <section className={`${s.foHero} ${drop.active ? s.isDrop : ''}`} onDragOver={drop.over} onDragLeave={drop.leave} onDrop={drop.drop}>
      {bg && <img key={bg} className={`${s.foBg} ${soft ? s.foBgSoft : ''}`} src={bg} alt="" />}
      <span className={s.foShade} />
      {item ? (
        <div className={s.foBody} key={item.id}>
          <div className={s.foCover} onClick={() => h.open(item)} onContextMenu={(e) => { e.preventDefault(); h.ctx(e, item) }}
            data-gpnav="" title={item.name} {...dragProps(item)}>
            <Thumb item={item} />
          </div>
          <div className={s.foInfo}>
            <span className={`${s.foKicker} ${lane === 'playing' ? s.foKickerLive : ''}`}>
              {lane === 'playing' ? <><span className={s.foDot} /> Playing now</> : <>Up next{n ? ` #${n}` : ''}</>}
            </span>
            <h2 className={s.foName}>{item.name}</h2>
            {genres.length > 0 && <span className={s.foGenres}>{genres.join('  ·  ')}</span>}
            <span className={s.foHours}>
              <IconClock size={15} />
              {item.month_seconds > 0 ? `${formatPlaytime(item.month_seconds)} this month` : lane === 'playing' ? 'Not played this month yet' : 'Not started'}
              {share > 0 && others.length > 1 && <span className={s.foShare}>{share}% of the month</span>}
            </span>
            <div className={s.foActions}>
              {item.game_id && <button type="button" className={s.foPlay} onClick={() => h.play(item)}><IconPlayerPlayFilled size={18} /> Play</button>}
              {lane === 'next' && <button type="button" className={s.foGhost} onClick={() => h.start(item)}><IconDeviceGamepad2 size={16} /> Start playing</button>}
              {lane === 'playing' && <button type="button" className={s.foGhost} onClick={() => h.done(item)}><IconFlag size={16} /> Mark as done</button>}
              <button type="button" className={s.foIcon} onClick={(e) => h.ctx(e, item)} aria-label="More" title="More"><IconDots size={18} /></button>
            </div>
          </div>
          {others.length > 1 && (
            <div className={s.foSwitch} aria-label="Playing this month">
              {others.map(o => (
                <button key={o.id} type="button" className={`${s.foSwitchBtn} ${o.id === item.id ? s.foSwitchOn : ''}`} onClick={() => onPick(o.id)} title={o.name}>
                  <Thumb item={o} />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={s.foEmpty}>
          <IconDeviceGamepad2 size={34} stroke={1.4} />
          <span>Nothing playing or queued this month</span>
          <span className={s.foEmptySub}>Drop a game here to start it, or add games to the month.</span>
        </div>
      )}
    </section>
  )
}

// One row of the Focus queue: place, cover, name, Start.
function QueueRow({ item, n, dropMark, h }) {
  return (
    <div {...itemProps(item, h, dropMark, s.qRow)}>
      <span className={s.qNum}>{n}</span>
      <span className={s.qCover}><Thumb item={item} /></span>
      <span className={s.qText}>
        <span className={s.qName}>{item.name}</span>
        <span className={s.qSub}>{subLine(item)}</span>
      </span>
      <span className={s.qActions} onClick={e => e.stopPropagation()}><Actions item={item} h={h} compact /></span>
    </div>
  )
}

// A card in a Board column: cover, name, state line, actions.
function BoardCard({ item, n, dropMark, h }) {
  const lane = laneOf(item.status)
  const score = item.rating ? Math.round(item.rating) : null
  return (
    <div {...itemProps(item, h, dropMark, `${s.bdCard} ${s['bd_' + lane]} ${item.status === 'dropped' ? s.bdDropped : ''}`)}>
      <span className={s.bdCover}><Thumb item={item} />{lane === 'next' && <span className={s.bdNum}>{n}</span>}</span>
      <span className={s.bdText}>
        <span className={s.bdName}>{item.name}</span>
        <span className={s.bdSub}>{subLine(item)}</span>
        {lane === 'playing' && item.month_seconds > 0 && <span className={s.bdHours}><IconClock size={12} /> {formatPlaytime(item.month_seconds)}</span>}
        {score && <span className={s.miniScore} style={{ '--score': ratingColor(score) }}>{score}/10</span>}
      </span>
      <span className={s.bdActions} onClick={e => e.stopPropagation()}><Actions item={item} h={h} compact /></span>
    </div>
  )
}

// A Wall tile: the game's wide Steam art, sized by its state.
function WallTile({ item, n, dropMark, h }) {
  const lane = laneOf(item.status)
  const art = useWideArt(item)
  const big = lane === 'playing'
  const src = big ? (art?.hero || art?.header) : (art?.header || art?.capsule)
  const cover = coverOf(item)
  const st = stateOf(item, n)
  const score = item.rating ? Math.round(item.rating) : null
  return (
    <div {...itemProps(item, h, dropMark, `${s.wl} ${s['wl_' + lane]} ${item.status === 'dropped' ? s.wlDropped : ''}`)} style={{ '--stc': st.color }}>
      <span className={s.wlArt}>
        {src ? <img src={src} alt="" loading="lazy" />
          : cover ? <><img src={cover} alt="" aria-hidden="true" className={s.wlSoftBg} /><img src={cover} alt="" className={s.wlSoftFg} /></>
          : <GeneratedCover name={item.name} />}
      </span>
      <span className={s.wlShade} />
      <span className={s.wlState}><st.Icon size={12} stroke={2.2} /> {st.label}</span>
      {score && <span className={s.luScore} style={{ '--score': ratingColor(score) }}><strong>{score}</strong><span>/10</span></span>}
      <span className={s.wlFoot}>
        <span className={s.wlName}>{item.name}</span>
        <span className={s.wlSub}>{lane === 'playing' && item.month_seconds > 0 ? `${formatPlaytime(item.month_seconds)} this month` : subLine(item)}</span>
      </span>
      <span className={s.wlActions} onClick={e => e.stopPropagation()}><Actions item={item} h={h} compact={!big} /></span>
    </div>
  )
}

// One table row for the List view.
function ListRow({ item, n, dropMark, h }) {
  const lane = laneOf(item.status)
  const score = item.rating ? Math.round(item.rating) : null
  const st = item.status === 'dropped' ? { label: 'Dropped', color: 'var(--status-dropped)' }
    : lane === 'playing' ? { label: 'Playing', color: 'var(--status-playing)' }
    : lane === 'done' ? { label: 'Done', color: '#fbbf24' }
    : { label: 'Up next', color: 'var(--a)' }
  const genres = parseGenres(item).slice(0, 3)
  return (
    <div {...itemProps(item, h, dropMark, `${s.lrow} ${lane === 'done' ? s.lrowDone : ''}`)}>
      <span className={s.lnum}>{lane === 'next' ? n : lane === 'playing' ? <IconDeviceGamepad2 size={15} /> : <IconCheck size={15} />}</span>
      <span className={s.lcover}><Thumb item={item} /></span>
      <span className={s.lname}>{item.name}</span>
      <span className={s.lstatus} style={{ '--sc': st.color }}>{st.label}</span>
      <span className={s.lgenres}>{genres.length ? genres.join(' · ') : '·'}</span>
      <span className={s.ltime}>{item.month_seconds > 0 ? formatPlaytime(item.month_seconds) : '·'}</span>
      <span className={s.lscore}>{score ? <span className={s.miniScore} style={{ '--score': ratingColor(score) }}>{score}/10</span> : '·'}</span>
      <span className={s.lactions} onClick={e => e.stopPropagation()}>
        <Actions item={item} h={h} compact />
        <button type="button" className={s.miniBtn} onClick={(e) => h.ctx(e, item)} title="More" aria-label="More"><IconDots size={14} /></button>
      </span>
    </div>
  )
}

// Pick games that have no plan yet and put them in a month.
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


// Month header shared by the views: name, "This month", numbers, Add games.
function MonthTitle({ m, model, isNow, onAdd, small }) {
  return (
    <div className={`${s.mtitle} ${small ? s.mtitleSmall : ''}`}>
      {!small && <Ring pct={model.pct} />}
      <div className={s.mtitleText}>
        <span className={s.mname}>
          <span className={s.cap}>{formatMonthKey(m, 'long')}</span>
          {isNow && <span className={s.nowTag}>This month</span>}
        </span>
        <span className={s.mstats}>
          {model.total
            ? <>{model.done} of {model.total} done{model.playedSec > 0 && <> · <IconClock size={12} /> {formatPlaytime(model.playedSec)}</>}</>
            : 'Nothing planned'}
        </span>
      </div>
      <button type="button" className={s.addBtn} onClick={() => onAdd(m)} title="Add games to this month">
        <IconPlus size={14} stroke={2} />{!small && ' Add'}
      </button>
    </div>
  )
}

function EmptyMonth({ m, onAdd }) {
  return (
    <div className={s.emptyDrop}>
      <span>Drop a game here, or <button type="button" className={s.linkBtn} onClick={() => onAdd(m)}>add games</button></span>
    </div>
  )
}

export default function PlayPlan() {
  const thisMonth = monthKey(new Date())
  const [view, setViewRaw] = useState(() => {
    try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.some(x => x.key === v) ? v : 'timeline' } catch { return 'timeline' }
  })
  const contentRef = useRef(null)
  // A new view starts at its top (and the controller ring with it).
  const setView = (v) => { setViewRaw(v); try { localStorage.setItem(VIEW_KEY, v) } catch {} ; contentRef.current?.scrollTo({ top: 0 }) }
  const [summary, setSummary] = useState({})   // 'YYYY-MM' → { total, done }
  const [boards, setBoards] = useState({})     // 'YYYY-MM' → rows (play order)
  const [opened, setOpened] = useState([])     // earlier months shown on request
  const [rmStart, setRmStart] = useState(thisMonth)
  const [oneMonth, setOneMonth] = useState(thisMonth)   // Focus and Board
  const [focusId, setFocusId] = useState(null)          // which Playing game fills the Focus hero
  const [heroDrop, setHeroDrop] = useState(false)
  const [unplanned, setUnplanned] = useState(null)
  const [showUnplanned, setShowUnplanned] = useState(false)
  const [showEarlier, setShowEarlier] = useState(false)
  const [dropOn, setDropOn] = useState(null)   // month being dragged over
  const [dropMark, setDropMark] = useState(null)   // { id, pos } where a dragged game lands
  const [edit, setEdit] = useState(null)
  const [ctx, setCtx] = useState(null)
  const [rateItem, setRateItem] = useState(null)
  const [moveIds, setMoveIds] = useState(null)
  const [adding, setAdding] = useState(null)   // month to add games to
  const [launchError, setLaunchError] = useState(null)
  const boardsRef = useRef(boards)
  boardsRef.current = boards
  const zoomStyle = useCardZoom('plan', 'grid', { grid: 170 }, { min: 120, max: 360 })   // Ctrl + mouse wheel

  // Timeline and List: this month, the next two, any later month with plans,
  // and earlier months you opened. Roadmap: four months from rmStart.
  const flowMonths = useMemo(() => {
    const later = Object.keys(summary).filter(m => m > thisMonth)
    return [...new Set([...opened, thisMonth, shiftMonth(thisMonth, 1), shiftMonth(thisMonth, 2), ...later])].sort()
  }, [summary, opened, thisMonth])
  const rmMonths = [0, 1, 2, 3].map(i => shiftMonth(rmStart, i))
  const shown = view === 'roadmap' ? rmMonths : (view === 'focus' || view === 'board') ? [oneMonth] : flowMonths
  const earlier = Object.keys(summary).filter(m => m < thisMonth && !opened.includes(m)).sort().reverse()

  async function loadSummary() {
    const r = await window.kozo?.api?.gameList?.planSummary?.()
    if (r?.ok) setSummary(Object.fromEntries((r.data || []).map(m => [m.month, { total: m.total, done: m.done }])))
  }
  async function loadBoard(m) {
    const r = await window.kozo?.api?.gameList?.planBoard?.(m, ...monthBounds(m))
    const rows = r?.ok ? r.data || [] : []
    setBoards(prev => ({ ...prev, [m]: rows }))
  }
  async function loadUnplanned() {
    const r = await window.kozo?.api?.gameList?.list?.({ month: 'none', limit: 5000, offset: 0 })
    setUnplanned(r?.ok ? (r.data?.items || []).filter(i => i.status !== 'finished' && i.status !== 'dropped') : [])
  }
  // Refetch everything already on screen.
  function reload() {
    loadSummary()
    Object.keys(boardsRef.current).forEach(loadBoard)
    loadUnplanned()
  }

  useEffect(() => { loadSummary(); loadUnplanned() }, [])
  useEffect(() => { shown.forEach(m => { if (!(m in boards)) loadBoard(m) }) }, [shown.join()])
  useEffect(() => {
    const offs = [
      window.kozo?.events?.onGameUpdated?.(() => reload()),
      window.kozo?.events?.onSessionEnded?.(() => reload()),
    ]
    return () => offs.forEach(off => off?.())
  }, [])

  const allRows = () => [...Object.values(boards).flat(), ...(unplanned || [])]
  const findItem = (id) => allRows().find(i => i.id === id)
  const dropId = (e) => Number(e.dataTransfer.getData('text/kozo-plan'))

  async function moveTo(ids, target) {
    await window.kozo?.api?.gameList?.planMonth?.(ids, target === 'none' ? null : target)
    reload()
  }
  async function setStatus(it, status) {
    setBoards(prev => Object.fromEntries(Object.entries(prev).map(([m, rows]) => [m, rows.map(i => (i.id === it.id ? { ...i, status } : i))])))
    await window.kozo?.api?.gameList?.update?.(it.id, { status })
    reload()
  }
  async function play(item) {
    const res = await window.kozo?.api?.games?.launch?.(item.game_id)
    if (!res?.ok) setLaunchError(res?.error || 'KoZo could not start this game.')
  }

  // Dragging over a game: a bar shows which side it lands on.
  function dragOverItem(e, target) {
    e.preventDefault()
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const across = e.currentTarget.parentElement?.dataset.axis === 'x'   // side by side: drop left or right
    const pos = across ? (e.clientX < r.left + r.width / 2 ? 'before' : 'after') : (e.clientY < r.top + r.height / 2 ? 'before' : 'after')
    setDropMark(m => (m?.id === target.id && m.pos === pos ? m : { id: target.id, pos, across }))
    setDropOn(target.planned_month)
  }
  // Dropped on a game: in its month it takes that place and that game's
  // state; from elsewhere it moves into that month.
  async function dropOnItem(e, target) {
    e.preventDefault()
    e.stopPropagation()
    const id = dropId(e)
    const mark = dropMark
    setDropMark(null); setDropOn(null)
    if (!id || id === target.id) return
    const item = findItem(id)
    const m = target.planned_month
    if (!item || !m) return
    if (item.planned_month !== m) return moveTo([id], m)
    const ids = monthModel(boards[m]).order.map(i => i.id).filter(x => x !== id)
    let at = ids.indexOf(target.id)
    if (mark?.pos === 'after') at += 1
    ids.splice(Math.max(0, at), 0, id)
    const lane = laneOf(target.status)
    if (laneOf(item.status) !== lane) {
      const status = LANES.find(l => l.key === lane).status
      setBoards(prev => ({ ...prev, [m]: prev[m].map(i => (i.id === id ? { ...i, status } : i)) }))
      await window.kozo?.api?.gameList?.update?.(id, { status })
    }
    await window.kozo?.api?.gameList?.reorderPage?.({ month: m }, 0, ids)
    reload()
  }
  // Dropped on a month (not on a game): move it there.
  const monthDrop = (m) => ({
    onDragOver: (e) => { e.preventDefault(); setDropOn(m) },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setDropOn(d => (d === m ? null : d)); setDropMark(null) } },
    onDrop: (e) => {
      e.preventDefault(); setDropOn(null); setDropMark(null)
      const id = dropId(e)
      const item = id && findItem(id)
      if (item && (item.planned_month || 'none') !== m) moveTo([id], m)
    },
  })

  const h = {
    open: setEdit,
    ctx: (e, it) => setCtx({ x: e.clientX, y: e.clientY, item: it }),
    play,
    start: (it) => setStatus(it, 'playing'),
    done: (it) => setStatus(it, 'finished'),
    rate: setRateItem,
    dragOverItem,
    dropOnItem,
  }
  const markOf = (it) => (dropMark?.id === it.id ? dropMark.pos : null)
  const openAdd = (m) => setAdding(m)

  // Right-click on a plan game: only what fits a plan (no Upcoming status).
  function planMenu(it) {
    const lane = laneOf(it.status)
    const next = lane === 'next' ? { label: 'Start playing', status: 'playing' }
      : lane === 'playing' ? { label: 'Mark as done', status: 'finished' } : null
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
      { label: 'Edit…', Icon: IconPencil, onClick: () => setEdit({ ...it, _openTab: 'edit' }) },
      it.steam_app_id && { label: 'Steam page', Icon: IconBrandSteam, onClick: () => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${it.steam_app_id}`) },
      here && { label: 'Remove from the plan', Icon: IconCalendarOff, danger: true, onClick: () => moveTo([it.id], 'none') },
    ]
  }

  // ── Views ──
  function timeline() {
    return (
      <div className={s.tl}>
        {flowMonths.map(m => {
          const model = monthModel(boards[m])
          return (
            <section key={m} className={`${s.tlMonth} ${m === thisMonth ? s.tlNow : ''} ${m < thisMonth ? s.tlPast : ''} ${dropOn === m ? s.isDrop : ''}`} {...monthDrop(m)}>
              <span className={s.tlDot} aria-hidden="true" />
              <MonthTitle m={m} model={model} isNow={m === thisMonth} onAdd={openAdd} />
              {boards[m] === undefined ? <div className={s.muted}>Loading…</div>
                : model.total ? (
                  <div className={s.posterGrid} style={zoomStyle} data-axis="x">
                    {model.order.map(i => <PlanPoster key={i.id} item={i} n={model.num(i)} maxSec={model.maxSec} dropMark={markOf(i)} h={h} />)}
                  </div>
                ) : <EmptyMonth m={m} onAdd={openAdd} />}
            </section>
          )
        })}
      </div>
    )
  }

  function focus() {
    const m = oneMonth
    const model = monthModel(boards[m])
    const playing = model.lanes.playing
    const hero = playing.find(i => i.id === focusId) || playing[0] || model.lanes.next[0] || null
    const queue = model.lanes.next.filter(i => i !== hero)
    const done = model.lanes.done
    // Dropping a game on the hero starts it (and plans it for this month).
    const drop = {
      active: heroDrop,
      over: (e) => { e.preventDefault(); setHeroDrop(true) },
      leave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setHeroDrop(false) },
      drop: async (e) => {
        e.preventDefault(); setHeroDrop(false); setDropMark(null)
        const item = findItem(dropId(e))
        if (!item) return
        if (item.planned_month !== m) await window.kozo?.api?.gameList?.planMonth?.([item.id], m)
        if (item.status !== 'playing') await setStatus(item, 'playing')
        else reload()
        setFocusId(item.id)
      },
    }
    return (
      <>
        <MonthNav m={m} thisMonth={thisMonth} onChange={setOneMonth} summary={summary} />
        {boards[m] === undefined ? <div className={s.muted}>Loading…</div> : (
          <div className={`${s.fo} ${dropOn === m ? s.isDrop : ''}`} {...monthDrop(m)}>
            <FocusHero item={hero} n={hero ? model.num(hero) : 0} model={model} h={h} others={playing} onPick={setFocusId} drop={drop} />
            <aside className={s.foQueue}>
              <div className={s.foQueueHead}>
                <IconListCheck size={16} /> Up next <span className={s.foldCount}>{queue.length}</span>
                <span className={s.spacer} />
                <button type="button" className={s.addBtn} onClick={() => openAdd(m)} title="Add games to this month"><IconPlus size={14} stroke={2} /> Add</button>
              </div>
              {queue.length ? (
                <div className={s.qList}>
                  {queue.map(i => <QueueRow key={i.id} item={i} n={model.num(i)} dropMark={markOf(i)} h={h} />)}
                </div>
              ) : <EmptyMonth m={m} onAdd={openAdd} />}
            </aside>
            {done.length > 0 && (
              <div className={s.foDone}>
                <div className={s.foQueueHead}><IconFlag size={16} /> Done this month <span className={s.foldCount}>{done.length}</span></div>
                <div className={s.foDoneRow} data-axis="x">
                  {done.map(i => <PlanPoster key={i.id} item={i} n={0} maxSec={0} dropMark={markOf(i)} h={h} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </>
    )
  }

  function board() {
    const m = oneMonth
    const model = monthModel(boards[m])
    // Dropped on a column (not on a card): that state, at the end of it.
    const colDrop = (lane) => ({
      onDragOver: (e) => { e.preventDefault(); setDropOn(`${m}:${lane.key}`) },
      onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropOn(d => (d === `${m}:${lane.key}` ? null : d)) },
      onDrop: async (e) => {
        e.preventDefault(); setDropOn(null); setDropMark(null)
        const item = findItem(dropId(e))
        if (!item) return
        if (item.planned_month !== m) await window.kozo?.api?.gameList?.planMonth?.([item.id], m)
        if (laneOf(item.status) !== lane.key) await setStatus(item, lane.status)
        else reload()
      },
    })
    return (
      <>
        <MonthNav m={m} thisMonth={thisMonth} onChange={setOneMonth} summary={summary} />
        {boards[m] === undefined ? <div className={s.muted}>Loading…</div> : (
          <div className={s.bd}>
            {[LANES[0], LANES[1], LANES[2]].map(lane => {
              const items = model.lanes[lane.key]
              return (
                <section key={lane.key} className={`${s.bdCol} ${s['bdCol_' + lane.key]} ${dropOn === `${m}:${lane.key}` ? s.isDrop : ''}`} {...colDrop(lane)}>
                  <div className={s.bdHead}>
                    <lane.Icon size={16} /> {lane.label} <span className={s.foldCount}>{items.length}</span>
                    {lane.key === 'next' && <><span className={s.spacer} /><button type="button" className={s.addBtn} onClick={() => openAdd(m)} title="Add games to this month"><IconPlus size={14} stroke={2} /></button></>}
                  </div>
                  <div className={s.bdList}>
                    {items.map(i => <BoardCard key={i.id} item={i} n={model.num(i)} dropMark={markOf(i)} h={h} />)}
                    {!items.length && <div className={s.bdEmpty}>{lane.key === 'next' ? 'Drop games here to queue them' : lane.key === 'playing' ? 'Drop a game here to start it' : 'Drop a game here when you finish it'}</div>}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </>
    )
  }

  function wall() {
    return (
      <div className={s.wall}>
        {flowMonths.map(m => {
          const model = monthModel(boards[m])
          return (
            <section key={m} className={`${s.wallMonth} ${dropOn === m ? s.isDrop : ''}`} {...monthDrop(m)}>
              <MonthTitle m={m} model={model} isNow={m === thisMonth} onAdd={openAdd} />
              {boards[m] === undefined ? <div className={s.muted}>Loading…</div>
                : model.total ? (
                  <div className={s.wlGrid} data-axis="x">
                    {model.order.map(i => <WallTile key={i.id} item={i} n={model.num(i)} dropMark={markOf(i)} h={h} />)}
                  </div>
                ) : <EmptyMonth m={m} onAdd={openAdd} />}
            </section>
          )
        })}
      </div>
    )
  }

  function roadmap() {
    return (
      <>
        <div className={s.rmNav}>
          <button className={s.navBtn} onClick={() => setRmStart(shiftMonth(rmStart, -1))} aria-label="Earlier months"><IconChevronLeft size={17} /></button>
          <span className={s.rmRange}>{formatMonthKey(rmMonths[0], 'long')} to {formatMonthKey(rmMonths[3], 'long')}</span>
          <button className={s.navBtn} onClick={() => setRmStart(shiftMonth(rmStart, 1))} aria-label="Later months"><IconChevronRight size={17} /></button>
          {rmStart !== thisMonth && <button className={s.todayBtn} onClick={() => setRmStart(thisMonth)}>This month</button>}
        </div>
        <div className={s.rm}>
          {rmMonths.map((m, idx) => {
            const model = monthModel(boards[m])
            const wide = idx === 0
            return (
              <section key={m} className={`${s.rmCol} ${wide ? s.rmWide : ''} ${m === thisMonth ? s.rmNow : ''} ${dropOn === m ? s.isDrop : ''}`} {...monthDrop(m)}>
                <MonthTitle m={m} model={model} isNow={m === thisMonth} onAdd={openAdd} small={!wide} />
                {!wide && model.total > 0 && <div className={s.rmBar}><span style={{ width: `${model.pct}%` }} /></div>}
                {boards[m] === undefined ? <div className={s.muted}>Loading…</div>
                  : !model.total ? <EmptyMonth m={m} onAdd={openAdd} />
                  : wide ? (
                    <div className={s.posterGrid} style={zoomStyle} data-axis="x">
                      {model.order.map(i => <PlanPoster key={i.id} item={i} n={model.num(i)} maxSec={model.maxSec} dropMark={markOf(i)} h={h} />)}
                    </div>
                  ) : (
                    <div className={s.miniList}>
                      {model.order.map(i => <MiniCard key={i.id} item={i} n={model.num(i)} dropMark={markOf(i)} h={h} />)}
                    </div>
                  )}
              </section>
            )
          })}
        </div>
      </>
    )
  }

  function list() {
    return (
      <div className={s.lv}>
        {flowMonths.map(m => {
          const model = monthModel(boards[m])
          return (
            <section key={m} className={`${s.lgroup} ${m === thisMonth ? s.lgroupNow : ''} ${dropOn === m ? s.isDrop : ''}`} {...monthDrop(m)}>
              <MonthTitle m={m} model={model} isNow={m === thisMonth} onAdd={openAdd} />
              {boards[m] === undefined ? <div className={s.muted}>Loading…</div>
                : model.total ? (
                  <div className={s.ltable}>
                    <div className={s.lhead} aria-hidden="true">
                      <span /><span /><span>Game</span><span>Status</span><span className={s.lgenres}>Genres</span><span className={s.ltime}>This month</span><span className={s.lscore}>Score</span><span />
                    </div>
                    {model.order.map(i => <ListRow key={i.id} item={i} n={model.num(i)} dropMark={markOf(i)} h={h} />)}
                  </div>
                ) : <EmptyMonth m={m} onAdd={openAdd} />}
            </section>
          )
        })}
      </div>
    )
  }

  const unplannedCount = unplanned?.length || 0

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconCalendarEvent size={16} stroke={1.7} /> Play Plan</h1>
        <div className={s.views} role="tablist" aria-label="Play Plan view">
          {MAIN_VIEWS.map(v => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key}
              className={`${s.viewBtn} ${view === v.key ? s.viewOn : ''}`} onClick={() => setView(v.key)} title={v.label}>
              <v.Icon size={15} stroke={1.8} /> <span className={s.viewLabel}>{v.label}</span>
            </button>
          ))}
        </div>
        <div className={MORE_VIEWS.some(v => v.key === view) ? s.moreOn : undefined} data-plan-more="">
          <SearchableSelect
            value={MORE_VIEWS.some(v => v.key === view) ? view : ''}
            onChange={v => { if (v) setView(v) }}
            options={MORE_VIEWS.map(v => ({ value: v.key, label: v.label }))}
            placeholder="More views"
            searchable={false}
            clearable={false}
            width={128}
          />
        </div>
        <div className={s.spacer} />
        <button className={s.btnPrimary} onClick={() => openAdd(view === 'roadmap' ? rmStart : (view === 'focus' || view === 'board') ? oneMonth : thisMonth)}>
          <IconPlus size={14} stroke={2} /> Add games
        </button>
      </div>

      <div className={s.content} ref={contentRef}>
        {view === 'timeline' && timeline()}
        {view === 'focus' && focus()}
        {view === 'board' && board()}
        {view === 'wall' && wall()}
        {view === 'roadmap' && roadmap()}
        {view === 'list' && list()}

        {/* Earlier months and games without a month, folded away */}
        <div className={s.folds}>
          {earlier.length > 0 && (
            <section className={s.fold}>
              <button type="button" className={s.foldHead} onClick={() => setShowEarlier(v => !v)} aria-expanded={showEarlier}>
                <IconHistory size={15} /> Earlier months <span className={s.foldCount}>{earlier.length}</span>
                <IconChevronDown size={15} className={`${s.chev} ${showEarlier ? s.chevOpen : ''}`} />
              </button>
              {showEarlier && (
                <div className={s.pastList}>
                  {earlier.map(m => {
                    const sm = summary[m]
                    const p = sm.total ? Math.round((sm.done / sm.total) * 100) : 0
                    return (
                      <button key={m} className={s.pastRow} onClick={() => {
                        if (view === 'roadmap') setRmStart(m)
                        else setOpened(o => [...o, m])
                      }}>
                        <span className={`${s.pastName} ${s.cap}`}>{formatMonthKey(m, 'long')}</span>
                        <span className={s.pastBar}><span style={{ width: `${p}%` }} /></span>
                        <span className={s.pastText}>{sm.done} of {sm.total} done</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          )}
          <section className={`${s.fold} ${dropOn === 'none' ? s.isDrop : ''}`} {...monthDrop('none')}>
            <button type="button" className={s.foldHead} onClick={() => setShowUnplanned(v => !v)} aria-expanded={showUnplanned}>
              <IconCalendarOff size={15} /> Not planned <span className={s.foldCount}>{unplannedCount}</span>
              <span className={s.foldHint}>Drag a game onto a month to plan it, or drop one here to unplan it</span>
              <IconChevronDown size={15} className={`${s.chev} ${showUnplanned ? s.chevOpen : ''}`} />
            </button>
            {showUnplanned && (
              unplannedCount ? (
                <div className={s.unplannedGrid}>
                  {unplanned.map(i => (
                    <div key={i.id} className={s.uCard} {...dragProps(i)} onClick={() => setEdit(i)}
                      onContextMenu={(e) => { e.preventDefault(); h.ctx(e, i) }} data-gpnav="" title={i.name}>
                      <span className={s.uCover}><Thumb item={i} /></span>
                      <span className={s.uName}>{i.name}</span>
                    </div>
                  ))}
                </div>
              ) : <div className={s.muted}>Every game on your Game List has a month.</div>
            )}
          </section>
        </div>
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
          current={null}
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
        <AddToMonthModal month={adding} onClose={() => setAdding(null)} onAdded={() => { setAdding(null); reload() }} />
      )}
      {launchError && <InfoModal variant="error" title="Couldn't start the game" message={launchError} onClose={() => setLaunchError(null)} />}
    </div>
  )
}
