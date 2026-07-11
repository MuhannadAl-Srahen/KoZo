import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconTrophy, IconDiamond, IconTargetArrow, IconHistory, IconLoader2 } from '@tabler/icons-react'
import { fileUrl, formatDate, rarityLabel } from '../lib/utils'
import Modal from '../components/ui/Modal'
import s from './AchievementsHub.module.css'

// Compact "when": "2h ago" / "Jun 12"
function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diffMin = Math.floor((Date.now() - then) / 60000)
  if (diffMin < 60) return `${Math.max(1, diffMin)}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD < 7) return `${diffD}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function AchIcon({ url, size = 40 }) {
  const [failed, setFailed] = useState(false)
  if (!url || failed) {
    return <span className={s.achIconFallback} style={{ width: size, height: size }}><IconTrophy size={size * 0.5} stroke={1.4} /></span>
  }
  return <img className={s.achIcon} style={{ width: size, height: size }} src={url} alt="" onError={() => setFailed(true)} />
}

export default function AchievementsHub() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [feedModal, setFeedModal] = useState(false)

  async function load() {
    const res = await window.kozo?.api?.achievements?.hub?.()
    if (res?.ok) setData(res.data)
  }

  useEffect(() => {
    load()
    window.kozo?.events?.onGameUpdated?.(load)
    return () => window.kozo?.events?.removeAll?.('game:updated')
  }, [])

  if (!data) {
    return (
      <div className={s.page}>
        <div className={s.loading}><IconLoader2 size={20} className="spin" /></div>
      </div>
    )
  }

  const { totals, recent, rarest, perGame } = data
  const pct = totals.total > 0 ? Math.round((totals.unlocked / totals.total) * 100) : 0
  const perfect = perGame.filter(g => g.unlocked === g.total).length
  const inProgress = perGame.filter(g => g.unlocked > 0 && g.unlocked < g.total).slice(0, 8)
  const rarestPct = rarest[0]?.global_unlock_percent

  return (
    <div className={s.page}>
      <div className={s.scroll}>
        <h1 className={s.title}><IconTrophy size={20} stroke={1.7} /> Achievements</h1>

        {/* Stats */}
        <div className={s.statsBar}>
          <div className={s.statCard}>
            <span className={s.statLabel}>Unlocked</span>
            <span className={s.statValue}>{totals.unlocked}<span className={s.statDim}>/{totals.total}</span></span>
          </div>
          <div className={s.statCard}>
            <span className={s.statLabel}>Completion</span>
            <span className={s.statValue}>{pct}%</span>
          </div>
          <div className={s.statCard}>
            <span className={s.statLabel}>Perfect games</span>
            <span className={s.statValue}>{perfect}</span>
          </div>
          <div className={s.statCard}>
            <span className={s.statLabel}>Rarest trophy</span>
            <span className={s.statValue}>{rarestPct != null ? `${Number(rarestPct).toFixed(1)}%` : '—'}</span>
          </div>
        </div>

        {totals.total === 0 && (
          <div className={s.empty}>
            No achievements yet — add Steam or cracked games and start unlocking.
          </div>
        )}

        {/* Closest to 100% */}
        {inProgress.length > 0 && (
          <section className={s.section}>
            <div className={s.sectionTitle}><IconTargetArrow size={14} stroke={1.7} /> Closest to 100%</div>
            <div className={s.progressList}>
              {inProgress.map(g => {
                const p = Math.round((g.unlocked / g.total) * 100)
                const src = g.banner_local_path ? fileUrl(g.banner_local_path) : g.banner_url
                return (
                  <button key={g.id} className={s.progressRow} onClick={() => navigate(`/game/${g.id}`)}>
                    <span className={s.progressThumb}>
                      {src && <img src={src} alt="" onError={e => { e.target.style.display = 'none' }} />}
                    </span>
                    <span className={s.progressInfo}>
                      <span className={s.progressName}>{g.name}</span>
                      <span className={s.progressBar}><span className={s.progressFill} style={{ width: `${p}%` }} /></span>
                    </span>
                    <span className={s.progressPct}>{g.unlocked}/{g.total} · {p}%</span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {/* Rarest trophies */}
        {rarest.length > 0 && (
          <section className={s.section}>
            <div className={s.sectionTitle}><IconDiamond size={14} stroke={1.7} /> Your rarest trophies</div>
            <div className={s.rareGrid}>
              {rarest.map((a, i) => (
                <button key={i} className={s.rareCard} onClick={() => navigate(`/game/${a.game_id}`)} title={a.description || a.display_name}>
                  <AchIcon url={a.icon_url} size={44} />
                  <span className={s.rareInfo}>
                    <span className={s.rareName}>{a.display_name}</span>
                    <span className={s.rareGame}>{a.game_name}</span>
                  </span>
                  <span className={s.rarePct} title={rarityLabel?.(a.global_unlock_percent) || ''}>
                    {Number(a.global_unlock_percent).toFixed(1)}%
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Recent unlocks — newest 10 only; the full feed opens in a popup so
            the page never turns into an endless scroll. */}
        {recent.length > 0 && (
          <section className={s.section}>
            <div className={s.sectionTitle}><IconHistory size={14} stroke={1.7} /> Recent unlocks</div>
            <div className={s.feed}>
              {recent.slice(0, 10).map((a, i) => <FeedRow key={i} a={a} navigate={navigate} />)}
            </div>
            {recent.length > 10 && (
              <button className={s.showAll} onClick={() => setFeedModal(true)}>
                Show all ({recent.length})
              </button>
            )}
          </section>
        )}

        {feedModal && (
          <Modal title="Recent unlocks" icon={<IconHistory size={17} stroke={1.6} />} width={560} onClose={() => setFeedModal(false)}>
            <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
              <div className={s.feed}>
                {recent.map((a, i) => (
                  <FeedRow key={i} a={a} navigate={(p) => { setFeedModal(false); navigate(p) }} />
                ))}
              </div>
            </div>
          </Modal>
        )}
      </div>
    </div>
  )
}

function FeedRow({ a, navigate }) {
  return (
    <button className={s.feedRow} onClick={() => navigate(`/game/${a.game_id}`)}>
      <AchIcon url={a.icon_url} size={34} />
      <span className={s.feedInfo}>
        <span className={s.feedName}>{a.display_name}</span>
        <span className={s.feedGame}>{a.game_name}</span>
      </span>
      {a.global_unlock_percent != null && (
        <span className={s.feedPct}>{Number(a.global_unlock_percent).toFixed(1)}%</span>
      )}
      <span className={s.feedWhen}>{a.unlocked_at ? timeAgo(a.unlocked_at) : formatDate(a.unlocked_at)}</span>
    </button>
  )
}
