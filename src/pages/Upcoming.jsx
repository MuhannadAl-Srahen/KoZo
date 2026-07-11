import React, { useState, useEffect } from 'react'
import {
  IconCalendar, IconLoader2, IconHourglassLow, IconConfetti, IconHelpCircle,
  IconExternalLink, IconPlayerPlayFilled, IconBookmark,
} from '@tabler/icons-react'
import { parseGenres } from '../lib/utils'
import s from './Upcoming.module.css'

// Steam's release_date strings vary in precision: "13 Nov, 2025" (exact),
// "November 2025" (month), "2026" (year only), "TBA"/"Coming soon" (nothing).
// Year-only must NOT be treated as Jan 1st — that faked "Out now!" for games
// that are a year away.
function parseRelease(str) {
  if (!str) return { ts: null }
  const trimmed = str.trim()
  const yearOnly = trimmed.match(/^(\d{4})$/)
  if (yearOnly) {
    const y = parseInt(yearOnly[1], 10)
    // Sort within its year (mid-year anchor), display just the year.
    return { ts: Date.UTC(y, 5, 30), vague: true, label: trimmed }
  }
  const t = Date.parse(trimmed)
  return Number.isFinite(t) ? { ts: t, vague: false } : { ts: null }
}

function countdown(rel) {
  if (rel.ts == null) return 'TBA'
  if (rel.vague) return rel.label
  const days = Math.ceil((rel.ts - Date.now()) / 86400000)
  if (days <= 0) return 'Out now'
  if (days === 1) return 'Tomorrow'
  if (days < 31) return `in ${days} days`
  const months = Math.round(days / 30.4)
  if (months < 13) return `in ~${months} month${months === 1 ? '' : 's'}`
  return `in ~${(days / 365).toFixed(1)} years`
}

// Timeline group label: "October 2026" for precise dates, "2027" for year-only.
function groupLabel(rel) {
  if (rel.vague) return rel.label
  return new Date(rel.ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function openStore(item) {
  if (item.steam_app_id) {
    window.kozo?.api?.shell?.openExternal(`https://store.steampowered.com/app/${item.steam_app_id}`)
  }
}

// The stored banner_url is a PORTRAIT cover (600×900) — stretched across a wide
// strip it shows a warped slice. Wide cards want Steam's wide art instead:
// library_hero (3840×1240) → header (460×215) → portrait as a last resort.
function wideArtSources(item) {
  const id = item.steam_app_id
  const srcs = []
  if (id) {
    srcs.push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/library_hero.jpg`)
    srcs.push(`https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`)
  }
  if (item.banner_url) srcs.push(item.banner_url)
  return srcs
}

function WideArt({ item, className }) {
  const [idx, setIdx] = useState(0)
  const srcs = wideArtSources(item)
  if (idx >= srcs.length) return null
  return <img className={className} src={srcs[idx]} alt="" onError={() => setIdx(i => i + 1)} />
}

// Wide banner-strip row — wide cover art as the card background.
function StripCard({ item, rel, actions }) {
  const genres = parseGenres(item)
  return (
    <div className={s.stripCard} onClick={() => openStore(item)} role="button" tabIndex={0}>
      <WideArt item={item} className={s.stripArt} />
      <span className={s.stripGrad} />
      <div className={s.stripInfo}>
        <div className={s.stripName}>{item.name}</div>
        {genres.length > 0 && <div className={s.stripGenres}>{genres.slice(0, 3).join(' · ')}</div>}
      </div>
      {actions ? (
        <div className={s.statusActions} onClick={e => e.stopPropagation()}>
          <button className={s.actionBtn} title="Move to Want to play" onClick={() => actions('want_to_play')}>
            <IconBookmark size={12} stroke={1.8} /> Want to play
          </button>
          <button className={s.actionBtn} title="Move to Playing" onClick={() => actions('playing')}>
            <IconPlayerPlayFilled size={11} /> Playing
          </button>
        </div>
      ) : (
        <div className={s.stripWhen}>
          <span className={s.stripCountdown}>{rel ? countdown(rel) : 'TBA'}</span>
          {(() => {
            const sub = item.release_date || 'To be announced'
            const main = rel ? countdown(rel) : 'TBA'
            return sub !== main ? <span className={s.stripDate}>{sub}</span> : null
          })()}
        </div>
      )}
      {item.steam_app_id && <IconExternalLink size={13} stroke={1.7} className={s.stripLink} />}
    </div>
  )
}

export default function Upcoming() {
  const [items, setItems] = useState(null)
  const [moving, setMoving] = useState(false)

  async function load() {
    const res = await window.kozo?.api?.gameList?.list?.({ status: 'upcoming', limit: 1000, offset: 0 })
    if (res?.ok) setItems(res.data?.items ?? [])
  }

  useEffect(() => {
    load()
    window.kozo?.events?.onGameUpdated?.(load)
    return () => window.kozo?.events?.removeAll?.('game:updated')
  }, [])

  async function setStatus(item, status) {
    await window.kozo?.api?.gameList?.update?.(item.id, { status })
    load()
  }

  async function moveAll(list) {
    setMoving(true)
    for (const { item } of list) {
      await window.kozo?.api?.gameList?.update?.(item.id, { status: 'want_to_play' })
    }
    setMoving(false)
    load()
  }

  if (items === null) {
    return <div className={s.page}><div className={s.loading}><IconLoader2 size={20} className="spin" /></div></div>
  }

  const withRel = items.map(item => ({ item, rel: parseRelease(item.release_date) }))
  const future = withRel
    .filter(x => x.rel.ts != null && x.rel.ts > Date.now())
    .sort((a, b) => a.rel.ts - b.rel.ts)
  const released = withRel
    .filter(x => x.rel.ts != null && x.rel.ts <= Date.now())
    .sort((a, b) => b.rel.ts - a.rel.ts)
  const tba = withRel
    .filter(x => x.rel.ts == null)
    .sort((a, b) => a.item.name.localeCompare(b.item.name))

  const featured = future[0] || null
  const rest = future.slice(1)

  // Chronological month/year groups for everything after the featured one.
  const groups = []
  for (const entry of rest) {
    const label = groupLabel(entry.rel)
    const g = groups[groups.length - 1]
    if (g && g.label === label) g.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }

  const featuredGenres = featured ? parseGenres(featured.item) : []

  return (
    <div className={s.page}>
      <div className={s.scroll}>
        <h1 className={s.title}>
          <IconCalendar size={20} stroke={1.7} /> Upcoming
          {items.length > 0 && <span className={s.count}>{items.length}</span>}
        </h1>

        {items.length === 0 && (
          <div className={s.empty}>
            <IconHourglassLow size={40} stroke={1.2} />
            <div>No upcoming games yet.</div>
            <div className={s.emptySub}>Add games to your Game List with the "Upcoming" status and they'll line up here with release countdowns.</div>
          </div>
        )}

        {/* NEXT UP — the soonest dated release, big */}
        {featured && (
          <div className={s.featured} onClick={() => openStore(featured.item)} role="button" tabIndex={0}>
            <WideArt item={featured.item} className={s.featuredArt} />
            <span className={s.featuredGrad} />
            <div className={s.featuredBody}>
              <div className={s.featuredTag}>Next up</div>
              <div className={s.featuredName}>{featured.item.name}</div>
              {featuredGenres.length > 0 && <div className={s.featuredGenres}>{featuredGenres.slice(0, 3).join(' · ')}</div>}
            </div>
            <div className={s.featuredWhen}>
              <div className={s.featuredCountdown}>{countdown(featured.rel)}</div>
              {featured.item.release_date !== countdown(featured.rel) && (
                <div className={s.featuredDate}>{featured.item.release_date}</div>
              )}
            </div>
          </div>
        )}

        {/* Timeline */}
        {groups.length > 0 && (
          <div className={s.timeline}>
            {groups.map(g => (
              <div key={g.label} className={s.timelineGroup}>
                <div className={s.groupHeader}><span className={s.groupDot} />{g.label}</div>
                <div className={s.groupRows}>
                  {g.entries.map(({ item, rel }) => <StripCard key={item.id} item={item} rel={rel} />)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Out now — released, still marked upcoming → one-click status update */}
        {released.length > 0 && (
          <div className={s.timeline}>
            <div className={s.timelineGroup}>
              <div className={`${s.groupHeader} ${s.groupHeaderOut}`}>
                <span className={`${s.groupDot} ${s.groupDotOut}`} />
                <IconConfetti size={13} stroke={1.8} /> Out now — update their status
                <button className={s.moveAllBtn} disabled={moving} onClick={() => moveAll(released)}>
                  {moving ? 'Moving…' : 'Move all to Want to play'}
                </button>
              </div>
              <div className={s.groupRows}>
                {released.map(({ item }) => (
                  <StripCard key={item.id} item={item} actions={(status) => setStatus(item, status)} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TBA */}
        {tba.length > 0 && (
          <div className={s.timeline}>
            <div className={s.timelineGroup}>
              <div className={s.groupHeader}>
                <span className={s.groupDot} />
                <IconHelpCircle size={13} stroke={1.8} /> No date yet
              </div>
              <div className={s.groupRows}>
                {tba.map(({ item }) => <StripCard key={item.id} item={item} rel={null} />)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
