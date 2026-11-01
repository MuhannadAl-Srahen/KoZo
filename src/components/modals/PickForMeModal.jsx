import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconDice5, IconPlayerPlayFilled, IconDeviceGamepad2, IconRefresh, IconListCheck } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import GeneratedCover from '../GeneratedCover'
import InfoModal from '../ui/InfoModal'
import { fileUrl, monthKey } from '../../lib/utils'
import { scoreCandidates, pickWeighted } from '../../lib/pickForMe'
import s from './PickForMeModal.module.css'

// "Pick for me": one game from Up next (this month's first, else all of Want
// to play), weighted by your favourite genres. A short shuffle of covers lands
// on the pick; Play now starts it, Start playing moves it to Playing.

function coverOf(item) {
  return item.banner_url || (item.game_banner_local_path ? fileUrl(item.game_banner_local_path) : null)
}

function Cover({ item }) {
  const [failed, setFailed] = useState(false)
  const src = coverOf(item)
  return src && !failed
    ? <img src={src} alt="" decoding="async" onError={() => setFailed(true)} />
    : <GeneratedCover name={item.name} />
}

const SHUFFLE_STEPS = 9

export default function PickForMeModal({ onClose, onChanged }) {
  const navigate = useNavigate()
  const [scored, setScored] = useState(null)   // null = loading
  const [pick, setPick] = useState(null)
  const [shuffle, setShuffle] = useState(null) // the cover flashing during the shuffle
  const [launchMsg, setLaunchMsg] = useState(null)
  const [moved, setMoved] = useState(false)
  const timers = useRef([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [listRes, tasteRes, gamesRes] = await Promise.all([
        window.kozo?.api?.gameList?.list?.({ status: 'want_to_play', limit: 5000 }),
        window.kozo?.api?.steam?.tasteProfile?.(),
        window.kozo?.api?.games?.list?.(),
      ])
      if (!alive) return
      const rows = listRes?.ok ? (listRes.data?.items || listRes.data || []) : []
      const thisMonth = rows.filter(r => r.planned_month === monthKey(new Date()))
      const pool = thisMonth.length ? thisMonth : rows
      const playableIds = new Set((gamesRes?.ok ? gamesRes.data || [] : [])
        .filter(g => !g.is_archived && g.is_installed !== 0 && (g.exe_name || g.launch_file || g.launch_uri || g.steam_app_id))
        .map(g => g.id))
      const sc = scoreCandidates(pool, tasteRes?.ok ? tasteRes.data?.weights || {} : {}, { playableIds })
      setScored(sc)
      roll(sc, null)
    })()
    return () => { alive = false; timers.current.forEach(clearTimeout) }
  }, [])

  function roll(sc = scored, avoid = pick?.item.id ?? null) {
    if (!sc?.length) return
    timers.current.forEach(clearTimeout)
    timers.current = []
    setMoved(false)
    const chosen = pickWeighted(sc, Math.random, avoid)
    const quick = document.documentElement.hasAttribute('data-inactive') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (quick || sc.length < 2) { setShuffle(null); setPick(chosen); return }
    setPick(null)
    // Flash a few random covers, slowing down, then land on the pick.
    let delay = 0
    for (let i = 0; i < SHUFFLE_STEPS; i++) {
      delay += 60 + i * 18
      const any = sc[Math.floor(Math.random() * sc.length)]
      timers.current.push(setTimeout(() => setShuffle(any.item), delay))
    }
    timers.current.push(setTimeout(() => { setShuffle(null); setPick(chosen) }, delay + 160))
  }

  async function playNow() {
    const res = await window.kozo?.api?.games?.launch?.(pick.item.game_id)
    if (!res?.ok) { setLaunchMsg({ variant: 'error', title: "Couldn't start the game", message: res?.error || 'KoZo could not start this game.' }); return }
    await startPlaying(true)
    onClose()
  }

  async function startPlaying(silent) {
    await window.kozo?.api?.gameList?.update?.(pick.item.id, { status: 'playing' })
    onChanged?.()
    if (!silent) setMoved(true)
  }

  const shown = pick?.item || shuffle
  const empty = scored && scored.length === 0

  return (
    <Modal
      title="Pick for me"
      icon={<IconDice5 size={16} stroke={1.8} />}
      onClose={onClose}
      width={460}
      footer={empty ? (
        <button type="button" className={ms.btnPrimary} onClick={() => { onClose(); navigate('/game-list') }}>
          <IconListCheck size={14} /> Open Game List
        </button>
      ) : (
        <>
          <button type="button" className={ms.btnCancel} onClick={() => roll()} disabled={!pick || scored.length < 2}>
            <IconRefresh size={14} /> Roll again
          </button>
          {pick?.playable ? (
            <button type="button" className={ms.btnPrimary} onClick={playNow} data-autofocus="">
              <IconPlayerPlayFilled size={14} /> Play now
            </button>
          ) : (
            <button type="button" className={ms.btnPrimary} onClick={() => startPlaying(false)} disabled={!pick || moved}>
              <IconDeviceGamepad2 size={14} /> {moved ? 'Moved to Playing' : 'Start playing'}
            </button>
          )}
        </>
      )}
    >
      {empty ? (
        <div className={s.empty}>
          <IconDice5 size={36} stroke={1.4} />
          <div className={s.emptyTitle}>Nothing in Up next yet</div>
          <div className={s.emptyText}>Add games you want to play to your Game List and KoZo picks one for you.</div>
        </div>
      ) : (
        <div className={s.stage}>
          <div className={`${s.cover} ${pick ? s.landed : ''}`}>
            {shown ? <Cover key={shown.id} item={shown} /> : <div className={s.coverWait} />}
          </div>
          <div className={s.info}>
            {pick ? (
              <>
                <div className={s.name}>{pick.item.name}</div>
                <div className={s.because}>
                  {pick.because.length
                    ? <>Because you like <strong>{pick.because.join(' and ')}</strong></>
                    : 'Something different this time'}
                </div>
                <div className={s.tags}>
                  {pick.playable && <span className={s.tagReady}>Ready to play</span>}
                  {pick.item.planned_month === monthKey(new Date()) && <span className={s.tag}>Planned this month</span>}
                  {!!pick.item.is_favorite && <span className={s.tag}>Favourite</span>}
                </div>
                <div className={s.from}>Picked from {scored.length} game{scored.length === 1 ? '' : 's'} in Up next</div>
              </>
            ) : (
              <div className={s.rolling}>Picking…</div>
            )}
          </div>
        </div>
      )}
      {launchMsg && <InfoModal {...launchMsg} onClose={() => setLaunchMsg(null)} />}
    </Modal>
  )
}
