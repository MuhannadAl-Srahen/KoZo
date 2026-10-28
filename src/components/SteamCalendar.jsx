import React, { useEffect, useMemo, useState } from 'react'
import {
  IconChevronLeft, IconChevronRight, IconBrandSteam, IconBookmark, IconCheck,
  IconCalendarMonth, IconList, IconLoader2, IconRefresh,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import EmptyState from './ui/EmptyState'
import { parseRelease, localDayKey, monthKey, formatMonthKey } from '../lib/utils'
import s from './SteamCalendar.module.css'

// Steam-style release calendar: popular games coming soon plus the most
// wishlisted upcoming games (main process: steamApi.getComingSoon), laid out by
// release day. Track adds a game to the Game List as "upcoming", which is what
// the release notifications and the "My upcoming" tab follow.

const FEEDS = ['soon', 'wishlist']
const START_PAGES = { soon: 2, wishlist: 3 }
const MAX_PAGES = 10
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MAX_PER_DAY = 3

// Survives tab switches: the feeds are cached in main for 6h anyway.
let calendarCache = null   // { games: [], pages: { soon, wishlist } }

function headerArt(appid) {
  return `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`
}

function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1) }

// Week rows (Monday first) covering the whole month.
function monthGrid(first) {
  const lead = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead)
  const days = []
  for (let i = 0; i < 42; i++) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  const weeks = []
  for (let w = 0; w < 6; w++) {
    const row = days.slice(w * 7, w * 7 + 7)
    if (w > 3 && row[0].getMonth() !== first.getMonth()) break
    weeks.push(row)
  }
  return weeks
}

export default function SteamCalendar({ trackedAppIds, onTrack }) {
  const [games, setGames]     = useState(() => calendarCache?.games || [])
  const [pages, setPages]     = useState(() => calendarCache?.pages || { soon: 0, wishlist: 0 })
  const [loading, setLoading] = useState(!calendarCache)
  const [error, setError]     = useState(null)
  const [month, setMonth]     = useState(() => monthStart(new Date()))
  const [view, setView]       = useState(() => localStorage.getItem('kozo:calendar:view') || 'month')
  const [dayOpen, setDayOpen] = useState(null)    // { key, label, games }
  const [detail, setDetail]   = useState(null)    // game
  const [busyId, setBusyId]   = useState(null)

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
    setGames(prev => {
      const byId = new Map(prev.map(g => [g.appid, g]))
      for (const g of fresh) if (!byId.has(g.appid)) byId.set(g.appid, g)
      const next = [...byId.values()]
      const nextPages = { soon: Math.min(target.soon, MAX_PAGES), wishlist: Math.min(target.wishlist, MAX_PAGES) }
      calendarCache = { games: next, pages: nextPages }
      setPages(nextPages)
      return next
    })
    if (failed.length && !fresh.length) setError(failed[0]?.error || 'Could not reach the Steam store.')
    setLoading(false)
  }

  useEffect(() => { if (!calendarCache) loadPages(START_PAGES) }, [])

  // Bucket every game by its release: exact day, month-only, or later/TBA.
  const buckets = useMemo(() => {
    const byDay = new Map(), byMonth = new Map(), later = []
    for (const g of games) {
      const rel = parseRelease(g.release)
      const entry = { ...g, rel }
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
  }, [games])

  const weeks = monthGrid(month)
  const mKey = monthKey(month)
  const todayKey = localDayKey(new Date())
  const monthGames = [...buckets.byDay.entries()]
    .filter(([k]) => k.startsWith(mKey))
    .sort(([a], [b]) => a.localeCompare(b))
  const vagueThisMonth = buckets.byMonth.get(mKey) || []
  const canLoadMore = pages.soon < MAX_PAGES || pages.wishlist < MAX_PAGES

  function shiftMonth(delta) { setMonth(m => new Date(m.getFullYear(), m.getMonth() + delta, 1)) }
  function setViewMode(v) { setView(v); try { localStorage.setItem('kozo:calendar:view', v) } catch {} }

  async function track(g) {
    setBusyId(g.appid)
    await onTrack(g)
    setBusyId(null)
  }

  const GameChip = ({ g }) => {
    const tracked = trackedAppIds.has(g.appid)
    return (
      <button className={`${s.chip} ${tracked ? s.chipTracked : ''}`} onClick={() => setDetail(g)} title={g.name}>
        {g.capsule && <img className={s.chipArt} src={g.capsule} alt="" loading="lazy" />}
        <span className={s.chipName}>{g.name}</span>
        {tracked && <IconBookmark size={11} className={s.chipMark} />}
      </button>
    )
  }

  return (
    <div className={s.wrap}>
      <div className={s.nav}>
        <button className={s.navBtn} onClick={() => shiftMonth(-1)} aria-label="Previous month"><IconChevronLeft size={16} /></button>
        <div className={s.monthLabel}>{formatMonthKey(mKey, 'long')}</div>
        <button className={s.navBtn} onClick={() => shiftMonth(1)} aria-label="Next month"><IconChevronRight size={16} /></button>
        <button className={s.textBtn} onClick={() => setMonth(monthStart(new Date()))}>Today</button>
        <div className={s.spacer} />
        {loading && <IconLoader2 size={15} className="spin" />}
        {canLoadMore && !loading && (
          <button className={s.textBtn} onClick={() => loadPages({ soon: pages.soon + 2, wishlist: pages.wishlist + 2 })}>
            <IconRefresh size={13} /> Load more games
          </button>
        )}
        <div className={s.viewToggle}>
          <button className={`${s.viewBtn} ${view === 'month' ? s.viewBtnActive : ''}`} onClick={() => setViewMode('month')} title="Month">
            <IconCalendarMonth size={15} />
          </button>
          <button className={`${s.viewBtn} ${view === 'list' ? s.viewBtnActive : ''}`} onClick={() => setViewMode('list')} title="List">
            <IconList size={15} />
          </button>
        </div>
      </div>

      {error && !games.length && (
        <EmptyState Icon={IconBrandSteam} title="Steam calendar unavailable" desc={`${error} Check your connection and try again.`} />
      )}

      {vagueThisMonth.length > 0 && (
        <div className={s.strip}>
          <span className={s.stripLabel}>Sometime in {formatMonthKey(mKey, 'long')}</span>
          <div className={s.stripGames}>{vagueThisMonth.map(g => <GameChip key={g.appid} g={g} />)}</div>
        </div>
      )}

      {view === 'month' ? (
        <div className={s.gridScroll}>
          <div className={s.grid}>
            {WEEKDAYS.map(d => <div key={d} className={s.weekday}>{d}</div>)}
            {weeks.flat().map(day => {
              const k = localDayKey(day)
              const list = buckets.byDay.get(k) || []
              const outside = day.getMonth() !== month.getMonth()
              return (
                <div key={k} className={`${s.day} ${outside ? s.dayOutside : ''} ${k === todayKey ? s.dayToday : ''} ${k < todayKey ? s.dayPast : ''}`}>
                  <div className={s.dayNum}>{day.getDate()}</div>
                  {list.slice(0, MAX_PER_DAY).map(g => <GameChip key={g.appid} g={g} />)}
                  {list.length > MAX_PER_DAY && (
                    <button className={s.more} onClick={() => setDayOpen({ key: k, label: day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), games: list })}>
                      +{list.length - MAX_PER_DAY} more
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className={s.list}>
          {monthGames.length === 0 && !loading && (
            <div className={s.muted}>No dated releases this month in the loaded games{canLoadMore ? ' — try Load more games.' : '.'}</div>
          )}
          {monthGames.map(([k, list]) => (
            <div key={k} className={s.listDay}>
              <div className={`${s.listDate} ${k === todayKey ? s.listDateToday : ''}`}>
                {new Date(`${k}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
              </div>
              <div className={s.listGames}>{list.map(g => <GameChip key={g.appid} g={g} />)}</div>
            </div>
          ))}
        </div>
      )}

      {buckets.later.length > 0 && (
        <div className={s.strip}>
          <span className={s.stripLabel}>Later / date not announced ({buckets.later.length})</span>
          <div className={s.stripGames}>{buckets.later.map(g => <GameChip key={g.appid} g={g} />)}</div>
        </div>
      )}

      {dayOpen && (
        <Modal title={dayOpen.label} icon={<IconCalendarMonth size={17} stroke={1.6} />} onClose={() => setDayOpen(null)} width={460}>
          <div className={s.listGames}>{dayOpen.games.map(g => <GameChip key={g.appid} g={g} />)}</div>
        </Modal>
      )}

      {detail && (
        <Modal
          title={detail.name}
          icon={<IconBrandSteam size={17} stroke={1.6} />}
          onClose={() => setDetail(null)}
          width={480}
          footer={
            <div style={{ display: 'flex', gap: 8, width: '100%' }}>
              <button className={ms.btnGhost} onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${detail.appid}`)}>
                <IconBrandSteam size={14} /> Steam page
              </button>
              <div style={{ flex: 1 }} />
              {trackedAppIds.has(detail.appid) ? (
                <button className={ms.btnCancel} disabled><IconCheck size={14} /> Tracked</button>
              ) : (
                <button className={ms.btnPrimary} onClick={() => track(detail)} disabled={busyId === detail.appid}>
                  <IconBookmark size={14} /> {busyId === detail.appid ? 'Adding…' : 'Track release'}
                </button>
              )}
            </div>
          }
        >
          <img className={s.detailArt} src={headerArt(detail.appid)} alt="" onError={e => { if (detail.capsule && e.currentTarget.src !== detail.capsule) e.currentTarget.src = detail.capsule }} />
          <div className={s.detailRelease}>Release: {detail.release || 'To be announced'}</div>
          <div className={s.muted}>Tracking adds it to your Game List as Upcoming — KoZo tells you when it's out.</div>
        </Modal>
      )}
    </div>
  )
}
