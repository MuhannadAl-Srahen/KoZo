import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconCalendarStats, IconCheck, IconClock, IconCopy, IconDeviceFloppy, IconFlag, IconFlame, IconShare2, IconStarFilled, IconTrophy,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../components/ui/Modal'
import AchImg from '../components/ui/AchImg'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import GeneratedCover from '../components/GeneratedCover'
import { fileUrl, formatDate, formatPlaytime } from '../lib/utils'
import s from './YearReview.module.css'

// Activity > Your year. Everything comes from the database already on this PC
// (db/queries/yearReview.js). KoZo may be new to someone, so a year with little in
// it has to look right: any section with nothing to say simply isn't there.

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2024, i, 1))
const monthShort = (i) => MONTHS[i].toLocaleString('en-US', { month: 'short' })
const monthLong = (i) => MONTHS[i].toLocaleString('en-US', { month: 'long' })

let yearsCache = null
const dataCache = new Map()

function coverSrc(g) {
  if (g.banner_local_path) return fileUrl(g.banner_local_path, g.banner_rev)
  return g.banner_url || null
}

function Cover({ g, className }) {
  const [failed, setFailed] = useState(false)
  const src = coverSrc(g)
  return (
    <span className={`${s.cover} ${className || ''}`}>
      {src && !failed
        ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <GeneratedCover name={g.name} compact />}
    </span>
  )
}

// One series, so one color and no legend. Thin bars from the baseline, the top
// month labeled directly and the others on hover, with the numbers as a table for
// screen readers.
function MonthChart({ months, busiest }) {
  const max = Math.max(...months, 1)
  return (
    <>
      <div className={s.chart} role="img" aria-label={`Hours played per month. Most in ${busiest ? monthLong(busiest - 1) : 'no month yet'}.`}>
        {months.map((secs, i) => {
          const pct = secs > 0 ? Math.max(3, Math.round((secs / max) * 100)) : 0
          return (
            <div key={i} className={s.col} tabIndex={secs > 0 ? 0 : undefined}>
              <div className={s.barArea}>
                {busiest === i + 1 && <span className={s.barLabel} style={{ bottom: `calc(${pct}% + 4px)` }}>{formatPlaytime(secs)}</span>}
                {secs > 0
                  ? <div className={s.bar} style={{ height: `${pct}%` }} />
                  : <div className={s.barNone} />}
              </div>
              <span className={s.axis}>{monthShort(i)[0]}</span>
              <span className={s.tip} role="presentation">{monthLong(i)}: <b>{secs > 0 ? formatPlaytime(secs) : 'No play'}</b></span>
            </div>
          )
        })}
      </div>
      <table className={s.srOnly}>
        <caption>Hours played per month</caption>
        <tbody>
          {months.map((secs, i) => <tr key={i}><th scope="row">{monthLong(i)}</th><td>{secs > 0 ? formatPlaytime(secs) : 'No play'}</td></tr>)}
        </tbody>
      </table>
    </>
  )
}

function Highlight({ Icon, label, value, sub, children }) {
  return (
    <div className={s.highlight}>
      <div className={s.hlLabel}><Icon size={14} /> {label}</div>
      {value && <div className={s.hlValue} title={typeof value === 'string' ? value : undefined}>{value}</div>}
      {sub && <div className={s.hlSub} title={sub}>{sub}</div>}
      {children}
    </div>
  )
}

function statsOf(d) {
  return [
    d.games > 0 && { label: d.games === 1 ? 'game' : 'games', value: d.games },
    d.sessions > 0 && { label: d.sessions === 1 ? 'session' : 'sessions', value: d.sessions },
    d.days > 0 && { label: d.days === 1 ? 'day played' : 'days played', value: d.days },
    d.streak > 1 && { label: 'days in a row', value: d.streak },
    d.achievements > 0 && { label: d.achievements === 1 ? 'achievement' : 'achievements', value: d.achievements },
  ].filter(Boolean)
}

// The picture. A fixed design rather than a capture of the page, so it looks the
// same whatever the window size. Sized to fit a small window too.
function ShareModal({ d, isNow, onClose }) {
  const ref = useRef(null)
  const [state, setState] = useState(null)   // { busy } | { done } | { error }

  async function take(action) {
    setState({ busy: action })
    const r = ref.current?.getBoundingClientRect()
    const zoom = window.kozo?.ui?.getZoom?.() || 1
    const res = await window.kozo?.api?.stats?.captureCard?.(
      r && { x: r.left * zoom, y: r.top * zoom, width: r.width * zoom, height: r.height * zoom },
      action, d.year,
    )
    if (!res?.ok) setState({ error: res?.error || 'Could not make the picture.' })
    else if (res.data?.canceled) setState(null)
    else setState({ done: action })
  }

  const top = d.topGames.slice(0, 3)
  return (
    <Modal
      title="Share your year"
      icon={<IconShare2 size={17} stroke={1.6} />}
      onClose={onClose}
      width={720}
      footer={
        <div className={s.shareFooter}>
          {state?.done && <span className={s.shareDone}><IconCheck size={14} /> {state.done === 'copy' ? 'Copied. Paste it anywhere.' : 'Saved.'}</span>}
          {state?.error && <span className={s.shareError}>{state.error}</span>}
          <div className={s.spacer} />
          <button className={ms.btnCancel} onClick={onClose}>Close</button>
          <button className={ms.btnGhost} disabled={!!state?.busy} onClick={() => take('copy')}><IconCopy size={14} /> Copy image</button>
          <button className={ms.btnPrimary} disabled={!!state?.busy} onClick={() => take('save')}><IconDeviceFloppy size={14} /> Save image</button>
        </div>
      }
    >
      <div ref={ref} className={s.card} data-share-card>
        <div className={s.cardTop}>
          <span className={s.cardBrand}>KoZo</span>
          <span className={s.cardYear}>{d.year}{isNow ? ' so far' : ''}</span>
        </div>
        <div className={s.cardHours}>{d.seconds > 0 ? formatPlaytime(d.seconds) : '0m'}</div>
        <div className={s.cardHoursLabel}>played</div>
        <div className={s.cardStats}>
          {statsOf(d).slice(0, 4).map(x => <span key={x.label}><b>{x.value}</b> {x.label}</span>)}
        </div>
        {top.length > 0 && (
          <div className={s.cardGames}>
            {top.map(g => (
              <div key={g.id} className={s.cardGame}>
                <Cover g={g} className={s.cardCover} />
                <div className={s.cardGameName}>{g.name}</div>
                <div className={s.cardGameTime}>{formatPlaytime(g.seconds)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function YearReview() {
  const navigate = useNavigate()
  const thisYear = new Date().getFullYear()
  const [years, setYears] = useState(yearsCache || [thisYear])
  const [year, setYear] = useState(thisYear)
  const [data, setData] = useState(dataCache.get(thisYear) || null)
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    window.kozo?.api?.stats?.years?.().then((res) => {
      if (res?.ok && res.data?.length) { yearsCache = res.data; setYears(res.data) }
    })
  }, [])

  useEffect(() => {
    let alive = true
    setData(dataCache.get(year) || null)
    window.kozo?.api?.stats?.year?.(year).then((res) => {
      if (alive && res?.ok) { dataCache.set(year, res.data); setData(res.data) }
    })
    return () => { alive = false }
  }, [year])

  const isNow = year === thisYear
  const d = data?.year === year ? data : null
  const hasAnything = d && (d.seconds > 0 || d.achievements > 0 || d.finished.length > 0)
  const topMax = d?.topGames?.[0]?.seconds || 1

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconCalendarStats size={16} stroke={1.7} /> Your year</h1>
        {years.length > 1 && (
          <div className={s.seg} role="group" aria-label="Year">
            {years.map(y => (
              <button key={y} type="button" data-gpnav aria-pressed={y === year}
                className={`${s.segBtn} ${y === year ? s.segOn : ''}`} onClick={() => setYear(y)}>{y}</button>
            ))}
          </div>
        )}
        <div className={s.spacer} />
        {hasAnything && (
          <button type="button" className={s.shareBtn} data-gpnav onClick={() => setSharing(true)}>
            <IconShare2 size={14} /> Share
          </button>
        )}
      </div>

      <div className={s.content}>
        {!d ? (
          <div className={s.skel}>
            <Skeleton w="100%" h={140} r={14} />
            <div className={s.twoCols}><Skeleton w="100%" h={220} r={14} /><Skeleton w="100%" h={220} r={14} /></div>
          </div>
        ) : !hasAnything ? (
          <EmptyState
            Icon={IconCalendarStats}
            title={isNow ? `Nothing in ${year} yet` : `Nothing in ${year}`}
            desc={isNow ? 'Play something and it starts filling up here.' : 'KoZo has no play or achievements from that year.'}
          />
        ) : (
          <>
            <section className={s.hero}>
              <div className={s.heroMain}>
                <div className={s.heroLabel}>{isNow ? `${year} so far` : year}</div>
                <div className={s.heroValue} data-year-hours>{d.seconds > 0 ? formatPlaytime(d.seconds) : 'No play'}</div>
                {d.seconds > 0 && <div className={s.heroSub}>played</div>}
              </div>
              <div className={s.heroStats}>
                {statsOf(d).map(x => (
                  <div key={x.label} className={s.heroStat}><b>{x.value.toLocaleString()}</b><span>{x.label}</span></div>
                ))}
              </div>
            </section>

            {(d.topGames.length > 0 || d.seconds > 0) && (
              <div className={s.twoCols}>
                <section className={s.panel}>
                  <div className={s.panelHead}><IconTrophy size={14} /> Most played</div>
                  <div className={s.games}>
                    {d.topGames.map((g, i) => (
                      <button key={g.id} type="button" className={s.game} data-gpnav onClick={() => navigate(`/game/${g.id}`)}>
                        <span className={s.rank}>{i + 1}</span>
                        <Cover g={g} className={s.gameCover} />
                        <span className={s.gameInfo}>
                          <span className={s.gameName} title={g.name}>{g.name}</span>
                          <span className={s.gameBar}><span style={{ width: `${Math.max(4, Math.round((g.seconds / topMax) * 100))}%` }} /></span>
                        </span>
                        <span className={s.gameTime}>{formatPlaytime(g.seconds)}</span>
                      </button>
                    ))}
                  </div>
                </section>
                <section className={s.panel}>
                  <div className={s.panelHead}><IconClock size={14} /> Hours per month</div>
                  <MonthChart months={d.months} busiest={d.busiestMonth} />
                </section>
              </div>
            )}

            <div className={s.highlights}>
              {d.longestSession && (
                <Highlight Icon={IconClock} label="Longest session" value={formatPlaytime(d.longestSession.seconds)}
                  sub={`${d.longestSession.game_name}, ${formatDate(d.longestSession.started_at)}`} />
              )}
              {d.busiestMonth && (
                <Highlight Icon={IconCalendarStats} label="Busiest month" value={monthLong(d.busiestMonth - 1)}
                  sub={formatPlaytime(d.months[d.busiestMonth - 1])} />
              )}
              {d.streak > 1 && (
                <Highlight Icon={IconFlame} label="Longest streak" value={`${d.streak} days`} sub="Played every day in a row" />
              )}
              {d.rarest && (
                <Highlight Icon={IconTrophy} label="Rarest achievement">
                  <div className={s.rare}>
                    <AchImg className={s.rareIcon} src={d.rarest.icon_url} alt="" fallback={<span className={s.rareIcon} />} />
                    <div className={s.rareInfo}>
                      <div className={s.hlValueSm} title={d.rarest.display_name}>{d.rarest.display_name}</div>
                      <div className={s.hlSub} title={d.rarest.game_name}>{d.rarest.game_name}, {Number(d.rarest.percent).toFixed(1)}% of players</div>
                    </div>
                  </div>
                </Highlight>
              )}
              {d.bestRated && (
                <Highlight Icon={IconStarFilled} label="Best rated" value={d.bestRated.name} sub={`${Math.round(d.bestRated.rating)} out of 10`} />
              )}
              {d.finished.length > 0 && (
                <Highlight Icon={IconFlag} label={`${d.finished.length} ${d.finished.length === 1 ? 'game' : 'games'} finished`}>
                  <div className={s.finished}>
                    {d.finished.slice(0, 8).map((g, i) => (
                      <span key={`${g.name}${i}`} title={g.name}><Cover g={g} className={s.finishedCover} /></span>
                    ))}
                    {d.finished.length > 8 && <span className={s.moreCount}>+{d.finished.length - 8}</span>}
                  </div>
                </Highlight>
              )}
            </div>
          </>
        )}
      </div>

      {sharing && d && <ShareModal d={d} isNow={isNow} onClose={() => setSharing(false)} />}
    </div>
  )
}
