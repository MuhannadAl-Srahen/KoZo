import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconTrophy, IconDiamond, IconTargetArrow, IconHistory } from '@tabler/icons-react'
import { fileUrl, formatDate, rarityLabel } from '../lib/utils'
import Modal from '../components/ui/Modal'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton, RowSkeleton } from '../components/ui/Skeleton'
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

// React keys for the hub lists. `achievements:hub` selects no unique column
// (no a.id, no au.id, no steam_api_name) and display_name is only unique per
// (game_id, steam_api_name), so key on the fullest composite the payload
// offers and suffix any leftover collision. Index keys are not an option —
// they pin AchIcon's `failed` state to a list position, which misfires every
// time a new unlock is prepended to the feed.
function keyed(rows) {
  const seen = new Map()
  return rows.map(a => {
    const base = `${a.game_id}|${a.unlocked_at || ''}|${a.display_name}`
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    return { a, key: n > 1 ? `${base}#${n}` : base }
  })
}

// Rarity token for a global-unlock %. Same bands as utils.rarityLabel; the
// colors are the fixed --rarity-* semantics from variables.css (deliberately
// NOT accent-derived — rarity keeps its meaning across accent themes).
function rarityToken(pct) {
  if (pct == null)  return 'var(--rarity-common)'
  if (pct < 5)      return 'var(--rarity-ultra)'
  if (pct < 15)     return 'var(--rarity-very)'
  if (pct < 30)     return 'var(--rarity-rare)'
  if (pct < 50)     return 'var(--rarity-uncommon)'
  return 'var(--rarity-common)'
}

function AchIcon({ url, size = 40 }) {
  const [failed, setFailed] = useState(false)
  if (!url || failed) {
    return <span className={s.achIconFallback} style={{ width: size, height: size }}><IconTrophy size={size * 0.5} stroke={1.4} /></span>
  }
  return (
    <img
      className={s.achIcon}
      style={{ width: size, height: size }}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

export default function AchievementsHub() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [feedModal, setFeedModal] = useState(false)

  async function load() {
    const res = await window.kozo?.api?.achievements?.hub?.()
    if (res?.ok) { setData(res.data || {}); return }
    // A failed reload must NOT wipe an already-populated page to the false
    // "No achievements yet" empty state — `load` is also the game:updated
    // subscriber, which fires on every sync/edit. Only unstick the FIRST load
    // so a cold mount can't sit on the spinner forever.
    setData(prev => prev ?? {})
  }

  useEffect(() => {
    load()
    // Unsubscribe THIS page's own listener only — removeAll() is window-wide
    // and would tear down the always-mounted Sidebar's listeners too.
    const off = window.kozo?.events?.onGameUpdated?.(load)
    return () => off?.()
  }, [])

  // First load: ghost the real layout (stat row + a list of rows) instead of a
  // bare spinner, so nothing shifts when the data lands.
  if (!data) {
    return (
      <div className={s.page}>
        <div className={s.toolbar}>
          <h1 className={s.pageTitle}><IconTrophy size={16} stroke={1.7} /> Achievements</h1>
        </div>
        <div className={s.content}>
          <div className={s.inner}>
            <div className={s.statsBar}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className={s.statCard}>
                  <Skeleton w="55%" h={10} />
                  <Skeleton w="35%" h={18} />
                </div>
              ))}
            </div>
            <RowSkeleton count={5} height={58} />
          </div>
        </div>
      </div>
    )
  }

  const { totals = { unlocked: 0, total: 0 }, recent = [], rarest = [], perGame = [] } = data
  const pct = totals.total > 0 ? Math.round((totals.unlocked / totals.total) * 100) : 0
  const perfect = perGame.filter(g => g.unlocked === g.total).length
  const inProgress = perGame.filter(g => g.unlocked > 0 && g.unlocked < g.total).slice(0, 8)
  const rarestPct = rarest[0]?.global_unlock_percent
  const rarestKeyed = keyed(rarest)
  const recentKeyed = keyed(recent)

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconTrophy size={16} stroke={1.7} /> Achievements</h1>
      </div>

      <div className={s.content}>
        <div className={s.inner}>
          {/* Stats */}
          <div className={s.statsBar}>
            <div className={s.statCard}>
              <span className={s.statLabel}>Unlocked</span>
              <span className={s.statValue} title={`${totals.unlocked} of ${totals.total}`}>
                {totals.unlocked}<span className={s.statDim}>/{totals.total}</span>
              </span>
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
            <EmptyState
              Icon={IconTrophy}
              title="No achievements yet"
              desc="Add Steam or cracked games and start unlocking — every unlock lands here automatically."
            />
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
                    <button key={g.id} className={s.progressRow} data-gpnav="" onClick={() => navigate(`/game/${g.id}`)}>
                      <span className={s.progressThumb}>
                        {src && <img src={src} alt="" loading="lazy" decoding="async" onError={e => { e.target.style.display = 'none' }} />}
                      </span>
                      <span className={s.progressInfo}>
                        <span className={s.progressName} title={g.name}>{g.name}</span>
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
                {rarestKeyed.map(({ a, key }) => (
                  <button key={key} className={s.rareCard} data-gpnav=""
                    style={{ '--rc': rarityToken(a.global_unlock_percent) }}
                    onClick={() => navigate(`/game/${a.game_id}`)} title={a.description || a.display_name}>
                    <AchIcon url={a.icon_url} size={44} />
                    <span className={s.rareInfo}>
                      <span className={s.rareName} title={a.display_name}>{a.display_name}</span>
                      <span className={s.rareGame} title={a.game_name}>{a.game_name}</span>
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
                {recentKeyed.slice(0, 10).map(({ a, key }) => <FeedRow key={key} a={a} navigate={navigate} />)}
              </div>
              {recent.length > 10 && (
                <button className={s.showAll} onClick={() => setFeedModal(true)}>
                  Show all ({recent.length})
                </button>
              )}
            </section>
          )}
        </div>

        {feedModal && (
          <Modal title="Recent unlocks" icon={<IconHistory size={17} stroke={1.6} />} width={560} onClose={() => setFeedModal(false)}>
            <div className={s.modalScroll}>
              <div className={s.feed}>
                {recentKeyed.map(({ a, key }) => (
                  <FeedRow key={key} a={a} navigate={(p) => { setFeedModal(false); navigate(p) }} />
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
    <button className={s.feedRow} data-gpnav="" onClick={() => navigate(`/game/${a.game_id}`)}>
      <AchIcon url={a.icon_url} size={34} />
      <span className={s.feedInfo}>
        <span className={s.feedName} title={a.display_name}>{a.display_name}</span>
        <span className={s.feedGame} title={a.game_name}>{a.game_name}</span>
      </span>
      {a.global_unlock_percent != null && (
        <span className={s.feedPct}>{Number(a.global_unlock_percent).toFixed(1)}%</span>
      )}
      <span className={s.feedWhen}>{a.unlocked_at ? timeAgo(a.unlocked_at) : formatDate(a.unlocked_at)}</span>
    </button>
  )
}
