import React, { useState, useEffect, useRef } from 'react'
import { IconTrophy, IconX, IconArrowBigUpLines } from '@tabler/icons-react'
import s from './AchievementToast.module.css'

const DISPLAY_MS = 6000

export default function AchievementToast() {
  const [queue, setQueue] = useState([])  // [{ id, achievement, gameName }]
  const nextId = useRef(0)

  useEffect(() => {
    if (!window.kozo?.events?.onAchievementUnlocked) return
    window.kozo.events.onAchievementUnlocked(({ achievements, gameName }) => {
      const list = achievements || []
      if (list.length === 0) return
      // Many at once (e.g. a long session synced in one go) → one summary card,
      // not a flood of individual toasts.
      if (list.length > 3) {
        setQueue(q => [...q, {
          id: ++nextId.current,
          summary: { count: list.length, first: list[0] },
          gameName: gameName || '',
        }])
        return
      }
      const toasts = list.map(ach => ({
        id: ++nextId.current,
        ach,
        gameName: gameName || '',
      }))
      setQueue(q => [...q, ...toasts])
    })
    // Level-up celebration — one card per level-up, mixed into the same stack.
    window.kozo?.events?.onXpLevelUp?.((data) => {
      setQueue(q => [...q, { id: ++nextId.current, levelUp: data }])
    })
    // Cleanup so StrictMode's double-mount doesn't register the listener twice.
    return () => {
      window.kozo?.events?.removeAll?.('achievement:unlocked')
      window.kozo?.events?.removeAll?.('xp:levelup')
    }
  }, [])

  function dismiss(id) {
    setQueue(q => q.filter(t => t.id !== id))
  }

  if (queue.length === 0) return null

  return (
    <div className={s.stack}>
      {queue.slice(0, 4).map((toast, idx) => (
        <Toast
          key={toast.id}
          toast={toast}
          onDismiss={() => dismiss(toast.id)}
          stacked={idx > 0}
        />
      ))}
    </div>
  )
}

function Toast({ toast, onDismiss, stacked }) {
  const [progress, setProgress] = useState(100)
  const [leaving, setLeaving]   = useState(false)

  useEffect(() => {
    const start  = Date.now()
    const tick   = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - start) / DISPLAY_MS) * 100)
      setProgress(pct)
      if (pct <= 0) clearInterval(tick)
    }, 50)

    const timer = setTimeout(() => {
      setLeaving(true)
      setTimeout(onDismiss, 380)
    }, DISPLAY_MS)

    return () => { clearInterval(tick); clearTimeout(timer) }
  }, [])

  const { ach, gameName, summary, levelUp } = toast

  if (levelUp) {
    return (
      <div className={`${s.toast} ${leaving ? s.toastOut : s.toastIn} ${stacked ? s.stacked : ''}`}>
        <div className={s.header}>
          <IconArrowBigUpLines size={11} stroke={2} className={s.headerIcon} />
          <span className={s.headerText}>Level Up!</span>
          <button className={s.close} onClick={() => { setLeaving(true); setTimeout(onDismiss, 380) }}>
            <IconX size={11} stroke={2.5} />
          </button>
        </div>
        <div className={s.body}>
          <div className={`${s.iconWrap} ${s.iconFallback}`}>
            <span className={s.levelNumber}>{levelUp.level}</span>
          </div>
          <div className={s.info}>
            <div className={s.achName}>Level {levelUp.level} — {levelUp.tier}</div>
            <div className={s.achDesc}>{(levelUp.totalXp ?? 0).toLocaleString()} XP total. See your Profile for the breakdown.</div>
          </div>
        </div>
        <div className={s.progressBar}>
          <div className={s.progressFill} style={{ width: `${progress}%` }} />
        </div>
      </div>
    )
  }

  const headerText = summary ? `${summary.count} Achievements Unlocked` : 'Achievement Unlocked'
  const displayAch = summary ? summary.first : ach
  const hasIcon = !!displayAch?.icon_url

  return (
    <div className={`${s.toast} ${leaving ? s.toastOut : s.toastIn} ${stacked ? s.stacked : ''}`}>
      <div className={s.header}>
        <IconTrophy size={11} stroke={2} className={s.headerIcon} />
        <span className={s.headerText}>{headerText}</span>
        <button className={s.close} onClick={() => { setLeaving(true); setTimeout(onDismiss, 380) }}>
          <IconX size={11} stroke={2.5} />
        </button>
      </div>

      <div className={s.body}>
        <div className={`${s.iconWrap} ${hasIcon ? '' : s.iconFallback}`}>
          {hasIcon
            ? <img src={displayAch.icon_url} alt="" className={s.achIcon} onError={e => { e.target.style.display = 'none' }} />
            : <IconTrophy size={26} stroke={1.3} />
          }
        </div>
        <div className={s.info}>
          {summary ? (
            <>
              <div className={s.achName}>{summary.count} unlocked</div>
              <div className={s.achDesc}>Including “{summary.first.display_name || summary.first.steam_api_name}”</div>
              <div className={s.gameName}>{gameName}</div>
            </>
          ) : (
            <>
              <div className={s.achName}>{ach.display_name || ach.steam_api_name}</div>
              {ach.description && <div className={s.achDesc}>{ach.description}</div>}
              <div className={s.gameName}>{gameName}</div>
            </>
          )}
        </div>
      </div>

      <div className={s.progressBar}>
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}
