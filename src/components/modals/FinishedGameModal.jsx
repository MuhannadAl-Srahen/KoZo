import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconFlag, IconStarFilled, IconClock, IconTrophy, IconCalendar, IconHistory, IconPlayerPlay, IconExternalLink, IconBrandSteam } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import GeneratedCover from '../GeneratedCover'
import InfoModal from '../ui/InfoModal'
import RatingPicker, { RATING_WORDS, ratingColor } from '../ui/RatingPicker'
import { fileUrl, formatPlaytime, formatDate, parseGenres } from '../../lib/utils'
import s from './FinishedGameModal.module.css'

// The Finished tab's popup for one game: big art, your rating (click a number
// to change it, saved at once), and the story of the run: playtime, sessions,
// when you started and finished, achievements. Library games can be opened
// or launched again from here.
export default function FinishedGameModal({ g, onClose, onChanged }) {
  const navigate = useNavigate()
  const [rating, setRating] = useState(g.rating ? Math.round(g.rating) : null)
  const [heroUrl, setHeroUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState(null)

  const cover = g.banner_local_path ? fileUrl(g.banner_local_path, g.banner_rev) : (g.list_banner || g.banner_url || null)
  const localHero = g.hero_local_path ? fileUrl(g.hero_local_path) : null

  // No hero on disk: ask Steam for the wide art (cached in the main process).
  useEffect(() => {
    if (localHero || !g.steam_app_id) return
    let alive = true
    window.kozo?.api?.steam?.appAssets?.([g.steam_app_id]).then(res => {
      const a = res?.ok ? res.data?.[g.steam_app_id] : null
      if (alive && (a?.hero || a?.header)) setHeroUrl(a.hero || a.header)
    }).catch(() => {})
    return () => { alive = false }
  }, [g.steam_app_id, localHero])

  const hero = localHero || heroUrl
  const started = g.first_session_at || g.first_played_at
  const genres = parseGenres(g).slice(0, 4)
  const achPct = g.ach_total > 0 ? Math.round((g.ach_unlocked / g.ach_total) * 100) : 0

  async function rate(n) {
    setRating(n)
    await window.kozo?.api?.gameList?.rate?.({ listId: g.list_id, gameId: g.game_id }, n)
    onChanged?.()
  }

  async function playAgain() {
    setLaunching(true)
    const res = await window.kozo?.api?.games?.launch?.(g.game_id)
    setLaunching(false)
    if (!res?.ok) setLaunchError(res?.error || 'KoZo could not start this game.')
    else onClose()
  }

  // Always the same four tiles; what KoZo doesn't know reads "Not tracked".
  const stats = [
    { Icon: IconClock,    label: 'Playtime', value: g.total_playtime_seconds > 0 ? formatPlaytime(g.total_playtime_seconds) : null },
    { Icon: IconHistory,  label: 'Sessions', value: g.session_count > 0 ? g.session_count : null },
    { Icon: IconCalendar, label: 'Started',  value: started ? formatDate(started) : null },
    { Icon: IconFlag,     label: 'Finished', value: g.finished_at ? formatDate(g.finished_at) : null },
  ]

  return (
    <Modal
      title={g.name}
      icon={<IconFlag size={17} stroke={1.6} />}
      onClose={onClose}
      width={720}
      footer={
        <div className={s.footer}>
          {g.steam_app_id && (
            <button className={ms.btnCancel} onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.steam_app_id}`)}>
              <IconBrandSteam size={14} stroke={1.6} /> Steam page
            </button>
          )}
          <div className={s.spacer} />
          {g.game_id && (
            <>
              <button className={ms.btnCancel} onClick={() => { onClose(); navigate(`/game/${g.game_id}`) }}>
                <IconExternalLink size={14} stroke={1.6} /> Open game page
              </button>
              <button className={ms.btnPrimary} onClick={playAgain} disabled={launching}>
                <IconPlayerPlay size={14} stroke={1.8} /> {launching ? 'Starting…' : 'Play again'}
              </button>
            </>
          )}
        </div>
      }
    >
      <div className={s.hero}>
        {hero && <img className={s.heroArt} src={hero} alt="" />}
        <div className={s.heroShade} />
        <div className={s.heroRow}>
          <div className={s.cover}>
            {cover && !failed ? <img src={cover} alt="" onError={() => setFailed(true)} /> : <GeneratedCover name={g.name} compact />}
          </div>
          <div className={s.heroText}>
            <div className={s.name}>{g.name}</div>
            {rating
              ? <div className={s.ratingBadge} style={{ '--rc': ratingColor(rating) }}><IconStarFilled size={15} /> <strong>{rating}</strong>/10 <span>{RATING_WORDS[rating]}</span></div>
              : <div className={s.ratingBadge}><IconStarFilled size={15} /> Not rated yet</div>}
            {genres.length > 0 && <div className={s.genres}>{genres.join(' · ')}</div>}
          </div>
        </div>
      </div>

      <div className={s.sectionLabel}>Your rating</div>
      <div className={s.ratingBox}><RatingPicker value={rating} onChange={rate} /></div>

      <div className={s.stats}>
        {stats.map(st => (
          <div key={st.label} className={s.stat}>
            <st.Icon size={16} />
            <span className={`${s.statValue} ${st.value == null ? s.statNone : ''}`}>{st.value ?? 'Not tracked'}</span>
            <span className={s.statLabel}>{st.label}</span>
          </div>
        ))}
      </div>

      {g.ach_total > 0 && (
        <div className={s.ach}>
          <div className={s.achHead}>
            <IconTrophy size={15} />
            <span>Achievements</span>
            <strong>{g.ach_unlocked} / {g.ach_total}</strong>
            <span className={s.achPct}>{achPct}%</span>
          </div>
          <div className={s.achBar}><span style={{ width: `${achPct}%` }} /></div>
        </div>
      )}

      {!g.game_id && (
        <p className={s.note}>Only on your Game List: add it to your Library to track playtime and sessions.</p>
      )}
      {launchError && <InfoModal variant="error" title="Couldn't start the game" message={launchError} onClose={() => setLaunchError(null)} />}
    </Modal>
  )
}
