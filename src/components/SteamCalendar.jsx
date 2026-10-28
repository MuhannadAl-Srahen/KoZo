import React, { useEffect, useMemo, useState } from 'react'
import {
  IconChevronLeft, IconChevronRight, IconBrandSteam, IconBookmark, IconBookmarkFilled, IconCheck,
  IconX, IconCalendarMonth, IconLayoutGrid, IconLoader2, IconRefresh, IconClock,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import EmptyState from './ui/EmptyState'
import SteamGameModal from './SteamGameModal'
import { PanelSkeleton } from './ui/Skeleton'
import { parseRelease, localDayKey, monthKey, formatMonthKey } from '../lib/utils'
import s from './SteamCalendar.module.css'

// Steam-style release calendar: popular games coming soon plus the most
// wishlisted upcoming games (main process: steamApi.getComingSoon), with real
// portrait covers from steamApi.getAppAssets. Two layouts the user switches
// between — Days (a poster wall per release day) and Month (a big grid).
// Track adds a game to the Game List as "upcoming", which drives release
// notifications and the "My upcoming" tab.

const FEEDS = ['soon', 'wishlist']
const START_PAGES = { soon: 2, wishlist: 3 }
const MAX_PAGES = 10
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const LATER_PREVIEW = 24
const DAY_MS = 86400000

// Survives tab switches: the feeds are cached in main for 6h anyway.
let calendarCache = null   // { games, pages, art }
// The adult-games setting changes what the feeds return — start over.
if (typeof window !== 'undefined') window.addEventListener('kozo:adult-changed', () => { calendarCache = null })

function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function dayStart(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

// Week rows (Monday first) covering the whole month.
function monthGrid(first) {
  const lead = (first.getDay() + 6) % 7
  const weeks = []
  for (let w = 0; w < 6; w++) {
    const row = []
    for (let d = 0; d < 7; d++) row.push(new Date(first.getFullYear(), first.getMonth(), 1 - lead + w * 7 + d))
    if (w > 3 && row[0].getMonth() !== first.getMonth()) break
    weeks.push(row)
  }
  return weeks
}

function countdownLabel(rel) {
  if (!rel || rel.ts == null) return 'TBA'
  if (rel.precision !== 'day') return rel.label || 'TBA'
  const days = Math.round((dayStart(rel.ts) - dayStart(Date.now())) / DAY_MS)
  if (days < 0) return 'Out now'
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days < 31) return `in ${days} days`
  return new Date(rel.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function dayHeading(key) {
  const d = new Date(`${key}T00:00:00`)
  const diff = Math.round((d.getTime() - dayStart(Date.now())) / DAY_MS)
  const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  if (diff === 0) return { main: 'Today', sub: date }
  if (diff === 1) return { main: 'Tomorrow', sub: date }
  return { main: d.toLocaleDateString(undefined, { weekday: 'long' }), sub: d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) }
}

// Portrait first, then wide art, then the search capsule — skipping any that 404.
function Cover({ g, wide = false, className }) {
  const srcs = (wide
    ? [g.art?.hero, g.art?.header, g.art?.capsule, g.capsule]
    : [g.art?.portrait, g.art?.header, g.capsule]).filter(Boolean)
  const [i, setI] = useState(0)
  useEffect(() => { setI(0) }, [srcs[0]])
  if (i >= srcs.length) return <div className={`${className} ${s.coverEmpty}`}><IconBrandSteam size={22} /></div>
  const portraitMissing = !wide && srcs[i] !== g.art?.portrait
  return (
    <img
      className={`${className} ${portraitMissing ? s.coverWideFallback : ''}`}
      src={srcs[i]}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setI(n => n + 1)}
    />
  )
}

// Track / Untrack. Untrack only removes entries still marked Upcoming; a game
// the user moved to another status stays on their list ("On your list").
function TrackControl({ g, info, busy, onTrack, onUntrack, big = false }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 3000)
    return () => clearTimeout(t)
  }, [confirm])
  if (!info) {
    return (
      <button className={big ? ms.btnPrimary : s.trackBtn} onClick={() => onTrack(g)} disabled={busy}>
        <IconBookmark size={big ? 14 : 12} /> {busy ? 'Adding…' : big ? 'Track release' : 'Track'}
      </button>
    )
  }
  if (info.status !== 'upcoming') {
    return <span className={s.trackedTag}><IconCheck size={12} /> On your list</span>
  }
  return (
    <button
      className={big ? (confirm ? ms.btnDanger : ms.btnCancel) : `${s.untrackBtn} ${confirm ? s.untrackConfirm : ''}`}
      onClick={() => (confirm ? (setConfirm(false), onUntrack(g)) : setConfirm(true))}
      disabled={busy}
      title="Stop tracking this release"
    >
      {confirm ? <IconX size={big ? 14 : 12} /> : <IconCheck size={big ? 14 : 12} />}
      {busy ? 'Removing…' : confirm ? 'Untrack?' : big ? 'Tracked (click to untrack)' : 'Tracked'}
    </button>
  )
}

function PosterCard({ g, tracked, info, onOpen, onTrack, onUntrack, busy, compact = false }) {
  return (
    <div className={`${s.poster} ${tracked ? s.posterTracked : ''} ${compact ? s.posterCompact : ''}`}>
      <button className={s.posterHit} onClick={() => onOpen(g)} title={g.name}>
        <Cover g={g} className={s.posterArt} />
        <span className={s.posterShade} />
        {!compact && <span className={s.posterCountdown}>{countdownLabel(g.rel)}</span>}
        {!compact && (g.prepurchase || g.price) && (
          <span className={s.posterPrice}>{g.prepurchase ? 'Pre-purchase' : g.price}</span>
        )}
        {tracked && <span className={s.posterMark}><IconBookmarkFilled size={12} /></span>}
        <span className={s.posterName}>{g.name}</span>
      </button>
      {!compact && (
        <div className={s.posterActions}>
          <TrackControl g={g} info={info} busy={busy} onTrack={onTrack} onUntrack={onUntrack} />
          <button
            className={s.iconBtn}
            title="Steam page"
            onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.appid}`)}
          >
            <IconBrandSteam size={13} />
          </button>
        </div>
      )}
    </div>
  )
}

export default function SteamCalendar({ trackedAppIds, onTrack, onUntrack }) {
  const [games, setGames]     = useState(() => calendarCache?.games || [])
  const [art, setArt]         = useState(() => calendarCache?.art || {})
  const [pages, setPages]     = useState(() => calendarCache?.pages || { soon: 0, wishlist: 0 })
  const [loading, setLoading] = useState(!calendarCache)
  const [error, setError]     = useState(null)
  const [month, setMonth]     = useState(() => monthStart(new Date()))
  const [view, setView]       = useState(() => {
    try { return localStorage.getItem('kozo:calendar:view') === 'month' ? 'month' : 'days' } catch { return 'days' }
  })
  const [dayOpen, setDayOpen] = useState(null)    // { label, games }
  const [detail, setDetail]   = useState(null)    // game
  const [busyId, setBusyId]   = useState(null)
  const [showAllLater, setShowAllLater] = useState(false)

  async function loadPages(target) {
    setLoading(true)
    setError(null)
    const jobs = []
    for (const feed of FEEDS) {
      for (let p = pages[feed]; p < Math.min(target[feed], MAX_PAGES); p++) {
        jobs.push(window.kozo?.api?.steam?.comingSoon?.(feed, p))
      }
    }
    const results = await Promise.all(jobs)
    const failed = results.filter(r => !r?.ok)
    const fresh = results.filter(r => r?.ok).flatMap(r => r.data?.items || [])
    const nextPages = { soon: Math.min(target.soon, MAX_PAGES), wishlist: Math.min(target.wishlist, MAX_PAGES) }

    const byId = new Map(games.map(g => [g.appid, g]))
    for (const g of fresh) if (!byId.has(g.appid)) byId.set(g.appid, g)
    const nextGames = [...byId.values()]

    // Show the games right away; real portrait covers stream in afterwards
    // (cards use the search capsule until then).
    calendarCache = { games: nextGames, pages: nextPages, art }
    setGames(nextGames)
    setPages(nextPages)
    if (failed.length && !fresh.length) setError(failed[0]?.error || 'Could not reach the Steam store.')
    setLoading(false)

    const needArt = nextGames.map(g => g.appid).filter(id => !art[id])
    if (needArt.length) {
      const res = await window.kozo?.api?.steam?.appAssets?.(needArt)
      if (res?.ok) {
        setArt(prev => {
          const merged = { ...prev, ...res.data }
          if (calendarCache) calendarCache.art = merged
          return merged
        })
      }
    }
  }

  useEffect(() => { if (!calendarCache) loadPages(START_PAGES) }, [])

  // Bucket every game by its release: exact day, month-only, or later/TBA.
  const buckets = useMemo(() => {
    const byDay = new Map(), byMonth = new Map(), later = []
    for (const g of games) {
      const rel = parseRelease(g.release)
      const entry = { ...g, rel, art: art[g.appid] || art[String(g.appid)] || null }
      if (rel.ts != null && rel.precision === 'day') {
        const k = localDayKey(new Date(rel.ts))
        if (!byDay.has(k)) byDay.set(k, [])
        byDay.get(k).push(entry)
      } else if (rel.ts != null && rel.precision === 'month') {
        const k = monthKey(new Date(rel.ts))
        if (!byMonth.has(k)) byMonth.set(k, [])
        byMonth.get(k).push(entry)
      } else {
        later.push(entry)
      }
    }
    return { byDay, byMonth, later }
  }, [games, art])

  const mKey = monthKey(month)
  const todayKey = localDayKey(new Date())
  const isCurrentMonth = mKey === monthKey(new Date())
  // Days view: the shown month's release days, from today on in the current month.
  const monthDays = [...buckets.byDay.entries()]
    .filter(([k]) => k.startsWith(mKey) && (!isCurrentMonth || k >= todayKey))
    .sort(([a], [b]) => a.localeCompare(b))
  const vagueThisMonth = buckets.byMonth.get(mKey) || []
  const canLoadMore = pages.soon < MAX_PAGES || pages.wishlist < MAX_PAGES
  const laterShown = showAllLater ? buckets.later : buckets.later.slice(0, LATER_PREVIEW)

  function shiftMonth(delta) { setMonth(m => new Date(m.getFullYear(), m.getMonth() + delta, 1)) }
  function setViewMode(v) { setView(v); try { localStorage.setItem('kozo:calendar:view', v) } catch {} }

  async function track(g) {
    setBusyId(g.appid)
    await onTrack(g)
    setBusyId(null)
  }

  async function untrack(g) {
    setBusyId(g.appid)
    await onUntrack?.(g)
    setBusyId(null)
  }

  const poster = (g, extra = {}) => (
    <PosterCard key={g.appid} g={g} tracked={trackedAppIds.has(g.appid)} info={trackedAppIds.get?.(g.appid) || null}
      onOpen={setDetail} onTrack={track} onUntrack={untrack} busy={busyId === g.appid} {...extra} />
  )

  return (
    <div className={s.wrap}>
      <div className={s.nav}>
        <button className={s.navBtn} onClick={() => shiftMonth(-1)} aria-label="Previous month"><IconChevronLeft size={16} /></button>
        <div className={s.monthLabel}>{formatMonthKey(mKey, 'long')}</div>
        <button className={s.navBtn} onClick={() => shiftMonth(1)} aria-label="Next month"><IconChevronRight size={16} /></button>
        {!isCurrentMonth && <button className={s.textBtn} onClick={() => setMonth(monthStart(new Date()))}>Today</button>}
        <div className={s.spacer} />
        {loading && <IconLoader2 size={15} className="spin" />}
        {canLoadMore && !loading && (
          <button className={s.textBtn} onClick={() => loadPages({ soon: pages.soon + 2, wishlist: pages.wishlist + 2 })}>
            <IconRefresh size={13} /> Load more games
          </button>
        )}
        <div className={s.viewToggle} role="tablist">
          <button className={`${s.viewBtn} ${view === 'days' ? s.viewBtnActive : ''}`} onClick={() => setViewMode('days')}>
            <IconLayoutGrid size={14} /> Days
          </button>
          <button className={`${s.viewBtn} ${view === 'month' ? s.viewBtnActive : ''}`} onClick={() => setViewMode('month')}>
            <IconCalendarMonth size={14} /> Month
          </button>
        </div>
      </div>

      {error && !games.length && (
        <EmptyState Icon={IconBrandSteam} title="Steam calendar unavailable" desc={`${error} Check your connection and try again.`} />
      )}
      {loading && !games.length && view === 'days' && <PanelSkeleton lines={6} />}

      {view === 'days' ? (
        <>
          {monthDays.map(([k, list]) => {
            const h = dayHeading(k)
            return (
              <section key={k} className={s.daySection}>
                <div className={`${s.dayHead} ${k === todayKey ? s.dayHeadToday : ''}`}>
                  <span className={s.dayHeadMain}>{h.main}</span>
                  <span className={s.dayHeadSub}>{h.sub}</span>
                  <span className={s.dayHeadCount}>{list.length} game{list.length !== 1 ? 's' : ''}</span>
                </div>
                <div className={s.posterGrid}>{list.map(g => poster(g))}</div>
              </section>
            )
          })}
          {!loading && games.length > 0 && monthDays.length === 0 && (
            <div className={s.muted}>No dated releases in {formatMonthKey(mKey, 'long')} among the loaded games{canLoadMore ? '. Try Load more games.' : '.'}</div>
          )}
        </>
      ) : (
        <div className={s.gridScroll}>
          <div className={s.grid}>
            {WEEKDAYS.map(d => <div key={d} className={s.weekday}>{d}</div>)}
            {monthGrid(month).flat().map(day => {
              const k = localDayKey(day)
              const list = buckets.byDay.get(k) || []
              const outside = day.getMonth() !== month.getMonth()
              const lead = list[0]
              return (
                <div
                  key={k}
                  className={`${s.day} ${outside ? s.dayOutside : ''} ${k === todayKey ? s.dayToday : ''} ${k < todayKey ? s.dayPast : ''} ${list.length ? s.dayHasGames : ''}`}
                  onClick={list.length ? () => setDayOpen({ label: day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), games: list }) : undefined}
                >
                  {lead && <Cover g={lead} wide className={s.dayBg} />}
                  <div className={s.dayInner}>
                    <div className={s.dayNum}>{day.getDate()}</div>
                    <div className={s.dayPosters}>
                      {list.slice(0, 2).map(g => <Cover key={g.appid} g={g} className={s.dayPoster} />)}
                    </div>
                    {list.length > 0 && (
                      <div className={s.dayFoot}>
                        <span className={s.dayLead}>{lead.name}</span>
                        {list.length > 1 && <span className={s.dayMore}>+{list.length - 1}</span>}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {vagueThisMonth.length > 0 && (
        <section className={s.daySection}>
          <div className={s.dayHead}>
            <span className={s.dayHeadMain}>Sometime in {formatMonthKey(mKey, 'long')}</span>
            <span className={s.dayHeadCount}>{vagueThisMonth.length}</span>
          </div>
          <div className={s.posterGrid}>{vagueThisMonth.map(g => poster(g))}</div>
        </section>
      )}

      {buckets.later.length > 0 && (
        <section className={s.daySection}>
          <div className={s.dayHead}>
            <span className={s.dayHeadMain}>Later / date not announced</span>
            <span className={s.dayHeadCount}>{buckets.later.length}</span>
          </div>
          <div className={s.posterGrid}>{laterShown.map(g => poster(g))}</div>
          {buckets.later.length > LATER_PREVIEW && (
            <button className={s.textBtn} style={{ alignSelf: 'center' }} onClick={() => setShowAllLater(v => !v)}>
              {showAllLater ? 'Show fewer' : `Show all ${buckets.later.length}`}
            </button>
          )}
        </section>
      )}

      {dayOpen && (
        <Modal title={dayOpen.label} icon={<IconCalendarMonth size={17} stroke={1.6} />} onClose={() => setDayOpen(null)} width={760}>
          <div className={s.posterGrid}>{dayOpen.games.map(g => poster(g))}</div>
        </Modal>
      )}

      {detail && (
        <DetailModal
          g={detail}
          info={trackedAppIds.get?.(detail.appid) || null}
          busy={busyId === detail.appid}
          onTrack={() => track(detail)}
          onUntrack={() => untrack(detail)}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

function DetailModal({ g, info, busy, onTrack, onUntrack, onClose }) {
  return (
    <SteamGameModal
      appId={g.appid}
      name={g.name}
      release={g.release}
      countdown={countdownLabel(g.rel)}
      art={g.art}
      fallbackArt={[g.capsule]}
      onClose={onClose}
      actions={<TrackControl g={g} info={info} busy={busy} onTrack={onTrack} onUntrack={onUntrack} big />}
    />
  )
}
