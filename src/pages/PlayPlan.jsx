import React, { useEffect, useMemo, useState } from 'react'
import {
  IconCalendarEvent, IconPlus, IconSearch, IconCalendarOff, IconCheck, IconChevronLeft, IconChevronRight,
  IconPlayerPlayFilled, IconListCheck, IconDeviceGamepad2, IconFlag, IconStarFilled, IconClock,
} from '@tabler/icons-react'
import { fileUrl, formatMonthKey, formatPlaytime, monthKey } from '../lib/utils'
import { LIST_STATUSES } from '../lib/cardModel'
import GeneratedCover from '../components/GeneratedCover'
import CardContextMenu from '../components/ui/CardContextMenu'
import EmptyState from '../components/ui/EmptyState'
import InfoModal from '../components/ui/InfoModal'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
import EditGameListModal from '../components/modals/EditGameListModal'
import PlanMonthModal from '../components/modals/PlanMonthModal'
import useCardZoom from '../lib/useCardZoom'
import s from './PlayPlan.module.css'

// Play Plan: what you mean to play, month by month. A month is a board with
// three lanes (Up next, Playing, Done): drag a card across lanes to change its
// status (Done marks it Finished, which asks for a rating), or onto a month
// chip to move it. The plan lives on the Game List row (planned_month), the
// same field Plan for month sets from the Library and the Game List.

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

// One game on the board: poster, name, what's going on with it, Play.
function LaneCard({ item, onOpen, onContextMenu, onPlay }) {
  const st = LIST_STATUSES[item.status]
  const extraTag = ['on_hold', 'upcoming', 'dropped'].includes(item.status) ? st : null
  return (
    <div
      className={`${s.laneCard} ${item.status === 'dropped' ? s.laneCardDropped : ''}`}
      {...dragProps(item)}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
      data-gpnav=""
      title={item.name}
    >
      <div className={s.laneThumb}><Thumb item={item} /></div>
      <div className={s.laneInfo}>
        <div className={s.laneName}>{item.name}</div>
        <div className={s.laneMeta}>
          {extraTag && <span className={s.tag} style={{ color: extraTag.color }}>{extraTag.label}</span>}
          {item.status === 'finished' && item.rating > 0 && (
            <span className={s.stars}><IconStarFilled size={11} /> {Math.round(item.rating)}/10</span>
          )}
          {item.month_seconds > 0 && (
            <span className={s.hours}><IconClock size={11} /> {formatPlaytime(item.month_seconds)} this month</span>
          )}
        </div>
      </div>
      {item.game_id && item.status !== 'finished' && item.status !== 'dropped' && (
        <button
          className={s.playBtn}
          title="Play"
          aria-label={`Play ${item.name}`}
          onClick={(e) => { e.stopPropagation(); onPlay(item) }}
        >
          <IconPlayerPlayFilled size={13} />
        </button>
      )}
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
  const [moveIds, setMoveIds] = useState(null)
  const [adding, setAdding] = useState(false)
  const [launchError, setLaunchError] = useState(null)
  const zoomStyle = useCardZoom('plan', month === 'none' ? 'grid' : 'board', { grid: 200, board: 72 }, month === 'none' ? { min: 140, max: 380 } : { min: 48, max: 140 })   // Ctrl + mouse wheel

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
            <div className={s.hero}>
              <button className={s.navBtn} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><IconChevronLeft size={18} /></button>
              <div className={s.heroMain}>
                <div className={s.heroTitle}>
                  {label}
                  {month === thisMonth && <span className={s.nowTag}>This month</span>}
                </div>
                <div className={s.progress}><span style={{ width: `${pct}%` }} /></div>
                <div className={s.heroStats}>
                  <span><strong>{done}</strong> of <strong>{total}</strong> done</span>
                  {playedSec > 0 && <span><IconClock size={13} /> {formatPlaytime(playedSec)} played this month</span>}
                  {total > 0 && done === total && <span className={s.allDone}><IconCheck size={13} /> All done</span>}
                </div>
              </div>
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
              <div className={s.board} style={zoomStyle}>
                {lanes.map(l => (
                  <section
                    key={l.key}
                    className={`${s.lane} ${s['lane_' + l.key]} ${dropOn === 'lane:' + l.key ? s.laneDrop : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDropOn('lane:' + l.key) }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropOn(d => (d === 'lane:' + l.key ? null : d)) }}
                    onDrop={(e) => { e.preventDefault(); setDropOn(null); const id = dropId(e); if (id) dropInLane(id, l.key) }}
                  >
                    <div className={s.laneHead}>
                      <l.Icon size={15} />
                      <span>{l.label}</span>
                      <span className={s.laneCount}>{l.items.length}</span>
                    </div>
                    <div className={s.laneBody}>
                      {items === null && <div className={s.muted}>Loading…</div>}
                      {l.items.map(i => <LaneCard key={i.id} item={i} onOpen={setEdit} onContextMenu={openCtx} onPlay={play} />)}
                      {items && l.items.length === 0 && (
                        <div className={s.laneEmpty}>
                          {l.key === 'next' ? 'Nothing waiting' : l.key === 'playing' ? 'Drag a game here when you start it' : 'Drag a game here when you finish it'}
                        </div>
                      )}
                    </div>
                  </section>
                ))}
              </div>
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
        <CardContextMenu
          x={ctx.x}
          y={ctx.y}
          game={ctx.item}
          statuses={LIST_STATUSES}
          statusField="status"
          clearable={false}
          onClose={() => setCtx(null)}
          onSetStatus={async (it, status) => { if (status) { await window.kozo?.api?.gameList?.update?.(it.id, { status }); reload() } }}
          onEdit={(it) => setEdit(it)}
          extraItems={[
            { label: 'Move to another month…', Icon: IconCalendarEvent, onClick: (it) => setMoveIds([it.id]) },
            { label: 'Remove from the plan', Icon: IconCalendarOff, onClick: (it) => moveTo([it.id], 'none') },
          ]}
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
