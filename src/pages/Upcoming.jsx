import React, { useState, useEffect } from 'react'
import {
  IconCalendar, IconHourglassLow, IconConfetti, IconHelpCircle,
  IconPlayerPlayFilled, IconBookmark, IconBrandSteam,
} from '@tabler/icons-react'
import { parseGenres } from '../lib/utils'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton, CardSkeletonGrid, PanelSkeleton } from '../components/ui/Skeleton'
import s from './Upcoming.module.css'

// Persist the last working art source per game across tab switches so cards don't
// re-run fallback image probing (hero -> header -> portrait) every time.
const wideArtIndexCache = new Map()

// Keep Upcoming data hot between route changes to avoid full visual resets.
let upcomingCache = null

// Steam's release_date strings vary in precision: "13 Nov, 2025" (exact),
// "November 2025" (month), "2026" (year only), "TBA"/"Coming soon" (nothing).
// Anything short of a full date is `vague` and carries TWO instants: `ts` (the
// start of the named window — a month's 1st, or a mid-year point for year-only)
// for ordering, and `until` (the first instant past the window's end) as the
// ONLY thing that may read as released. Reading a vague `ts` as "out" faked
// "Out now" up to a month — or half a year — early.
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
// Steam writes both "November 2025" and "Winter 2026"/"Holiday 2026" in this
// shape. Date.parse quietly resolves the seasonal ones to January 1st, so they
// must be matched here and downgraded rather than trusted as a real month.
const WORD_YEAR = /^([A-Za-z]{3,9}),?\s+(\d{4})$/

function yearRelease(y, label) {
  return { ts: Date.UTC(y, 5, 30), until: Date.UTC(y + 1, 0, 1), vague: true, precision: 'year', label }
}

function parseRelease(str) {
  if (!str) return { ts: null }
  const trimmed = str.trim()
  const yearOnly = trimmed.match(/^(\d{4})$/)
  if (yearOnly) return yearRelease(parseInt(yearOnly[1], 10), trimmed)
  const wordYear = trimmed.match(WORD_YEAR)
  if (wordYear) {
    const y  = parseInt(wordYear[2], 10)
    const mi = MONTH_NAMES.indexOf(wordYear[1].slice(0, 3).toLowerCase())
    // A season names no month Steam ever defines — it's no more precise than its year.
    if (mi < 0) return yearRelease(y, trimmed)
    return {
      ts: new Date(y, mi, 1).getTime(),
      until: new Date(y, mi + 1, 1).getTime(),
      vague: true, precision: 'month', label: trimmed,
    }
  }
  const t = Date.parse(trimmed)
  if (!Number.isFinite(t)) return { ts: null }
  return { ts: t, until: t, vague: false, precision: 'day' }
}

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

// The stored banner_url is a PORTRAIT cover — wide cards want Steam's wide art.
// capsule_616x353 first: it matches the rendered card size and exists for
// virtually every store page, unreleased ones included. The old order started
// at library_hero (3840×1240) — every card decoded a wallpaper-sized bitmap,
// and unreleased games usually 404 on it, so first paint burned a failed
// request per card before the real art even started. That was the page's lag.
function wideArtSources(item) {
  const id = item.steam_app_id
  const srcs = []
  if (id) {
    srcs.push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/capsule_616x353.jpg`)
    srcs.push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`)
  }
  if (item.banner_url) srcs.push(item.banner_url)
  return srcs
}

function WideArt({ item, className }) {
  const cacheKey = item?.id ?? item?.steam_app_id ?? item?.name
  const [idx, setIdx] = useState(() => wideArtIndexCache.get(cacheKey) ?? 0)
  const srcs = wideArtSources(item)
  useEffect(() => {
    setIdx(wideArtIndexCache.get(cacheKey) ?? 0)
  }, [cacheKey])
  if (idx >= srcs.length) return null
  return (
    <img
      className={className}
      src={srcs[idx]}
      alt=""
      loading="lazy"
      decoding="async"
      onLoad={() => wideArtIndexCache.set(cacheKey, idx)}
      onError={() => setIdx((i) => {
        const next = i + 1
        wideArtIndexCache.set(cacheKey, next)
        return next
      })}
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

// ── Detail popup — richer store info, Steam link, quick status ───────────────
function DetailModal({ item, rel, onClose, onStatus }) {
  const [details, setDetails] = useState(undefined)   // undefined = loading, null = unavailable

  useEffect(() => {
    let cancelled = false
    if (item.steam_app_id) {
      window.kozo?.api?.steam?.storeDetails?.(item.steam_app_id).then(res => {
        if (!cancelled) setDetails(res?.ok ? res.data : null)
      })
    } else {
      setDetails(null)
    }
    return () => { cancelled = true }
  }, [item.id])

  const genres = details?.genres?.length ? details.genres : parseGenres(item)

  return (
    <Modal title={item.name} icon={<IconCalendar size={17} stroke={1.6} />} width={620} onClose={onClose}>
      <div className={s.detailHero}>
        <WideArt item={item} className={s.detailArt} />
        <span className={s.detailGrad} />
        <span className={`${s.badge} ${s.detailBadge} ${badgeClassFor(rel)}`}>
          {countdown(rel)}
        </span>
      </div>

      <div className={s.detailMeta}>
        {item.release_date && <span className={s.detailDate}><IconCalendar size={13} stroke={1.7} /> {item.release_date}</span>}
        {genres.length > 0 && <span className={s.detailGenres}>{genres.slice(0, 4).join(' · ')}</span>}
      </div>

      {details === undefined && <PanelSkeleton lines={3} />}
      {details?.description && <p className={s.detailDesc}>{details.description}</p>}
      {details?.developers?.length > 0 && (
        <div className={s.detailDevs}>
          By <strong>{details.developers.join(', ')}</strong>
          {details.publishers?.length > 0 && details.publishers.join() !== details.developers.join() && (
            <> · Published by {details.publishers.join(', ')}</>
          )}
        </div>
      )}
      {details === null && !item.steam_app_id && (
        <p className={`${s.detailDesc} ${s.detailDescMuted}`}>No Steam page linked for this game.</p>
      )}

      <div className={s.detailActions}>
        {item.steam_app_id && (
          <button
            className={ms.btnPrimary}
            onClick={() => window.kozo?.api?.shell?.openExternal(`https://store.steampowered.com/app/${item.steam_app_id}`)}
          >
            <IconBrandSteam size={14} stroke={1.8} /> View on Steam
          </button>
        )}
        <button className={ms.btnCancel} onClick={() => onStatus('want_to_play')}>
          <IconBookmark size={13} stroke={1.8} /> Want to play
        </button>
        <button className={ms.btnCancel} onClick={() => onStatus('playing')}>
          <IconPlayerPlayFilled size={12} /> Playing
        </button>
      </div>
    </Modal>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────
function UpcomingCard({ item, rel, onOpen }) {
  const genres = parseGenres(item)
  const sub = item.release_date || (genres.length ? genres.slice(0, 2).join(' · ') : 'To be announced')
  return (
    <button className={s.card} data-gpnav="" onClick={() => onOpen({ item, rel })}>
      <WideArt item={item} className={s.cardArt} />
      <span className={s.cardGrad} />
      <span className={`${s.badge} ${badgeClassFor(rel)}`}>{countdown(rel)}</span>
      <div className={s.cardBody}>
        <div className={s.cardName} title={item.name}>{item.name}</div>
        <div className={s.cardSub} title={sub}>{sub}</div>
      </div>
    </button>
  )
}

export default function Upcoming() {
  const [items, setItems] = useState(upcomingCache)
  const [detail, setDetail] = useState(null)   // { item, rel } | null

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
    // Warm the store-details cache (instant popups) and backfill any missing
    // release dates so long-released games can't linger in "No date yet".
    window.kozo?.api?.gameList?.refreshUpcomingInfo?.()
    // Unsubscribe THIS page's own listener only — removeAll() is window-wide
    // and would tear down the always-mounted Sidebar's listeners too.
    const off = window.kozo?.events?.onGameUpdated?.(load)
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
    { key: 'out', Icon: IconConfetti, label: 'Out now — click a game to update its status', entries: released, out: true },
    { key: 'tba', Icon: IconHelpCircle, label: 'No date yet', entries: tba },
  ].filter(sec => sec.entries.length > 0)

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}>
          <IconCalendar size={16} stroke={1.7} /> Upcoming
        </h1>
        {items.length > 0 && <span className={s.count}>{items.length}</span>}
      </div>

      <div className={s.content}>
        <div className={s.inner}>
          {items.length === 0 && (
            <EmptyState
              Icon={IconHourglassLow}
              title="No upcoming games yet"
              desc={'Add games to your Game List with the "Upcoming" status and they\'ll line up here with release countdowns.'}
            />
          )}

          {sections.map(sec => (
            <section key={sec.key} className={s.section}>
              <div className={`${s.sectionTitle} ${sec.out ? s.sectionTitleOut : ''}`}>
                <sec.Icon size={14} stroke={1.7} /> {sec.label}
              </div>
              <div className={s.grid}>
                {sec.entries.map(({ item, rel }) => (
                  <UpcomingCard key={item.id} item={item} rel={rel} onOpen={setDetail} />
                ))}
              </div>
            </section>
          ))}
        </div>

        {detail && (
          <DetailModal
            item={detail.item}
            rel={detail.rel}
            onClose={() => setDetail(null)}
            onStatus={(status) => setStatus(detail.item, status)}
          />
        )}
      </div>
    </div>
  )
}
