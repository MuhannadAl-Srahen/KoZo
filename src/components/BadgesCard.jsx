import React, { useEffect, useState } from 'react'
import {
  IconAward, IconDiamond, IconTrophy, IconStars, IconCrown, IconCircleCheck, IconChecklist, IconFlag,
  IconFlag3, IconRepeat, IconCalendarCheck, IconCompass, IconClockHour4, IconHourglass, IconRun,
  IconFlame, IconBolt, IconMoon, IconLock,
} from '@tabler/icons-react'
import s from './BadgesCard.module.css'

// Profile badges (services/badges.js): KoZo's own trophies, earned ones in color, the rest
// dimmed with how far along you are. The maker asked for "First Ultra Rare", "100 hours
// club", "Finished 10 games".
const ICONS = {
  'first-ultra': IconDiamond, 'ultra-10': IconCrown, 'ach-100': IconTrophy, 'ach-500': IconStars, 'ach-1000': IconAward,
  'perfect-1': IconCircleCheck, 'perfect-5': IconChecklist, 'finish-1': IconFlag, 'finish-10': IconFlag3, 'finish-25': IconFlag3,
  replay: IconRepeat, planner: IconCalendarCheck, explorer: IconCompass, 'club-100': IconClockHour4, 'hours-500': IconHourglass,
  marathon: IconRun, 'streak-7': IconFlame, 'streak-30': IconBolt, 'night-owl': IconMoon,
}

let cache = null

export default function BadgesCard() {
  const [data, setData] = useState(cache)

  useEffect(() => {
    let alive = true
    const load = () => window.kozo?.api?.stats?.badges?.().then(r => { if (alive && r?.ok) { cache = r.data; setData(r.data) } })
    load()
    const ev = window.kozo?.events
    const offs = [ev?.onBadgeEarned?.(load), ev?.onAchievementUnlocked?.(load), ev?.onGameUpdated?.(load)]
    return () => { alive = false; for (const off of offs) { try { off?.() } catch {} } }
  }, [])

  if (!data?.list?.length) return null
  // Earned first, then the closest to being earned.
  const list = [...data.list].sort((a, b) => (b.earned - a.earned) || (b.have / b.need - a.have / a.need))

  return (
    <div className={s.card} data-badges="">
      <div className={s.head}>
        <span className={s.title}><IconAward size={14} stroke={1.8} /> Badges</span>
        <span className={s.note}>{data.earned} of {data.total} earned</span>
      </div>
      <div className={s.grid}>
        {list.map(b => {
          const Icon = ICONS[b.key] || IconAward
          const pct = Math.round((b.have / b.need) * 100)
          return (
            <div key={b.key} className={`${s.badge} ${b.earned ? s.earned : s.locked}`} title={b.desc} data-badge={b.key} data-earned={b.earned ? '1' : '0'}>
              <span className={s.icon}>
                <Icon size={20} stroke={1.7} />
                {!b.earned && <span className={s.lock}><IconLock size={9} stroke={2.4} /></span>}
              </span>
              <span className={s.text}>
                <b className={s.name}>{b.name}</b>
                <span className={s.desc}>{b.desc}</span>
                {!b.earned && b.need > 1 && (
                  <span className={s.progress}>
                    <span className={s.bar}><span style={{ width: `${pct}%` }} /></span>
                    <span className={s.count}>{b.have.toLocaleString()} / {b.need.toLocaleString()}</span>
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
