import React, { useState, useEffect, useCallback } from 'react'
import { IconHistory, IconTrophy, IconDeviceGamepad2, IconClock } from '@tabler/icons-react'
import { getBannerBg, formatPlaytime, fileUrl } from '../lib/utils'
import SearchableSelect from '../components/ui/SearchableSelect'
import s from './Sessions.module.css'

const PAGE_SIZE = 60

function sessionTimeRange(startedAt, durationSeconds) {
  const start = new Date(startedAt)
  const end   = new Date(start.getTime() + (durationSeconds || 0) * 1000)
  const fmt   = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${fmt(start)} – ${fmt(end)}`
}

function dayLabel(dateStr) {
  const today     = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  if (dateStr === today)     return 'Today'
  if (dateStr === yesterday) return 'Yesterday'
  const d = new Date(dateStr + 'T12:00:00')
  const isThisYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString([], isThisYear
    ? { weekday: 'long', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
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
    if (from) filters.from = from
    if (to)   filters.to = to + 'T23:59:59'
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

  // Summary stats
  const totalPlaytime = sessions.reduce((a, s) => a + (s.duration_seconds || 0), 0)
  const totalAchs     = sessions.reduce((a, s) => a + (s.achievements_unlocked || 0), 0)

  // Group by date
  const groups = sessions.reduce((acc, session) => {
    const day = session.started_at.slice(0, 10)
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
          <SearchableSelect
            value={gameId}
            onChange={handleGameFilter}
            placeholder="All games"
            width={170}
            options={games.map(g => ({ value: String(g.id), label: g.name }))}
          />
          <input type="date" className={s.dateInput} value={fromDate} onChange={e => handleFromDate(e.target.value)} />
          <span className={s.dateSep}>→</span>
          <input type="date" className={s.dateInput} value={toDate} onChange={e => handleToDate(e.target.value)} />
        </div>
      </div>

      <div className={s.content}>
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

        {loading && sessions.length === 0 && (
          <div className={s.emptyState}>Loading…</div>
        )}

        {!loading && sessions.length === 0 && (
          <div className={s.emptyState}>
            <IconHistory size={44} stroke={1.2} />
            <div className={s.emptyTitle}>No sessions found</div>
            <div className={s.emptyHint}>
              {gameId || fromDate || toDate
                ? 'Try clearing the filters.'
                : 'Sessions are recorded automatically when KoZo detects a game running.'}
            </div>
          </div>
        )}

        {/* Timeline groups */}
        {sortedDays.map(day => {
          const daySessions = groups[day]
          const dayPlaytime = daySessions.reduce((a, s) => a + (s.duration_seconds || 0), 0)
          return (
            <div key={day} className={s.dayGroup}>
              <div className={s.dayHeader}>
                <span className={s.dayLabel}>{dayLabel(day)}</span>
                <span className={s.dayTotal}>{formatPlaytime(dayPlaytime)}</span>
              </div>

              <div className={s.dayRows}>
                {daySessions.map(session => {
                  const bg = getBannerBg(session.game_id)
                  return (
                    <div key={session.id} className={s.sessionRow}>
                      {/* Thumbnail — local file first, remote banner_url if the
                          file is missing (e.g. right after a backup restore) */}
                      <div className={s.thumb} style={{ background: bg }}>
                        {(session.banner_local_path || session.banner_url)
                          ? <img
                              src={session.banner_local_path ? fileUrl(session.banner_local_path) : session.banner_url}
                              alt=""
                              onError={e => {
                                const img = e.target
                                if (session.banner_local_path && session.banner_url && !img.dataset.fallbackTried) {
                                  img.dataset.fallbackTried = '1'
                                  img.src = session.banner_url
                                  return
                                }
                                img.style.display = 'none'
                              }}
                            />
                          : <IconDeviceGamepad2 size={16} stroke={1.4} style={{ color: 'rgba(255,255,255,0.2)' }} />
                        }
                      </div>

                      {/* Game + time range */}
                      <div className={s.sessionInfo}>
                        <div className={s.sessionGame}>{session.game_name}</div>
                        <div className={s.sessionTime}>{sessionTimeRange(session.started_at, session.duration_seconds)}</div>
                      </div>

                      {/* Duration */}
                      <div className={s.sessionDur}>
                        <IconClock size={12} stroke={1.5} />
                        {formatPlaytime(session.duration_seconds) || '—'}
                      </div>

                      {/* Achievements */}
                      <div className={`${s.sessionAch} ${session.achievements_unlocked > 0 ? s.sessionAchHas : ''}`}>
                        <IconTrophy size={12} stroke={1.5} />
                        {session.achievements_unlocked > 0 ? session.achievements_unlocked : '—'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {hasMore && (
          <div className={s.loadMore}>
            <button className={s.loadMoreBtn} onClick={() => load(false)} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
