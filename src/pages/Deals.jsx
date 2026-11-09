import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconDiscount2, IconRefresh, IconThumbUp, IconTrendingDown, IconClock, IconBuildingStore, IconPlus, IconCheck,
  IconSparkles, IconListCheck, IconBrandSteam, IconChevronDown, IconBell, IconSearch, IconX, IconLoader2,
} from '@tabler/icons-react'
import SteamGameModal from '../components/SteamGameModal'
import GamePrices, { lowestLine } from '../components/GamePrices'
import GeneratedCover from '../components/GeneratedCover'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import useCardZoom from '../lib/useCardZoom'
import CardSizeSlider from '../components/ui/CardSizeSlider'
import { timeAgo } from '../lib/utils'
import s from './Deals.module.css'

// Discount games: Steam's sales ranked for YOU (services/deals.js). Your
// Game List games on sale come first; every deal has a deal score (discount,
// reviews and how close it is to what you play), and CheapShark's price
// history says when a price is the lowest ever (or only looks like a sale).
// A game's window has a Prices tab: other stores and a price alert.

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

// Search: "need for speed" finds "Need for Speed™ Most Wanted" (marks and punctuation ignored).
function searchKey(v) {
  return String(v || '').toLowerCase().replace(/[™®©:'’".,!?\-–—_/()[\]]/g, ' ').replace(/\s+/g, ' ').trim()
}
function matchesSearch(name, term) {
  const k = searchKey(term)
  return !k || searchKey(name).includes(k)
}

function scoreTone(n) { return n >= 80 ? 'great' : n >= 65 ? 'good' : 'ok' }
function scoreWord(n) { return n >= 80 ? 'Great deal' : n >= 65 ? 'Good deal' : 'Deal' }
// "Very Positive · 12K": Steam's own words and how many people said so. A bare "98%"
// could be 98% of a dozen people.
function reviewText(r) {
  const n = r.count >= 1e6 ? `${(r.count / 1e6).toFixed(1).replace(/\.0$/, '')}M` : r.count >= 1e3 ? `${Math.round(r.count / 1e3)}K` : String(r.count)
  return `${r.label || `${r.pct}%`} · ${n}`
}
// "24% your taste" read like something bad, and a weak match says nothing worth a line.
// 35 is where the "Close to your taste" filter starts.
function tasteWord(n) { return n >= 35 ? 'Close to your taste' : n >= 20 ? 'Near your taste' : null }
function endsIn(ts) {
  if (!ts) return null
  const ms = ts - Date.now()
  if (ms <= 0) return null
  const h = Math.floor(ms / 3600000)
  if (h < 24) return `Ends in ${Math.max(1, h)}h`
  return `Ends in ${Math.floor(h / 24)}d`
}

function DealCard({ g, i, us, alert, onOpen }) {
  const ends = endsIn(g.price?.endsAt)
  const taste = tasteWord(g.match)
  const low = lowestLine(g.lowest, g.lowestDate, us)
  return (
    <button type="button" className={s.card} data-gpnav onClick={() => onOpen(g)} style={{ '--i': Math.min(i, 18) }}>
      <div className={s.art}>
        {(g.header || g.capsule) && <img src={g.header || g.capsule} alt="" loading="lazy" decoding="async" />}
        <span className={s.pct}>-{g.price.pct}%</span>
        <span className={`${s.score} ${s['score_' + scoreTone(g.score)]}`} title="Deal score out of 100: discount, reviews and how close it is to what you play">
          <span className={s.scoreNum}>{g.score}<i>/100</i></span><small>{scoreWord(g.score)}</small>
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
          {g.reviews?.count > 0 && <span className={s.reviews} title={`${g.reviews.pct}% of ${g.reviews.count.toLocaleString()} reviews are positive`}><IconThumbUp size={12} /> {reviewText(g.reviews)}</span>}
          {taste && <span className={s.matchTxt} title={`${g.match}% like the games you play most`}><IconSparkles size={12} /> {taste}</span>}
          {ends && <span className={s.ends}><IconClock size={12} /> {ends}</span>}
        </div>
        <div className={s.badges}>
          {g.low === 'lowest' && <span className={`${s.badge} ${s.badgeLow}`}><IconTrendingDown size={12} /> Lowest price ever</span>}
          {g.low === 'near' && <span className={`${s.badge} ${s.badgeNear}`}><IconTrendingDown size={12} /> Near its lowest</span>}
          {g.low === 'above' && <span className={`${s.badge} ${s.badgeAbove}`} title="This game has been cheaper before">Was cheaper before</span>}
          {g.elsewhere && <span className={`${s.badge} ${s.badgeStore}`}><IconBuildingStore size={12} /> {g.elsewhere.save}% less at {g.elsewhere.store}</span>}
        </div>
        {low && <div className={s.lowLine} title="The lowest price at any store CheapShark follows, in US dollars"><IconTrendingDown size={12} /> {low}</div>}
        {g.why?.length > 0 && <div className={s.why}>Because you play {g.why.join(', ')}</div>}
      </div>
    </button>
  )
}

function alertText(a) {
  if (a.state === 'currency') return 'Set in another currency. Open it to set it again.'
  if (!a.price) return 'Steam gave no price just now.'
  return `Now ${a.price.finalText}, your alert is ${a.targetText}`
}

function AlertRow({ a, us, onOpen }) {
  const low = lowestLine(a.lowest, a.lowestDate, us)
  const art = a.header || a.capsule
  return (
    <button type="button" className={`${s.alertRow} ${a.state === 'reached' ? s.alertReached : ''}`} data-gpnav onClick={() => onOpen(a)}>
      <span className={s.alertArt}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : <GeneratedCover name={a.name} compact />}
      </span>
      <span className={s.alertBody}>
        <span className={s.alertTop}>
          <span className={s.alertName} title={a.name}>{a.name}</span>
          {a.state === 'reached' && <span className={`${s.badge} ${s.badgeLow}`}><IconCheck size={12} /> At your price</span>}
        </span>
        <span className={s.alertLine}>{alertText(a)}</span>
        {low && <span className={s.alertLow}>{low}</span>}
      </span>
    </button>
  )
}

// A Steam search hit with no deal on this page: its window opens on the Prices tab.
function SteamHitRow({ h, onOpen }) {
  const [art, setArt] = useState(h.header_image || h.capsule)
  return (
    <button type="button" className={s.alertRow} data-gpnav data-deal-steam-hit={h.steam_app_id} onClick={() => onOpen(h)}>
      <span className={s.alertArt}>
        {art ? <img src={art} alt="" loading="lazy" decoding="async" onError={() => setArt(art !== h.capsule ? h.capsule : null)} /> : <GeneratedCover name={h.name} compact />}
      </span>
      <span className={s.alertBody}>
        <span className={s.alertTop}><span className={s.alertName} title={h.name}>{h.name}</span></span>
        <span className={s.alertLine}>Its price now, the lowest ever and a price alert</span>
      </span>
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
  const [openTab, setOpenTab] = useState('overview')
  const [added, setAdded] = useState(() => new Set())
  const [adding, setAdding] = useState(null)
  // Search: filters every section by name, and looks the name up on Steam too, so a game
  // that isn't on sale here can still be opened for its price and an alert.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState(null)        // null = not searched; [] = nothing on Steam
  const [hitsBusy, setHitsBusy] = useState(false)
  const searchRef = useRef(null)
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
    if (query.trim()) list = list.filter(g => matchesSearch(g.name, query))
    return [...list].sort(by)
  }, [data, filter, sort, query])

  useEffect(() => { setShown(PAGE) }, [filter, sort, query])

  // Steam's own search, a moment after typing stops.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setHits(null); setHitsBusy(false); return }
    let alive = true
    setHitsBusy(true)
    const t = setTimeout(async () => {
      const res = await window.kozo?.api?.steam?.search?.(q)
      if (!alive) return
      setHitsBusy(false)
      setHits(res?.ok ? (res.data || []) : [])
    }, 350)
    return () => { alive = false; clearTimeout(t) }
  }, [query])

  async function addToList(g) {
    setAdding(g.appid)
    const res = await window.kozo?.api?.gameList?.add?.({ steam_app_id: g.appid, name: g.name, banner_url: g.portrait2x || g.portrait || null, status: 'want_to_play', rating: null, game_id: null })
    setAdding(null)
    if (res?.ok) setAdded(a => new Set(a).add(g.appid))
  }

  function openWindow(g, tab = 'overview') { setOpenTab(tab); setOpen(g) }

  const searching = !!query.trim()
  const yours = (data?.yours || []).filter(g => matchesSearch(g.name, query))
  const us = data?.cc === 'US'
  const alerts = (data?.alerts || []).filter(a => matchesSearch(a.name, query))
  // Steam hits that aren't already a card or an alert on this page.
  const listed = new Set([...(data?.deals || []), ...(data?.yours || []), ...(data?.alerts || [])].map(g => Number(g.appid)))
  const steamHits = (hits || []).filter(h => !listed.has(Number(h.steam_app_id))).slice(0, 8)
  const reachedCount = alerts.filter(a => a.state === 'reached').length
  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconDiscount2 size={16} stroke={1.7} /> Discounts</h1>
        <div className={`${s.searchBox} hasRing`} data-deals-search>
          <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
          <input
            ref={searchRef}
            className={s.searchInput}
            placeholder="Search a game…" aria-label="Search discounts"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
          />
          {query && (
            <button type="button" className={s.searchClear} onClick={() => { setQuery(''); searchRef.current?.focus() }} aria-label="Clear search">
              <IconX size={12} stroke={2} />
            </button>
          )}
        </div>
        <div className={s.spacer} />
        <CardSizeSlider pageKey="deals" view="grid" defaults={{ grid: 260 }} opts={{ min: 200, max: 440 }} />
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
            {!searching && data?.taste?.length > 0 && (
              <div className={s.taste}>
                <IconSparkles size={14} /> Ranked for you: you play a lot of
                {data.taste.map(t => <span key={t} className={s.tasteChip}>{t}</span>)}
              </div>
            )}

            {alerts.length > 0 && (
              <section className={s.section}>
                <div className={s.sectionHead}>
                  <IconBell size={15} /> Price alerts
                  <span className={s.count}>{reachedCount > 0 ? `${reachedCount} at your price` : alerts.length}</span>
                </div>
                <div className={s.alerts}>
                  {alerts.map(a => <AlertRow key={a.appid} a={a} us={us} onOpen={(x) => openWindow({ ...x, mine: true }, 'prices')} />)}
                </div>
              </section>
            )}

            {/* Your Game List games on sale: the reason to open this page. While searching, only with a match. */}
            {(!searching || yours.length > 0) && <section className={s.section}>
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
                  {yours.map((g, i) => <DealCard key={g.appid} g={g} i={i} us={us} onOpen={openWindow} />)}
                </div>
              )}
            </section>}

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
                searching
                  ? <p className={s.quiet} data-deals-nomatch>No game on sale here matches “{query.trim()}”.{steamHits.length ? ' Steam has it below: open it for its price.' : ''}</p>
                  : <EmptyState Icon={IconDiscount2} title="Nothing matches" desc="Try another filter." />
              ) : (
                <>
                  <div className={s.grid} style={zoomStyle}>
                    {deals.slice(0, shown).map((g, i) => <DealCard key={g.appid} g={g} i={i % PAGE} us={us} onOpen={openWindow} />)}
                  </div>
                  {deals.length > shown && (
                    <button type="button" className={s.more} onClick={() => setShown(n => n + PAGE)}>
                      <IconChevronDown size={14} /> Show more ({deals.length - shown})
                    </button>
                  )}
                </>
              )}
            </section>

            {searching && (hitsBusy || hits) && (
              <section className={s.section} data-deals-steam>
                <div className={s.sectionHead}>
                  <IconBrandSteam size={15} /> On Steam
                  {hitsBusy && <IconLoader2 size={13} className="spin" />}
                </div>
                {steamHits.length > 0 ? (
                  <div className={s.alerts}>
                    {steamHits.map(h => (
                      <SteamHitRow key={h.steam_app_id} h={h} onOpen={(x) => openWindow({ appid: x.steam_app_id, name: x.name, header: x.header_image, capsule: x.capsule }, 'prices')} />
                    ))}
                  </div>
                ) : !hitsBusy && (
                  <p className={s.quiet}>Steam found nothing else for “{query.trim()}”.</p>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {open && (
        <SteamGameModal
          appId={open.appid}
          name={open.name}
          art={{ header: open.header, header2x: open.header2x, capsule: open.capsule }}
          onClose={() => setOpen(null)}
          tab={openTab}
          onTab={setOpenTab}
          extraTab={{
            key: 'prices',
            label: 'Prices',
            node: <GamePrices appId={open.appid} name={open.name} banner={open.portrait} onAlertChanged={() => setAdded(a => new Set(a).add(open.appid))} />,
          }}
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
              <IconBrandSteam size={14} /> {open.price ? `${open.price.finalText} on Steam` : 'On Steam'}
            </button>
          </>}
        />
      )}
    </div>
  )
}
