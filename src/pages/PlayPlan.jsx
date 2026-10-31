import React, { useEffect, useMemo, useState } from 'react'
import { IconCalendarEvent, IconPlus, IconSearch, IconCalendarOff, IconCheck } from '@tabler/icons-react'
import { fileUrl, formatMonthKey, monthKey, parseGenres } from '../lib/utils'
import { LIST_STATUSES } from '../lib/cardModel'
import GeneratedCover from '../components/GeneratedCover'
import CardContextMenu from '../components/ui/CardContextMenu'
import EmptyState from '../components/ui/EmptyState'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
import EditGameListModal from '../components/modals/EditGameListModal'
import PlanMonthModal from '../components/modals/PlanMonthModal'
import useCardZoom from '../lib/useCardZoom'
import s from './PlayPlan.module.css'

// Play Plan: what you mean to play, month by month. Picking a month shows its
// games; drag a card onto another month to move it. The plan lives on the
// Game List row (game_list.planned_month), the same field Plan for month sets
// from the Library and the Game List.

function monthsAround() {
  const now = new Date()
  return Array.from({ length: 13 }, (_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() - 1 + i, 1)))
}

function coverOf(item) {
  return item.banner_url || (item.game_banner_local_path ? fileUrl(item.game_banner_local_path) : null)
}

function PlanCard({ item, onOpen, onContextMenu }) {
  const [failed, setFailed] = useState(false)
  const src = coverOf(item)
  const st = LIST_STATUSES[item.status]
  const genres = parseGenres(item).slice(0, 2)
  return (
    <div
      className={s.card}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/kozo-plan', String(item.id)); e.dataTransfer.effectAllowed = 'move' }}
      onClick={() => onOpen(item)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
      data-gpnav=""
      title={item.name}
    >
      <div className={s.cover}>
        {src && !failed
          ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
          : <GeneratedCover name={item.name} />}
      </div>
      <div className={s.info}>
        <div className={s.name}>{item.name}</div>
        <div className={s.meta}>
          {st && <span style={{ color: st.color }}>{st.label}</span>}
          {genres.length > 0 && <span className={s.genres}>{genres.join(' · ')}</span>}
        </div>
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
  const [month, setMonth] = useState(() => monthKey(new Date()))
  const [counts, setCounts] = useState({})     // 'YYYY-MM' → count
  const [items, setItems] = useState(null)
  const [dropOn, setDropOn] = useState(null)
  const [edit, setEdit] = useState(null)
  const [ctx, setCtx] = useState(null)
  const [moveIds, setMoveIds] = useState(null)
  const [adding, setAdding] = useState(false)
  const zoomStyle = useCardZoom('plan', 'grid', { grid: 200 }, { min: 140, max: 380 })   // Ctrl + mouse wheel

  // The 13-month window, plus any other month that has plans (an old one).
  const months = useMemo(() => {
    const set = new Set([...monthsAround(), ...Object.keys(counts)])
    return [...set].sort()
  }, [counts])

  async function loadCounts() {
    const r = await window.kozo?.api?.gameList?.plannedMonths?.()
    if (r?.ok) setCounts(Object.fromEntries((r.data || []).map(m => [m.month, m.count])))
  }
  async function loadItems(m = month) {
    const r = await window.kozo?.api?.gameList?.list?.({ month: m, limit: 5000, offset: 0 })
    setItems(r?.ok ? (r.data?.items || []) : [])
  }
  const reload = () => { loadCounts(); loadItems() }

  useEffect(() => { loadCounts() }, [])
  useEffect(() => { setItems(null); loadItems(month) }, [month])
  useEffect(() => {
    const off = window.kozo?.events?.onGameUpdated?.(() => { loadCounts(); loadItems() })
    return () => off?.()
  }, [month])

  async function moveTo(ids, target) {
    await window.kozo?.api?.gameList?.planMonth?.(ids, target === 'none' ? null : target)
    reload()
  }

  const thisMonth = monthKey(new Date())
  const label = month === 'none' ? 'Not planned' : formatMonthKey(month, 'long')

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconCalendarEvent size={16} stroke={1.7} /> Play Plan</h1>
        <div className={s.spacer} />
        {month !== 'none' && (
          <button className={s.btnPrimary} onClick={() => setAdding(true)}>
            <IconPlus size={14} stroke={2} /> Add games to {formatMonthKey(month)}
          </button>
        )}
      </div>

      <div className={s.content}>
        {/* Month strip: drop a card on a month to move it there */}
        <div className={s.months} role="tablist" aria-label="Months">
          {months.map(m => (
            <button
              key={m}
              role="tab"
              aria-selected={month === m}
              className={`${s.month} ${month === m ? s.monthOn : ''} ${m === thisMonth ? s.monthNow : ''} ${counts[m] ? s.monthHas : ''} ${dropOn === m ? s.monthDrop : ''}`}
              onClick={() => setMonth(m)}
              onDragOver={(e) => { e.preventDefault(); setDropOn(m) }}
              onDragLeave={() => setDropOn(d => (d === m ? null : d))}
              onDrop={(e) => { e.preventDefault(); setDropOn(null); const id = Number(e.dataTransfer.getData('text/kozo-plan')); if (id && m !== month) moveTo([id], m) }}
            >
              <span className={s.monthName}>{new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' })}</span>
              <span className={s.monthYear}>{m.slice(0, 4)}</span>
              <span className={s.monthCount}>{counts[m] || ''}</span>
            </button>
          ))}
          <button
            className={`${s.month} ${s.monthNone} ${month === 'none' ? s.monthOn : ''} ${dropOn === 'none' ? s.monthDrop : ''}`}
            onClick={() => setMonth('none')}
            onDragOver={(e) => { e.preventDefault(); setDropOn('none') }}
            onDragLeave={() => setDropOn(d => (d === 'none' ? null : d))}
            onDrop={(e) => { e.preventDefault(); setDropOn(null); const id = Number(e.dataTransfer.getData('text/kozo-plan')); if (id) moveTo([id], 'none') }}
            title="Games without a plan (drop a card here to unplan it)"
          >
            <IconCalendarOff size={16} />
            <span className={s.monthYear}>Not planned</span>
          </button>
        </div>

        <div className={s.heading}>
          <span className={s.headingMain}>{label}</span>
          {items && <span className={s.headingCount}>{items.length} {items.length === 1 ? 'game' : 'games'}</span>}
        </div>

        {items && items.length === 0 && month !== 'none' && (
          <EmptyState
            Icon={IconCalendarEvent}
            title={`Nothing planned for ${label}`}
            desc="Add games to this month, or use Plan for month from the Library or the Game List."
            action={{ label: 'Add games', Icon: IconPlus, onClick: () => setAdding(true) }}
          />
        )}
        {items && items.length > 0 && (
          <div className={s.grid} style={zoomStyle}>
            {items.map(i => (
              <PlanCard key={i.id} item={i} onOpen={setEdit}
                onContextMenu={(e, it) => setCtx({ x: e.clientX, y: e.clientY, item: it })} />
            ))}
          </div>
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
    </div>
  )
}
