import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconArrowBigUpLines, IconX } from '@tabler/icons-react'
import s from './LevelUpCelebration.module.css'

// In-app level-up moment.
//
// The main process has always broadcast `xp:levelup` to the renderer — nothing
// listened to it, so levelling up inside KoZo produced no reaction at all. The
// overlay toast only covers the case where you're mid-game with the overlay up,
// and at higher levels a level takes tens of hours to reach, so in practice the
// whole XP system looked inert. This is the missing celebration.
//
// Portalled to document.body for the same reason Modal is (§3): cards use
// `transform` on hover, and a transformed ancestor becomes the containing block
// for position:fixed descendants, which would clip this to a card.

const CONFETTI = Array.from({ length: 18 }, (_, i) => i)

export default function LevelUpCelebration() {
  const [data, setData] = useState(null)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (!window.kozo?.events?.onXpLevelUp) return
    window.kozo.events.onXpLevelUp((payload) => {
      setLeaving(false)
      setData(payload)
    })
    return () => window.kozo?.events?.removeAll?.('xp:levelup')
  }, [])

  // Auto-dismiss, but generously — this is the payoff for tens of hours.
  useEffect(() => {
    if (!data) return
    const t = setTimeout(() => close(), 9000)
    return () => clearTimeout(t)
  }, [data])

  function close() {
    setLeaving(true)
    setTimeout(() => { setData(null); setLeaving(false) }, 260)
  }

  if (!data) return null

  const { level, previousLevel, tier, totalXp, toNextLevel, gameName } = data

  return createPortal(
    <div className={`${s.backdrop} ${leaving ? s.backdropOut : ''}`} onClick={close}>
      <div className={`${s.card} ${leaving ? s.cardOut : ''}`} onClick={e => e.stopPropagation()}>
        <button className={s.close} onClick={close} aria-label="Dismiss"><IconX size={15} stroke={2} /></button>

        <div className={s.confetti} aria-hidden="true">
          {CONFETTI.map(i => <span key={i} className={s.piece} style={{ '--i': i }} />)}
        </div>

        <div className={s.badge}>
          <svg className={s.ring} viewBox="0 0 100 100" aria-hidden="true">
            <circle className={s.ringTrack} cx="50" cy="50" r="44" />
            <circle className={s.ringFill} cx="50" cy="50" r="44" />
          </svg>
          <span className={s.levelNum}>{level}</span>
        </div>

        <div className={s.kicker}><IconArrowBigUpLines size={13} stroke={2} /> Level up</div>
        <h2 className={s.title}>Level {previousLevel ?? level - 1} → {level}</h2>
        <div className={s.tier}>{tier}</div>

        {gameName && <div className={s.source}>while playing {gameName}</div>}

        <div className={s.stats}>
          <div className={s.stat}>
            <span className={s.statValue}>{Number(totalXp || 0).toLocaleString()}</span>
            <span className={s.statLabel}>total XP</span>
          </div>
          <div className={s.stat}>
            <span className={s.statValue}>{Number(toNextLevel || 0).toLocaleString()}</span>
            <span className={s.statLabel}>to level {level + 1}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
