import React, { useState, useEffect } from 'react'
import {
  IconCalendar, IconHourglassLow, IconConfetti, IconHelpCircle,
  IconPlayerPlayFilled, IconBookmark, IconBrandSteam, IconBookmarkOff,
} from '@tabler/icons-react'
import { parseGenres, parseRelease } from '../lib/utils'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton, CardSkeletonGrid, PanelSkeleton } from '../components/ui/Skeleton'
import SteamCalendar from '../components/SteamCalendar'
import SteamGameModal from '../components/SteamGameModal'
import ReleasedPanel from '../components/ReleasedPanel'
import useCardZoom from '../lib/useCardZoom'
import s from './Upcoming.module.css'

// Keep Upcoming data hot between route changes to avoid full visual resets.
let upcomingCache = null

// "How far away" wording. `approx` marks a vague date whose exact day is a guess,
// so it never reads as a confident "Tomorrow".
function relativeLabel(ms, approx) {
  const days = Math.ceil(ms / 86400000)
  if (days < 31) {
    if (!approx && days === 1) return 'Tomorrow'
    return `in ${approx ? '~' : ''}${days} day${days === 1 ? '' : 's'}`
  }
  const months = Math.round(days / 30.4)
  if (months < 13) return `in ~${months} month${months === 1 ? '' : 's'}`
  return `in ~${(days / 365).toFixed(1)} years`
}

function countdown(rel) {
  if (!rel || rel.ts == null) return 'No date'
  const now = Date.now()
  if (rel.until <= now) return 'Out now'
  if (!rel.vague) return relativeLabel(rel.ts - now, false)
  // Inside the named window: not provably out, and echoing "November 2026" here
  // would just repeat the subtitle underneath the badge.
  if (rel.ts <= now) return rel.precision === 'month' ? 'This month' : 'This year'
  // A year-only ts is a synthetic mid-year point — ±6 months of error makes a
  // countdown noise, so the raw label stays.
  if (rel.precision === 'year') return rel.label
  return relativeLabel(rel.ts - now, true)
}

// Wide card art. Steam's 616×353 capsule first: it matches the card size, so
// it decodes fast and sharp. The library hero is a ~3840px wallpaper and made
// every card lag, so it only appears in the detail gallery.
function wideArtSources(item, art) {
  const id = item.steam_app_id
  const srcs = []
  if (art?.capsule) srcs.push(art.capsule)
  if (art?.header) srcs.push(art.header)
  if (id) {
    srcs.push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/capsule_616x353.jpg`)
    srcs.push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`)
  }
  if (item.banner_url) srcs.push(item.banner_url)
  return [...new Set(srcs)]
}

// Walks the source list on error. Keyed by the first source so new art
// (arriving from steam:appAssets) restarts the ladder instead of sticking.
function WideArt({ item, art, className }) {
  const srcs = wideArtSources(item, art)
  const [idx, setIdx] = useState(0)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { setIdx(0); setLoaded(false) }, [srcs[0]])
  if (idx >= srcs.length) return <div className={`${className} ${s.artEmpty}`}><IconCalendar size={26} stroke={1.3} /></div>
  return (
    <img
      className={`${className} ${loaded ? s.artLoaded : ''}`}
      src={srcs[idx]}
      alt=""
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(true)}
      onError={() => setIdx(i => i + 1)}
    />
  )
}

function badgeClassFor(rel) {
  if (!rel || rel.ts == null) return s.badgeTba
  const now = Date.now()
  // Green only once the whole named window has closed (`until`), never off a
  // month's 1st or a year's midpoint.
  if (rel.until <= now) return s.badgeOut
  // Month precision is tight enough to flag as imminent; year-only isn't.
  if (rel.vague && rel.precision !== 'month') return ''
  if (rel.ts > now && rel.ts - now < 31 * 86400000) return s.badgeSoon
  return ''
}

// ── Detail popup: the shared store-style game modal ───────────────────────────
function DetailModal({ item, rel, art, onClose, onStatus, onUntrack }) {
  const [confirm, setConfirm] = useState(false)
  return (
    <SteamGameModal
      appId={item.steam_app_id}
      name={item.name}
      release={item.release_date}
      countdown={countdown(rel)}
      art={art}
      fallbackArt={wideArtSources(item, null)}
      onClose={onClose}
      actions={
        <>
          <button className={ms.btnCancel} onClick={() => (confirm ? onUntrack() : setConfirm(true))}
            title="Stop tracking this release">
            <IconBookmarkOff size={13} stroke={1.8} /> {confirm ? 'Click to confirm' : 'Untrack'}
          </button>
          <button className={ms.btnCancel} onClick={() => onStatus('want_to_play')}>
            <IconBookmark size={13} stroke={1.8} /> Want to play
          </button>
          <button className={ms.btnPrimary} onClick={() => onStatus('playing')}>
            <IconPlayerPlayFilled size={12} /> Playing
          </button>
        </>
      }
    />
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────
// How far along the wait is, from when it was added to the list to release.
function waitProgress(item, rel) {
  if (!rel || rel.ts == null || rel.vague || !item.added_at) return null
  const start = new Date(item.added_at).getTime()
  const end = rel.ts
  if (!Number.isFinite(start) || end <= start) return null
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)))
}

function UpcomingCard({ item, rel, art, onOpen, onStatus, onUntrack }) {
  const [confirm, setConfirm] = useState(false)
  const genres = parseGenres(item).slice(0, 3)
  const progress = waitProgress(item, rel)
  const out = rel?.until != null && rel.until <= Date.now()
  const open = () => onOpen({ item, rel })
  const stop = (fn) => (e) => { e.stopPropagation(); fn() }
  return (
    <div
      className={`${s.card} ${out ? s.cardOut : ''}`}
      role="button"
      tabIndex={0}
      data-gpnav=""
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') open() }}
    >
      <div className={s.cardMedia}>
        <WideArt item={item} art={art} className={s.cardArt} />
        <span className={`${s.pill} ${badgeClassFor(rel)}`}>{countdown(rel)}</span>
        <div className={s.cardActions}>
          {item.steam_app_id && (
            <button className={s.cardAction} title="Steam page"
              onClick={stop(() => window.kozo?.api?.shell?.openExternal(`https://store.steampowered.com/app/${item.steam_app_id}`))}>
              <IconBrandSteam size={14} stroke={1.8} />
            </button>
          )}
          <button className={s.cardAction} title="Move to Want to play" onClick={stop(() => onStatus(item, 'want_to_play'))}>
            <IconBookmark size={14} stroke={1.8} />
          </button>
          <button className={`${s.cardAction} ${confirm ? s.cardActionConfirm : ''}`}
            title={confirm ? 'Click again to untrack' : 'Untrack'}
            onMouseLeave={() => setConfirm(false)}
            onClick={stop(() => (confirm ? onUntrack(item) : setConfirm(true)))}>
            <IconBookmarkOff size={14} stroke={1.8} />{confirm && <span>Untrack?</span>}
          </button>
        </div>
      </div>
      <div className={s.cardInfo}>
        <div className={s.cardName} title={item.name}>{item.name}</div>
        <div className={s.cardDate}>
          <IconCalendar size={13} stroke={1.8} />
          {item.release_date || 'Release date not announced'}
        </div>
        {genres.length > 0 && (
          <div className={s.cardGenres}>{genres.map(g => <span key={g} className={s.cardGenre}>{g}</span>)}</div>
        )}
        {progress != null && (
          <div className={s.cardWait}>
            <div className={s.cardProgress}><span style={{ width: `${progress * 100}%` }} /></div>
            <span className={s.cardWaitLabel}>{Math.round(progress * 100)}% of the wait</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Upcoming() {
  const [items, setItems] = useState(upcomingCache)
  const [detail, setDetail] = useState(null)   // { item, rel } | null
  const [tab, setTab] = useState(() => localStorage.getItem('kozo:upcoming:tab') || 'mine')
  // Ctrl + mouse wheel card size (the Steam calendar tab has its own).
  const zoomStyle = useCardZoom('upcoming', tab === 'mine' ? 'grid' : 'off', { grid: 280 })
  // Steam appids already on the Game List: appid → { id, status }. The calendar
  // marks them tracked and can untrack entries that are still Upcoming.
  const [trackedAppIds, setTrackedAppIds] = useState(() => new Map())
  const [art, setArt] = useState({})   // steam appid → real store art (steam:appAssets)

  async function loadTracked() {
    const res = await window.kozo?.api?.gameList?.list?.({ limit: 100000, offset: 0 })
    if (res?.ok) {
      setTrackedAppIds(new Map((res.data?.items || [])
        .filter(i => i.steam_app_id)
        .map(i => [Number(i.steam_app_id), { id: i.id, status: i.status }])))
    }
  }

  async function trackGame(g) {
    const res = await window.kozo?.api?.gameList?.add?.({
      name: g.name,
      steam_app_id: g.appid,
      status: 'upcoming',
      release_date: g.release || null,
    })
    if (res?.ok) { await Promise.all([load(), loadTracked()]) }
  }

  // Real hero/header art for the cards (newer titles 404 on the classic paths).
  useEffect(() => {
    const ids = (items || []).map(i => i.steam_app_id).filter(id => id && !art[id])
    if (!ids.length) return
    let alive = true
    window.kozo?.api?.steam?.appAssets?.(ids).then(res => {
      if (alive && res?.ok) setArt(prev => ({ ...prev, ...res.data }))
    })
    return () => { alive = false }
  }, [items])

  async function untrackGame(g) {
    const info = trackedAppIds.get(Number(g.appid))
    if (!info || info.status !== 'upcoming') return
    const res = await window.kozo?.api?.gameList?.delete?.(info.id)
    if (res?.ok) { await Promise.all([load(), loadTracked()]) }
  }

  // My upcoming: remove a tracked release from the Game List.
  async function untrackItem(item) {
    const res = await window.kozo?.api?.gameList?.delete?.(item.id)
    if (res?.ok) { setDetail(null); await Promise.all([load(), loadTracked()]) }
  }

  function switchTab(next) {
    setTab(next)
    try { localStorage.setItem('kozo:upcoming:tab', next) } catch {}
  }

  const tabs = (
    <div className={s.tabs} data-tour="upcoming-tabs">
      <button className={`${s.tab} ${tab === 'mine' ? s.tabActive : ''}`} onClick={() => switchTab('mine')}>My upcoming</button>
      <button className={`${s.tab} ${tab === 'steam' ? s.tabActive : ''}`} onClick={() => switchTab('steam')}>Steam calendar</button>
    </div>
  )

  async function load() {
    const res = await window.kozo?.api?.gameList?.list?.({ status: 'upcoming', limit: 1000, offset: 0 })
    if (res?.ok) {
      const nextItems = res.data?.items ?? []
      setItems(nextItems)
      upcomingCache = nextItems
    } else {
      // Never leave the first load stuck on the spinner when the read fails.
      setItems(prev => prev ?? [])
    }
  }

  useEffect(() => {
    load()
    loadTracked()
    // Warm the store-details cache (instant popups) and backfill any missing
    // release dates so long-released games can't linger in "No date yet".
    window.kozo?.api?.gameList?.refreshUpcomingInfo?.()
    // Unsubscribe THIS page's own listener only — removeAll() is window-wide
    // and would tear down the always-mounted Sidebar's listeners too.
    const off = window.kozo?.events?.onGameUpdated?.(() => { load(); loadTracked() })
    return () => off?.()
  }, [])

  async function setStatus(item, status) {
    setDetail(null)
    await window.kozo?.api?.gameList?.update?.(item.id, { status })
    load()
  }

  // First load: a ghost of the real layout, so the cards swap in without the
  // page jumping from a centred spinner to a full grid.
  if (items === null) {
    return (
      <div className={s.page}>
        <div className={s.toolbar}>
          <h1 className={s.pageTitle}><IconCalendar size={16} stroke={1.7} /> Upcoming</h1>
        </div>
        <div className={s.content}>
          <div className={s.inner}>
            <Skeleton w={130} h={11} className={s.ghostTitle} />
            <CardSkeletonGrid gridClassName={s.grid} count={6} portrait={false} />
          </div>
        </div>
      </div>
    )
  }

  const withRel = items.map(item => ({ item, rel: parseRelease(item.release_date) }))
  const now = Date.now()
  // Split on `until`, so a vague date only counts as out once its whole window
  // has passed ("June 2026" read in August is genuinely behind us), while one
  // we're still inside stays in Coming soon. Sorting an in-window entry by its
  // already-past start would pin it above games releasing in days, so those sort
  // by when the window CLOSES instead.
  const soonKey = x => (x.rel.ts > now ? x.rel.ts : x.rel.until)
  const soon = withRel.filter(x => x.rel.ts != null && x.rel.until > now).sort((a, b) => soonKey(a) - soonKey(b))
  const released = withRel.filter(x => x.rel.ts != null && x.rel.until <= now).sort((a, b) => b.rel.ts - a.rel.ts)
  const tba = withRel.filter(x => x.rel.ts == null).sort((a, b) => a.item.name.localeCompare(b.item.name))

  const sections = [
    { key: 'soon', Icon: IconCalendar, label: 'Coming soon', entries: soon },
    { key: 'out', Icon: IconConfetti, label: 'Out now. Click a game to update its status', entries: released, out: true },
    { key: 'tba', Icon: IconHelpCircle, label: 'No date yet', entries: tba },
  ].filter(sec => sec.entries.length > 0)

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}>
          <IconCalendar size={16} stroke={1.7} /> Upcoming
        </h1>
        {items.length > 0 && <span className={s.count}>{items.length}</span>}
        {tabs}
      </div>

      <div className={s.content}>
        <div className={s.inner} style={zoomStyle}>
          <ReleasedPanel onChanged={load} />
          {tab === 'steam' && <SteamCalendar trackedAppIds={trackedAppIds} onTrack={trackGame} onUntrack={untrackGame} />}

          {tab === 'mine' && items.length === 0 && (
            <EmptyState
              Icon={IconHourglassLow}
              title="No upcoming games yet"
              desc={'Track games from the Steam calendar tab, or give Game List entries the "Upcoming" status, and they\'ll line up here with release countdowns.'}
            />
          )}

          {tab === 'mine' && sections.map(sec => (
            <section key={sec.key} className={s.section}>
              <div className={`${s.sectionTitle} ${sec.out ? s.sectionTitleOut : ''}`}>
                <sec.Icon size={14} stroke={1.7} /> {sec.label}
              </div>
              <div className={s.grid}>
                {sec.entries.map(({ item, rel }) => (
                  <UpcomingCard key={item.id} item={item} rel={rel} art={art[item.steam_app_id]} onOpen={setDetail} onStatus={setStatus} onUntrack={untrackItem} />
                ))}
              </div>
            </section>
          ))}
        </div>

        {detail && (
          <DetailModal
            item={detail.item}
            art={art[detail.item.steam_app_id]}
            rel={detail.rel}
            onClose={() => setDetail(null)}
            onStatus={(status) => setStatus(detail.item, status)}
            onUntrack={() => untrackItem(detail.item)}
          />
        )}
      </div>
    </div>
  )
}
