import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronLeft, IconChevronRight, IconBrandSteam, IconBookmark, IconBookmarkFilled, IconCheck,
  IconX, IconCalendarMonth, IconLayoutGrid, IconLoader2, IconRefresh, IconClock,
  IconCalendarEvent, IconCalendarWeek, IconHourglass, IconSearch,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import EmptyState from './ui/EmptyState'
import SteamGameModal from './SteamGameModal'
import { PanelSkeleton } from './ui/Skeleton'
import { parseRelease, localDayKey, monthKey, formatMonthKey } from '../lib/utils'
import useCardZoom from '../lib/useCardZoom'
import s from './SteamCalendar.module.css'

// Steam-style release calendar: popular games coming soon plus the most
// wishlisted upcoming games (main process: steamApi.getComingSoon), with real
// portrait covers from steamApi.getAppAssets. Layouts, each shaping the whole
// tab: Steam (day columns like the store's calendar), Strip (pick a day from a
// TV-guide row), Week, Days (poster wall per day) and Month (big grid). Games
// with no day or month live in the TBA view; your tracked releases in Tracked.
// "Picked for you" keeps a few games per day, ranked by your genres + popularity.
// Track = a release watch on the Game List row (survives status changes).

const FEEDS = ['soon', 'wishlist']
const START_PAGES = { soon: 2, wishlist: 3 }
const MAX_PAGES = 10
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const VIEWS = [
  { key: 'steam',    label: 'Steam',    Icon: IconBrandSteam },
  { key: 'strip',    label: 'Strip',    Icon: IconCalendarEvent },
  { key: 'week',     label: 'Week',     Icon: IconCalendarWeek },
  { key: 'days',     label: 'Days',     Icon: IconLayoutGrid },
  { key: 'month',    label: 'Month',    Icon: IconCalendarMonth },
]
const VIEW_KEYS = new Set([...VIEWS.map(v => v.key), 'tba', 'tracked'])
const DAY_PICK = 4   // "Picked for you": games shown per day before "+N more"
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

// Portrait cover when Steam has one. Without a portrait, the wide art is shown
// whole (contained) over a blurred copy of itself instead of being cropped into
// a portrait ("GHT N"). `g.art === null` means art hasn't arrived yet: a
// shimmer, never the blurry 231px search capsule stretched over the card.
// `hero` asks for the 3840px library hero (only a big banner would need it);
// every other wide spot uses the 616px store capsule.
function Cover({ g, wide = false, hero = false, className }) {
  const srcs = (wide
    ? (hero ? [g.art?.hero, g.art?.header, g.art?.capsule, g.capsule] : [g.art?.capsule, g.art?.header, g.capsule])
    : [g.art?.portrait, g.art?.header, g.art?.capsule, g.capsule]).filter(Boolean)
  const [i, setI] = useState(0)
  useEffect(() => { setI(0) }, [srcs[0]])
  if (g.art === null) return <span className={`${className} ${s.coverPending} skeleton`} />
  if (i >= srcs.length) return <div className={`${className} ${s.coverEmpty}`}><IconBrandSteam size={22} /></div>
  const src = srcs[i]
  const next = () => setI(n => n + 1)
  if (!wide && src !== g.art?.portrait) {
    return (
      <span className={`${className} ${s.coverWide}`}>
        <img className={s.coverWideBg} src={src} alt="" aria-hidden="true" loading="lazy" decoding="async" />
        <img className={s.coverWideFg} src={src} alt="" loading="lazy" decoding="async" onError={next} />
      </span>
    )
  }
  return <img className={className} src={src} alt="" loading="lazy" decoding="async" onError={next} />
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
  // Tracked = release-watched, whatever its Game List status. A game that is
  // on your list but not watched can still be tracked.
  if (!info?.watch) {
    return (
      <button className={big ? ms.btnPrimary : s.trackBtn} onClick={() => onTrack(g)} disabled={busy}>
        <IconBookmark size={big ? 14 : 12} /> {busy ? 'Adding…' : big ? 'Track release' : 'Track'}
      </button>
    )
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

// ── Wide store card (Strip and Week views) ──────────────────────────────────
function WideCard({ g, tracked, info, onOpen, onTrack, onUntrack, busy }) {
  return (
    <div className={`${s.wide} ${tracked ? s.posterTracked : ''}`}>
      <button className={s.wideHit} onClick={() => onOpen(g)} title={g.name}>
        <Cover g={g} wide className={s.wideArt} />
        <span className={s.wideShade} />
        <span className={s.posterCountdown}>{countdownLabel(g.rel)}</span>
        {(g.prepurchase || g.price) && (
          <span className={s.posterPrice}>{g.prepurchase ? 'Pre-purchase' : g.price}</span>
        )}
        {tracked && <span className={s.posterMark}><IconBookmarkFilled size={12} /></span>}
      </button>
      <div className={s.wideInfo}>
        <div className={s.wideName} title={g.name}>{g.name}</div>
        <div className={s.wideMeta}>{g.release || 'To be announced'}</div>
        <div className={s.posterActions}>
          <TrackControl g={g} info={info} busy={busy} onTrack={onTrack} onUntrack={onUntrack} />
          <button className={s.iconBtn} title="Steam page"
            onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.appid}`)}>
            <IconBrandSteam size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Strip view: a TV-guide row of days, then the picked day's releases ──────
function StripView({ buckets, todayKey, wide, dayPick, onMore }) {
  const stripRef = useRef(null)
  // Every day from today to the last loaded release (max ~4 months), plus a
  // "Sometime in <month>" chip at the end of each month that has vague dates.
  const chips = useMemo(() => {
    const keys = [...buckets.byDay.keys()].filter(k => k >= todayKey).sort()
    const last = keys.length ? keys[keys.length - 1] : todayKey
    const out = []
    const start = new Date(`${todayKey}T00:00:00`)
    for (let i = 0; i < 125; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const k = localDayKey(d)
      if (k > last) break
      const count = (buckets.byDay.get(k) || []).length
      if (count) out.push({ key: k, date: d, count })   // no empty days
      const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
      if (tomorrow.getMonth() !== d.getMonth() || localDayKey(tomorrow) > last) {
        const mk = monthKey(d)
        const vague = buckets.byMonth.get(mk) || []
        if (vague.length) out.push({ key: `m:${mk}`, month: mk, count: vague.length })
      }
    }
    return out
  }, [buckets, todayKey])
  const firstWithGames = chips.find(c => c.count > 0)?.key || todayKey
  const [picked, setPicked] = useState(null)
  const sel = picked && chips.some(c => c.key === picked) ? picked : firstWithGames
  useEffect(() => {
    stripRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [sel])
  const scroll = (d) => stripRef.current?.scrollBy({ left: d * stripRef.current.clientWidth * 0.7, behavior: 'smooth' })

  const isMonth = sel.startsWith('m:')
  const full = isMonth ? (buckets.byMonth.get(sel.slice(2)) || []) : (buckets.byDay.get(sel) || [])
  const list = isMonth ? full : dayPick(full)
  const h = isMonth ? { main: `Sometime in ${formatMonthKey(sel.slice(2), 'long')}`, sub: 'Exact day not announced' } : dayHeading(sel)

  return (
    <>
      <div className={s.stripWrap}>
        <button className={s.stripArrow} onClick={() => scroll(-1)} aria-label="Earlier days"><IconChevronLeft size={16} /></button>
        <div className={s.strip} ref={stripRef}>
          {chips.map(c => c.month ? (
            <button key={c.key} data-sel={sel === c.key ? '1' : undefined}
              className={`${s.chip} ${s.chipMonth} ${sel === c.key ? s.chipSel : ''}`} onClick={() => setPicked(c.key)}>
              <span className={s.chipWeekday}>Sometime in</span>
              <span className={s.chipDay}>{new Date(`${c.month}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' })}</span>
              <span className={s.chipCount}>{c.count}</span>
            </button>
          ) : (
            <button key={c.key} data-sel={sel === c.key ? '1' : undefined}
              className={`${s.chip} ${c.key === todayKey ? s.chipToday : ''} ${sel === c.key ? s.chipSel : ''} ${c.count ? '' : s.chipEmpty}`}
              onClick={() => setPicked(c.key)} disabled={!c.count}>
              <span className={s.chipWeekday}>{c.key === todayKey ? 'Today' : c.date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
              <span className={s.chipDay}>{c.date.getDate()}</span>
              <span className={s.chipCount}>{c.count || ''}</span>
              {c.date.getDate() === 1 && <span className={s.chipMonthTag}>{c.date.toLocaleDateString(undefined, { month: 'short' })}</span>}
            </button>
          ))}
        </div>
        <button className={s.stripArrow} onClick={() => scroll(1)} aria-label="Later days"><IconChevronRight size={16} /></button>
      </div>

      <div className={s.dayHead}>
        <span className={s.dayHeadMain}>{h.main}</span>
        <span className={s.dayHeadSub}>{h.sub}</span>
        <span className={s.dayHeadCount}>{full.length} release{full.length !== 1 ? 's' : ''}</span>
      </div>
      {list.length
        ? <div className={s.wideGrid}>{list.map(g => wide(g))}</div>
        : <div className={s.muted}>No releases this day among the loaded games.</div>}
      {full.length > list.length && (
        <button className={s.textBtn} style={{ alignSelf: 'center' }} onClick={() => onMore(h.main + (h.sub ? `, ${h.sub}` : ''), full)}>
          Show all {full.length} releases
        </button>
      )}
    </>
  )
}

// ── Steam view: rows of day columns, like the Steam store's calendar ───────
// One column per day that has releases: a header, then the day's capsules
// (art only; hover for Track). In "Picked for you" a day shows its best few
// with "+N more" for the rest.
function SteamView({ days, todayKey, dayPick, isTracked, renderTrack, onOpen, onMore }) {
  if (!days.length) return <div className={s.muted}>No dated releases this month among the loaded games.</div>
  return (
    <div className={s.steamGrid}>
      {days.map(([k, full]) => {
        const list = dayPick(full)
        const d = new Date(`${k}T00:00:00`)
        const label = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
        return (
          <section key={k} className={s.steamDay}>
            <div className={`${s.steamDayHead} ${k === todayKey ? s.steamDayToday : ''}`}>
              {k === todayKey ? `Today, ${label}` : label}
            </div>
            <div className={s.steamDayList}>
              {list.map(g => (
                <div key={g.appid} className={`${s.steamCap} ${isTracked(g) ? s.steamCapTracked : ''}`}>
                  <button className={s.steamCapHit} onClick={() => onOpen(g)} title={g.name}>
                    <Cover g={g} wide className={s.steamCapArt} />
                    {isTracked(g) && <span className={s.posterMark}><IconBookmarkFilled size={12} /></span>}
                  </button>
                  <div className={s.steamCapHover}>{renderTrack(g, false)}</div>
                </div>
              ))}
              {full.length > list.length && (
                <button className={s.steamMore} onClick={() => onMore(d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), full)}>
                  +{full.length - list.length} more
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

// ── Tracked view: every release you track, even ones not in Steam's feeds ──
function TrackedView({ entries, poster }) {
  if (!entries.length) return <div className={s.muted}>You aren't tracking any releases yet. Press Track on a game in the calendar.</div>
  return <div className={s.posterGrid}>{entries.map(g => poster(g))}</div>
}

// ── Week view: one row per day, cards scroll sideways ───────────────────────
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

function WeekView({ buckets, todayKey, weekStart, wide, dayPick, onMore }) {
  const days = Array.from({ length: 7 }, (_, n) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + n))
    .filter(d => (buckets.byDay.get(localDayKey(d)) || []).length)   // no empty days
  if (!days.length) return <div className={s.muted}>No releases this week among the loaded games.</div>
  return (
    <div className={s.weekRows}>
      {days.map(d => {
        const k = localDayKey(d)
        const full = buckets.byDay.get(k) || []
        const list = dayPick(full)
        return (
          <div key={k} className={`${s.weekRow} ${k === todayKey ? s.weekRowToday : ''} ${k < todayKey ? s.weekRowPast : ''}`}>
            <div className={s.weekDay}>
              <span className={s.weekDayName}>{k === todayKey ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
              <span className={s.weekDayNum}>{d.getDate()}</span>
              <span className={s.weekDayMonth}>{d.toLocaleDateString(undefined, { month: 'short' })}</span>
            </div>
            <div className={s.weekCards}>
              {list.map(g => wide(g))}
              {full.length > list.length && (
                <button className={s.steamMore} onClick={() => onMore(d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), full)}>
                  +{full.length - list.length} more
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── TBA view: every game without a day or month, searchable ─────────────────
const TBA_PAGE = 60
function TbaView({ later, poster }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('wish')
  const [limit, setLimit] = useState(TBA_PAGE)
  const filtered = later
    .filter(g => !q.trim() || g.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (sort === 'name'
      ? a.name.localeCompare(b.name)
      : (a.wishRank ?? 1e9) - (b.wishRank ?? 1e9) || a.name.localeCompare(b.name)))
  const shown = filtered.slice(0, limit)
  // Group by announced year ("2026", "2027"); the rest is "To be announced".
  const groups = new Map()
  for (const g of shown) {
    const y = g.rel?.ts != null ? String(new Date(g.rel.ts).getFullYear()) : 'To be announced'
    if (!groups.has(y)) groups.set(y, [])
    groups.get(y).push(g)
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'To be announced') - (b === 'To be announced') || a.localeCompare(b))
  return (
    <>
      <div className={s.nav}>
        <div className={`${s.tbaSearch} hasRing`}>
          <IconSearch size={14} />
          <input value={q} onChange={e => { setQ(e.target.value); setLimit(TBA_PAGE) }} placeholder="Search undated games" aria-label="Search undated games" />
        </div>
        <div className={s.viewToggle}>
          <button className={`${s.viewBtn} ${sort === 'wish' ? s.viewBtnActive : ''}`} onClick={() => setSort('wish')}>Most wishlisted</button>
          <button className={`${s.viewBtn} ${sort === 'name' ? s.viewBtnActive : ''}`} onClick={() => setSort('name')}>A to Z</button>
        </div>
        <span className={s.muted}>{filtered.length} game{filtered.length !== 1 ? 's' : ''} without a release date</span>
      </div>
      {order.map(y => (
        <section key={y} className={s.daySection}>
          <div className={s.dayHead}>
            <span className={s.dayHeadMain}>{y}</span>
            <span className={s.dayHeadCount}>{groups.get(y).length}</span>
          </div>
          <div className={s.posterGrid}>{groups.get(y).map(g => poster(g))}</div>
        </section>
      ))}
      {filtered.length > limit && (
        <button className={s.textBtn} style={{ alignSelf: 'center' }} onClick={() => setLimit(l => l + TBA_PAGE)}>
          Show more ({filtered.length - limit} left)
        </button>
      )}
      {!filtered.length && <div className={s.muted}>Nothing matches.</div>}
    </>
  )
}

export default function SteamCalendar({ byAppId = new Map(), trackedRows = [], onTrack, onUntrack }) {
  const [games, setGames]     = useState(() => calendarCache?.games || [])
  const [art, setArt]         = useState(() => calendarCache?.art || {})
  // App ids whose art request finished (found or not); the rest show a shimmer.
  const [artTried, setArtTried] = useState(() => new Set(Object.keys(calendarCache?.art || {}).map(Number)))
  const [pages, setPages]     = useState(() => calendarCache?.pages || { soon: 0, wishlist: 0 })
  const [loading, setLoading] = useState(!calendarCache)
  const [error, setError]     = useState(null)
  const [month, setMonth]     = useState(() => monthStart(new Date()))
  const [view, setView]       = useState(() => {
    try { const v = localStorage.getItem('kozo:calendar:view'); return VIEW_KEYS.has(v) ? v : 'steam' } catch { return 'steam' }
  })
  // "Picked for you" (your genres + popularity, a few per day) or every release.
  const [pickMode, setPickMode] = useState(() => {
    try { return localStorage.getItem('kozo:calendar:pick') === 'all' ? 'all' : 'picked' } catch { return 'picked' }
  })
  const [taste, setTaste] = useState(null)   // { weights: { genre: 0..1 }, tagNames: { id: name } }
  useEffect(() => {
    window.kozo?.api?.steam?.tasteProfile?.().then(r => { if (r?.ok) setTaste(r.data) }).catch(() => {})
  }, [])
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()))
  // Ctrl + mouse wheel card size, per layout (Month has a fixed layout).
  const zoomStyle = useCardZoom('calendar', view, { steam: 230, strip: 300, week: 300, days: 150, tba: 150, tracked: 150 })
  const [dayOpen, setDayOpen] = useState(null)    // { label, games }
  const [detail, setDetail]   = useState(null)    // game
  const [busyId, setBusyId]   = useState(null)

  async function loadPages(target) {
    setLoading(true)
    setError(null)
    const jobs = [], meta = []
    for (const feed of FEEDS) {
      for (let p = pages[feed]; p < Math.min(target[feed], MAX_PAGES); p++) {
        jobs.push(window.kozo?.api?.steam?.comingSoon?.(feed, p))
        meta.push({ feed, p })
      }
    }
    const results = await Promise.all(jobs)
    const failed = results.filter(r => !r?.ok)
    // wishRank = place in Steam's most-wishlisted feed (TBA sort, Picked for you).
    // popRank = place in the popular coming-soon feed. Both rank "Picked for you".
    const fresh = results.flatMap((r, j) => (r?.ok ? (r.data?.items || []).map((g, n) => (
      meta[j].feed === 'wishlist' ? { ...g, wishRank: meta[j].p * 50 + n } : { ...g, popRank: meta[j].p * 50 + n }
    )) : []))
    const nextPages = { soon: Math.min(target.soon, MAX_PAGES), wishlist: Math.min(target.wishlist, MAX_PAGES) }

    const byId = new Map(games.map(g => [g.appid, g]))
    for (const g of fresh) {
      const had = byId.get(g.appid)
      if (!had) byId.set(g.appid, g)
      else byId.set(g.appid, { ...had, wishRank: had.wishRank ?? g.wishRank, popRank: had.popRank ?? g.popRank })
    }
    const nextGames = [...byId.values()]

    // Show the games right away; real portrait covers stream in afterwards
    // (cards use the search capsule until then).
    calendarCache = { games: nextGames, pages: nextPages, art }
    setGames(nextGames)
    setPages(nextPages)
    if (failed.length && !fresh.length) setError(failed[0]?.error || 'Could not reach the Steam store.')
    setLoading(false)

    await fetchArt(nextGames.map(g => g.appid).filter(id => !art[id]))
  }

  // Portrait art for these games, 100 per request so the first covers show
  // quickly. Every id is marked tried afterwards, found or not.
  async function fetchArt(ids) {
    for (let k = 0; k < ids.length; k += 100) {
      const chunk = ids.slice(k, k + 100)
      const res = await window.kozo?.api?.steam?.appAssets?.(chunk).catch(() => null)
      if (res?.ok) {
        setArt(prev => {
          const merged = { ...prev, ...res.data }
          if (calendarCache) calendarCache.art = merged
          return merged
        })
      }
      setArtTried(prev => { const n = new Set(prev); chunk.forEach(id => n.add(Number(id))); return n })
    }
  }

  // Tracked games that aren't in the loaded feeds still need their art.
  useEffect(() => {
    const ids = trackedRows.map(r => Number(r.steam_app_id)).filter(id => id && !art[id] && !artTried.has(id))
    if (ids.length) fetchArt(ids)
  }, [trackedRows])

  useEffect(() => {
    if (!calendarCache) { loadPages(START_PAGES); return }
    // Cached games whose art never arrived (an earlier request failed): ask again.
    const missing = calendarCache.games.map(g => g.appid).filter(id => !calendarCache.art?.[id])
    if (missing.length) fetchArt(missing)
  }, [])

  // Bucket every game by its release: exact day, month-only, or later/TBA.
  const buckets = useMemo(() => {
    const byDay = new Map(), byMonth = new Map(), later = [], all = []
    for (const g of games) {
      const rel = parseRelease(g.release)
      const entry = { ...g, rel, art: art[g.appid] || art[String(g.appid)] || (artTried.has(Number(g.appid)) ? {} : null) }
      all.push(entry)
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
    return { byDay, byMonth, later, all }
  }, [games, art, artTried])

  // "Picked for you": taste (how much a game's Steam tags overlap the genres
  // you play, weighted by playtime) counts double, popularity (feed rank) once.
  const scoreOf = useMemo(() => {
    const weights = taste?.weights || {}, names = taste?.tagNames || {}
    return (g) => {
      let t = 0
      ;(g.art?.tags || []).forEach((id, i) => {
        const w = weights[String(names[id] || '').toLowerCase()]
        if (w) t += w * (1 - i * 0.06)
      })
      const rank = Math.min(g.wishRank ?? 1e4, g.popRank ?? 1e4)
      return Math.min(1, t / 3) * 2 + 1 / (1 + rank / 50)
    }
  }, [taste])
  const dayPick = (list) => (pickMode === 'all' ? list
    : [...list].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, DAY_PICK))
  function setPick(m) { setPickMode(m); try { localStorage.setItem('kozo:calendar:pick', m) } catch {} }
  const isTracked = (g) => !!(byAppId.get(Number(g.appid))?.watch || g._listId)
  const openMore = (label, games) => setDayOpen({ label, games })

  // The Tracked shelf: every release-watched row, dated first.
  const trackedEntries = useMemo(() => trackedRows.map(r => {
    const appid = Number(r.steam_app_id) || null
    return {
      appid: appid || `list-${r.id}`,
      _listId: r.id,
      name: r.name,
      release: r.release_date,
      capsule: r.banner_url,
      rel: parseRelease(r.release_date),
      art: appid ? (art[appid] || (artTried.has(appid) ? {} : null)) : {},
    }
  }).sort((a, b) => (a.rel.ts ?? 9e15) - (b.rel.ts ?? 9e15)), [trackedRows, art, artTried])

  const mKey = monthKey(month)
  const todayKey = localDayKey(new Date())
  const isCurrentMonth = mKey === monthKey(new Date())
  // Days view: the shown month's release days, from today on in the current month.
  const monthDays = [...buckets.byDay.entries()]
    .filter(([k]) => k.startsWith(mKey) && (!isCurrentMonth || k >= todayKey))
    .sort(([a], [b]) => a.localeCompare(b))
  const vagueThisMonth = buckets.byMonth.get(mKey) || []
  const canLoadMore = pages.soon < MAX_PAGES || pages.wishlist < MAX_PAGES
  const thisWeek = mondayOf(new Date())
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6)

  function shiftMonth(delta) { setMonth(m => new Date(m.getFullYear(), m.getMonth() + delta, 1)) }
  function shiftWeek(delta) { setWeekStart(w => new Date(w.getFullYear(), w.getMonth(), w.getDate() + delta * 7)) }
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

  const infoOf = (g) => byAppId.get(Number(g.appid)) || (g._listId ? { id: g._listId, watch: true } : null)
  const poster = (g, extra = {}) => (
    <PosterCard key={g.appid} g={g} tracked={isTracked(g)} info={infoOf(g)}
      onOpen={setDetail} onTrack={track} onUntrack={untrack} busy={busyId === g.appid} {...extra} />
  )
  const wide = (g) => (
    <WideCard key={g.appid} g={g} tracked={isTracked(g)} info={infoOf(g)}
      onOpen={setDetail} onTrack={track} onUntrack={untrack} busy={busyId === g.appid} />
  )
  const renderTrack = (g, big) => (
    <TrackControl g={g} info={infoOf(g)} busy={busyId === g.appid}
      onTrack={() => track(g)} onUntrack={() => untrack(g)} big={big} />
  )

  return (
    <div className={s.wrap} style={zoomStyle}>
      {/* Top bar: the layout picker, the TBA shelf, and loading more games */}
      <div className={s.nav}>
        <div className={s.viewToggle} role="tablist" aria-label="Calendar layout">
          {VIEWS.map(v => (
            <button key={v.key} role="tab" aria-selected={view === v.key}
              className={`${s.viewBtn} ${view === v.key ? s.viewBtnActive : ''}`} onClick={() => setViewMode(v.key)}>
              <v.Icon size={14} /> {v.label}
            </button>
          ))}
        </div>
        <button className={`${s.viewBtn} ${s.tbaBtn} ${view === 'tba' ? s.viewBtnActive : ''}`} onClick={() => setViewMode('tba')}
          title="Games without a release date">
          <IconHourglass size={14} /> TBA <span className={s.tbaCount}>{buckets.later.length}</span>
        </button>
        <button className={`${s.viewBtn} ${s.tbaBtn} ${view === 'tracked' ? s.viewBtnActive : ''}`} onClick={() => setViewMode('tracked')}
          title="Releases you track">
          <IconBookmarkFilled size={14} /> Tracked <span className={s.tbaCount}>{trackedEntries.length}</span>
        </button>
        {['steam', 'strip', 'week', 'days'].includes(view) && (
          <div className={s.viewToggle} role="radiogroup" aria-label="Which games">
            <button className={`${s.viewBtn} ${pickMode === 'picked' ? s.viewBtnActive : ''}`} onClick={() => setPick('picked')}
              title="Your genres and the most popular releases, a few per day">Picked for you</button>
            <button className={`${s.viewBtn} ${pickMode === 'all' ? s.viewBtnActive : ''}`} onClick={() => setPick('all')}>All releases</button>
          </div>
        )}
        <div className={s.spacer} />
        {loading && <IconLoader2 size={15} className="spin" />}
        {canLoadMore && !loading && (
          <button className={s.textBtn} onClick={() => loadPages({ soon: pages.soon + 2, wishlist: pages.wishlist + 2 })}>
            <IconRefresh size={13} /> Load more games
          </button>
        )}
      </div>

      {/* Second bar: navigation that belongs to the chosen layout */}
      {(view === 'steam' || view === 'days' || view === 'month') && (
        <div className={s.nav}>
          <button className={s.navBtn} onClick={() => shiftMonth(-1)} aria-label="Previous month"><IconChevronLeft size={16} /></button>
          <div className={s.monthLabel}>{formatMonthKey(mKey, 'long')}</div>
          <button className={s.navBtn} onClick={() => shiftMonth(1)} aria-label="Next month"><IconChevronRight size={16} /></button>
          {!isCurrentMonth && <button className={s.textBtn} onClick={() => setMonth(monthStart(new Date()))}>Today</button>}
        </div>
      )}
      {view === 'week' && (
        <div className={s.nav}>
          <button className={s.navBtn} onClick={() => shiftWeek(-1)} aria-label="Previous week"><IconChevronLeft size={16} /></button>
          <div className={s.monthLabel}>
            {weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} to {weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </div>
          <button className={s.navBtn} onClick={() => shiftWeek(1)} aria-label="Next week"><IconChevronRight size={16} /></button>
          {weekStart.getTime() !== thisWeek.getTime() && <button className={s.textBtn} onClick={() => setWeekStart(thisWeek)}>This week</button>}
        </div>
      )}

      {error && !games.length && (
        <EmptyState Icon={IconBrandSteam} title="Steam calendar unavailable" desc={`${error} Check your connection and try again.`} />
      )}
      {loading && !games.length && <PanelSkeleton lines={6} />}

      {games.length > 0 && view === 'steam' && (
        <SteamView days={monthDays} todayKey={todayKey} dayPick={dayPick} isTracked={isTracked}
          renderTrack={renderTrack} onOpen={setDetail} onMore={openMore} />
      )}
      {games.length > 0 && view === 'strip' && <StripView buckets={buckets} todayKey={todayKey} wide={wide} dayPick={dayPick} onMore={openMore} />}
      {games.length > 0 && view === 'week' && <WeekView buckets={buckets} todayKey={todayKey} weekStart={weekStart} wide={wide} dayPick={dayPick} onMore={openMore} />}
      {view === 'tracked' && <TrackedView entries={trackedEntries} poster={poster} />}
      {games.length > 0 && view === 'tba' && <TbaView later={buckets.later} poster={poster} />}

      {view === 'days' && (
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
                <div className={s.posterGrid}>
                  {dayPick(list).map(g => poster(g))}
                  {list.length > dayPick(list).length && (
                    <button className={s.steamMore} onClick={() => openMore(`${h.main}, ${h.sub}`, list)}>+{list.length - dayPick(list).length} more</button>
                  )}
                </div>
              </section>
            )
          })}
          {!loading && games.length > 0 && monthDays.length === 0 && (
            <div className={s.muted}>No dated releases in {formatMonthKey(mKey, 'long')} among the loaded games{canLoadMore ? '. Try Load more games.' : '.'}</div>
          )}
        </>
      )}
      {view === 'month' && (
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

      {(view === 'steam' || view === 'days' || view === 'month') && vagueThisMonth.length > 0 && (
        <section className={s.daySection}>
          <div className={s.dayHead}>
            <span className={s.dayHeadMain}>Sometime in {formatMonthKey(mKey, 'long')}</span>
            <span className={s.dayHeadCount}>{vagueThisMonth.length}</span>
          </div>
          <div className={s.posterGrid}>{vagueThisMonth.map(g => poster(g))}</div>
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
          info={infoOf(detail)}
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
