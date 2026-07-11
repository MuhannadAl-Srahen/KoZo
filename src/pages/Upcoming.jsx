import React, { useState, useEffect } from 'react'
import {
  IconCalendar, IconLoader2, IconHourglassLow, IconConfetti, IconHelpCircle,
  IconExternalLink, IconPlayerPlayFilled, IconBookmark, IconBrandSteam,
} from '@tabler/icons-react'
import { parseGenres } from '../lib/utils'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
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
    return { ts: Date.UTC(y, 5, 30), vague: true, label: trimmed }
  }
  const t = Date.parse(trimmed)
  return Number.isFinite(t) ? { ts: t, vague: false } : { ts: null }
}

function countdown(rel) {
  if (!rel || rel.ts == null) return 'No date'
  if (rel.vague) return rel.label
  const days = Math.ceil((rel.ts - Date.now()) / 86400000)
  if (days <= 0) return 'Out now'
  if (days === 1) return 'Tomorrow'
  if (days < 31) return `in ${days} days`
  const months = Math.round(days / 30.4)
  if (months < 13) return `in ~${months} month${months === 1 ? '' : 's'}`
  return `in ~${(days / 365).toFixed(1)} years`
}

// The stored banner_url is a PORTRAIT cover — wide cards want Steam's wide art:
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

function badgeClassFor(rel) {
  if (!rel || rel.ts == null) return s.badgeTba
  if (rel.ts <= Date.now()) return s.badgeOut
  if (!rel.vague && rel.ts - Date.now() < 31 * 86400000) return s.badgeSoon
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
        <span className={`${s.badge} ${badgeClassFor(rel)}`} style={{ position: 'absolute', top: 10, right: 10 }}>
          {countdown(rel)}
        </span>
      </div>

      <div className={s.detailMeta}>
        {item.release_date && <span className={s.detailDate}><IconCalendar size={13} stroke={1.7} /> {item.release_date}</span>}
        {genres.length > 0 && <span className={s.detailGenres}>{genres.slice(0, 4).join(' · ')}</span>}
      </div>

      {details === undefined && (
        <div className={s.detailLoading}><IconLoader2 size={15} className="spin" /> Loading store info…</div>
      )}
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
        <p className={s.detailDesc} style={{ color: 'var(--text-muted)' }}>No Steam page linked for this game.</p>
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
  return (
    <button className={s.card} onClick={() => onOpen({ item, rel })}>
      <WideArt item={item} className={s.cardArt} />
      <span className={s.cardGrad} />
      <span className={`${s.badge} ${badgeClassFor(rel)}`}>{countdown(rel)}</span>
      <div className={s.cardBody}>
        <div className={s.cardName}>{item.name}</div>
        <div className={s.cardSub}>
          {item.release_date || (genres.length ? genres.slice(0, 2).join(' · ') : 'To be announced')}
        </div>
      </div>
    </button>
  )
}

export default function Upcoming() {
  const [items, setItems] = useState(null)
  const [detail, setDetail] = useState(null)   // { item, rel } | null

  async function load() {
    const res = await window.kozo?.api?.gameList?.list?.({ status: 'upcoming', limit: 1000, offset: 0 })
    if (res?.ok) setItems(res.data?.items ?? [])
  }

  useEffect(() => {
    load()
    // Warm the store-details cache (instant popups) and backfill any missing
    // release dates so long-released games can't linger in "No date yet".
    window.kozo?.api?.gameList?.refreshUpcomingInfo?.()
    window.kozo?.events?.onGameUpdated?.(load)
    return () => window.kozo?.events?.removeAll?.('game:updated')
  }, [])

  async function setStatus(item, status) {
    setDetail(null)
    await window.kozo?.api?.gameList?.update?.(item.id, { status })
    load()
  }

  if (items === null) {
    return <div className={s.page}><div className={s.loading}><IconLoader2 size={20} className="spin" /></div></div>
  }

  const withRel = items.map(item => ({ item, rel: parseRelease(item.release_date) }))
  const soon = withRel.filter(x => x.rel.ts != null && x.rel.ts > Date.now()).sort((a, b) => a.rel.ts - b.rel.ts)
  const released = withRel.filter(x => x.rel.ts != null && x.rel.ts <= Date.now()).sort((a, b) => b.rel.ts - a.rel.ts)
  const tba = withRel.filter(x => x.rel.ts == null).sort((a, b) => a.item.name.localeCompare(b.item.name))

  const sections = [
    { key: 'soon', Icon: IconCalendar, label: 'Coming soon', entries: soon },
    { key: 'out', Icon: IconConfetti, label: 'Out now — click a game to update its status', entries: released, out: true },
    { key: 'tba', Icon: IconHelpCircle, label: 'No date yet', entries: tba },
  ].filter(sec => sec.entries.length > 0)

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
