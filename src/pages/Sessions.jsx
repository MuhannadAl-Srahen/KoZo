import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  IconHistory, IconTrophy, IconDeviceGamepad2, IconClock, IconFilterOff,
} from '@tabler/icons-react'
import { getBannerBg, formatPlaytime, fileUrl, localDayKey } from '../lib/utils'
import SearchableSelect from '../components/ui/SearchableSelect'
import EmptyState from '../components/ui/EmptyState'
import { RowSkeleton } from '../components/ui/Skeleton'
import s from './Sessions.module.css'

const PAGE_SIZE = 60

function sessionTimeRange(startedAt, durationSeconds) {
  const start = new Date(startedAt)
  const end   = new Date(start.getTime() + (durationSeconds || 0) * 1000)
  const fmt   = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${fmt(start)} – ${fmt(end)}`
}

function dayLabel(dateStr) {
  const y = new Date()
  y.setDate(y.getDate() - 1)          // setDate, not -86400000: DST-safe
  const today     = localDayKey()
  const yesterday = localDayKey(y)
  if (dateStr === today)     return 'Today'
  if (dateStr === yesterday) return 'Yesterday'
  const d = new Date(dateStr + 'T12:00:00')
  const isThisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString([], isThisYear
    ? { weekday: 'long', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
}

// Blurred-fill thumbnail: the cover is CONTAINED over a blurred copy of itself,
// so a landscape header and a 2:3 portrait both sit in the same box uncropped.
// Local file first, remote banner_url as the fallback (e.g. right after a backup
// restore, when the cached file is gone but the URL still resolves).
function SessionThumb({ session }) {
  const chain = [
    session.banner_local_path ? fileUrl(session.banner_local_path) : null,
    session.banner_url || null,
  ].filter(Boolean)

  const [step, setStep] = useState(0)
  const src = chain[step] || null
  // Both <img>s carry the same src, so a broken image fires onError twice for
  // the same URL. Without this guard the second one would skip the remote
  // fallback entirely and blank a thumbnail that would have loaded.
  const handledRef = useRef(null)

  function handleError() {
    if (handledRef.current === src) return
    handledRef.current = src
    setStep(i => i + 1)
  }

  return (
    <div className={s.thumb} style={{ background: getBannerBg(session.game_id) }}>
      <IconDeviceGamepad2 size={16} stroke={1.4} style={{ color: 'var(--on-art-muted)', zIndex: 0 }} />
      {src && (
        <>
          <img className={s.thumbBlur} src={src} alt="" aria-hidden="true"
            loading="lazy" decoding="async" onError={handleError} />
          <img className={s.thumbImg} src={src} alt="" loading="lazy" decoding="async" onError={handleError} />
        </>
      )}
    </div>
  )
}

export default function Sessions() {
  const [sessions, setSessions]   = useState([])
  const [games, setGames]         = useState([])
  const [gameId, setGameId]       = useState('')
  const [fromDate, setFromDate]   = useState('')
  const [toDate, setToDate]       = useState('')
  const [offset, setOffset]       = useState(0)
  const [hasMore, setHasMore]     = useState(false)
  const [loading, setLoading]     = useState(true)

  async function loadGames() {
    const res = await window.kozo?.api?.games?.list()
    if (res?.ok) setGames(res.data ?? [])
  }

  const load = useCallback(async (reset = true, gId = gameId, from = fromDate, to = toDate) => {
    if (!window.kozo?.api) return
    setLoading(true)
    const currentOffset = reset ? 0 : offset
    const filters = { limit: PAGE_SIZE + 1, offset: currentOffset }
    if (gId)  filters.gameId = Number(gId)
    // The date inputs are LOCAL days; started_at is a UTC ISO string compared
    // lexicographically in SQL, so send UTC instants for the local day bounds.
    if (from) filters.from = new Date(from + 'T00:00:00').toISOString()
    if (to)   filters.to = new Date(to + 'T23:59:59.999').toISOString()
    const res = await window.kozo.api.sessions.list(filters)
    if (res?.ok) {
      const all  = res.data ?? []
      const more = all.length > PAGE_SIZE
      const items = more ? all.slice(0, PAGE_SIZE) : all
      if (reset) { setSessions(items); setOffset(items.length) }
      else       { setSessions(prev => [...prev, ...items]); setOffset(prev => prev + items.length) }
      setHasMore(more)
    }
    setLoading(false)
  }, [gameId, fromDate, toDate, offset])

  useEffect(() => { loadGames(); load(true, '', '', '') }, [])

  function handleGameFilter(v) { setGameId(v);    setOffset(0); load(true, v, fromDate, toDate) }
  function handleFromDate(v)   { setFromDate(v);  setOffset(0); load(true, gameId, v, toDate) }
  function handleToDate(v)     { setToDate(v);    setOffset(0); load(true, gameId, fromDate, v) }

  const filtered = !!(gameId || fromDate || toDate)

  function clearFilters() {
    setGameId(''); setFromDate(''); setToDate(''); setOffset(0)
    load(true, '', '', '')
  }

  // Summary stats
  const totalPlaytime = sessions.reduce((a, s) => a + (s.duration_seconds || 0), 0)
  const totalAchs     = sessions.reduce((a, s) => a + (s.achievements_unlocked || 0), 0)

  // Group by date
  const groups = sessions.reduce((acc, session) => {
    const day = localDayKey(session.started_at)
    if (!acc[day]) acc[day] = []
    acc[day].push(session)
    return acc
  }, {})
  const sortedDays = Object.keys(groups).sort((a, b) => b.localeCompare(a))

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}>Sessions</h1>
        <div className={s.filters}>
          {/* The wrapper exists only to carry the focus ring around the whole
              control — the trigger inside draws its own border. */}
          <div className={`${s.selectWrap} hasRing`}>
            <SearchableSelect
              value={gameId}
              onChange={handleGameFilter}
              placeholder="All games"
              width={170}
              options={games.map(g => ({ value: String(g.id), label: g.name }))}
            />
          </div>
          <div className={`${s.dateWrap} hasRing`}>
            <input
              type="date"
              className={s.dateInput}
              aria-label="Sessions from date"
              title="Sessions from date"
              value={fromDate}
              onChange={e => handleFromDate(e.target.value)}
            />
          </div>
          {/* Decorative: each field names its own end of the range, so the
              separator carries no meaning of its own and is hidden from AT. */}
          <span className={s.dateSep} aria-hidden="true">to</span>
          <div className={`${s.dateWrap} hasRing`}>
            <input
              type="date"
              className={s.dateInput}
              aria-label="Sessions to date"
              title="Sessions to date"
              value={toDate}
              onChange={e => handleToDate(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className={s.content}>
        <div className={s.inner}>
          {/* Summary strip */}
          {sessions.length > 0 && (
            <div className={s.summaryStrip}>
              <div className={s.summaryItem}>
                <span className={s.summaryValue}>{sessions.length}{hasMore ? '+' : ''}</span>
                <span className={s.summaryLabel}>sessions</span>
              </div>
              <div className={s.summaryDivider} />
              <div className={s.summaryItem}>
                <span className={s.summaryValue}>{formatPlaytime(totalPlaytime)}</span>
                <span className={s.summaryLabel}>total playtime</span>
              </div>
              {totalAchs > 0 && (
                <>
                  <div className={s.summaryDivider} />
                  <div className={s.summaryItem}>
                    <span className={s.summaryValue}>{totalAchs}</span>
                    <span className={s.summaryLabel}>achievements</span>
                  </div>
                </>
              )}
            </div>
          )}

          {loading && sessions.length === 0 && <RowSkeleton count={7} height={85} />}

          {!loading && sessions.length === 0 && (
            <EmptyState
              Icon={IconHistory}
              title="No sessions found"
              desc={filtered
                ? 'No sessions match the current filters.'
                : 'Sessions are recorded automatically when KoZo detects a game running.'}
              action={filtered ? { label: 'Clear filters', onClick: clearFilters, Icon: IconFilterOff } : undefined}
            />
          )}

          {/* Timeline groups */}
          {sortedDays.map(day => {
            const daySessions = groups[day]
            const dayPlaytime = daySessions.reduce((a, x) => a + (x.duration_seconds || 0), 0)
            return (
              <div key={day} className={s.dayGroup}>
                <div className={s.dayHeader}>
                  <span className={s.dayLabel}>{dayLabel(day)}</span>
                  <span className={s.dayTotal}>{formatPlaytime(dayPlaytime)}</span>
                </div>

                <div className={s.dayRows}>
                  {daySessions.map(session => (
                    <div key={session.id} className={s.sessionRow}>
                      <SessionThumb session={session} />

                      {/* Game + time range */}
                      <div className={s.sessionInfo}>
                        <div className={s.sessionGame} title={session.game_name}>{session.game_name}</div>
                        <div className={s.sessionTime}>{sessionTimeRange(session.started_at, session.duration_seconds)}</div>
                      </div>

                      {/* Duration */}
                      <div className={s.sessionDur} title="Session length">
                        <IconClock size={12} stroke={1.5} />
                        {formatPlaytime(session.duration_seconds) || '—'}
                      </div>

                      {/* Achievements */}
                      <div
                        className={`${s.sessionAch} ${session.achievements_unlocked > 0 ? s.sessionAchHas : ''}`}
                        title={`${session.achievements_unlocked || 0} achievement${session.achievements_unlocked === 1 ? '' : 's'} unlocked`}
                      >
                        <IconTrophy size={12} stroke={1.5} />
                        {session.achievements_unlocked > 0 ? session.achievements_unlocked : '—'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {hasMore && (
            <div className={s.loadMore}>
              <button
                type="button"
                className={`${s.loadMoreBtn} ${loading ? s.loadMoreBtnBusy : ''}`}
                aria-busy={loading}
                onClick={() => load(false)}
              >
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
