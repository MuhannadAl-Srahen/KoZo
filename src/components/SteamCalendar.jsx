import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconBrandSteam, IconBookmark, IconBookmarkFilled, IconCheck,
  IconX, IconCalendarMonth, IconLoader2, IconClock,
  IconHourglass, IconSearch, IconInfoCircle, IconClockHour4, IconSparkles,
  IconStarFilled, IconCalendarEvent, IconCalendarTime, IconCircleCheck, IconCalendar,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import ContextMenu from './ui/ContextMenu'
import EmptyState from './ui/EmptyState'
import SteamGameModal from './SteamGameModal'
import GeneratedCover from './GeneratedCover'
import { Skeleton, widthAt } from './ui/Skeleton'
import { parseRelease, storeRelease, countdownTo, localDayKey, monthKey, fmtDate, parseGenres } from '../lib/utils'
import { matchesSearch } from '../lib/searchRank'
import useCardZoom from '../lib/useCardZoom'
import UpcomingHero from './UpcomingHero'
import { defaultPickMode, filterBuckets, onlyIds, pickDay, popRank, readPickMode, weekRows, calendarShown, calendarDay, calendarKeep, CALENDAR_COUNTS } from '../lib/upcomingPick'
import SearchableSelect from './ui/SearchableSelect'
import Switch from './ui/Switch'
import useNearEnd from '../lib/useNearEnd'
import s from './SteamCalendar.module.css'
import u from './UpcomingCard.module.css'

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
// Only the Steam layout: the maker likes it and not Strip, Week or Month, which are gone. TBA and
// Tracked are grids of its capsules. A saved Strip, Week or Month opens the Steam layout.
const VIEWS = [
  { key: 'steam',    label: 'Steam',    Icon: IconBrandSteam },
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

function dayStart(ts) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

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
  return fmtDate(rel.ts, { month: 'short', day: 'numeric' })
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

// ── One card for every layout ────────────────────────────────────────────────
// The maker: "all the views look different from each other", and Tracked looked worst. Every layout
// now draws Steam's calendar capsule: the wide art (a lone game on a Steam day shows its tall cover),
// the On wishlist / On your list tag, 1.0 or Early Access, a chip (price or countdown), Track in the
// corner, and the name and a line under it. The Steam layout's day columns leave the words out, like
// Steam's own calendar.
// `rise` is its place in a grid (Tracked, TBA): the cards come in one after another (styles/motion.css).
function CapCard({ g, tracked, renderTrack, onOpen, onMenu, tall = false, caption = true, when, whenTone, sub, rise, late }) {
  const chip = when === undefined ? (g.prepurchase ? 'Pre-purchase' : g.price || null) : when
  return (
    <div className={`${s.calCap} ${tracked ? s.capTracked : ''}`} data-cap={tall ? 'tall' : 'wide'}
      data-rise={rise != null ? '' : undefined} style={rise != null ? { '--i': rise } : undefined}
      data-late={late ? '' : undefined}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, g) } : undefined}>
      <button className={`${s.calCapHit} ${tall ? s.calCapTall : ''}`} onClick={() => onOpen(g)} title={g.name}>
        {tall && g.art?.heroCapsule
          ? <img className={s.calCapImg} src={g.art.heroCapsule} alt="" loading="lazy" decoding="async" />
          : <Cover g={g} wide className={s.calCapImg} />}
        {(g.onWishlist || g.onList) && (
          <span className={s.calTag}>{g.onWishlist ? <><IconStarFilled size={10} /> On wishlist</> : <><IconBookmarkFilled size={10} /> On your list</>}</span>
        )}
        {(g.v1 || g.early) && <span className={s.calChip}>{g.v1 ? '1.0' : 'Early Access'}</span>}
        {chip && <span className={`${s.capWhen} ${whenTone ? s['capWhen_' + whenTone] : ''}`}>{chip}</span>}
        {g.showMatch && <MatchBadge g={g} className={s.matchOnCap} />}
      </button>
      <div className={s.capTrack}>{renderTrack(g, 'icon')}</div>
      {caption && (
        // The name opens the game too (one tab stop: the picture's).
        <button type="button" tabIndex={-1} className={s.capCaption} onClick={() => onOpen(g)}>
          <span className={s.capName} title={g.name}>{g.name}</span>
          <span className={s.capSub}>{sub || (g.showMatch && reasonText(g)) || releaseText(g)}</span>
        </button>
      )}
    </div>
  )
}

// The date line: the store record's day in your time zone, else Steam's text.
function releaseText(g) {
  if (g.rel?.precision === 'day' && g.rel.ts) {
    return fmtDate(g.rel.ts, { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return g.rel?.label || g.release || 'To be announced'
}

// ── Tracked, TBA and Steam search hits: the Discounts card ──────────────────
// The maker found Tracked and TBA "not part of the same design" as the rest of KoZo: a bare
// Steam capsule with loose text under it. This card is Discounts' (components/UpcomingCard
// .module.css): a surface with the art on top (on wishlist / 1.0 chips, Track in the corner,
// the countdown at the bottom) and the name, date and tags below it. Both halves open the game.
function UpcomingCard({ g, renderTrack, onOpen, onMenu, when, whenTone, sub, tags = [], rise }) {
  return (
    <div className={u.card} data-cap="wide" data-gpnav
      data-rise={rise != null ? '' : undefined} style={rise != null ? { '--i': rise } : undefined}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, g) } : undefined}>
      <button type="button" className={u.calCapHit} data-gpclick onClick={() => onOpen(g)} title={g.name}>
        {/* A Game List row with no Steam page has no art to ask for: a cover made from its name. */}
        {Number(g.appid) > 0 ? <Cover g={g} wide className={u.art} /> : <span className={u.art}><GeneratedCover name={g.name} /></span>}
        {(g.onWishlist || g.onList || g.v1 || g.early) && (
          <span className={u.artChips}>
            {g.onWishlist ? <span className={u.onArt}><IconStarFilled size={10} /> On wishlist</span>
              : g.onList ? <span className={u.onArt}><IconBookmarkFilled size={10} /> On your list</span> : null}
            {(g.v1 || g.early) && <span className={u.onArt}>{g.v1 ? '1.0' : 'Early Access'}</span>}
          </span>
        )}
        {when && <span className={`${u.capWhen} ${whenTone ? u['capWhen_' + whenTone] : ''}`}>{when}</span>}
      </button>
      <div className={u.capTrack}>{renderTrack(g, 'icon')}</div>
      <button type="button" tabIndex={-1} className={u.capCaption} onClick={() => onOpen(g)}>
        <span className={u.capName} title={g.name}>{g.name}</span>
        <span className={u.capSub}><IconCalendarEvent size={13} stroke={1.7} /><span>{sub || releaseText(g)}</span></span>
        {tags.length > 0 && (
          <span className={u.tags}>
            {tags.map(t => <span key={t.text} className={`${u.tag} ${t.tone ? u['tag' + t.tone] : ''}`}>{t.text}</span>)}
          </span>
        )}
      </button>
    </div>
  )
}

// A group heading: Discounts' section heading (an accent icon, the label, a count pill).
function GroupHead({ Icon, label, count }) {
  return <div className={u.groupHead}><Icon size={15} stroke={1.7} /><span>{label}</span><span className={u.count}>{count}</span></div>
}


// ── Loading: each view's own shape ───────────────────────────────────────────
// Steam's calendar while it loads: the real weekday names and dates, and in each day box
// capsules that shimmer, one tall cover or a few wide ones like a loaded day. It used to be six
// grey lines (the maker: "this is not good skeleton").
const SKEL_DAY = [1, 3, 2, 4, 2, 2, 1, 3, 2, 3, 3, 2, 1, 2, 4]
function CalendarSkeleton({ head, weeks = 3 }) {
  const todayKey = localDayKey(new Date())
  const lastKey = localDayKey(new Date(Date.now() + (weeks * 7 - 1) * DAY_MS))
  const rows = weekRows(new Map(), todayKey, lastKey).slice(0, weeks)
  return (
    <div className={s.calWrap} aria-busy="true" aria-label="Loading the calendar" data-cal-skeleton="">
      {head}
      <div className={s.calWeeks}>
        <div className={s.calWeekHead} aria-hidden="true">
          {STEAM_WEEKDAYS.map(d => <span key={d}>{d}</span>)}
        </div>
        {rows.map((row, ri) => (
          <div key={row.key} className={s.skWeek}>
            {row.cells.map(({ key: k, date: d }, ci) => {
              const n = SKEL_DAY[(ri * 5 + ci) % SKEL_DAY.length]
              return (
                <div key={k} className={`${s.calDay} ${k === todayKey ? s.calDayToday : ''}`}>
                  <div className={s.calDayHead}>{fmtDate(d, { month: 'long', day: 'numeric' })}</div>
                  <div className={s.calDayList}>
                    {Array.from({ length: n }, (_, j) => <Skeleton key={j} h={null} className={n === 1 ? s.skCapTall : s.skCap} />)}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// Tracked and TBA while they load: the group headings and the same cards, shimmering.
function CapGridSkeleton({ groups = [4, 8] }) {
  let n = 0
  return (
    <div className={u.list} aria-busy="true" aria-label="Loading">
      {groups.map((count, gi) => (
        <section key={gi} className={u.group}>
          <div className={u.groupHead}><Skeleton w={gi ? 64 : 96} h={10} /><Skeleton w={22} h={16} r={8} /></div>
          <div className={u.grid}>
            {Array.from({ length: count }, () => {
              const i = n++
              return (
                <div key={i} className={u.skCard}>
                  <Skeleton w="100%" h={null} r={0} className={u.skArt} />
                  <div className={u.skBody}>
                    <Skeleton w={widthAt(['70%', '54%', '78%', '62%'], i)} h={13} />
                    <Skeleton w={widthAt(['34%', '26%', '40%'], i)} h={10} />
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

// TBA's sort and count, while the games load.
function TbaNavSkeleton() {
  return (
    <div className={u.bar} aria-hidden="true">
      <Skeleton w={214} h={36} r={18} />
      <Skeleton w={170} h={11} />
    </div>
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
    <div className={s.steamWeeks} data-fade="">
      <div className={s.steamWeekHead} aria-hidden="true">
        {STEAM_WEEKDAYS.map(d => <span key={d}>{d}</span>)}
      </div>
      {rows.map((row, ri) => (
        <div key={row.key} className={s.steamWeek}>
          {row.cells.map(({ key: k, date: d, list: full, past }, ci) => {
            const list = dayPick(full).slice(0, COLUMN_SHOW)
            return (
              <section key={k} className={`${s.steamDay} ${past ? s.steamDayPast : ''}`} data-day={k} data-games={full.length}
                data-rise={ri < 3 ? '' : undefined} style={ri < 3 ? { '--i': ri + ci } : undefined}>
                <div className={`${s.steamDayHead} ${k === todayKey ? s.steamDayToday : ''}`}>
                  {k === todayKey ? 'Today' : fmtDate(d, { month: 'long', day: 'numeric' })}
                </div>
                <div className={s.steamDayList}>
                  {list.map(g => (
                    <CapCard key={g.appid} g={g} tracked={isTracked(g)} renderTrack={renderTrack} onOpen={onOpen} onMenu={onMenu}
                      when={null} caption={picked && !!reasonText(g)} sub={reasonText(g)} />
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

function SteamWeeks({ cal, opts, query = '', controls, steamConnected, isTracked, renderTrack, onOpen, onMenu, onMore }) {
  const { data, error, busy } = cal
  // Upcoming's search box: the weeks keep only the games it matches.
  const shown = useMemo(() => calendarShown(query ? (data?.items || []).filter(it => matchesSearch(it.name, query)) : data?.items, opts), [data, opts, query])
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
  // The games of the first paint: they come in with their day box. Only a game that joins a box
  // later (another tag, Game count) fades in; every capsule fading as well as its box was double
  // work on each visit.
  const firstIds = useRef(null)
  useEffect(() => { if (data && !firstIds.current) firstIds.current = new Set(shown.map(it => it.appid)) }, [data, shown])

  // Scrolling past the last week asks for the next four, up to half a year.
  const canMore = !!data && data.to - data.from < CAL_MAX_DAYS * DAY_MS
  const endRef = useRef(null)
  useNearEnd(endRef, () => { if (!busy && canMore) cal.more() }, { enabled: canMore && !busy, key: data?.to })

  if (!data && error) return <EmptyState Icon={IconBrandSteam} title="Steam calendar unavailable" desc={`${error} Check your connection and try again.`} />
  // Loading: the title, the controls and the weeks are where they will be; the games shimmer.
  if (!data) {
    return (
      <CalendarSkeleton head={
        <div className={s.calHead}>
          <div className={s.calTitleRow}>
            <h2 className={s.calTitle}>Your calendar</h2>
            <Skeleton w={340} h={11} />
          </div>
          {controls}
        </div>
      } />
    )
  }

  const total = shown.length
  return (
    <div className={s.calWrap} data-steam-weeks="" data-fade="">
      <div className={s.calHead}>
        <div className={s.calTitleRow}>
          <h2 className={s.calTitle}>Your calendar</h2>
          <span className={s.muted}>{total} game{total === 1 ? '' : 's'} in these weeks, picked from what you play and what Steam players wishlist</span>
        </div>
        {controls}
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
        {/* The day boxes come in as a wave from the top left (data-rise, styles/motion.css); a
            game that joins a box later (another tag or Game count) fades in. */}
        {rows.map((row, ri) => (
          <div key={row.key} className={s.calWeek}>
            {row.cells.map(({ key: k, date: d, list: full }, ci) => {
              const list = calendarDay(full)
              const top = list.slice(0, DAY_SHOW)
              const tall = list.length === 1
              return (
                <section key={k} className={`${s.calDay} ${k === todayKey ? s.calDayToday : ''}`} data-day={k} data-games={full.length}
                  data-rise={ri < 3 ? '' : undefined} style={ri < 3 ? { '--i': ri + ci } : undefined}>
                  <div className={s.calDayHead} title={k === todayKey ? 'Today' : undefined}>
                    {fmtDate(d, { month: 'long', day: 'numeric' })}
                  </div>
                  <div className={s.calDayList}>
                    {top.map(g => (
                      <CapCard key={g.appid} g={g} tall={tall} tracked={isTracked(g)} renderTrack={renderTrack} onOpen={onOpen} onMenu={onMenu} caption={false} when={null}
                        late={!!firstIds.current && !firstIds.current.has(g.appid)} />
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

// Steam's calendar controls, for every dated layout (the maker: "have an option for the game count
// for the other tabs too"): one tag, how many games, wishlisted games, no Early Access, nothing you
// have. The same choices (localStorage kozo:calendar:*) apply to Steam, Strip, Week and Month.
function CalendarControls({ opts, set, tagOptions }) {
  return (
    <div className={s.calControls} data-zoom-ignore="" data-cal-controls>
      <label className={s.calField}>
        <span>Tag</span>
        <span className={s.calSelect}>
          <SearchableSelect value={opts.tag} onChange={(v) => set('tag', v ? Number(v) : null)} options={tagOptions} placeholder="Any tag" width="100%" />
        </span>
      </label>
      <div className={s.calField}>
        <span>Game count</span>
        <div className={s.viewToggle} role="radiogroup" aria-label="Game count" data-cal-count>
          {CALENDAR_COUNTS.map(n => (
            <button key={n} type="button" role="radio" aria-checked={opts.count === n} title={n ? undefined : 'Every game with a date in these weeks'}
              className={`${s.viewBtn} ${opts.count === n ? s.viewBtnActive : ''}`} onClick={() => set('count', n)}>{n || 'All'}</button>
          ))}
        </div>
      </div>
      <div className={s.calField}>
        <span>Wishlisted games</span>
        <div className={s.viewToggle} role="radiogroup" aria-label="Wishlisted games" data-cal-wish>
          {[['show', 'Show'], ['hide', 'Hide'], ['only', 'Only']].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={opts.wish === k}
              className={`${s.viewBtn} ${opts.wish === k ? s.viewBtnActive : ''}`} onClick={() => set('wish', k)}>{label}</button>
          ))}
        </div>
      </div>
      <label className={s.calSwitch}><Switch checked={opts.hideEarly} onChange={(v) => set('hideEarly', v)} label="Hide Early Access" /> Hide Early Access</label>
      <label className={s.calSwitch}><Switch checked={opts.hideOwned} onChange={(v) => set('hideOwned', v)} label="Hide games I have" /> Hide games I have</label>
    </div>
  )
}
const CAL_OPT_KEYS = { tag: 'kozo:calendar:tag', count: 'kozo:calendar:count', wish: 'kozo:calendar:wish', hideEarly: 'kozo:calendar:noEa', hideOwned: 'kozo:calendar:noOwned' }
function readCalOpts() {
  const n = Number(readLS(CAL_OPT_KEYS.count, 100))
  const w = readLS(CAL_OPT_KEYS.wish, 'show')
  return {
    count: CALENDAR_COUNTS.includes(n) ? n : 100,
    wish: ['show', 'hide', 'only'].includes(w) ? w : 'show',
    tag: Number(readLS(CAL_OPT_KEYS.tag, '')) || null,
    hideEarly: readLS(CAL_OPT_KEYS.hideEarly, '0') === '1',
    hideOwned: readLS(CAL_OPT_KEYS.hideOwned, '0') === '1',
  }
}

// ── Tracked: the cards, grouped by when they land ─────────────────────────────
// Every card is tracked here, so none gets a tracked ring. Out now / This month / Later / Date not
// announced, how long until it on the picture, the status (when not Upcoming) and genres below.
const TRACK_GROUPS = [
  { key: 'out',   label: 'Out now', Icon: IconCircleCheck },
  { key: 'month', label: 'This month', Icon: IconCalendarEvent },
  { key: 'later', label: 'Later', Icon: IconCalendarTime },
  { key: 'tba',   label: 'Date not announced', Icon: IconHourglass },
]
function trackGroupOf(rel, now) {
  if (rel?.ts == null) return 'tba'
  if (rel.precision === 'day' && rel.ts <= now) return 'out'
  if (rel.precision === 'day' && rel.ts - now <= 31 * DAY_MS) return 'month'
  return 'later'
}

// How long until it, on the picture: Out now (green), Today to in 6 days (the accent), then in N
// days, weeks or months. A month or a year alone has no chip: the date line says it.
function trackChip(rel, now = Date.now()) {
  if (rel?.precision !== 'day' || rel.ts == null) return null
  if (rel.ts <= now) return { text: 'Out now', tone: 'out' }
  const days = Math.round((dayStart(rel.ts) - dayStart(now)) / DAY_MS)
  if (days < 31) return { text: countdownLabel(rel), tone: days < 7 ? 'soon' : null }
  if (days < 63) return { text: `in ${Math.round(days / 7)} weeks`, tone: null }
  return { text: `in ${Math.round(days / 30.4)} months`, tone: null }
}
function statusText(status) {
  if (!status || status === 'upcoming') return null
  const t = status.replace(/_/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function TrackedView({ entries, card, infoOf, searching }) {
  if (!entries.length) {
    return searching ? null : (
      <EmptyState Icon={IconBookmark} title="You aren't tracking any releases yet"
        desc="Press Track on a game in the calendar, in TBA or in a search, and KoZo tells you the day before it comes out and the day it does." />
    )
  }
  const now = Date.now()
  const groups = new Map(TRACK_GROUPS.map(gr => [gr.key, []]))
  for (const g of entries) groups.get(trackGroupOf(g.rel, now)).push(g)
  let n = 0
  return (
    <div className={u.list} data-tracked data-fade="">
      {TRACK_GROUPS.filter(gr => groups.get(gr.key).length).map((gr) => (
        <section key={gr.key} className={u.group} data-track-group={gr.key}>
          <GroupHead Icon={gr.Icon} label={gr.label} count={groups.get(gr.key).length} />
          <div className={u.grid}>
            {groups.get(gr.key).map((g) => {
              const chip = trackChip(g.rel, now)
              const status = statusText(infoOf(g)?.status)
              const tags = [status && { text: status, tone: 'Status' }, ...(g.genres || []).slice(0, 3).map(t => ({ text: t }))].filter(Boolean)
              const i = n++
              return card(g, { when: chip?.text || null, whenTone: chip?.tone, sub: releaseText(g), tags, rise: i < 16 ? i : null })
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

// ── TBA: every game without a day or month ───────────────────────────────────
// The page's search box filters it (`later` arrives filtered); more come in as the end nears,
// like every other list (it had a Show more button).
const TBA_PAGE = 60
function TbaView({ later, card, query }) {
  const [sort, setSort] = useState('wish')
  const [limit, setLimit] = useState(TBA_PAGE)
  useEffect(() => { setLimit(TBA_PAGE) }, [query, sort])
  const sorted = [...later].sort((a, b) => (sort === 'name'
    ? a.name.localeCompare(b.name)
    : (a.wishRank ?? 1e9) - (b.wishRank ?? 1e9) || a.name.localeCompare(b.name)))
  const shown = sorted.slice(0, limit)
  // Grouped by announced year ("2026", "2027"); the rest is "To be announced".
  const groups = new Map()
  for (const g of shown) {
    const y = g.rel?.ts != null ? String(new Date(g.rel.ts).getFullYear()) : 'To be announced'
    if (!groups.has(y)) groups.set(y, [])
    groups.get(y).push(g)
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'To be announced') - (b === 'To be announced') || a.localeCompare(b))
  const endRef = useRef(null)
  useNearEnd(endRef, () => setLimit(l => l + TBA_PAGE), { enabled: sorted.length > limit, key: `${limit}:${sorted.length}` })
  let n = 0
  return (
    <div className={u.list} data-tba>
      <div className={u.bar} data-fade="">
        <div className={u.seg} role="radiogroup" aria-label="Sort undated games">
          {[['wish', 'Most wishlisted'], ['name', 'A to Z']].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={sort === k} className={`${u.segBtn} ${sort === k ? u.segOn : ''}`} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
        <span className={u.muted}>{sorted.length} game{sorted.length !== 1 ? 's' : ''} without a release date{query ? ` match “${query}”` : ''}</span>
      </div>
      {order.map((y) => (
        <section key={y} className={u.group} data-tba-group={y}>
          <GroupHead Icon={y === 'To be announced' ? IconHourglass : IconCalendar} label={y} count={groups.get(y).length} />
          <div className={u.grid}>
            {groups.get(y).map((g) => { const i = n++; return card(g, { when: null, sub: releaseText(g), rise: i < 16 ? i : null }) })}
          </div>
        </section>
      ))}
      {sorted.length > limit && <div ref={endRef} className={u.endRow} />}
      {!sorted.length && !query && <div className={u.muted}>No undated games in what Steam lists right now.</div>}
    </div>
  )
}

export default function SteamCalendar({ byAppId = new Map(), trackedRows = [], trackedLoaded = true, onTrack, onUntrack, onWant, view: viewProp = 'steam', query = '', onCounts, onOpenListRow }) {
  const [games, setGames]     = useState(() => calendarCache?.games || [])
  const [art, setArt]         = useState(() => calendarCache?.art || {})
  // App ids whose art request finished (found or not); the rest show a shimmer.
  const [artTried, setArtTried] = useState(() => new Set(Object.keys(calendarCache?.art || {}).map(Number)))
  const [pages, setPages]     = useState(() => calendarCache?.pages || { soon: 0, wishlist: 0 })
  const [loading, setLoading] = useState(!calendarCache)
  const [error, setError]     = useState(null)
  // Steam, TBA or Tracked: chosen by the page's tabs (pages/Upcoming.jsx), which remember it.
  const view = VIEW_KEYS.has(viewProp) ? viewProp : 'steam'
  const q = String(query || '').trim()
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
  const [steamDays, setSteamDays] = useState(42)   // Steam view: how far ahead (days) it reaches
  // Ctrl + mouse wheel card size, per layout (Month has a fixed layout).
  const zoomStyle = useCardZoom('calendar', view, { steam: 290, tba: 230, tracked: 240 })
  // The controls (CalendarControls) for every dated layout, the Steam layout's own.
  const [calOpts, setCalOpts] = useState(readCalOpts)
  const setCalOpt = (k, v) => { setCalOpts(o => ({ ...o, [k]: v })); writeLS(CAL_OPT_KEYS[k], typeof v === 'boolean' ? (v ? '1' : '0') : (v ?? '')) }
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
        // Steam's calendar knows these; a game only the feeds list has no tags, and no tag picks it.
        early: !!c?.early, v1: !!c?.v1, owned: !!c?.owned, tagIds: c?.tagIds || null,
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
  const picked = useMemo(() => (pickMode === 'steam' ? onlyIds(buckets, new Set(steamIds.keys())) : filterBuckets(buckets, pickMode)), [buckets, pickMode, steamIds])
  // Then the controls: Game count, wishlisted, tag, Early Access, games you have (lib/upcomingPick
  // calendarKeep, Steam's own rules). Month shows every game the controls keep.
  const shown = useMemo(() => onlyIds(picked, calendarKeep(picked.all, calOpts)), [picked, calOpts])
  const tagOptions = useMemo(() => {
    const all = cal.data?.tagNames || []
    const mine = new Set(cal.data?.tasteTags || [])
    return [...all.filter(t => mine.has(t.id)), ...all.filter(t => !mine.has(t.id))].map(t => ({ value: t.id, label: t.name }))
  }, [cal.data])
  const controls = <CalendarControls opts={calOpts} set={setCalOpt} tagOptions={tagOptions} />
  const dayPick = (list) => pickDay(list, pickMode)
  function setPick(m) { setPickChoice(m); try { localStorage.setItem('kozo:calendar:pick', m) } catch {} }
  const emptyText = pickMode === 'steam' ? "Nothing from your Steam wishlist or games like the ones you play on Steam comes out in these weeks."
    : pickMode === 'like'
    ? (picks?.failed ? "Steam didn't answer, so games like yours can't be shown right now."
      : picks?.sources ? 'No games like yours in what Steam lists right now.'
      : 'Add a few games to your Library or Game List to see upcoming games like them.')
    : pickMode === 'others' ? 'No other games among the loaded ones.'
    : 'No dated releases ahead among the loaded games yet.'
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
      genres: parseGenres(r),
    }
  }).sort((a, b) => (a.rel.ts ?? 9e15) - (b.rel.ts ?? 9e15)), [trackedRows, art, artTried])
  // Upcoming's search box, on each view.
  const trackedShown = useMemo(() => (q ? trackedEntries.filter(g => matchesSearch(g.name, q)) : trackedEntries), [trackedEntries, q])
  const laterShown = useMemo(() => (q ? buckets.later.filter(g => matchesSearch(g.name, q)) : buckets.later), [buckets, q])
  const shownQ = useMemo(() => (q ? onlyIds(shown, new Set(shown.all.filter(g => matchesSearch(g.name, q)).map(g => Number(g.appid)))) : shown), [shown, q])

  const todayKey = localDayKey(new Date())
  // Steam view: a rolling run of release days from today, like the store's
  // calendar (no month paging; "Show later days" reaches further).
  const steamHorizon = localDayKey(new Date(Date.now() + steamDays * DAY_MS))
  const steamRun = [...shownQ.byDay.entries()]
    .filter(([k]) => k >= todayKey && k <= steamHorizon)
    .sort(([a], [b]) => a.localeCompare(b))
  const steamHasLater = [...shownQ.byDay.keys()].some(k => k > steamHorizon)
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
  // A tracked game with no Steam page (a Game List row only) opens its Game List window: its
  // Steam window asked Steam for "list-227" and showed nothing (log: status 400).
  const openGame = (g) => {
    if (g._listId && !(Number(g.appid) > 0)) { onOpenListRow?.(g._listId); return }
    setDetail(g)
  }
  // Upcoming's search also asks Steam's store, a moment after typing stops: a game you look for
  // that isn't on the page can be opened and tracked from here.
  const [hits, setHits] = useState(null)          // null = not searched
  const [hitsBusy, setHitsBusy] = useState(false)
  useEffect(() => {
    if (q.length < 2) { setHits(null); setHitsBusy(false); return undefined }
    let alive = true
    setHitsBusy(true)
    const t = setTimeout(async () => {
      const res = await window.kozo?.api?.steam?.search?.(q)
      if (!alive) return
      setHitsBusy(false)
      setHits(res?.ok ? (res.data || []) : [])
    }, 350)
    return () => { alive = false; clearTimeout(t) }
  }, [q])
  const steamHits = useMemo(() => {
    if (!hits?.length) return []
    const onPage = new Set([...allGames.map(g => Number(g.appid)), ...trackedEntries.map(g => Number(g.appid)), ...(cal.data?.items || []).map(it => Number(it.appid))])
    return hits.filter(h => Number(h.steam_app_id) > 0 && !onPage.has(Number(h.steam_app_id))).slice(0, 8).map(h => {
      const id = Number(h.steam_app_id)
      const a = art[id] || null
      return {
        appid: id, name: h.name, release: null, capsule: h.header_image || h.capsule || null,
        art: a || { header: h.header_image || null, capsule: h.capsule || h.header_image || null },
        rel: storeRelease(a?.release, null),
      }
    })
  }, [hits, allGames, trackedEntries, cal.data, art])

  // Right-click on any release (every layout, shelves and the day popup).
  function menuItems(g) {
    const info = infoOf(g)
    const tracked = isTracked(g)
    return [
      { label: 'Details', Icon: IconInfoCircle, onClick: () => openGame(g) },
      tracked
        ? { label: 'Untrack release', Icon: IconBookmarkFilled, color: 'var(--a)', onClick: () => untrack(g) }
        : { label: 'Track release', Icon: IconBookmark, onClick: () => track(g) },
      onWant && info?.status !== 'want_to_play' && { label: info ? 'Set to Want to play' : 'Add to Game List (Want to play)', Icon: IconClockHour4, onClick: () => onWant(g) },
      g.appid && { divider: true },
      g.appid && { label: 'Steam page', Icon: IconBrandSteam, onClick: () => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.appid}`) },
    ]
  }
  const renderTrack = (g, variant = 'pill') => (
    <TrackControl g={g} info={infoOf(g)} busy={busyId === g.appid}
      onTrack={() => track(g)} onUntrack={() => untrack(g)} variant={variant === true ? 'big' : variant === false ? 'pill' : variant} />
  )
  // The one card (CapCard) with this page's Track, menu and details.
  const cap = (g, extra = {}) => (
    <CapCard key={g.appid} g={g} tracked={isTracked(g)} renderTrack={renderTrack} onOpen={openGame} onMenu={openMenu} {...extra} />
  )
  // Tracked, TBA and Steam search hits: the Discounts-style card.
  const card = (g, extra = {}) => (
    <UpcomingCard key={g.appid} g={g} renderTrack={renderTrack} onOpen={openGame} onMenu={openMenu} {...extra} />
  )
  // The page's tabs show how many each view has, or how many match while searching.
  const tbaCount = loading && !haveGames ? null : laterShown.length
  const trackedCount = trackedLoaded ? trackedShown.length : null
  const steamCount = useMemo(() => {
    if (!q) return null
    if (cal.data) return calendarShown((cal.data.items || []).filter(it => matchesSearch(it.name, q)), calOpts).length
    return shownQ.all.length
  }, [q, cal.data, calOpts, shownQ])
  useEffect(() => { onCounts?.({ steam: steamCount, tba: tbaCount, tracked: trackedCount }) }, [steamCount, tbaCount, trackedCount])

  return (
    <div className={s.wrap} style={zoomStyle}>
      {/* The fallback layout's top bar (Steam's calendar didn't load): which games, and loading.
          Steam / TBA / Tracked are the page's tabs (pages/Upcoming.jsx). */}
      {view === 'steam' && !steamWeeks && <div className={s.nav} data-zoom-ignore="">
        {view === 'steam' && !steamWeeks && (
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
        {pickMode === 'like' && view === 'steam' && !steamWeeks && (
          <span className={s.muted} title={picks?.names?.length ? `Steam's "More like this" for: ${picks.names.join(', ')}` : ''}>
            {!picks ? 'Finding games like yours…'
              : picks.sources ? `Like ${picks.sources} of your games`
              : ''}
          </span>
        )}
        {loading && !steamWeeks && <IconLoader2 size={15} className="spin" />}
      </div>}

      {steamWeeks && (
        <SteamWeeks cal={cal} opts={calOpts} query={q} controls={controls} steamConnected={!!steamCal || steamKnown} isTracked={isTracked} renderTrack={renderTrack}
          onOpen={openGame} onMenu={openMenu} onMore={openMore} />
      )}

      {haveGames && view === 'steam' && !steamWeeks && !q && (
        <UpcomingHero games={shown.all} isTracked={isTracked} onOpen={openGame} renderTrack={renderTrack} />
      )}

      {!steamWeeks && view === 'steam' && controls}

      {error && !haveGames && !steamWeeks && (
        <EmptyState Icon={IconBrandSteam} title="Steam calendar unavailable" desc={`${error} Check your connection and try again.`} />
      )}
      {/* Loading: each view's own shape, never lines or an empty page. */}
      {loading && !haveGames && view === 'steam' && !steamWeeks && <CalendarSkeleton />}
      {loading && !haveGames && view === 'tba' && <div className={u.list}><TbaNavSkeleton /><CapGridSkeleton groups={[4, 8]} /></div>}

      {haveGames && picksPending && view === 'steam' && !steamWeeks && <CalendarSkeleton />}
      {haveGames && !picksPending && view === 'steam' && !steamWeeks && (
        <SteamView days={steamRun} todayKey={todayKey} lastKey={todayKey} dayPick={dayPick} picked={pickMode === 'like' || pickMode === 'steam'} isTracked={isTracked}
          renderTrack={renderTrack} onOpen={openGame} onMenu={openMenu} onMore={openMore} empty={steamHasLater ? '' : emptyText} />
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
      {view === 'tracked' && (trackedLoaded ? <TrackedView entries={trackedShown} card={card} infoOf={infoOf} searching={!!q} /> : <CapGridSkeleton groups={[3, 4]} />)}
      {haveGames && view === 'tba' && <TbaView later={laterShown} card={card} query={q} />}
      {q.length >= 2 && (hitsBusy || hits) && (
        <section className={u.group} data-upcoming-steam>
          <div className={u.groupHead}><IconBrandSteam size={15} stroke={1.7} /><span>On Steam</span>{hitsBusy && <IconLoader2 size={13} className="spin" />}</div>
          {steamHits.length > 0
            ? <div className={u.grid}>{steamHits.map(g => card(g, { when: null, sub: 'Open it for its release date' }))}</div>
            : !hitsBusy && <p className={u.muted}>Steam found nothing else for “{q}”.</p>}
        </section>
      )}

      {dayOpen && (
        <Modal title={dayOpen.label} icon={<IconCalendarMonth size={17} stroke={1.6} />} onClose={() => setDayOpen(null)} width={1080}>
          <div className={`${s.capGrid} ${s.dayModalGrid}`}>{[...dayOpen.games].sort((a, b) => (b.match || 0) - (a.match || 0) || flagged(b) - flagged(a) || popRank(a) - popRank(b)).map(g => cap(g))}</div>
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
