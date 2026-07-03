import React, { useState } from 'react'
import { IconTrophy, IconLock, IconCheck, IconStar } from '@tabler/icons-react'
import Modal from '../ui/Modal'
import { rarityLabel, formatDateTime } from '../../lib/utils'
import s from './AchievementModal.module.css'

export default function AchievementModal({ achievement: initialAch, game, onClose, onToggle }) {
  const [ach, setAch] = useState(initialAch)
  const [busy, setBusy] = useState(false)
  const unlocked = !!ach.unlocked_at
  const rarity = rarityLabel(ach.global_unlock_percent)

  async function toggle() {
    setBusy(true)
    // toggleManual routes an unlock through the same flow as a real detected one
    // (overlay toast, notification, XP check) — with a legacy fallback.
    let updated
    const res = await (window.kozo.api.achievements.toggleManual
      ? window.kozo.api.achievements.toggleManual(ach.id)
      : Promise.resolve(null))
    if (res?.ok) {
      updated = res.data.unlocked
        ? { ...ach, unlocked_at: res.data.unlocked_at, unlock_source: 'manual' }
        : { ...ach, unlocked_at: null, unlock_source: null }
    } else if (unlocked) {
      await window.kozo.api.achievements.removeUnlock(ach.id)
      updated = { ...ach, unlocked_at: null, unlock_source: null }
    } else {
      const now = new Date().toISOString()
      await window.kozo.api.achievements.addUnlock({
        achievement_id: ach.id, session_id: null, unlocked_at: now, source: 'manual',
      })
      updated = { ...ach, unlocked_at: now, unlock_source: 'manual' }
    }
    setAch(updated)
    onToggle?.(updated)
    setBusy(false)
  }

  return (
    <Modal
      title={ach.display_name}
      icon={<IconTrophy size={16} stroke={1.6} />}
      onClose={onClose}
      width={420}
      footer={
        <button
          className={unlocked ? s.btnLock : s.btnUnlock}
          onClick={toggle}
          disabled={busy}
        >
          {unlocked
            ? <><IconLock size={13} stroke={1.8} /> Mark as Locked</>
            : <><IconCheck size={13} stroke={2.5} /> Mark as Unlocked</>
          }
        </button>
      }
    >
      <div className={s.body}>
        <div className={`${s.iconWrap} ${unlocked ? s.iconUnlocked : s.iconLocked}`}>
          {ach.icon_url
            ? <img src={ach.icon_url} alt="" className={s.iconImg} />
            : <IconTrophy size={44} stroke={1.1} style={{ color: unlocked ? 'var(--a)' : 'var(--text-muted)' }} />
          }
          {unlocked && (
            <div className={s.checkBadge}>
              <IconCheck size={11} stroke={3} />
            </div>
          )}
        </div>

        {ach.description && (
          <p className={s.desc}>{ach.description}</p>
        )}

        <div className={s.meta}>
          {rarity && (
            <span className={`${s.rarityBadge} ${s[`rarity${rarity.replace(/\s/g, '')}`]}`}>
              <IconStar size={9} stroke={1.6} />
              {rarity}
            </span>
          )}
          {ach.global_unlock_percent != null && (
            <span className={s.pct}>
              {Number(ach.global_unlock_percent).toFixed(1)}% of players
            </span>
          )}
        </div>

        {unlocked && ach.unlocked_at && (
          <div className={s.unlockedAt}>
            <IconCheck size={12} stroke={2.5} style={{ color: 'var(--a)' }} />
            Unlocked {formatDateTime(ach.unlocked_at)}
            {ach.unlock_source === 'manual' && (
              <span className={s.sourceTag}>manual</span>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
