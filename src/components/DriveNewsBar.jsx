import React, { useEffect, useState } from 'react'
import { IconBrandGoogleDrive, IconX } from '@tabler/icons-react'
import DriveOffer from './DriveOffer'
import { driveNewsText } from '../lib/driveNews'
import s from './UpdateBanner.module.css'

// Another PC on this Google account has something new: a bar at the top, the page stays
// usable. "See what's new" opens the same three questions as a sign-in. Looked for about
// once an hour when no game is running, and said once for each new thing (ipc.js).
export default function DriveNewsBar() {
  const [news, setNews] = useState(null)
  const [offer, setOffer] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    window.kozo?.api?.drive?.news?.().then(r => { if (alive && r?.ok) setNews(r.data) })
    const off = window.kozo?.events?.onDriveNews?.((d) => setNews(d))
    return () => { alive = false; off?.() }
  }, [])

  async function open() {
    setBusy(true)
    const r = await window.kozo?.api?.drive?.offer?.()
    setBusy(false)
    if (r?.ok && r.data?.anything) setOffer(r.data)
    setNews(null)
  }
  function hide() {
    window.kozo?.api?.drive?.newsSeen?.()
    setNews(null)
  }

  return (
    <>
      {news && (
        <div className={s.bar} role="status" data-drive-news="">
          <IconBrandGoogleDrive size={15} stroke={1.8} />
          <span className={s.text}>{driveNewsText(news)}</span>
          <button type="button" className={s.primary} disabled={busy} onClick={open} data-drive-news-open>{busy ? 'Looking…' : "See what's new"}</button>
          <button type="button" className={s.close} onClick={hide} aria-label="Hide" data-drive-news-hide><IconX size={14} /></button>
        </div>
      )}
      {offer && <DriveOffer offer={offer} onClose={() => setOffer(null)} />}
    </>
  )
}
