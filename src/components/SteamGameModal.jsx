import React, { useEffect, useState } from 'react'
import { IconBrandSteam, IconCalendar, IconClock, IconTag, IconUsers } from '@tabler/icons-react'
import Modal from './ui/Modal'
import MediaGallery from './ui/MediaGallery'
import { PanelSkeleton } from './ui/Skeleton'
import s from './SteamGameModal.module.css'

// One store-style game popup, shared by the Steam calendar and My upcoming:
// a media gallery (hero art + screenshots, full-screen on click), release and
// countdown, price, genres, developer, description and Steam categories.
// `actions` renders in the footer next to "Steam page".
export default function SteamGameModal({ appId, name, release, countdown, art, fallbackArt = [], onClose, actions }) {
  const [details, setDetails] = useState(undefined)   // undefined = loading, null = unavailable

  useEffect(() => {
    let alive = true
    if (!appId) { setDetails(null); return }
    window.kozo?.api?.steam?.storeDetails?.(appId).then(res => { if (alive) setDetails(res?.ok ? res.data : null) })
    return () => { alive = false }
  }, [appId])

  const lead = [art?.hero, art?.capsule, art?.header, ...fallbackArt].filter(Boolean)
  const media = [
    ...(lead.length ? [{ thumb: art?.capsule || art?.header || lead[0], full: lead[0] }] : []),
    ...(details?.media || []),
  ]

  return (
    <Modal
      title={name}
      icon={<IconBrandSteam size={17} stroke={1.6} />}
      onClose={onClose}
      width={860}
      footer={
        <div className={s.footer}>
          {appId && (
            <button className={s.ghostBtn} onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${appId}`)}>
              <IconBrandSteam size={14} /> Steam page
            </button>
          )}
          <div className={s.spacer} />
          {actions}
        </div>
      }
    >
      <div className={s.layout}>
        <div className={s.mediaCol}>
          {media.length > 0
            ? <MediaGallery items={media} />
            : <div className={s.noMedia}><IconBrandSteam size={28} /></div>}
        </div>

        <div className={s.infoCol}>
          {countdown && <div className={s.countdown}><IconClock size={14} /> {countdown}</div>}
          <div className={s.facts}>
            <div className={s.fact}>
              <IconCalendar size={14} />
              <span className={s.factLabel}>Release</span>
              <strong>{release || details?.release_date || 'To be announced'}</strong>
            </div>
            {details?.price && (
              <div className={s.fact}>
                <IconTag size={14} />
                <span className={s.factLabel}>Price</span>
                <strong className={s.price}>{details.price}</strong>
              </div>
            )}
            {details?.developers?.length > 0 && (
              <div className={s.fact}>
                <IconUsers size={14} />
                <span className={s.factLabel}>Developer</span>
                <strong>{details.developers.join(', ')}</strong>
              </div>
            )}
          </div>

          {details?.genres?.length > 0 && (
            <div className={s.chips}>{details.genres.map(g => <span key={g} className={s.chip}>{g}</span>)}</div>
          )}

          {details === undefined && <PanelSkeleton lines={4} />}
          {details?.description && <p className={s.desc}>{details.description}</p>}
          {details === null && <p className={s.muted}>Steam has no store details for this game yet.</p>}

          {details?.categories?.length > 0 && (
            <div className={s.chips}>{details.categories.map(c => <span key={c} className={s.chipMuted}>{c}</span>)}</div>
          )}
        </div>
      </div>
    </Modal>
  )
}
