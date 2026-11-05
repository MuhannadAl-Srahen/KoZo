import React, { useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconExternalLink, IconNews, IconPlayerPlay } from '@tabler/icons-react'
import EmptyState from './ui/EmptyState'
import { TextSkeleton } from './SteamGameModal'
import { formatDate } from '../lib/utils'
import s from './GameNews.module.css'

// The developer's own Steam announcements, on a game's page (services/steamNews.js
// turns Steam's markup into plain blocks, so nothing here is injected as HTML).

function open(url) { if (url) window.kozo?.api?.shell?.openExternal?.(url) }

function NewsImage({ src }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return <img className={s.image} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

function Blocks({ blocks }) {
  // Lists stay together so they read as lists.
  const out = []
  blocks.forEach((b, i) => {
    if (b.type === 'li') {
      const last = out[out.length - 1]
      if (last?.type === 'ul') last.items.push(b.text)
      else out.push({ type: 'ul', items: [b.text], key: i })
    } else out.push({ ...b, key: i })
  })
  return (
    <div className={s.blocks}>
      {out.map(b => {
        if (b.type === 'h') return <h4 key={b.key} className={s.h}>{b.text}</h4>
        if (b.type === 'ul') return <ul key={b.key} className={s.list}>{b.items.map((t, i) => <li key={i}>{t}</li>)}</ul>
        if (b.type === 'img') return <NewsImage key={b.key} src={b.src} />
        if (b.type === 'link') {
          const video = /youtube\.com/.test(b.href)
          return (
            <button key={b.key} type="button" className={s.inlineLink} onClick={() => open(b.href)}>
              {video ? <IconPlayerPlay size={13} /> : <IconExternalLink size={13} />} {b.text}
            </button>
          )
        }
        return <p key={b.key} className={s.p}>{b.text}</p>
      })}
    </div>
  )
}

function Chips({ n, isNew }) {
  return (
    <>
      {isNew && <span className={`${s.chip} ${s.chipNew}`}>New</span>}
      {n.patch && <span className={s.chip}>Patch notes</span>}
    </>
  )
}

// Headlines for the Overview's "Since you last played".
export function NewsHeadlines({ items, onOpen }) {
  return (
    <div className={s.headlines}>
      {items.map(n => (
        <button key={n.id} type="button" className={s.headline} data-gpnav onClick={() => onOpen(n.id)}>
          <span className={s.headlineTitle} title={n.title}>{n.title}</span>
          <Chips n={n} />
          <span className={s.date}>{formatDate(new Date(n.date).toISOString())}</span>
        </button>
      ))}
    </div>
  )
}

function NewsItem({ n, isNew, startOpen }) {
  const [opened, setOpened] = useState(startOpen)
  const ref = useRef(null)
  useEffect(() => {
    if (startOpen) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [startOpen])
  return (
    <article ref={ref} className={s.item}>
      <button type="button" className={s.itemHead} data-gpnav aria-expanded={opened} onClick={() => setOpened(v => !v)}>
        <span className={s.itemMeta}>
          <span className={s.date}>{formatDate(new Date(n.date).toISOString())}</span>
          <Chips n={n} isNew={isNew} />
        </span>
        <span className={s.itemTitle}>{n.title}</span>
        {!opened && n.excerpt && <span className={s.excerpt}>{n.excerpt}</span>}
        <IconChevronDown size={16} className={`${s.chevron} ${opened ? s.chevronUp : ''}`} />
      </button>
      {opened && (
        <div className={s.itemBody}>
          <Blocks blocks={n.blocks} />
          {n.url && (
            <button type="button" className={s.steamBtn} data-gpnav onClick={() => open(n.url)}>
              <IconExternalLink size={14} /> Open on Steam
            </button>
          )}
        </div>
      )}
    </article>
  )
}

export default function GameNews({ items, lastEnded, openId }) {
  if (items === undefined) {
    return (
      <div className={s.list0}>
        {[0, 1, 2].map(i => <div key={i} className={s.item}><div className={s.itemHead}><TextSkeleton lines={3} /></div></div>)}
      </div>
    )
  }
  if (!items?.length) {
    return <EmptyState Icon={IconNews} title="No news" desc="The developers haven't posted any news on Steam, or Steam didn't answer just now." />
  }
  return (
    <div className={s.list0}>
      {items.map(n => (
        <NewsItem key={n.id} n={n} isNew={!!lastEnded && n.date > lastEnded} startOpen={openId === n.id} />
      ))}
    </div>
  )
}
