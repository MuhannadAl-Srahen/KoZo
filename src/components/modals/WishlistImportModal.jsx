import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconBrandSteam, IconCheck, IconExternalLink, IconRefresh, IconSettings } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import { Skeleton } from '../ui/Skeleton'
import GeneratedCover from '../GeneratedCover'
import { LIST_STATUSES } from '../../lib/cardModel'
import s from './WishlistImportModal.module.css'

const PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings'

// Steam wishlist into the Game List (services/wishlist.js). It only runs when you
// press the button, and you choose what comes in. Running it again offers only
// what's new, so nothing already on the list changes.
export default function WishlistImportModal({ onClose, onImported }) {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [picked, setPicked] = useState(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function load() {
    setData(null)
    setError(null)
    window.kozo?.api?.gameList?.wishlistPreview?.().then((res) => {
      const d = res?.ok ? res.data : { state: 'failed', error: res?.error, items: [] }
      setData(d)
      setPicked(new Set(d.items.map(i => i.appid)))
    })
  }
  useEffect(load, [])

  const items = data?.items || []
  const counts = useMemo(() => {
    const chosen = items.filter(i => picked.has(i.appid))
    return { all: chosen.length, upcoming: chosen.filter(i => i.status === 'upcoming').length }
  }, [items, picked])

  function toggle(id) {
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function add() {
    setSaving(true)
    setError(null)
    const res = await window.kozo?.api?.gameList?.wishlistImport?.([...picked])
    setSaving(false)
    if (res?.ok) onImported?.(res.data.added)
    else setError(res?.error || 'Could not add the games.')
  }

  const message = data && {
    not_connected: {
      title: 'Connect Steam first',
      desc: 'KoZo needs to know your Steam account to read its wishlist.',
      button: <button className={ms.btnPrimary} onClick={() => { onClose(); navigate('/settings?tab=accounts') }}><IconSettings size={14} /> Open Connections</button>,
    },
    empty: {
      title: 'No wishlist games found',
      desc: 'Your Steam wishlist is empty, or your profile keeps it private. Steam answers the same for both, so if you have one, set Game details to Public in your Steam privacy settings.',
      button: <button className={ms.btnGhost} onClick={() => window.kozo?.api?.shell?.openExternal?.(PRIVACY_URL)}><IconExternalLink size={14} /> Steam privacy settings</button>,
    },
    nothing_new: {
      title: 'Nothing new',
      desc: `All ${data.total === 1 ? 'of your 1 wishlist game is' : `${data.total} wishlist games are`} already on your Game List or in your Library.`,
    },
    failed: {
      title: "Steam didn't answer",
      desc: 'Check your connection and try again.',
      button: <button className={ms.btnPrimary} onClick={load}><IconRefresh size={14} /> Try again</button>,
    },
  }[data.state]

  return (
    <Modal
      title="Steam wishlist"
      icon={<IconBrandSteam size={17} stroke={1.6} />}
      onClose={onClose}
      width={620}
      footer={
        <div className={s.footer}>
          {items.length > 0 && (
            <button type="button" className={s.linkBtn} onClick={() => setPicked(counts.all === items.length ? new Set() : new Set(items.map(i => i.appid)))}>
              {counts.all === items.length ? 'Select none' : 'Select all'}
            </button>
          )}
          <div className={s.spacer} />
          <button className={ms.btnCancel} onClick={onClose}>{items.length ? 'Cancel' : 'Close'}</button>
          {items.length > 0 && (
            <button className={ms.btnPrimary} disabled={saving || counts.all === 0} onClick={add}>
              {saving ? 'Adding...' : `Add ${counts.all} ${counts.all === 1 ? 'game' : 'games'}`}
            </button>
          )}
        </div>
      }
    >
      {!data && (
        <div className={s.rows} aria-busy="true">
          {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} w="100%" h={56} r={8} />)}
        </div>
      )}

      {message && (
        <div className={s.message} data-wishlist-state={data.state}>
          <div className={s.messageTitle}>{message.title}</div>
          <p className={s.messageDesc}>{message.desc}</p>
          {message.button}
        </div>
      )}

      {items.length > 0 && (
        <>
          <p className={s.lead}>
            {data.total} on your wishlist, {items.length} not on your Game List yet.
            {' '}Games not out yet become Upcoming, so KoZo tells you when they release. The rest become Want to play.
          </p>
          <div className={s.rows} data-wishlist-state="ok">
            {items.map((g) => {
              const on = picked.has(g.appid)
              return (
                <button key={g.appid} type="button" role="checkbox" aria-checked={on} data-gpnav
                  className={`${s.row} ${on ? s.rowOn : ''}`} onClick={() => toggle(g.appid)}>
                  <span className={`${s.tick} ${on ? s.tickOn : ''}`}>{on && <IconCheck size={13} stroke={3} />}</span>
                  <span className={s.art}>
                    {g.wide ? <img src={g.wide} alt="" loading="lazy" decoding="async" /> : <GeneratedCover name={g.name} compact />}
                  </span>
                  <span className={s.info}>
                    <span className={s.name} title={g.name}>{g.name}</span>
                    <span className={s.sub}>{LIST_STATUSES[g.status]?.label}{g.release ? `, ${g.release}` : ''}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
      {error && <p className={s.error}>{error}</p>}
    </Modal>
  )
}
