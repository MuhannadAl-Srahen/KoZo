import React, { useEffect, useMemo, useState } from 'react'
import {
  IconDiscount2, IconRefresh, IconThumbUp, IconTrendingDown, IconClock, IconBuildingStore, IconPlus, IconCheck,
  IconSparkles, IconListCheck, IconBrandSteam, IconChevronDown,
} from '@tabler/icons-react'
import SteamGameModal from '../components/SteamGameModal'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import useCardZoom from '../lib/useCardZoom'
import { timeAgo } from '../lib/utils'
import s from './Deals.module.css'

// Discount games: Steam's sales ranked for YOU (services/deals.js). Your
// Game List games on sale come first; every deal has a deal score (discount,
// reviews and how close it is to what you play), and CheapShark's price
// history says when a price is the lowest ever (or only looks like a sale).

const FILTERS = [
  { key: 'all',    label: 'All' },
  { key: 'deep',   label: '75% off or more' },
  { key: 'lowest', label: 'Lowest price ever' },
  { key: 'match',  label: 'Close to your taste' },
]
const SORTS = [
  { key: 'score',   label: 'Best for you' },
  { key: 'pct',     label: 'Biggest discount' },
  { key: 'price',   label: 'Cheapest' },
  { key: 'reviews', label: 'Best reviewed' },
  { key: 'ending',  label: 'Ending soon' },
]
const PAGE = 36

let dealsCache = null   // module cache: a revisit paints at once

function scoreTone(n) { return n >= 80 ? 'great' : n >= 65 ? 'good' : 'ok' }
function scoreWord(n) { return n >= 80 ? 'Great deal' : n >= 65 ? 'Good deal' : 'Deal' }
function endsIn(ts) {
  if (!ts) return null
  const ms = ts - Date.now()
  if (ms <= 0) return null
  const h = Math.floor(ms / 3600000)
  if (h < 24) return `Ends in ${Math.max(1, h)}h`
  return `Ends in ${Math.floor(h / 24)}d`
}

function DealCard({ g, i, onOpen }) {
  const ends = endsIn(g.price?.endsAt)
  return (
    <button type="button" className={s.card} data-gpnav onClick={() => onOpen(g)} style={{ '--i': Math.min(i, 18) }}>
      <div className={s.art}>
        {(g.header || g.capsule) && <img src={g.header || g.capsule} alt="" loading="lazy" decoding="async" />}
        <span className={s.pct}>-{g.price.pct}%</span>
        <span className={`${s.score} ${s['score_' + scoreTone(g.score)]}`} title="Deal score: discount, reviews and how close it is to what you play">
          {g.score}<small>{scoreWord(g.score)}</small>
        </span>
      </div>
      <div className={s.body}>
        <div className={s.nameRow}>
          <span className={s.name} title={g.name}>{g.name}</span>
          <span className={s.prices}>
            {g.price.originalText && g.price.original > g.price.final && <s className={s.was}>{g.price.originalText}</s>}
            <b className={s.now}>{g.price.finalText}</b>
          </span>
        </div>
        <div className={s.meta}>
          {g.reviews?.count > 0 && <span className={s.reviews} title={`${g.reviews.count.toLocaleString()} reviews`}><IconThumbUp size={12} /> {g.reviews.pct}%</span>}
          {g.match > 0 && <span className={s.matchTxt}><IconSparkles size={12} /> {g.match}% your taste</span>}
          {ends && <span className={s.ends}><IconClock size={12} /> {ends}</span>}
        </div>
        <div className={s.badges}>
          {g.low === 'lowest' && <span className={`${s.badge} ${s.badgeLow}`}><IconTrendingDown size={12} /> Lowest price ever</span>}
          {g.low === 'near' && <span className={`${s.badge} ${s.badgeNear}`}><IconTrendingDown size={12} /> Near its lowest</span>}
          {g.low === 'above' && <span className={`${s.badge} ${s.badgeAbove}`} title="This game has been cheaper before">Was cheaper before</span>}
          {g.elsewhere && <span className={`${s.badge} ${s.badgeStore}`}><IconBuildingStore size={12} /> {g.elsewhere.save}% less at {g.elsewhere.store}</span>}
        </div>
        {g.why?.length > 0 && <div className={s.why}>Because you play {g.why.join(', ')}</div>}
      </div>
    </button>
  )
}

function DealsSkeleton({ count = 9 }) {
  return (
    <div className={s.grid}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={s.skelCard}>
          <div className={s.skelArt}><Skeleton w="100%" h="100%" r={0} /></div>
          <div className={s.body}><Skeleton w="70%" h={14} /><Skeleton w="45%" h={11} /><Skeleton w="55%" h={18} r={9} /></div>
        </div>
      ))}
    </div>
  )
}

export default function Deals() {
  const [data, setData] = useState(dealsCache)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('score')
  const [shown, setShown] = useState(PAGE)
  const [open, setOpen] = useState(null)
  const [added, setAdded] = useState(() => new Set())
  const [adding, setAdding] = useState(null)
  const zoomStyle = useCardZoom('deals', 'grid', { grid: 260 }, { min: 200, max: 440 })

  function load(force = false) {
    if (force) setRefreshing(true)
    return window.kozo?.api?.deals?.list?.({ force }).then(res => {
      setRefreshing(false)
      if (res?.ok) { dealsCache = res.data; setData(res.data); setError(null) }
      else if (!dealsCache) setError(res?.error || 'Steam did not answer. Try again in a moment.')
    })
  }

  useEffect(() => {
    load().then(() => window.kozo?.api?.deals?.markSeen?.())
    const off = window.kozo?.events?.onDealsUpdated?.((d) => { dealsCache = d; setData(d) })
    return () => { try { off?.() } catch {} }
  }, [])

  const deals = useMemo(() => {
    let list = data?.deals || []
    if (filter === 'deep') list = list.filter(g => g.price.pct >= 75)
    else if (filter === 'lowest') list = list.filter(g => g.low === 'lowest')
    else if (filter === 'match') list = list.filter(g => g.match >= 35)
    const by = {
      score: (a, b) => b.score - a.score,
      pct: (a, b) => b.price.pct - a.price.pct || b.score - a.score,
      price: (a, b) => a.price.final - b.price.final,
      reviews: (a, b) => (b.reviews?.pct || 0) - (a.reviews?.pct || 0) || (b.reviews?.count || 0) - (a.reviews?.count || 0),
      ending: (a, b) => (a.price.endsAt || 9e15) - (b.price.endsAt || 9e15),
    }[sort]
    return [...list].sort(by)
  }, [data, filter, sort])

  useEffect(() => { setShown(PAGE) }, [filter, sort])

  async function addToList(g) {
    setAdding(g.appid)
    const res = await window.kozo?.api?.gameList?.add?.({ steam_app_id: g.appid, name: g.name, banner_url: g.portrait || null, status: 'want_to_play', rating: null, game_id: null })
    setAdding(null)
    if (res?.ok) setAdded(a => new Set(a).add(g.appid))
  }

  const yours = data?.yours || []
  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconDiscount2 size={16} stroke={1.7} /> Discounts</h1>
        <div className={s.spacer} />
        {data?.at && <span className={s.updated}>Prices for {data.cc}, checked {timeAgo(data.at)}</span>}
        <button type="button" className={s.ghostBtn} onClick={() => load(true)} disabled={refreshing}>
          <IconRefresh size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Checking…' : 'Check now'}
        </button>
      </div>

      <div className={s.content}>
        {error && !data ? (
          <EmptyState Icon={IconDiscount2} title="Couldn't load the sales" desc={error} action={{ label: 'Try again', Icon: IconRefresh, onClick: () => load(true) }} />
        ) : (
          <>
            {data?.taste?.length > 0 && (
              <div className={s.taste}>
                <IconSparkles size={14} /> Ranked for you: you play a lot of
                {data.taste.map(t => <span key={t} className={s.tasteChip}>{t}</span>)}
              </div>
            )}

            {/* Your Game List games on sale: the reason to open this page. */}
            <section className={s.section}>
              <div className={s.sectionHead}>
                <IconListCheck size={15} /> On your Game List
                {yours.length > 0 && <span className={s.count}>{yours.length} on sale</span>}
              </div>
              {!data ? <DealsSkeleton count={3} /> : yours.length === 0 ? (
                <p className={s.quiet}>
                  {data.wantedCount
                    ? `None of the ${data.wantedCount} games you want is on sale right now. KoZo checks every few hours and puts a badge on Discounts when one is.`
                    : 'Add games you want to your Game List (Want to play) and KoZo tells you the moment one goes on sale.'}
                </p>
              ) : (
                <div className={s.grid} style={zoomStyle}>
                  {yours.map((g, i) => <DealCard key={g.appid} g={g} i={i} onOpen={setOpen} />)}
                </div>
              )}
            </section>

            <section className={s.section}>
              <div className={s.sectionHead}>
                <IconDiscount2 size={15} /> Best deals for you
                {data && <span className={s.count}>{deals.length}</span>}
              </div>
              <div className={s.filters}>
                <div className={s.seg}>
                  {FILTERS.map(f => (
                    <button key={f.key} type="button" className={`${s.segBtn} ${filter === f.key ? s.segOn : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
                  ))}
                </div>
                <div className={s.seg}>
                  {SORTS.map(f => (
                    <button key={f.key} type="button" className={`${s.segBtn} ${sort === f.key ? s.segOn : ''}`} onClick={() => setSort(f.key)}>{f.label}</button>
                  ))}
                </div>
              </div>
              {!data ? <DealsSkeleton /> : deals.length === 0 ? (
                <EmptyState Icon={IconDiscount2} title="Nothing matches" desc="Try another filter." />
              ) : (
                <>
                  <div className={s.grid} style={zoomStyle}>
                    {deals.slice(0, shown).map((g, i) => <DealCard key={g.appid} g={g} i={i % PAGE} onOpen={setOpen} />)}
                  </div>
                  {deals.length > shown && (
                    <button type="button" className={s.more} onClick={() => setShown(n => n + PAGE)}>
                      <IconChevronDown size={14} /> Show more ({deals.length - shown})
                    </button>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>

      {open && (
        <SteamGameModal
          appId={open.appid}
          name={open.name}
          art={{ header: open.header, capsule: open.capsule }}
          onClose={() => setOpen(null)}
          actions={<>
            {open.mine || added.has(open.appid)
              ? <span className={s.addedNote}><IconCheck size={14} /> On your Game List</span>
              : <button type="button" className={s.ghostBtn} disabled={adding === open.appid} onClick={() => addToList(open)}>
                  <IconPlus size={14} /> {adding === open.appid ? 'Adding…' : 'Add to Game List'}
                </button>}
            {open.elsewhere && (
              <button type="button" className={s.ghostBtn} onClick={() => window.kozo?.api?.shell?.openExternal?.(open.elsewhere.url)}>
                <IconBuildingStore size={14} /> {open.elsewhere.store}
              </button>
            )}
            <button type="button" className={s.buyBtn} onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${open.appid}`)}>
              <IconBrandSteam size={14} /> {open.price.finalText} on Steam
            </button>
          </>}
        />
      )}
    </div>
  )
}
