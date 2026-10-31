import React, { useState } from 'react'
import { IconTrophy } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import GeneratedCover from '../GeneratedCover'
import RatingPicker from '../ui/RatingPicker'
import { fileUrl } from '../../lib/utils'
import s from './RateGameModal.module.css'

// "You finished it, how was it?" Opens whenever a game is marked Finished
// (Library or Game List, see statusSync.announceFinished). 1 to 10, saved on
// the Game List row; Skip leaves any earlier rating as it was.
export default function RateGameModal({ game, onClose }) {
  const [rating, setRating] = useState(game.rating ? Math.round(game.rating) : null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const cover = game.coverPath ? fileUrl(game.coverPath) : game.coverUrl

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
      <div className={s.head}>
        <div className={s.cover}>
          {cover && !failed ? <img src={cover} alt="" onError={() => setFailed(true)} /> : <GeneratedCover name={game.name} compact />}
        </div>
        <div>
          <div className={s.name}>{game.name}</div>
          <div className={s.ask}>How would you rate it?</div>
        </div>
      </div>
      <RatingPicker value={rating} onChange={setRating} />
    </Modal>
  )
}
