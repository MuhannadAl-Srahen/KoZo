import React from 'react'
import { IconTrophy } from '@tabler/icons-react'
import AchImg from './ui/AchImg'
import { formatPlaytime, rarityColor } from '../lib/utils'
import { clockTime, sessionGroups } from '../lib/sessionDetail'
import s from './SessionDetail.module.css'

// What happened in one session, opened right under its row on a game's Sessions tab:
// when it ran, played and paused time, and what was earned, in the order it came.

const MIN_PAUSE_SEC = 60
const PAUSE_HINT = "Time you were away or in another app. KoZo didn't count it."

function Unlock({ ach, onOpen }) {
  return (
    <button type="button" className={s.ach} onClick={() => onOpen(ach)}>
      <span className={s.achIcon}><AchImg src={ach.icon_url} loading="lazy" fallback={<IconTrophy size={16} />} /></span>
      <span className={s.achText}>
        <span className={s.achName}>{ach.display_name}</span>
        {ach.description && <span className={s.achDesc}>{ach.description}</span>}
      </span>
      {ach.global_unlock_percent != null && (
        <span className={s.achPct} style={{ '--rar': rarityColor(ach.global_unlock_percent) || undefined }} title="Players who have it">
          {Number(ach.global_unlock_percent).toFixed(1)}%
        </span>
      )}
      {ach.unlocked_at && <span className={s.achTime}>{clockTime(ach.unlocked_at)}</span>}
    </button>
  )
}

export default function SessionDetail({ session, achievements, onOpenAchievement }) {
  const { paused, unlocks } = sessionGroups([session], achievements).groups[0]
  const running = !session.ended_at
  return (
    <div className={s.detail} data-session-detail={session.id}>
      <p className={s.line} title={!running && paused >= MIN_PAUSE_SEC ? PAUSE_HINT : undefined}>
        {running
          ? `Started ${clockTime(session.started_at)}, still running`
          : <>{clockTime(session.started_at)} to {clockTime(session.ended_at)}, {formatPlaytime(session.duration_seconds)} played{paused >= MIN_PAUSE_SEC && `, ${formatPlaytime(paused)} paused`}</>}
      </p>
      {unlocks.length === 0
        ? <p className={s.none}>Nothing unlocked in this session.</p>
        : <div className={s.list}>{unlocks.map(a => <Unlock key={a.id} ach={a} onOpen={onOpenAchievement} />)}</div>}
    </div>
  )
}
