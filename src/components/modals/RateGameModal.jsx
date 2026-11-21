import React, { useEffect, useState } from 'react'
import { IconTrophy, IconClock } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import GeneratedCover from '../GeneratedCover'
import RatingPicker from '../ui/RatingPicker'
import { fileUrl, formatPlaytime } from '../../lib/utils'
import s from './RateGameModal.module.css'

// "You finished it, how was it?" Opens whenever a game is marked Finished
// (Library or Game List, see statusSync.announceFinished). 1 to 10, saved on
// the Game List row; Skip leaves any earlier rating as it was. It is the only window
// a finish opens: the game page used to stack a "Marked as finished" box on top of it
// (the maker: "when I mark it as finished it looks bad"), so what that said is here.
export default function RateGameModal({ game, onClose }) {
  const [rating, setRating] = useState(game.rating ? Math.round(game.rating) : null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [stats, setStats] = useState(null)   // { seconds, unlocked, total } for a Library game
  const cover = game.coverPath ? fileUrl(game.coverPath) : game.coverUrl

  useEffect(() => {
    if (!game.gameId) return
    let alive = true
    Promise.all([
      window.kozo?.api?.games?.get?.(Number(game.gameId)),
      window.kozo?.api?.achievements?.listForGame?.(Number(game.gameId)),
    ]).then(([g, a]) => {
      if (!alive) return
      const list = a?.ok ? a.data || [] : []
      setStats({
        seconds: g?.ok ? g.data?.total_playtime_seconds || 0 : 0,
        unlocked: list.filter(x => x.unlock_id != null || x.unlocked_at).length,
        total: list.length,
      })
    }).catch(() => {})
    return () => { alive = false }
  }, [game.gameId])

  async function save() {
    if (!rating) return
    setSaving(true)
    await window.kozo?.api?.gameList?.rate?.({ listId: game.listId, gameId: game.gameId }, rating)
    setSaving(false)
    onClose()
  }

  return (
    <Modal
      title="Finished!"
      icon={<IconTrophy size={17} stroke={1.6} />}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className={ms.btnCancel} onClick={onClose}>Skip</button>
          <button className={ms.btnPrimary} onClick={save} disabled={!rating || saving}>
            {saving ? 'Saving…' : 'Save rating'}
          </button>
        </>
      }
    >
      <div className={s.hero} data-finished>
        {cover && !failed && <img className={s.backdrop} src={cover} alt="" aria-hidden="true" />}
        <div className={s.cover}>
          {cover && !failed ? <img src={cover} alt="" onError={() => setFailed(true)} /> : <GeneratedCover name={game.name} compact />}
        </div>
        <div className={s.info}>
          <div className={s.kicker}><IconTrophy size={13} stroke={2} /> You finished</div>
          <div className={s.name}>{game.name}</div>
          {stats && (stats.seconds > 0 || stats.total > 0) && (
            <div className={s.stats}>
              {stats.seconds > 0 && <span><IconClock size={13} /> {formatPlaytime(stats.seconds)} played</span>}
              {stats.total > 0 && <span><IconTrophy size={13} /> {stats.unlocked} of {stats.total} achievements</span>}
            </div>
          )}
          <div className={s.note}>It's on your Finished page and counts toward your XP.</div>
        </div>
      </div>
      <div className={s.ask}>How would you rate it?</div>
      <RatingPicker value={rating} onChange={setRating} />
    </Modal>
  )
}
