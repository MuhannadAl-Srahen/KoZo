import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  IconTrophy, IconClock, IconHistory, IconDeviceGamepad2, IconFlame, IconLoader2, IconX,
} from '@tabler/icons-react'
import { formatPlaytime } from '../lib/utils'
import s from './Statistics.module.css'

const PERIODS = [
  { key: '1d',  label: '24h' },
  { key: '7d',  label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
]

// Build the day array for the chart. Each period maps to a fixed window of daily
// columns; 'all' spans from the first data point to today (capped) so it reads as
// a real timeline without hundreds of empty bars.
function buildDays(period, data) {
  const byDay = Object.fromEntries((data || []).map(d => [d.day, d.seconds]))
  const todayMs = Date.now()

  let count
  if (period === 'all') {
    const span = data?.length
      ? Math.ceil((todayMs - new Date(data[0].day + 'T12:00:00').getTime()) / 86400000) + 1
      : 0
    count = Math.min(Math.max(span, 14), 120)
  } else {
    // 24h & 7d → one week of context; 30d → a month.
    count = period === '30d' ? 30 : 7
  }

  const result = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(todayMs - i * 86400000)
    const key = d.toISOString().slice(0, 10)
    result.push({ day: key, seconds: byDay[key] || 0 })
  }
  return result
}

// All-time view → one bar PER MONTH (trailing 12 months) so the axis reads as
// real month names (Jan, Feb, …) instead of a sea of day bars.
function buildMonths(data) {
  const byMonth = {}
  for (const d of (data || [])) {
    const key = (d.day || '').slice(0, 7)   // YYYY-MM
    if (key) byMonth[key] = (byMonth[key] || 0) + (d.seconds || 0)
  }
  const now = new Date()
  const result = []
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
    result.push({ key, monthIdx: dt.getMonth(), year: dt.getFullYear(), seconds: byMonth[key] || 0 })
  }
  return result
}

const WEEKDAY_2 = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const WEEKDAY_1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS    = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW       = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function prettyDay(key) {
  const d = new Date(key + 'T12:00:00')
  return `${DOW[d.getDay()]}, ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}
function prettyShort(key) {
  const d = new Date(key + 'T12:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

// Daily bars (7d / 30d / all). Clicking a bar selects that day so the sections
// below re-scope to it. Hover/selection highlight the BAR itself, not a box.
// Label mode is by PERIOD so it's predictable: 7d → 2-letter weekday on every bar,
// 30d → 1-letter weekday on every bar (fits 30 cols, same "every day shows" feel),
// all → month abbrev at each month boundary.
function DailyChart({ data, period, selectedDay, onSelectDay }) {
  // All-time → monthly bars (display-only) so the axis shows month names.
  if (period === 'all') {
    const months = buildMonths(data)
    const maxSec  = Math.max(...months.map(m => m.seconds), 1)
    const curKey  = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    return (
      <div className={s.chartWrap}>
        <div className={s.chart}>
          {months.map(m => {
            const pct     = m.seconds > 0 ? Math.max((m.seconds / maxSec) * 100, 6) : 0
            const hasData = m.seconds > 0
            const isNow   = m.key === curKey
            return (
              <div key={m.key} className={s.chartCol}
                title={`${MONTHS[m.monthIdx]} ${m.year} — ${formatPlaytime(m.seconds) || 'No activity'}`}>
                <div className={s.chartBarArea}>
                  <div className={[s.chartBar, hasData ? '' : s.chartBarEmpty, isNow ? s.chartBarToday : ''].join(' ')}
                    style={{ height: hasData ? `${pct}%` : undefined }} />
                </div>
                <div className={`${s.chartLabel} ${isNow ? s.chartLabelToday : ''}`}>{MONTHS[m.monthIdx]}</div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const days     = buildDays(period, data)
  const maxSec   = Math.max(...days.map(d => d.seconds), 1)
  const today    = new Date().toISOString().slice(0, 10)
  const labelMode = period === '30d' ? 'wd1' : 'wd2'

  return (
    <div className={s.chartWrap}>
      <div className={s.chart}>
        {days.map((d, idx) => {
          const dt      = new Date(d.day + 'T12:00:00')
          const pct     = d.seconds > 0 ? Math.max((d.seconds / maxSec) * 100, 6) : 0
          const isToday = d.day === today
          const isSel   = d.day === selectedDay
          const hasData = d.seconds > 0

          let label = ''
          if (labelMode === 'wd2') {
            label = WEEKDAY_2[dt.getDay()]
          } else if (labelMode === 'wd1') {
            label = WEEKDAY_1[dt.getDay()]
          } else {
            const prev = idx > 0 ? new Date(days[idx - 1].day + 'T12:00:00') : null
            if (!prev || prev.getMonth() !== dt.getMonth()) label = MONTHS[dt.getMonth()]
          }

          return (
            <button
              type="button"
              key={d.day}
              className={s.chartCol}
              title={`${prettyDay(d.day)} — ${formatPlaytime(d.seconds) || 'No activity'}`}
              onClick={() => onSelectDay(isSel ? null : d.day)}
            >
              <div className={s.chartBarArea}>
                <div
                  className={[
                    s.chartBar,
                    hasData ? '' : s.chartBarEmpty,
                    isToday ? s.chartBarToday : '',
                    isSel ? s.chartBarSel : '',
                  ].join(' ')}
                  style={{ height: hasData ? `${pct}%` : undefined }}
                />
              </div>
              <div className={`${s.chartLabel} ${isToday ? s.chartLabelToday : ''} ${isSel ? s.chartLabelSel : ''}`}>
                {label}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const HOUR_LABELS = { 0: '12am', 6: '6am', 12: '12pm', 18: '6pm', 23: '11pm' }
function fmtHour(h) {
  const am = h < 12
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${am ? 'am' : 'pm'}`
}
function hourSeconds(data, hour) {
  return (data || []).find(d => d.hour === hour)?.seconds || 0
}

// 24h view → real hour-by-hour bars of today (not a single lonely day bar).
// Bars are clickable like the daily view; clicking highlights an hour (caption
// shows in the section header).
function HourlyChart({ data, selectedHour, onSelectHour }) {
  const byHour  = Object.fromEntries((data || []).map(d => [d.hour, d.seconds]))
  const hours   = Array.from({ length: 24 }, (_, h) => ({ hour: h, seconds: byHour[h] || 0 }))
  const maxSec  = Math.max(...hours.map(h => h.seconds), 1)
  const nowHour = new Date().getHours()

  return (
    <div className={s.chartWrap}>
      <div className={s.chart}>
        {hours.map(h => {
          const pct     = h.seconds > 0 ? Math.max((h.seconds / maxSec) * 100, 6) : 0
          const hasData = h.seconds > 0
          const isNow   = h.hour === nowHour
          const isSel   = h.hour === selectedHour
          return (
            <button
              type="button"
              key={h.hour}
              className={s.chartCol}
              title={`${fmtHour(h.hour)} — ${formatPlaytime(h.seconds) || 'No activity'}`}
              onClick={() => onSelectHour(isSel ? null : h.hour)}
            >
              <div className={s.chartBarArea}>
                <div
                  className={[s.chartBar, hasData ? '' : s.chartBarEmpty, isNow ? s.chartBarToday : '', isSel ? s.chartBarSel : ''].join(' ')}
                  style={{ height: hasData ? `${pct}%` : undefined }}
                />
              </div>
              <div className={`${s.chartLabel} ${isNow ? s.chartLabelToday : ''} ${isSel ? s.chartLabelSel : ''}`}>
                {HOUR_LABELS[h.hour] || ''}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Statistics() {
  const [period, setPeriod]   = useState('7d')
  const [stats, setStats]     = useState(null)
  const [loading, setLoading] = useState(true)   // true only before first data arrives
  const [fetching, setFetching] = useState(false) // true during period-switch reloads
  const [selectedDay, setSelectedDay] = useState(null)
  const [dayDetail, setDayDetail] = useState(null)
  const [dayLoading, setDayLoading] = useState(false)
  const [selectedHour, setSelectedHour] = useState(null)   // 24h view
  const [hourDetail, setHourDetail] = useState(null)
  const [hourLoading, setHourLoading] = useState(false)

  const load = useCallback(async (p) => {
    if (!window.kozo?.api) return
    // First ever load → show loading placeholder
    // Subsequent loads (period switch) → keep old data visible, show subtle spinner
    if (!stats) setLoading(true)
    else setFetching(true)

    const res = await window.kozo.api.stats.get(p)
    if (res?.ok) setStats(res.data)
    setLoading(false)
    setFetching(false)
  }, [stats])

  useEffect(() => { load('7d') }, [])

  // Fetch the per-day breakdown whenever a bar is selected.
  useEffect(() => {
    if (!selectedDay) { setDayDetail(null); return }
    let cancelled = false
    setDayLoading(true)
    window.kozo?.api?.stats?.dayActivity(selectedDay).then(res => {
      if (cancelled) return
      setDayDetail(res?.ok ? res.data : null)
      setDayLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedDay])

  // Fetch the per-hour breakdown whenever an hour bar is selected (24h view).
  useEffect(() => {
    if (selectedHour == null) { setHourDetail(null); return }
    let cancelled = false
    setHourLoading(true)
    window.kozo?.api?.stats?.hourActivity(selectedHour).then(res => {
      if (cancelled) return
      setHourDetail(res?.ok ? res.data : null)
      setHourLoading(false)
    })
    return () => { cancelled = true }
  }, [selectedHour])

  function handlePeriod(p) { setPeriod(p); setSelectedDay(null); setSelectedHour(null); load(p) }

  const playtime    = stats?.playtime?.seconds ?? 0
  const sessions    = stats?.sessionCount?.count ?? 0
  const achUnlocked = stats?.achievementCounts?.unlocked ?? 0
  const avgSession  = sessions > 0 ? Math.floor(playtime / sessions) : 0
  const gamesCount  = stats?.gamesPlayedCount?.count ?? 0

  const HIGHLIGHTS = [
    { Icon: IconClock,          label: 'Playtime',     value: formatPlaytime(playtime) || '—',             color: 'var(--a)' },
    { Icon: IconHistory,        label: 'Sessions',     value: sessions,                                     color: '#60a5fa' },
    { Icon: IconTrophy,         label: 'Unlocked',     value: achUnlocked,                                  color: '#fbbf24' },
    { Icon: IconDeviceGamepad2, label: 'Games played', value: gamesCount,                                   color: '#4ade80' },
    { Icon: IconFlame,          label: 'Avg session',  value: avgSession ? formatPlaytime(avgSession) : '—', color: '#fb923c' },
  ]

  // When a day is selected (daily views only) the three lower panels re-scope to
  // that day; otherwise they show the whole period. This replaces the old inline
  // scroll panel — the data lands in the sections the user already reads.
  const dayScoped    = !!selectedDay && period !== '1d'
  const hourScoped   = period === '1d' && selectedHour != null
  const scoped       = dayScoped || hourScoped
  const detail       = dayScoped ? dayDetail : hourDetail
  const scopeLoadingNow = scoped && ((dayScoped ? dayLoading : hourLoading) || !detail)
  const scopeSuffix  = dayScoped
    ? ` · ${prettyShort(selectedDay)}`
    : hourScoped ? ` · ${fmtHour(selectedHour)}–${fmtHour((selectedHour + 1) % 24)}` : ''
  const topGames  = scoped ? (detail?.games || [])        : (stats?.topGames || [])
  const recentAch = scoped ? (detail?.achievements || []) : (stats?.recentAchievements || [])
  const longest   = scoped ? (detail?.sessions || [])     : (stats?.longestSessions || [])

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}>Statistics</h1>
        {fetching && (
          <IconLoader2 size={15} stroke={1.8} style={{ color: 'var(--text-muted)', animation: 'spin 0.8s linear infinite' }} />
        )}
        <div className={s.periodBtns}>
          {PERIODS.map(p => (
            <button
              key={p.key}
              className={`${s.periodBtn} ${period === p.key ? s.periodBtnActive : ''}`}
              onClick={() => handlePeriod(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className={s.firstLoad}>
          <IconLoader2 size={22} stroke={1.8} style={{ color: 'var(--text-muted)', animation: 'spin 0.8s linear infinite' }} />
        </div>
      )}

      {!loading && (
        <div className={s.content}>
          {/* Highlight row */}
          <div className={s.highlights}>
            {HIGHLIGHTS.map(({ Icon, label, value, color }) => (
              <div key={label} className={s.hlCard}>
                <div className={s.hlIcon} style={{ color, background: color + '18', borderColor: color + '33' }}>
                  <Icon size={18} stroke={1.6} />
                </div>
                <div className={s.hlBody}>
                  <div className={s.hlValue}>{value}</div>
                  <div className={s.hlLabel}>{label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Activity chart — hourly for 24h, daily otherwise */}
          <div className={s.section}>
            <div className={s.sectionHead}>
              <div className={s.sectionTitle}>{period === '1d' ? "Today's Activity" : 'Daily Activity'}</div>
              {dayScoped && (
                <button className={s.dayPill} onClick={() => setSelectedDay(null)}>
                  {prettyDay(selectedDay)}
                  <IconX size={12} stroke={2.2} />
                </button>
              )}
              {period === '1d' && selectedHour != null && (
                <button className={s.dayPill} onClick={() => setSelectedHour(null)}>
                  {fmtHour(selectedHour)}–{fmtHour((selectedHour + 1) % 24)} · {formatPlaytime(hourSeconds(stats?.hourlyActivity, selectedHour)) || 'No activity'}
                  <IconX size={12} stroke={2.2} />
                </button>
              )}
              {period === '1d' && selectedHour == null && (
                <span className={s.sectionHint}>Click an hour</span>
              )}
              {period !== '1d' && period !== 'all' && !dayScoped && (
                <span className={s.sectionHint}>Click a day to focus it</span>
              )}
            </div>
            {period === '1d'
              ? <HourlyChart data={stats?.hourlyActivity} selectedHour={selectedHour} onSelectHour={setSelectedHour} />
              : <DailyChart
                  data={stats?.dailyActivity}
                  period={period}
                  selectedDay={selectedDay}
                  onSelectDay={setSelectedDay}
                />}
          </div>

          {/* Playtime by Game — full width with rank + bar combined */}
          <div className={s.section}>
            <div className={s.sectionTitle}>Playtime by Game{scopeSuffix}</div>
            {scopeLoadingNow
              ? <div className={s.empty}><IconLoader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} /></div>
              : !(topGames.length)
                ? <div className={s.empty}>{scoped ? 'No playtime in this window' : 'No data this period'}</div>
                : (() => {
                    const max = Math.max(...topGames.map(g => g.seconds), 1)
                    return (
                      <div className={s.hbars}>
                        {topGames.map((g, i) => (
                          <div key={g.id} className={s.hbar}>
                            <div className={s.hbarMeta}>
                              <span className={s.hbarRank}>{i + 1}</span>
                              <span className={s.hbarName}>{g.name}</span>
                              <span className={s.hbarTime}>{formatPlaytime(g.seconds)}</span>
                            </div>
                            <div className={s.hbarTrack}>
                              <div className={s.hbarFill} style={{ width: `${(g.seconds / max) * 100}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  })()
            }
          </div>

          {/* Achievements + Sessions — scoped to the selected day, else the period */}
          <div className={s.bottomGrid}>
            <div className={s.section}>
              <div className={s.sectionTitle}>{scoped ? 'Achievements Unlocked' : 'Recent Achievements'}{scopeSuffix}</div>
              {scopeLoadingNow
                ? <div className={s.empty}><IconLoader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} /></div>
                : !(recentAch.length)
                  ? <div className={s.empty}>{scoped ? 'No unlocks in this window' : 'No unlocks this period'}</div>
                  : (
                    <div className={s.achList}>
                      {recentAch.map((a, i) => (
                        <div key={i} className={s.achRow}>
                          <div className={s.achThumb}>
                            {a.icon_url
                              ? <img src={a.icon_url} alt="" onError={e => { e.target.style.display = 'none' }} />
                              : <IconTrophy size={14} stroke={1.5} style={{ color: 'var(--a)' }} />
                            }
                          </div>
                          <div className={s.achBody}>
                            <div className={s.achName}>{a.display_name}</div>
                            <div className={s.achGame}>{a.game_name}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
              }
            </div>

            <div className={s.section}>
              <div className={s.sectionTitle}>Longest Sessions{scopeSuffix}</div>
              {scopeLoadingNow
                ? <div className={s.empty}><IconLoader2 size={16} style={{ animation: 'spin 0.8s linear infinite' }} /></div>
                : !(longest.length)
                  ? <div className={s.empty}>{scoped ? 'No sessions in this window' : 'No sessions this period'}</div>
                  : longest.map(sess => (
                      <div key={sess.id} className={s.rankRow}>
                        <span className={s.rankName}>{sess.game_name}</span>
                        <span className={s.rankVal}>{formatPlaytime(sess.duration_seconds)}</span>
                      </div>
                    ))
              }
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
