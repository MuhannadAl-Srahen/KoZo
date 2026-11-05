import React, { useEffect, useMemo, useState } from 'react'
import {
  IconBrandSteam, IconCalendar, IconClock, IconTag, IconUsers, IconSparkles, IconThumbUp,
  IconTrophy, IconDeviceGamepad2, IconLanguage, IconPuzzle, IconDeviceDesktop, IconBuilding,
} from '@tabler/icons-react'
import Modal from './ui/Modal'
import MediaGallery from './ui/MediaGallery'
import { PanelSkeleton, Skeleton } from './ui/Skeleton'
import s from './SteamGameModal.module.css'

// One store-style game popup, shared by the Steam calendar and My upcoming.
// Tabs: Overview (trailers + screenshots, key facts, reviews, description),
// About (the store's full description), Details (every fact) and System
// requirements. `actions` renders in the footer next to "Steam page".
// The Game List adds its own: `extraTab` { key, label, node } (or a list), `overviewTop`
// (above the facts), `chips`, `footerLeft`, and a parent-held `tab` / `onTab`.

// Steam's descriptions are HTML: keep text, lists, headings and images only.
const ALLOWED = new Set(['P', 'BR', 'UL', 'OL', 'LI', 'STRONG', 'B', 'I', 'EM', 'U', 'H1', 'H2', 'H3', 'H4', 'H5', 'IMG', 'SPAN', 'DIV'])
function cleanHtml(html) {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (!ALLOWED.has(el.tagName)) {
        // Links and the like keep their text; scripts and the rest go.
        if (['A', 'BDI', 'TABLE', 'TBODY', 'TR', 'TD'].includes(el.tagName)) { walk(el); el.replaceWith(...el.childNodes); continue }
        el.remove(); continue
      }
      for (const a of [...el.attributes]) {
        if (!(el.tagName === 'IMG' && a.name === 'src' && /^https:\/\//.test(a.value))) el.removeAttribute(a.name)
      }
      if (el.tagName === 'IMG') el.setAttribute('loading', 'lazy')
      walk(el)
    }
  }
  const root = doc.body.firstChild
  walk(root)
  return root.innerHTML
}

function Html({ html, className }) {
  const clean = useMemo(() => cleanHtml(html), [html])
  if (!clean) return null
  return <div className={`${s.html} ${className || ''}`} dangerouslySetInnerHTML={{ __html: clean }} />
}

// Every fact Steam has, as cards (Details tab here, About tab on Game Detail).
export function factsOf(details, reviews, release) {
  if (!details) return []
  const reviewPct = reviews?.total ? Math.round((reviews.positive / reviews.total) * 100) : null
  return [
    { Icon: IconCalendar, label: 'Release', value: release || details.release_date || 'To be announced' },
    details.price && { Icon: IconTag, label: 'Price', value: details.price, cls: s.price },
    details.developers?.length > 0 && { Icon: IconUsers, label: 'Developer', value: details.developers.join(', ') },
    details.publishers?.length > 0 && { Icon: IconBuilding, label: 'Publisher', value: details.publishers.join(', ') },
    details.platforms?.length > 0 && { Icon: IconDeviceDesktop, label: 'Platforms', value: details.platforms.map(p => p === 'mac' ? 'macOS' : p[0].toUpperCase() + p.slice(1)).join(', ') },
    details.controller && { Icon: IconDeviceGamepad2, label: 'Controller', value: details.controller === 'full' ? 'Full support' : 'Partial support' },
    details.achievements > 0 && { Icon: IconTrophy, label: 'Achievements', value: details.achievements },
    details.dlc > 0 && { Icon: IconPuzzle, label: 'DLC', value: details.dlc },
    details.metacritic && { Icon: IconSparkles, label: 'Metacritic', value: details.metacritic },
    reviews?.total > 0 && { Icon: IconThumbUp, label: 'Reviews', value: `${reviews.label}, ${reviewPct}% of ${reviews.total.toLocaleString()}` },
  ].filter(Boolean)
}

// Skeleton blocks shaped like what's loading (text, cards, two columns).
export function TextSkeleton({ lines = 6 }) {
  return (
    <div className={s.skelText}>
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} w={i === lines - 1 ? '55%' : `${96 - (i % 3) * 6}%`} h={12} />)}
    </div>
  )
}
export function CardsSkeleton({ count = 6 }) {
  return (
    <div className={s.detailGrid}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={s.detailCard}><Skeleton w="40%" h={10} /><Skeleton w="70%" h={14} /></div>
      ))}
    </div>
  )
}
function ReqsSkeleton() {
  return <div className={s.reqs}><div className={s.reqCol}><TextSkeleton lines={7} /></div><div className={s.reqCol}><TextSkeleton lines={7} /></div></div>
}

// The store's own sections for a page (Game Detail's About tab): the full
// description, every fact, languages and system requirements, with skeletons
// while Steam answers. details: undefined = loading, null = none.
export function StoreSections({ details, reviews, headClass, cardClass }) {
  const facts = factsOf(details, reviews)
  const Card = ({ title, children }) => (
    <section className={cardClass}>
      {title && <div className={headClass}>{title}</div>}
      {children}
    </section>
  )
  if (details === null) return null
  return (
    <>
      <Card title="About this game">
        {details === undefined ? <TextSkeleton lines={8} /> : details.about ? <Html html={details.about} className={s.aboutInline} /> : <p className={s.desc}>{details.description}</p>}
      </Card>
      <Card title="Details">
        {details === undefined ? <CardsSkeleton /> : (
          <div className={s.detailGrid}>
            {facts.map(f => (
              <div key={f.label} className={s.detailCard}>
                <span className={s.detailLabel}><f.Icon size={14} /> {f.label}</span>
                <strong className={f.cls}>{f.value}</strong>
              </div>
            ))}
            {details.languages && (
              <div className={`${s.detailCard} ${s.detailWide}`}>
                <span className={s.detailLabel}><IconLanguage size={14} /> Languages</span>
                <Html html={details.languages} className={s.langs} />
              </div>
            )}
            {(details.genres?.length > 0 || details.categories?.length > 0) && (
              <div className={`${s.detailCard} ${s.detailWide}`}>
                <span className={s.detailLabel}><IconTag size={14} /> Genres and features</span>
                <div className={s.chips}>
                  {[...new Set(details.genres || [])].map(g => <span key={g} className={s.chip}>{g}</span>)}
                  {[...new Set(details.categories || [])].map(c => <span key={c} className={s.chipMuted}>{c}</span>)}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
      {(details === undefined || details.requirements?.minimum || details.requirements?.recommended) && (
        <Card title="System requirements">
          {details === undefined ? <ReqsSkeleton /> : (
            <div className={s.reqs}>
              {details.requirements?.minimum && <div className={s.reqCol}><Html html={details.requirements.minimum} /></div>}
              {details.requirements?.recommended && <div className={s.reqCol}><Html html={details.requirements.recommended} /></div>}
            </div>
          )}
        </Card>
      )}
    </>
  )
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'about', label: 'About' },
  { key: 'details', label: 'Details' },
  { key: 'reqs', label: 'System requirements' },
]

export default function SteamGameModal({
  appId, name, release, countdown, art, fallbackArt = [], onClose, onRequestClose, actions, match = null,
  tab: heldTab, onTab, extraTab = null, overviewTop = null, chips = null, footerLeft = null, children,
}) {
  const [details, setDetails] = useState(undefined)   // undefined = loading, null = unavailable
  const [reviews, setReviews] = useState(null)
  const [ownTab, setOwnTab] = useState('overview')
  const tab = heldTab ?? ownTab
  const setTab = onTab ?? setOwnTab

  useEffect(() => {
    let alive = true
    if (!appId) { setDetails(null); return }
    window.kozo?.api?.steam?.storeDetails?.(appId).then(res => { if (alive) setDetails(res?.ok ? res.data : null) })
    window.kozo?.api?.steam?.reviews?.(appId).then(res => { if (alive && res?.ok) setReviews(res.data) })
    return () => { alive = false }
  }, [appId])

  const lead = [art?.hero, art?.capsule, art?.header, ...fallbackArt].filter(Boolean)
  // Trailers first, like the store page, then the art and screenshots. Nothing
  // shows until Steam answers (the skeleton has the same shape): the art alone
  // would be on screen for a moment, then be replaced by the trailer.
  const media = details === undefined ? [] : [
    ...(details?.videos || []).map(v => ({ thumb: v.thumb, video: v })),
    ...(lead.length ? [{ thumb: art?.capsule || art?.header || lead[0], full: lead[0] }] : []),
    ...(details?.media || []),
  ]
  // While Steam answers, every tab shows (with skeletons); then only the ones
  // that have something.
  const storeTabs = details === undefined ? TABS
    : TABS.filter(t => t.key === 'overview' || details?.[t.key === 'about' ? 'about' : t.key === 'reqs' ? 'requirements' : 'name'])
      .filter(t => t.key !== 'reqs' || details?.requirements?.minimum || details?.requirements?.recommended)
  const extraTabs = extraTab ? [].concat(extraTab) : []
  const tabs = [...storeTabs, ...extraTabs]

  const facts = details ? [
    { Icon: IconCalendar, label: 'Release', value: release || details.release_date || 'To be announced' },
    details.price && { Icon: IconTag, label: 'Price', value: details.price, cls: s.price },
    details.developers?.length > 0 && { Icon: IconUsers, label: 'Developer', value: details.developers.join(', ') },
    details.publishers?.length > 0 && { Icon: IconBuilding, label: 'Publisher', value: details.publishers.join(', ') },
  ].filter(Boolean) : []
  const allFacts = factsOf(details, reviews, release)

  return (
    <Modal
      title={name}
      icon={<IconBrandSteam size={17} stroke={1.6} />}
      onClose={onClose}
      onRequestClose={onRequestClose}
      width={1120}
      footer={
        <div className={s.footer}>
          {appId && (
            <button className={s.ghostBtn} onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${appId}`)}>
              <IconBrandSteam size={14} /> Steam page
            </button>
          )}
          {footerLeft}
          <div className={s.spacer} />
          {actions}
        </div>
      }
    >
      {tabs.length > 1 && (
        <div className={s.tabs} role="tablist" aria-label="Game details">
          {tabs.map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              className={`${s.tab} ${tab === t.key ? s.tabOn : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      )}

      {tab === 'overview' && (
        <div className={s.layout}>
          <div className={s.mediaCol}>
            {media.length > 0
              ? <MediaGallery items={media} />
              : details === undefined
                ? <div className={s.mediaSkel}><div className={s.mediaBox}><Skeleton w="100%" h="100%" r={12} /></div><div className={s.thumbSkel}>{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} w="100%" h={64} r={8} />)}</div></div>
                : <div className={s.noMedia}><IconBrandSteam size={28} /></div>}
          </div>

          <div className={s.infoCol}>
            {overviewTop}
            <div className={s.topChips}>
              {chips}
              {countdown && <div className={s.countdown}><IconClock size={14} /> {countdown}</div>}
              {match && <div className={`${s.match} ${s['match_' + match.tone]}`}><IconSparkles size={14} /> {match.pct}% match</div>}
              {reviews?.total > 0 && <div className={s.reviewChip} title={`${reviews.positive.toLocaleString()} of ${reviews.total.toLocaleString()} reviews are positive`}><IconThumbUp size={14} /> {reviews.label}</div>}
            </div>
            {match?.reason && <div className={s.matchReason}>{match.reason}</div>}
            <div className={s.facts}>
              {facts.map(f => (
                <div key={f.label} className={s.fact}>
                  <f.Icon size={14} />
                  <span className={s.factLabel}>{f.label}</span>
                  <strong className={f.cls}>{f.value}</strong>
                </div>
              ))}
              {!details && (
                <div className={s.fact}><IconCalendar size={14} /><span className={s.factLabel}>Release</span><strong>{release || 'To be announced'}</strong></div>
              )}
            </div>

            {details?.genres?.length > 0 && (
              <div className={s.chips}>{[...new Set(details.genres)].map(g => <span key={g} className={s.chip}>{g}</span>)}</div>
            )}

            {details === undefined && <PanelSkeleton lines={4} />}
            {details?.description && <p className={s.desc}>{details.description}</p>}
            {details === null && <p className={s.muted}>Steam has no store details for this game yet.</p>}
            {details?.about && <button type="button" className={s.moreLink} onClick={() => setTab('about')}>Read more about the game</button>}

            {details?.categories?.length > 0 && (
              <div className={s.chips}>{[...new Set(details.categories)].map(c => <span key={c} className={s.chipMuted}>{c}</span>)}</div>
            )}
          </div>
        </div>
      )}

      {tab === 'about' && (details === undefined ? <div className={s.about}><TextSkeleton lines={12} /></div> : <Html html={details?.about} className={s.about} />)}

      {tab === 'details' && details === undefined && <CardsSkeleton count={9} />}
      {tab === 'details' && details !== undefined && (
        <div className={s.detailGrid}>
          {allFacts.map(f => (
            <div key={f.label} className={s.detailCard}>
              <span className={s.detailLabel}><f.Icon size={14} /> {f.label}</span>
              <strong className={f.cls}>{f.value}</strong>
            </div>
          ))}
          {details?.languages && (
            <div className={`${s.detailCard} ${s.detailWide}`}>
              <span className={s.detailLabel}><IconLanguage size={14} /> Languages</span>
              <Html html={details.languages} className={s.langs} />
            </div>
          )}
          {details?.genres?.length > 0 && (
            <div className={`${s.detailCard} ${s.detailWide}`}>
              <span className={s.detailLabel}><IconTag size={14} /> Genres and features</span>
              <div className={s.chips}>
                {[...new Set(details.genres)].map(g => <span key={g} className={s.chip}>{g}</span>)}
                {[...new Set(details.categories || [])].map(c => <span key={c} className={s.chipMuted}>{c}</span>)}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'reqs' && details === undefined && <ReqsSkeleton />}
      {tab === 'reqs' && details !== undefined && (
        <div className={s.reqs}>
          {details?.requirements?.minimum && <div className={s.reqCol}><Html html={details.requirements.minimum} /></div>}
          {details?.requirements?.recommended && <div className={s.reqCol}><Html html={details.requirements.recommended} /></div>}
        </div>
      )}

      {extraTabs.map(t => tab === t.key && <React.Fragment key={t.key}>{t.node}</React.Fragment>)}
      {children}
    </Modal>
  )
}
