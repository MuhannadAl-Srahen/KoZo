import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconChevronLeft, IconChevronRight, IconBrandSteam, IconBookmark, IconBookmarkFilled, IconCheck,
  IconX, IconCalendarMonth, IconLoader2, IconClock,
  IconCalendarEvent, IconCalendarWeek, IconHourglass, IconSearch, IconInfoCircle, IconClockHour4, IconSparkles,
  IconStarFilled,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import ContextMenu from './ui/ContextMenu'
import EmptyState from './ui/EmptyState'
import SteamGameModal from './SteamGameModal'
import { PanelSkeleton } from './ui/Skeleton'
import { parseRelease, storeRelease, countdownTo, localDayKey, monthKey, formatMonthKey } from '../lib/utils'
import useCardZoom from '../lib/useCardZoom'
import UpcomingHero from './UpcomingHero'
import { defaultPickMode, filterBuckets, onlyIds, pickDay, popRank, readPickMode, weekRows, calendarShown, calendarDay, CALENDAR_COUNTS } from '../lib/upcomingPick'
import SearchableSelect from './ui/SearchableSelect'
import Switch from './ui/Switch'
import useNearEnd from '../lib/useNearEnd'
import s from './SteamCalendar.module.css'

// Steam-style release calendar: popular games coming soon plus the most
// wishlisted upcoming games (main process: steamApi.getComingSoon), with real
// portrait covers from steamApi.getAppAssets. Layouts, each shaping the whole
// tab: Steam (day columns like the store's calendar), Strip (pick a day from a
// TV-guide row), Week and Month (big grid). Games
// with no day or month live in the TBA view; your tracked releases in Tracked.
// The top bar picks which games show (lib/upcomingPick.js). "Like my games" = Steam's
// own "More like this" for your games (steamApi.getPicks): games Steam itself rates as
// similar, with a match % and which of your games they're like. "Other games" = the
// rest, "All" = both. Matches the popular feeds didn't load are added to the calendar
// too. Release days come from the store's own
// record (utils.storeRelease), so a date is the real unlock moment.
// Track = a release watch on the Game List row (survives status changes).

const FEEDS = ['soon', 'wishlist']
const START_PAGES = { soon: 2, wishlist: 3 }
const MAX_PAGES = 20
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const VIEWS = [
  { key: 'steam',    label: 'Steam',    Icon: IconBrandSteam },
  { key: 'strip',    label: 'Strip',    Icon: IconCalendarEvent },
  { key: 'week',     label: 'Week',     Icon: IconCalendarWeek },
  { key: 'month',    label: 'Month',    Icon: IconCalendarMonth },
]
const VIEW_KEYS = new Set([...VIEWS.map(v => v.key), 'tba', 'tracked'])
const DAY_MS = 86400000
const NO_PICKS = { picks: {}, sources: 0, failed: true }   // Steam didn't answer

// Survives tab switches: the feeds are cached in main for 6h anyway.
let calendarCache = null   // { games, pages, art }
let picksCache = null      // steam:picks result (main caches it 6h too)
let steamPicksCache = null // { cal } For you on Steam (services/steamForYou.js), null cal = no Steam account connected
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
  if (!rel || rel.ts == null) return rel?.label && rel.label !== 'To be announced' ? rel.label : 'TBA'
  if (rel.precision !== 'day') return rel.label || 'TBA'
  // An exact unlock within two days: hours and minutes.
  if (rel.exact && rel.ts - Date.now() < 2 * DAY_MS) return countdownTo(rel)
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
// App ids ordered by release, soonest first (undated last): the days on
// screen first get their art first.
function soonestFirst(games) {
  return games
    .map(g => ({ id: g.appid, ts: parseRelease(g.release).ts ?? Infinity }))
    .sort((a, b) => a.ts - b.ts)
    .map(x => x.id)
}

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

// "92%" match pill (Like my games), and the reason line.
export function matchTone(pct) { return pct >= 80 ? 'high' : pct >= 60 ? 'mid' : 'low' }
export function MatchBadge({ g, className = '' }) {
  if (!g.match) return null
  return <span className={`${s.match} ${s['match_' + matchTone(g.match)]} ${className}`}>{g.match}%</span>
}
// "Like Hollow Knight and Dead Cells" (Steam's More like this for those games);
// "on your list" when they're all games you still want to play.
export function reasonText(g) {
  if (g.onWishlist) return 'On your Steam wishlist'
  const n = g.reason || []
  if (!n.length) return null
  const list = n.length === 1 ? n[0] : n.length === 2 ? `${n[0]} and ${n[1]}` : `${n[0]}, ${n[1]} and ${n[2]}`
  const wanted = g.wantedSources && n.every(x => g.wantedSources.includes(x))
  return `Like ${list}${wanted ? ' on your list' : ''}`
}

// Track / Untrack, one look everywhere. variant: 'pill' (cards), 'icon' (a
// round button in a capsule's corner), 'big' (the details popup). Untrack asks
// once ("Untrack?") and only removes entries still marked Upcoming; a game you
// moved to another status stays on your list.
function TrackControl({ g, info, busy, onTrack, onUntrack, variant = 'pill' }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 3000)
    return () => clearTimeout(t)
  }, [confirm])
  const tracked = !!info?.watch
  const icon = variant === 'icon'
  const big = variant === 'big'
  const size = big ? 15 : 13
  const cls = [s.track, s['track_' + variant], tracked && s.trackOn, confirm && s.trackConfirm].filter(Boolean).join(' ')
  const label = busy ? (tracked ? 'Removing…' : 'Adding…')
    : confirm ? 'Untrack?'
    : tracked ? (big ? 'Tracked' : 'Tracked') : (big ? 'Track release' : 'Track')
  return (
    <button type="button" className={cls} disabled={busy}
      title={tracked ? (confirm ? 'Click again to stop tracking' : 'Tracked. Click to stop tracking') : 'Track this release: KoZo tells you when it comes out'}
      aria-label={tracked ? 'Untrack release' : 'Track release'}
      onClick={(e) => { e.stopPropagation(); if (!tracked) onTrack(g); else if (confirm) { setConfirm(false); onUntrack(g) } else setConfirm(true) }}>
      {confirm ? <IconX size={size} /> : tracked ? <IconBookmarkFilled size={size} /> : <IconBookmark size={size} />}
      {!icon && <span>{label}</span>}
    </button>
  )
}

function PosterCard({ g, tracked, info, onOpen, onTrack, onUntrack, onMenu, busy, compact = false }) {
  return (
    <div className={`${s.poster} ${tracked ? s.posterTracked : ''} ${compact ? s.posterCompact : ''}`} onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, g) } : undefined}>
      <button className={s.posterHit} onClick={() => onOpen(g)} title={g.name}>
        <Cover g={g} className={s.posterArt} />
        <span className={s.posterShade} />
        {!compact && <span className={s.posterCountdown}>{countdownLabel(g.rel)}</span>}
        {!compact && (g.prepurchase || g.price) && (
          <span className={s.posterPrice}>{g.prepurchase ? 'Pre-purchase' : g.price}</span>
        )}
        {g.showMatch && <MatchBadge g={g} className={s.matchOnPoster} />}
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

// The date line: the store record's day in your time zone, else Steam's text.
function releaseText(g) {
  if (g.rel?.precision === 'day' && g.rel.ts) {
    return new Date(g.rel.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return g.rel?.label || g.release || 'To be announced'
}

// ── Wide store card (Strip and Week views) ──────────────────────────────────
function WideCard({ g, tracked, info, onOpen, onTrack, onUntrack, onMenu, busy }) {
  return (
    <div className={`${s.wide} ${tracked ? s.posterTracked : ''}`} onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, g) } : undefined}>
      <button className={s.wideHit} onClick={() => onOpen(g)} title={g.name}>
        <Cover g={g} wide className={s.wideArt} />
        <span className={s.wideShade} />
        <span className={s.posterCountdown}>{countdownLabel(g.rel)}</span>
        {(g.prepurchase || g.price) && (
          <span className={s.posterPrice}>{g.prepurchase ? 'Pre-purchase' : g.price}</span>
        )}
        {g.showMatch && <MatchBadge g={g} className={s.matchOnWide} />}
      </button>
      <div className={s.wideInfo}>
        <div className={s.wideName} title={g.name}>{g.name}</div>
        <div className={s.wideMeta}>{g.showMatch && reasonText(g) ? reasonText(g) : releaseText(g)}</div>
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
function StripView({ buckets, todayKey, wide, dayPick, onMore, empty }) {
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
  if (!chips.length) return <div className={s.muted}>{empty}</div>

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
// (art only; hover for Track). A day shows its best few with "+N more" for the rest.
const STEAM_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
// Steam's calendar: Monday to Friday, one row per week, a date bar on each day and
// its games under it; a weekend release shows on the Monday after (lib/upcomingPick
// weekRows), as on Steam. A day with nothing stays an empty box, like Steam's.
// Only drawn when Steam's store index can't be reached (SteamWeeks is the Steam layout).
const COLUMN_SHOW = 8
function SteamView({ days, todayKey, lastKey, dayPick, picked, isTracked, renderTrack, onOpen, onMenu, onMore, empty }) {
  if (!days.length) return empty ? <div className={s.muted}>{empty}</div> : null
  const rows = weekRows(new Map(days), todayKey, lastKey)
  return (
    <div className={s.steamWeeks}>
      <div className={s.steamWeekHead} aria-hidden="true">
        {STEAM_WEEKDAYS.map(d => <span key={d}>{d}</span>)}
      </div>
      {rows.map(row => (
        <div key={row.key} className={s.steamWeek}>
          {row.cells.map(({ key: k, date: d, list: full, past }) => {
            const list = dayPick(full).slice(0, COLUMN_SHOW)
            return (
              <section key={k} className={`${s.steamDay} ${past ? s.steamDayPast : ''}`} data-day={k} data-games={full.length}>
                <div className={`${s.steamDayHead} ${k === todayKey ? s.steamDayToday : ''}`}>
                  {k === todayKey ? 'Today' : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}
                </div>
                <div className={s.steamDayList}>
                  {list.map(g => (
                    <div key={g.appid} className={`${s.steamCap} ${isTracked(g) ? s.steamCapTracked : ''}`} onContextMenu={(e) => { e.preventDefault(); onMenu(e, g) }}>
                      <div className={s.steamCapFrame}>
                        <button className={s.steamCapHit} onClick={() => onOpen(g)} title={g.name}>
                          <Cover g={g} wide className={s.steamCapArt} />
                          {picked && <MatchBadge g={g} className={s.matchOnCap} />}
                        </button>
                        <div className={s.capTrack}>{renderTrack(g, 'icon')}</div>
                      </div>
                      {picked && reasonText(g) && <div className={s.capReason} title={reasonText(g)}>{reasonText(g)}</div>}
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
      ))}
    </div>
  )
}

// ── Steam layout: Steam's own calendar ───────────────────────────────────────
// Built on Steam's store index (electron/services/steamCalendar.js): every game with an exact
// date in the weeks shown, ranked by wishlists and your taste, your Steam wishlist and Game List
// marked and kept. Drawn the way Steam draws its calendar: Monday to Friday, a day with one game
// shows its tall cover, two to four stack their wide ones, more show four and "+N more". Steam's
// own controls (game count, wishlisted games, a tag) instead of KoZo's picks bar, and no banner.
// The maker compared it with Steam's page: "it's not the same and not even the same games".
const CAL_WEEKS = 8           // what the first load covers, like Steam's page
const CAL_MORE_DAYS = 28      // each scroll past the end
const CAL_MAX_DAYS = 26 * 7
const DAY_SHOW = 4
let steamCalCache = null      // { from, to, items, tagNames, tasteTags, wishlist }
if (typeof window !== 'undefined') window.addEventListener('kozo:adult-changed', () => { steamCalCache = null })

const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const writeLS = (k, v) => { try { localStorage.setItem(k, String(v)) } catch {} }

// One calendar item as the rest of the page knows a game (details window, menus, Track).
function asGame(it) {
  const art = { ...(it.art || {}), release: it.release }
  return { ...it, rel: storeRelease(it.release, null), art, capsule: it.art?.capsule || null, reason: it.because || null, showMatch: false, calOrder: it.order }
}
// Your Steam wishlist and your Game List first in a day's window.
const flagged = (g) => (g.onWishlist || g.onList ? 1 : 0)

// Steam's calendar data, loaded once for the whole page: the Steam layout draws it, and Strip,
// Week and Month show its games too (the maker: "if I press All not all the games show": those
// layouts only had the two coming soon feeds). `failed` = the first load got nothing and nothing
// was cached, so the Steam layout falls back to the feeds.
function useSteamCal() {
  const [data, setData] = useState(() => steamCalCache)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const busyRef = useRef(false)

  const load = useCallback(async (range, append) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const res = await window.kozo?.api?.steam?.calendar?.(range).catch(() => null)
    busyRef.current = false
    setBusy(false)
    // Weeks already on screen stay when a refresh fails; only a first load with nothing to show
    // falls back to the old lists.
    if (!res?.ok || !res.data) {
      if (!append && !steamCalCache) { setError(res?.error || 'Steam did not answer.'); setFailed(true) }
      return
    }
    if (!append && !res.data.items?.length) { if (!steamCalCache) setFailed(true); return }
    setError(null)
    setData(prev => {
      const base = append && prev ? prev : null
      const byId = new Map((base?.items || []).map(g => [g.appid, g]))
      for (const it of res.data.items) if (!byId.has(it.appid)) byId.set(it.appid, it)
      // Two loads are ranked apart: keep each one's order, the later weeks after the earlier.
      const offset = base ? Math.max(0, ...base.items.map(g => g.order || 0)) : 0
      const items = base ? [...byId.values()].map(g => (base.items.includes(g) ? g : { ...g, order: (g.order || 0) + offset })) : res.data.items
      const tags = new Map([...(base?.tagNames || []), ...(res.data.tagNames || [])].map(t => [t.id, t]))
      const next = { ...res.data, from: base ? base.from : res.data.from, to: res.data.to, items, tagNames: [...tags.values()] }
      steamCalCache = next
      return next
    })
  }, [])

  useEffect(() => {
    load({}, false)   // the cached weeks paint at once; this refreshes them
  }, [load])

  // The next weeks, up to half a year from the first. `until`: at least to that moment.
  const more = useCallback((until = 0) => {
    const d = steamCalCache
    if (!d) return
    const cap = d.from + CAL_MAX_DAYS * DAY_MS
    if (d.to >= cap) return
    load({ from: d.to, to: Math.min(cap, Math.max(until, d.to + CAL_MORE_DAYS * DAY_MS)) }, true)
  }, [load])

  return { data, error, busy, failed, more }
}

function SteamWeeks({ cal, steamConnected, isTracked, renderTrack, onOpen, onMenu, onMore }) {
  const { data, error, busy } = cal
  const [count, setCount] = useState(() => { const n = Number(readLS('kozo:calendar:count', 100)); return CALENDAR_COUNTS.includes(n) ? n : 100 })
  const [wish, setWish] = useState(() => { const v = readLS('kozo:calendar:wish', 'show'); return ['show', 'hide', 'only'].includes(v) ? v : 'show' })
  const [tag, setTag] = useState(() => Number(readLS('kozo:calendar:tag', '')) || null)
  const [hideEarly, setHideEarly] = useState(() => readLS('kozo:calendar:noEa', '0') === '1')
  const [hideOwned, setHideOwned] = useState(() => readLS('kozo:calendar:noOwned', '0') === '1')

  const shown = useMemo(() => calendarShown(data?.items, { count, wish, tag, hideEarly, hideOwned }), [data, count, wish, tag, hideEarly, hideOwned])
  const byDay = useMemo(() => {
    const m = new Map()
    for (const it of shown) {
      const k = localDayKey(new Date(it.day))
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(asGame(it))
    }
    return m
  }, [shown])

  const todayKey = localDayKey(new Date())
  const lastKey = data ? localDayKey(new Date(data.to - DAY_MS)) : todayKey
  const rows = useMemo(() => weekRows(byDay, todayKey, lastKey), [byDay, todayKey, lastKey])

  // Scrolling past the last week asks for the next four, up to half a year.
  const canMore = !!data && data.to - data.from < CAL_MAX_DAYS * DAY_MS
  const endRef = useRef(null)
  useNearEnd(endRef, () => { if (!busy && canMore) cal.more() }, { enabled: canMore && !busy, key: data?.to })

  const setOpt = (setter, key) => (v) => { setter(v); writeLS(key, typeof v === 'boolean' ? (v ? '1' : '0') : (v ?? '')) }
  const tagOptions = useMemo(() => {
    const all = data?.tagNames || []
    const mine = new Set(data?.tasteTags || [])
    return [...all.filter(t => mine.has(t.id)), ...all.filter(t => !mine.has(t.id))].map(t => ({ value: t.id, label: t.name }))
  }, [data])

  if (!data && error) return <EmptyState Icon={IconBrandSteam} title="Steam calendar unavailable" desc={`${error} Check your connection and try again.`} />
  if (!data) return <PanelSkeleton lines={6} />

  const total = shown.length
  return (
    <div className={s.calWrap} data-steam-weeks="">
      <div className={s.calHead}>
        <div className={s.calTitleRow}>
          <h2 className={s.calTitle}>Your calendar</h2>
          <span className={s.muted}>{total} game{total === 1 ? '' : 's'} in these weeks, picked from what you play and what Steam players wishlist</span>
        </div>
        <div className={s.calControls} data-zoom-ignore="">
          <label className={s.calField}>
            <span>Tag</span>
            <span className={s.calSelect}>
              <SearchableSelect value={tag} onChange={(v) => setOpt(setTag, 'kozo:calendar:tag')(v ? Number(v) : null)} options={tagOptions} placeholder="Any tag" width="100%" />
            </span>
          </label>
          <div className={s.calField}>
            <span>Game count</span>
            <div className={s.viewToggle} role="radiogroup" aria-label="Game count" data-cal-count>
              {CALENDAR_COUNTS.map(n => (
                <button key={n} type="button" role="radio" aria-checked={count === n} title={n ? undefined : 'Every game Steam lists with a date in these weeks'}
                  className={`${s.viewBtn} ${count === n ? s.viewBtnActive : ''}`} onClick={() => setOpt(setCount, 'kozo:calendar:count')(n)}>{n || 'All'}</button>
              ))}
            </div>
          </div>
          <div className={s.calField}>
            <span>Wishlisted games</span>
            <div className={s.viewToggle} role="radiogroup" aria-label="Wishlisted games" data-cal-wish>
              {[['show', 'Show'], ['hide', 'Hide'], ['only', 'Only']].map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={wish === k}
                  className={`${s.viewBtn} ${wish === k ? s.viewBtnActive : ''}`} onClick={() => setOpt(setWish, 'kozo:calendar:wish')(k)}>{label}</button>
              ))}
            </div>
          </div>
          <label className={s.calSwitch}><Switch checked={hideEarly} onChange={setOpt(setHideEarly, 'kozo:calendar:noEa')} label="Hide Early Access" /> Hide Early Access</label>
          <label className={s.calSwitch}><Switch checked={hideOwned} onChange={setOpt(setHideOwned, 'kozo:calendar:noOwned')} label="Hide games I have" /> Hide games I have</label>
        </div>
        {steamConnected && data.wishlist?.state === 'empty' && (
          <p className={s.muted} data-cal-wishnote>
            Your Steam wishlist is private or empty, so only your Game List is marked.
            {' '}<a href="#/settings?tab=accounts" className={s.calLink}>Steam accounts</a>
          </p>
        )}
      </div>

      <div className={s.calWeeks}>
        <div className={s.calWeekHead} aria-hidden="true">
          {STEAM_WEEKDAYS.map(d => <span key={d}>{d}</span>)}
        </div>
        {rows.map(row => (
          <div key={row.key} className={s.calWeek}>
            {row.cells.map(({ key: k, date: d, list: full }) => {
              const list = calendarDay(full)
              const top = list.slice(0, DAY_SHOW)
              const tall = list.length === 1
              return (
                <section key={k} className={`${s.calDay} ${k === todayKey ? s.calDayToday : ''}`} data-day={k} data-games={full.length}>
                  <div className={s.calDayHead} title={k === todayKey ? 'Today' : undefined}>
                    {d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}
                  </div>
                  <div className={s.calDayList}>
                    {top.map(g => (
                      <div key={g.appid} className={`${s.calCap} ${isTracked(g) ? s.steamCapTracked : ''}`} data-cap={tall ? 'tall' : 'wide'}
                        onContextMenu={(e) => { e.preventDefault(); onMenu(e, g) }}>
                        <button className={`${s.calCapHit} ${tall ? s.calCapTall : ''}`} onClick={() => onOpen(g)} title={g.name}>
                          {tall && g.art?.heroCapsule
                            ? <img className={s.calCapImg} src={g.art.heroCapsule} alt="" loading="lazy" decoding="async" />
                            : <Cover g={g} wide className={s.calCapImg} />}
                          {(g.onWishlist || g.onList) && (
                            <span className={s.calTag}>{g.onWishlist ? <><IconStarFilled size={10} /> On wishlist</> : <><IconBookmarkFilled size={10} /> On your list</>}</span>
                          )}
                          {(g.v1 || g.early) && <span className={s.calChip}>{g.v1 ? '1.0' : 'Early Access'}</span>}
                        </button>
                        <div className={s.capTrack}>{renderTrack(g, 'icon')}</div>
                      </div>
                    ))}
                    {list.length > DAY_SHOW && (
                      <button className={s.calMore} onClick={() => onMore(d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), list)}>
                        +{list.length - DAY_SHOW} More
                      </button>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        ))}
      </div>
      <div ref={endRef} className={s.moreRow} data-cal-more>
        {busy ? <><IconLoader2 size={14} className="spin" /> Loading more weeks</>
          : canMore ? <span>Scroll for more weeks</span>
          : <span>That is every dated release Steam lists in these weeks</span>}
      </div>
    </div>
  )
}

// ── Tracked view: every release you track, grouped by when it lands ───────
const TRACK_GROUPS = [
  { key: 'out',   label: 'Out now' },
  { key: 'week',  label: 'This week' },
  { key: 'month', label: 'Within a month' },
  { key: 'later', label: 'Later' },
  { key: 'tba',   label: 'No date yet' },
]
function trackGroup(rel, now) {
  if (!rel || rel.ts == null) return 'tba'
  if (rel.precision === 'day' && rel.ts <= now) return 'out'
  if (rel.precision !== 'day') return rel.ts - now < 31 * DAY_MS ? 'month' : 'later'
  const d = rel.ts - now
  return d <= 7 * DAY_MS ? 'week' : d <= 31 * DAY_MS ? 'month' : 'later'
}

function TrackedCard({ g, info, renderTrack, onOpen, onMenu, onWant }) {
  const cd = countdownTo(g.rel)
  const status = info?.status && info.status !== 'upcoming' ? info.status : null
  const out = g.rel?.precision === 'day' && g.rel.ts != null && g.rel.ts <= Date.now()
  return (
    <div className={`${s.tcard} ${out ? s.tcardOut : ''}`} onContextMenu={(e) => { e.preventDefault(); onMenu(e, g) }}>
      <button type="button" className={s.tcardArt} onClick={() => onOpen(g)} title={g.name}>
        <Cover g={g} wide className={s.tcardImg} />
        <span className={s.tcardShade} />
        <span className={s.tcardWhen}>
          {out ? <span className={s.tcardOutTag}>Out now</span>
            : cd ? <span className={s.tcardCount}>{cd.replace(/^in /, '')}</span>
            : <span className={s.tcardCountSoft}>{g.rel?.label || 'TBA'}</span>}
        </span>
      </button>
      <div className={s.tcardBody}>
        <div className={s.tcardName} title={g.name}>{g.name}</div>
        <div className={s.tcardMeta}>
          <IconCalendarEvent size={13} /> {releaseText(g)}
          {status && <span className={s.tcardStatus}>{status === 'want_to_play' ? 'Want to play' : status.replace(/_/g, ' ')}</span>}
        </div>
        <div className={s.tcardActions}>
          {renderTrack(g, 'pill')}
          {out && onWant && info?.status !== 'want_to_play' && (
            <button type="button" className={s.textBtn} onClick={() => onWant(g)}><IconClockHour4 size={13} /> Want to play</button>
          )}
          {Number(g.appid) > 0 && (
            <button type="button" className={s.iconBtn} title="Steam page"
              onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.appid}`)}>
              <IconBrandSteam size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function TrackedView({ entries, card }) {
  if (!entries.length) return <div className={s.muted}>You aren't tracking any releases yet. Press Track on a game in the calendar, and KoZo tells you the day it comes out.</div>
  const now = Date.now()
  const groups = new Map(TRACK_GROUPS.map(gr => [gr.key, []]))
  for (const g of entries) groups.get(trackGroup(g.rel, now)).push(g)
  return (
    <div className={s.tracked}>
      {TRACK_GROUPS.filter(gr => groups.get(gr.key).length).map(gr => (
        <section key={gr.key} className={s.daySection}>
          <div className={s.dayHead}>
            <span className={s.dayHeadMain}>{gr.label}</span>
            <span className={s.dayHeadCount}>{groups.get(gr.key).length}</span>
          </div>
          <div className={s.tgrid}>{groups.get(gr.key).map(g => card(g))}</div>
        </section>
      ))}
    </div>
  )
}

// ── Week view: one row per day, cards scroll sideways ───────────────────────
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

function WeekView({ buckets, todayKey, weekStart, wide, dayPick, onMore, empty }) {
  const days = Array.from({ length: 7 }, (_, n) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + n))
    .filter(d => (buckets.byDay.get(localDayKey(d)) || []).length)   // no empty days
  if (!days.length) return <div className={s.muted}>{empty}</div>
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

export default function SteamCalendar({ byAppId = new Map(), trackedRows = [], onTrack, onUntrack, onWant }) {
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
  const [picks, setPicks] = useState(() => picksCache)   // steamApi.getPicks: { picks: { appid: { pct, because } }, sources, names }
  useEffect(() => {
    window.kozo?.api?.steam?.picks?.()
      .then(r => { if (r?.ok) { picksCache = r.data; setPicks(r.data) } else setPicks(p => p || NO_PICKS) })
      .catch(() => setPicks(p => p || NO_PICKS))
  }, [])
  // For you on Steam: the Steam wishlist, then games like the ones played most on Steam,
  // from the connected Steam account (services/steamForYou.js). No sign-in of its own.
  // null = no Steam account connected (or not known yet).
  const [steamCal, setSteamCal] = useState(() => steamPicksCache?.cal ?? null)
  const [steamKnown, setSteamKnown] = useState(() => !!steamPicksCache)
  useEffect(() => {
    window.kozo?.api?.steamPicks?.forYou?.().catch(() => null).then(r => {
      // An account with nothing to show (empty wishlist, private profile) has no Steam button.
      const cal = r?.ok && r.data?.items?.length ? r.data : null
      steamPicksCache = { cal }
      setSteamCal(cal)
      setSteamKnown(true)
    })
  }, [])
  const steamIds = useMemo(() => new Map((steamCal?.items || []).map((it, i) => [Number(it.appid), { rank: i, wishlist: it.wishlist, because: it.because, pct: it.pct }])), [steamCal])
  // For you on Steam / Like my games / Other games / All. Neither can be told apart until the first answer.
  const [pickChoice, setPickChoice] = useState(() => {
    try { return readPickMode(localStorage.getItem('kozo:calendar:pick')) } catch { return null }
  })
  const pickMode = pickChoice === 'steam' && steamKnown && !steamCal ? defaultPickMode(picks)
    : pickChoice || defaultPickMode(picks, !!steamCal)
  // Steam's own calendar (services/steamCalendar.js): the Steam layout, and its games in Strip,
  // Week and Month too, so every layout has the same games.
  const cal = useSteamCal()
  const calById = useMemo(() => new Map((cal.data?.items || []).map(it => [Number(it.appid), it])), [cal.data])
  // For you on Steam: its games only have a name and a date once their store record is in
  // (the feeds don't carry most of them), so until then it's loading, not empty. It said
  // "Nothing from your Steam wishlist..." for a moment before the games came in.
  const steamArtPending = pickMode === 'steam' && !!steamCal && (() => {
    const have = new Set(games.map(g => Number(g.appid)))
    return steamCal.items.some(it => !have.has(Number(it.appid)) && !calById.has(Number(it.appid)) && !art[it.appid] && !artTried.has(Number(it.appid)))
  })()
  const picksPending = pickMode === 'steam' ? (!steamCal || steamArtPending) : (!picks && pickMode !== 'all')
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()))
  const [steamDays, setSteamDays] = useState(42)   // Steam view: how far ahead (days) it reaches
  // Ctrl + mouse wheel card size, per layout (Month has a fixed layout).
  const zoomStyle = useCardZoom('calendar', view, { steam: 290, strip: 300, week: 300, tba: 160, tracked: 340 })
  const [dayOpen, setDayOpen] = useState(null)    // { label, games }
  const [detail, setDetail]   = useState(null)    // game
  const [menu, setMenu]       = useState(null)    // right-click: { x, y, g }
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
    // wishRank = place in Steam's most-wishlisted feed (TBA sort, a day's order).
    // popRank = place in the popular coming-soon feed. Both rank a day's games.
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

    await fetchArt(soonestFirst(nextGames).filter(id => !art[id]))
  }

  // Portrait art for these games, 100 per request, up to three requests at a
  // time, so the first covers show quickly. Every id is marked tried
  // afterwards, found or not.
  async function fetchArt(ids) {
    const chunks = []
    for (let k = 0; k < ids.length; k += 100) chunks.push(ids.slice(k, k + 100))
    const one = async (chunk) => {
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
    let next = 0
    const lane = async () => { while (next < chunks.length) await one(chunks[next++]) }
    await Promise.all([lane(), lane(), lane()])
  }

  // Tracked games that aren't in the loaded feeds still need their art.
  useEffect(() => {
    const ids = trackedRows.map(r => Number(r.steam_app_id)).filter(id => id && !art[id] && !artTried.has(id))
    if (ids.length) fetchArt(ids)
  }, [trackedRows])

  useEffect(() => {
    if (!calendarCache) { loadPages(START_PAGES); return }
    // Cached games whose art never arrived (an earlier request failed): ask again.
    const missing = soonestFirst(calendarCache.games).filter(id => !calendarCache.art?.[id])
    if (missing.length) fetchArt(missing)
  }, [])

  // Bucket every game by its release: exact day, month-only, or later/TBA.
  // Picks the popular feeds didn't load: ask for their store record (name,
  // date, art), then they join the calendar like any other game.
  const pickIds = useMemo(() => Object.keys(picks?.picks || {}).map(Number), [picks])
  const extraIds = useMemo(() => [...new Set([...pickIds, ...steamIds.keys()])], [pickIds, steamIds])
  useEffect(() => {
    const have = new Set(games.map(g => Number(g.appid)))
    const need = extraIds.filter(id => !have.has(id) && !calById.has(id) && !art[id] && !artTried.has(id))
    if (need.length) fetchArt(need)
  }, [extraIds, games.length, calById])
  // Steam's calendar brings its own name, date and art, so its games need no store record.
  const allGames = useMemo(() => {
    const have = new Set(games.map(g => Number(g.appid)))
    const fromCal = []
    for (const [id, it] of calById) if (!have.has(id)) { have.add(id); fromCal.push({ appid: id, name: it.name, release: null, capsule: it.art?.capsule || null }) }
    const extra = extraIds.filter(id => !have.has(id) && art[id]?.name).map(id => ({ appid: id, name: art[id].name, release: null, capsule: null }))
    return fromCal.length || extra.length ? [...games, ...fromCal, ...extra] : games
  }, [games, extraIds, art, calById])

  const buckets = useMemo(() => {
    const byDay = new Map(), byMonth = new Map(), later = [], all = []
    const todayStart = dayStart(Date.now())
    for (const g of allGames) {
      const c = calById.get(Number(g.appid))
      const a = art[g.appid] || art[String(g.appid)] || (c ? { ...c.art, name: c.name, release: c.release } : null) || (artTried.has(Number(g.appid)) ? {} : null)
      const st = pickMode === 'steam' ? steamIds.get(Number(g.appid)) : null
      const rel = storeRelease(a?.release, g.release)
      // Out already (the feeds lag behind the store): not upcoming any more.
      if (rel.precision === 'day' && rel.ts != null && rel.ts < todayStart) continue
      const pick = picks?.picks?.[g.appid]
      const entry = {
        ...g, name: g.name || a?.name || 'Unknown', rel, art: a,
        match: st ? (st.wishlist ? 0 : st.pct || 0) : pick?.pct || 0,
        reason: st ? (st.wishlist ? null : st.because) : pick?.because || null,
        wantedSources: st ? null : picks?.wanted || null,
        onWishlist: !!st?.wishlist || !!c?.onWishlist,
        onList: !!c?.onList,
        calOrder: c?.order,      // Steam's calendar rank (wishlists and your taste)
        steamRank: st ? st.rank : undefined,
        showMatch: pickMode === 'like' || (pickMode === 'steam' && !!st),
      }
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
  }, [allGames, art, artTried, picks, pickMode, steamIds, calById])

  // What the top bar's choice shows. Steam, Strip, Week and the banner follow it; Month
  // and TBA show every game, and that bar isn't there.
  const shown = useMemo(() => (pickMode === 'steam' ? onlyIds(buckets, new Set(steamIds.keys())) : filterBuckets(buckets, pickMode)), [buckets, pickMode, steamIds])
  const dayPick = (list) => pickDay(list, pickMode)
  function setPick(m) { setPickChoice(m); try { localStorage.setItem('kozo:calendar:pick', m) } catch {} }
  const emptyText = pickMode === 'steam' ? "Nothing from your Steam wishlist or games like the ones you play on Steam comes out in these weeks."
    : pickMode === 'like'
    ? (picks?.failed ? "Steam didn't answer, so games like yours can't be shown right now."
      : picks?.sources ? 'No games like yours in what Steam lists right now.'
      : 'Add a few games to your Library or Game List to see upcoming games like them.')
    : pickMode === 'others' ? 'No other games among the loaded ones.'
    : 'No dated releases ahead among the loaded games yet.'
  const weekEmpty = pickMode === 'steam' ? 'Steam has no picks for you this week.'
    : pickMode === 'like' ? 'No games like yours this week.'
    : pickMode === 'others' ? 'No other releases this week among the loaded games.'
    : 'No releases this week among the loaded games.'
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
      rel: storeRelease(appid ? art[appid]?.release : null, r.release_date),
      art: appid ? (art[appid] || (artTried.has(appid) ? {} : null)) : {},
    }
  }).sort((a, b) => (a.rel.ts ?? 9e15) - (b.rel.ts ?? 9e15)), [trackedRows, art, artTried])

  const mKey = monthKey(month)
  const todayKey = localDayKey(new Date())
  const isCurrentMonth = mKey === monthKey(new Date())
  const vagueThisMonth = buckets.byMonth.get(mKey) || []
  // Steam view: a rolling run of release days from today, like the store's
  // calendar (no month paging; "Show later days" reaches further).
  const steamHorizon = localDayKey(new Date(Date.now() + steamDays * DAY_MS))
  const steamRun = [...shown.byDay.entries()]
    .filter(([k]) => k >= todayKey && k <= steamHorizon)
    .sort(([a], [b]) => a.localeCompare(b))
  const steamHasLater = [...shown.byDay.keys()].some(k => k > steamHorizon)
  const canLoadMore = pages.soon < MAX_PAGES || pages.wishlist < MAX_PAGES
  // Endless scrolling: reaching the end shows later days, and once the loaded
  // games run out, asks Steam for the next pages of both feeds.
  const loadingRef = useRef(false)
  loadingRef.current = loading
  const reachRef = useRef(null)
  reachRef.current = () => {
    if (steamHasLater) { setSteamDays(d => d + 21); return }
    // Every match is already on the calendar, whatever pages the feeds have reached.
    if (pickMode !== 'like' && pickMode !== 'steam' && canLoadMore && !loadingRef.current) loadPages({ soon: pages.soon + 2, wishlist: pages.wishlist + 2 })
  }
  const sentinelRef = useRef(null)
  // The Steam layout is Steam's own calendar (SteamWeeks), the feeds only when it can't load.
  const steamWeeks = view === 'steam' && !cal.failed
  const haveGames = allGames.length > 0
  const hasSentinel = haveGames && view === 'steam' && !picksPending && !steamWeeks
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((ents) => { if (ents.some(e => e.isIntersecting)) reachRef.current?.() }, { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasSentinel, steamDays, games.length, pickMode])
  // Week view past the last loaded day: load more so the week fills in.
  const lastLoadedDay = useMemo(() => [...buckets.byDay.keys()].sort().pop() || todayKey, [buckets])
  useEffect(() => {
    if (view === 'week' && localDayKey(weekStart) > lastLoadedDay && canLoadMore && !loading) {
      loadPages({ soon: pages.soon + 2, wishlist: pages.wishlist + 2 })
    }
  }, [view, weekStart, lastLoadedDay])
  const thisWeek = mondayOf(new Date())
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6)
  // Week and Month past the calendar's last loaded day ask Steam's calendar for those weeks.
  // Once per end reached, so a failing Steam isn't asked again and again.
  const calTo = cal.data?.to || 0
  const askedAt = useRef(0)
  useEffect(() => {
    if (!calTo || cal.busy || askedAt.current === calTo) return
    const need = view === 'week' ? weekEnd.getTime() + DAY_MS
      : view === 'month' ? new Date(month.getFullYear(), month.getMonth() + 1, 8).getTime() : 0
    if (need > calTo) { askedAt.current = calTo; cal.more(need) }
  }, [view, weekStart, month, calTo, cal.busy])

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
  const openMenu = (e, g) => setMenu({ x: e.clientX, y: e.clientY, g })
  // Right-click on any release (every layout, shelves and the day popup).
  function menuItems(g) {
    const info = infoOf(g)
    const tracked = isTracked(g)
    return [
      { label: 'Details', Icon: IconInfoCircle, onClick: () => setDetail(g) },
      tracked
        ? { label: 'Untrack release', Icon: IconBookmarkFilled, color: 'var(--a)', onClick: () => untrack(g) }
        : { label: 'Track release', Icon: IconBookmark, onClick: () => track(g) },
      onWant && info?.status !== 'want_to_play' && { label: info ? 'Set to Want to play' : 'Add to Game List (Want to play)', Icon: IconClockHour4, onClick: () => onWant(g) },
      g.appid && { divider: true },
      g.appid && { label: 'Steam page', Icon: IconBrandSteam, onClick: () => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.appid}`) },
    ]
  }
  const poster = (g, extra = {}) => (
    <PosterCard key={g.appid} g={g} tracked={isTracked(g)} info={infoOf(g)}
      onOpen={setDetail} onTrack={track} onUntrack={untrack} onMenu={openMenu} busy={busyId === g.appid} {...extra} />
  )
  const wide = (g) => (
    <WideCard key={g.appid} g={g} tracked={isTracked(g)} info={infoOf(g)}
      onOpen={setDetail} onTrack={track} onUntrack={untrack} onMenu={openMenu} busy={busyId === g.appid} />
  )
  const renderTrack = (g, variant = 'pill') => (
    <TrackControl g={g} info={infoOf(g)} busy={busyId === g.appid}
      onTrack={() => track(g)} onUntrack={() => untrack(g)} variant={variant === true ? 'big' : variant === false ? 'pill' : variant} />
  )

  return (
    <div className={s.wrap} style={zoomStyle}>
      {/* Top bar: the layout picker, the TBA shelf, and loading more games */}
      <div className={s.nav} data-zoom-ignore="">
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
        {['steam', 'strip', 'week'].includes(view) && !steamWeeks && (
          <div className={s.viewToggle} role="radiogroup" aria-label="Which games">
            {steamCal && (
              <button className={`${s.viewBtn} ${pickMode === 'steam' ? s.viewBtnActive : ''}`} onClick={() => setPick('steam')} data-pick="steam"
                title="Your Steam wishlist, and games like the ones you play most on Steam">
                <IconBrandSteam size={14} /> For you on Steam
              </button>
            )}
            <button className={`${s.viewBtn} ${pickMode === 'like' ? s.viewBtnActive : ''}`} onClick={() => setPick('like')} data-pick="like"
              title="Only games like the ones in your Library and Game List">
              <IconSparkles size={14} /> Like my games
            </button>
            <button className={`${s.viewBtn} ${pickMode === 'others' ? s.viewBtnActive : ''}`} onClick={() => setPick('others')} data-pick="others"
              title="Only games that aren't like yours">Other games</button>
            <button className={`${s.viewBtn} ${pickMode === 'all' ? s.viewBtnActive : ''}`} onClick={() => setPick('all')} data-pick="all"
              title="Every release, most popular first">All</button>
          </div>
        )}
        <div className={s.spacer} />
        {pickMode === 'like' && ['steam', 'strip', 'week'].includes(view) && !steamWeeks && (
          <span className={s.muted} title={picks?.names?.length ? `Steam's "More like this" for: ${picks.names.join(', ')}` : ''}>
            {!picks ? 'Finding games like yours…'
              : picks.sources ? `Like ${picks.sources} of your games`
              : ''}
          </span>
        )}
        {loading && !steamWeeks && <IconLoader2 size={15} className="spin" />}
      </div>

      {steamWeeks && (
        <SteamWeeks cal={cal} steamConnected={!!steamCal || steamKnown} isTracked={isTracked} renderTrack={renderTrack}
          onOpen={setDetail} onMenu={openMenu} onMore={openMore} />
      )}

      {haveGames && ['steam', 'strip', 'week'].includes(view) && !steamWeeks && (
        <UpcomingHero games={shown.all} isTracked={isTracked} onOpen={setDetail} renderTrack={renderTrack} />
      )}

      {/* Second bar: navigation that belongs to the chosen layout */}
      {view === 'month' && (
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

      {error && !haveGames && !steamWeeks && (
        <EmptyState Icon={IconBrandSteam} title="Steam calendar unavailable" desc={`${error} Check your connection and try again.`} />
      )}
      {loading && !haveGames && !steamWeeks && <PanelSkeleton lines={6} />}

      {haveGames && picksPending && ['steam', 'strip', 'week'].includes(view) && !steamWeeks && <PanelSkeleton lines={6} />}
      {haveGames && !picksPending && view === 'steam' && !steamWeeks && (
        <SteamView days={steamRun} todayKey={todayKey} lastKey={todayKey} dayPick={dayPick} picked={pickMode === 'like' || pickMode === 'steam'} isTracked={isTracked}
          renderTrack={renderTrack} onOpen={setDetail} onMenu={openMenu} onMore={openMore} empty={steamHasLater ? '' : emptyText} />
      )}
      {hasSentinel && (
        <div ref={sentinelRef} className={s.moreRow}>
          {loading && pickMode !== 'like' ? <><IconLoader2 size={14} className="spin" /> Loading more days</>
            : (steamHasLater || (pickMode !== 'like' && canLoadMore)) ? <span>Scroll for more days</span>
            : !steamRun.length ? null
            : pickMode === 'steam' ? <span>That is every game Steam picks for you in these weeks</span>
            : pickMode === 'like' ? <span>That is every game like yours Steam lists right now</span>
            : <span>That is everything Steam lists as coming soon</span>}
        </div>
      )}
      {haveGames && !picksPending && view === 'strip' && <StripView buckets={shown} todayKey={todayKey} wide={wide} dayPick={dayPick} onMore={openMore} empty={emptyText} />}
      {haveGames && !picksPending && view === 'week' && <WeekView buckets={shown} todayKey={todayKey} weekStart={weekStart} wide={wide} dayPick={dayPick} onMore={openMore} empty={weekEmpty} />}
      {view === 'tracked' && <TrackedView entries={trackedEntries} card={(g) => (
        <TrackedCard key={g.appid} g={g} info={infoOf(g)} renderTrack={renderTrack} onOpen={setDetail} onMenu={openMenu} onWant={onWant} />
      )} />}
      {haveGames && view === 'tba' && <TbaView later={buckets.later} poster={poster} />}

      {view === 'month' && (
        <div className={s.gridScroll}>
          <div className={s.grid}>
            {WEEKDAYS.map(d => <div key={d} className={s.weekday}>{d}</div>)}
            {monthGrid(month).flat().map(day => {
              const k = localDayKey(day)
              const list = [...(buckets.byDay.get(k) || [])].sort((a, b) => popRank(a) - popRank(b))   // the most wanted in front
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

      {view === 'month' && vagueThisMonth.length > 0 && (
        <section className={s.daySection}>
          <div className={s.dayHead}>
            <span className={s.dayHeadMain}>Sometime in {formatMonthKey(mKey, 'long')}</span>
            <span className={s.dayHeadCount}>{vagueThisMonth.length}</span>
          </div>
          <div className={s.posterGrid}>{vagueThisMonth.map(g => poster(g))}</div>
        </section>
      )}

      {dayOpen && (
        <Modal title={dayOpen.label} icon={<IconCalendarMonth size={17} stroke={1.6} />} onClose={() => setDayOpen(null)} width={1080}>
          <div className={`${s.posterGrid} ${s.dayModalGrid}`}>{[...dayOpen.games].sort((a, b) => (b.match || 0) - (a.match || 0) || flagged(b) - flagged(a) || popRank(a) - popRank(b)).map(g => poster(g))}</div>
        </Modal>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          header={{ cover: menu.g.art?.portrait || menu.g.art?.capsule || menu.g.capsule || null, name: menu.g.name, sub: [countdownLabel(menu.g.rel), isTracked(menu.g) && 'Tracked'].filter(Boolean).join(' · ') }}
          items={menuItems(menu.g)}
        />
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
      release={releaseText(g)}
      countdown={countdownLabel(g.rel)}
      match={g.match ? { pct: g.match, tone: matchTone(g.match), reason: reasonText(g) } : null}
      art={g.art}
      fallbackArt={[g.capsule]}
      onClose={onClose}
      actions={<TrackControl g={g} info={info} busy={busy} onTrack={onTrack} onUntrack={onUntrack} variant="big" />}
    />
  )
}
