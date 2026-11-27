import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  IconDiscount2, IconRefresh, IconThumbUp, IconTrendingDown, IconClock, IconBuildingStore, IconPlus, IconCheck,
  IconSparkles, IconListCheck, IconBrandSteam, IconBell, IconSearch, IconX, IconLoader2, IconTrash,
} from '@tabler/icons-react'
import SteamGameModal from '../components/SteamGameModal'
import GamePrices, { lowestLine } from '../components/GamePrices'
import GeneratedCover from '../components/GeneratedCover'
import ContextMenu from '../components/ui/ContextMenu'
import UndoBar from '../components/ui/UndoBar'
import InfoModal from '../components/ui/InfoModal'
import { storeMenuItems, alertAtLowest } from '../components/storeMenu'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import useCardZoom from '../lib/useCardZoom'
import CardSizeSlider from '../components/ui/CardSizeSlider'
import { timeAgo } from '../lib/utils'
import useNearEnd from '../lib/useNearEnd'
import { keepShown } from '../lib/endless'
import { matchesSearch } from '../lib/searchRank'
import s from './Deals.module.css'
import t from '../styles/pillTabs.module.css'

// Discount games: Steam's sales ranked for YOU (services/deals.js). Two tabs (`?tab=`): Deals
// (the default: every deal with a deal score from the discount, reviews and how close it is to
// what you play) and My games (your price alerts and your Game List games on sale). My games
// used to sit above the deals, and 63 of the maker's games pushed the deals far down the page.
// CheapShark's price history says when a price is the lowest ever (or only looks like a sale).
// A game's window has a Prices tab: other stores and a price alert. Things new since the last
// look at My games carry a New pill there, and its tab says how many.

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
// The first cards, then more each time the end comes near (the maker asked for scrolling, not a
// Show more button). When those run out, the next page of Steam's sales is asked for.
const PAGE = 36
const CHUNK = 24

let dealsCache = null   // module cache: a revisit paints at once


// "Prices for Jordan": the country Steam's store prices this PC for (services/deals.js).
function regionName(cc) {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc } catch { return cc }
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

// Another store's price under yours, in US dollars: shown instead of Steam's (the maker's call).
const usd = (n) => `$${Number(n).toFixed(2)}`

function DealCard({ g, i, us, isNew, onOpen, onMenu }) {
  const ends = endsIn(g.price?.endsAt)
  const taste = tasteWord(g.match)
  const low = lowestLine(g.lowest, g.lowestDate, us)
  return (
    <button type="button" className={s.card} data-gpnav onClick={() => onOpen(g)} style={{ '--i': Math.min(i, 18) }}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(e, g) } : undefined} data-deal-card={g.appid}>
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
            {g.elsewhere ? <>
              <s className={s.was} title="Steam's price">{g.price.finalText}</s>
              <b className={s.now} title={`${g.elsewhere.store}'s price (the store's US price, through CheapShark)`} data-deal-cheaper>{usd(g.elsewhere.price)}</b>
            </> : <>
              {g.price.originalText && g.price.original > g.price.final && <s className={s.was}>{g.price.originalText}</s>}
              <b className={s.now}>{g.price.finalText}</b>
            </>}
          </span>
        </div>
        <div className={s.meta}>
          {g.reviews?.count > 0 && <span className={s.reviews} title={`${g.reviews.pct}% of ${g.reviews.count.toLocaleString()} reviews are positive`}><IconThumbUp size={12} /> {reviewText(g.reviews)}</span>}
          {taste && <span className={s.matchTxt} title={`${g.match}% like the games you play most`}><IconSparkles size={12} /> {taste}</span>}
          {ends && <span className={s.ends}><IconClock size={12} /> {ends}</span>}
        </div>
        <div className={s.badges}>
          {isNew && <span className={`${s.badge} ${s.badgeNew}`} data-deal-new>New</span>}
          {g.low === 'lowest' && <span className={`${s.badge} ${s.badgeLow}`}><IconTrendingDown size={12} /> Lowest price ever</span>}
          {g.low === 'near' && <span className={`${s.badge} ${s.badgeNear}`}><IconTrendingDown size={12} /> Near its lowest</span>}
          {g.low === 'above' && <span className={`${s.badge} ${s.badgeAbove}`} title="This game has been cheaper before">Was cheaper before</span>}
          {g.elsewhere && <span className={`${s.badge} ${s.badgeStore}`}><IconBuildingStore size={12} /> At {g.elsewhere.store}, {g.elsewhere.save}% under Steam</span>}
        </div>
        {low && <div className={s.lowLine} title="The lowest price at any store CheapShark follows, in US dollars"><IconTrendingDown size={12} /> {low}</div>}
        {g.why?.length > 0 && <div className={s.why}>Because you play {g.why.join(', ')}</div>}
      </div>
    </button>
  )
}

function alertText(a) {
  if (a.state === 'currency') {
    return a.convertText
      ? `Set for the US store. Here the same sale is about ${a.convertText}.`
      : 'Set in another currency. Open it to set it again.'
  }
  if (!a.price) return 'Steam gave no price just now.'
  return `Now ${a.price.finalText}, your alert is ${a.targetText}`
}

// One price alert. Two fixes sit beside it when it can never fire: a price below anything
// Steam sells it for (the old "lowest ever" came from any store, a key shop's bundle price),
// and an alert set in the US store's dollars on a PC that buys elsewhere.
function AlertRow({ a, us, isNew, onOpen, onFix }) {
  const low = lowestLine(a.lowest, a.lowestDate, us)
  const art = a.header || a.capsule
  const [busy, setBusy] = useState(false)
  const fixCents = a.fix ?? a.convert ?? null
  async function fix() {
    setBusy(true)
    try { await onFix(a, fixCents) } finally { setBusy(false) }
  }
  return (
    <div className={`${s.alertRow} ${a.state === 'reached' ? s.alertReached : ''}`} data-gpnav data-deal-alert={a.appid}>
      <button type="button" className={s.alertMain} data-gpclick onClick={() => onOpen(a)}>
        <span className={s.alertArt}>
          {art ? <img src={art} alt="" loading="lazy" decoding="async" /> : <GeneratedCover name={a.name} compact />}
        </span>
        <span className={s.alertBody}>
          <span className={s.alertTop}>
            <span className={s.alertName} title={a.name}>{a.name}</span>
            {isNew && <span className={`${s.badge} ${s.badgeNew}`}>New</span>}
            {a.state === 'reached' && <span className={`${s.badge} ${s.badgeLow}`}><IconCheck size={12} /> At your price</span>}
          </span>
          <span className={s.alertLine}>{alertText(a)}</span>
          {a.fix != null
            ? <span className={s.alertWarn}>Steam never goes that low: its sales stop at about 90% off.</span>
            : low && <span className={s.alertLow}>{low}</span>}
        </span>
      </button>
      {fixCents != null && (
        <button type="button" className={s.alertFix} disabled={busy} onClick={fix} data-deal-alert-fix>
          {busy ? <IconLoader2 size={13} className="spin" /> : null} Set to {a.fix != null ? a.fixText : a.convertText}
        </button>
      )}
    </div>
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
  const navigate = useNavigate()
  // Right-click on a card (components/storeMenu.js), and what "Tell me at its lowest price" did.
  const [menu, setMenu] = useState(null)        // { x, y, g }
  const [undo, setUndo] = useState(null)
  const [menuError, setMenuError] = useState(null)
  // The open game's place on the Game List (deals:listState): its window offers Add, or Remove.
  const [listInfo, setListInfo] = useState(null)   // { appid, onList, owned }
  const [listBusy, setListBusy] = useState(null)   // 'add' | 'remove' | null
  // Search: filters every section by name, and looks the name up on Steam too, so a game
  // that isn't on sale here can still be opened for its price and an alert.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState(null)        // null = not searched; [] = nothing on Steam
  const [hitsBusy, setHitsBusy] = useState(false)
  const searchRef = useRef(null)
  const zoomStyle = useCardZoom('deals', 'grid', { grid: 260 }, { min: 200, max: 440 })
  // Deals | My games. In the address (?tab=mine) so a notification can open My games.
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'mine' ? 'mine' : 'deals'
  const setTab = (k) => setParams(k === 'mine' ? { tab: 'mine' } : {}, { replace: true })
  // What was new when the page opened (deals:unseenDetails), for the New pills. My games
  // counts as seen once it's shown, not when the page opens: the badge used to vanish the
  // moment Discounts opened, before anyone could see which games it meant.
  const [fresh, setFresh] = useState(null)       // { sales: Set, reached: Set }
  const [mineViewed, setMineViewed] = useState(false)

  function load(force = false) {
    if (force) setRefreshing(true)
    return window.kozo?.api?.deals?.list?.({ force }).then(res => {
      setRefreshing(false)
      if (res?.ok) { dealsCache = res.data; setData(res.data); setError(null) }
      else if (!dealsCache) setError(res?.error || 'Steam did not answer. Try again in a moment.')
    })
  }

  useEffect(() => {
    load().then(() => window.kozo?.api?.deals?.unseenDetails?.()).then(r => {
      const d = r?.ok ? r.data : null
      setFresh({ sales: new Set((d?.sales || []).map(g => Number(g.appid))), reached: new Set((d?.reached || []).map(g => Number(g.appid))) })
    })
    const off = window.kozo?.events?.onDealsUpdated?.((d) => { dealsCache = d; setData(d) })
    return () => { try { off?.() } catch {} }
  }, [])
  useEffect(() => {
    if (tab !== 'mine' || !fresh || !data) return
    setMineViewed(true)
    window.kozo?.api?.deals?.markSeen?.()
  }, [tab, fresh, data])

  const sorted = useMemo(() => {
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

  // Cards already on screen keep their places when a new page of sales arrives; a new filter,
  // sort or search starts from the top.
  const orderRef = useRef([])
  const viewKey = `${filter}|${sort}|${query}`
  const viewRef = useRef(viewKey)
  if (viewRef.current !== viewKey) { viewRef.current = viewKey; orderRef.current = [] }
  const deals = useMemo(() => keepShown(orderRef.current, sorted), [sorted, viewKey])
  const visibleDeals = deals.slice(0, shown)
  useLayoutEffect(() => { orderRef.current = visibleDeals.map(g => g.appid) })
  const [moreBusy, setMoreBusy] = useState(false)
  const [moreError, setMoreError] = useState(null)
  // A sparse filter (Lowest price ever) can find nothing new on page after page: once a page
  // added nothing to what this view shows, stop asking until the view changes.
  const [moreStopped, setMoreStopped] = useState(false)
  useEffect(() => { setShown(PAGE); setMoreStopped(false); setMoreError(null) }, [filter, sort, query])

  const searching0 = !!query.trim()
  const canFetch = !!data?.more && !searching0 && !moreStopped
  const fetchMore = useCallback(async () => {
    if (moreBusy) return
    setMoreBusy(true); setMoreError(null)
    const before = deals.length
    const res = await window.kozo?.api?.deals?.more?.()
    setMoreBusy(false)
    if (!res?.ok) { setMoreError(res?.error || 'Steam did not answer.'); return }
    if (res.data?.error) setMoreError(res.data.error)
    dealsCache = { ...(dealsCache || {}), ...res.data }
    setData(dealsCache)
    // How many of the new ones this view shows: the next render tells; compared by count.
    pendingCheck.current = before
  }, [moreBusy, deals.length])
  const pendingCheck = useRef(null)
  useEffect(() => {
    if (pendingCheck.current == null) return
    if (deals.length <= pendingCheck.current) setMoreStopped(true)
    pendingCheck.current = null
  }, [deals.length, data])
  const onReach = useCallback(() => {
    if (shown < deals.length) setShown(n => n + CHUNK)
    else if (canFetch && !moreError) fetchMore()
  }, [shown, deals.length, canFetch, moreError, fetchMore])
  const endRef = useRef(null)
  const dealsEnd = shown >= deals.length && !canFetch
  useNearEnd(endRef, onReach, { enabled: !!data && deals.length > 0 && !dealsEnd, key: `${shown}:${deals.length}:${canFetch}` })

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

  const refreshListInfo = useCallback((appid) => {
    window.kozo?.api?.deals?.listState?.(appid).then(r => { if (r?.ok) setListInfo({ appid, ...r.data }) })
  }, [])
  useEffect(() => { setListInfo(null); if (open?.appid) refreshListInfo(open.appid) }, [open?.appid, refreshListInfo])

  // Both update the page by themselves: the main process sends deals:updated with the list as it is now.
  async function addToList(g) {
    setListBusy('add')
    await window.kozo?.api?.gameList?.add?.({ steam_app_id: g.appid, name: g.name, banner_url: g.portrait2x || g.portrait || null, status: 'want_to_play', rating: null, game_id: null })
    setListBusy(null)
    refreshListInfo(g.appid)
  }
  async function removeFromList(g) {
    setListBusy('remove')
    const res = await window.kozo?.api?.deals?.removeFromList?.(g.appid)
    setListBusy(null)
    if (res?.ok) setListInfo({ appid: g.appid, ...res.data })
    else refreshListInfo(g.appid)
  }

  function openWindow(g, tab = 'overview') { setOpenTab(tab); setOpen(g) }
  const openMenu = useCallback((e, g) => setMenu({ x: e.clientX, y: e.clientY, g }), [])
  async function alertLowest(g) {
    const r = await alertAtLowest(g, () => load())
    if (r.error) setMenuError(r.error)
    else setUndo(r.undo)
  }
  // An alert's one-click fix (AlertRow): the main process sends deals:updated afterwards.
  async function fixAlert(a, cents) {
    const r = await window.kozo?.api?.deals?.setTarget?.(a.appid, cents)
    if (!r?.ok) setMenuError(r?.error || "Couldn't change the alert.")
  }

  const searching = !!query.trim()
  const yours = (data?.yours || []).filter(g => matchesSearch(g.name, query))
  const us = data?.cc === 'US'
  const alerts = (data?.alerts || []).filter(a => matchesSearch(a.name, query))
  // Steam hits that aren't already a card or an alert on this page.
  const listed = new Set([...(data?.deals || []), ...(data?.yours || []), ...(data?.alerts || [])].map(g => Number(g.appid)))
  const steamHits = (hits || []).filter(h => !listed.has(Number(h.steam_app_id))).slice(0, 8)
  const reachedCount = alerts.filter(a => a.state === 'reached').length
  const isNewSale = (g) => !!fresh?.sales.has(Number(g.appid))
  const isNewAlert = (a) => !!fresh?.reached.has(Number(a.appid))
  const newMine = mineViewed ? 0 : (fresh ? yours.filter(isNewSale).length + alerts.filter(isNewAlert).length : 0)
  // While searching every section shows (a match can be in either tab); the tabs count matches.
  const showDeals = searching || tab === 'deals'
  const showMine = searching || tab === 'mine'
  const tabs = [
    { key: 'deals', label: 'Deals', Icon: IconDiscount2, count: data ? deals.length : null },
    { key: 'mine', label: 'My games', Icon: IconListCheck, count: data ? yours.length + alerts.length : null, fresh: newMine },
  ]
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
        {data?.at && <span className={s.updated} title="The prices Steam's store gives this PC">Prices for {regionName(data.cc)}, checked {timeAgo(data.at)}</span>}
        <button type="button" className={s.ghostBtn} onClick={() => load(true)} disabled={refreshing}>
          <IconRefresh size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Checking…' : 'Check now'}
        </button>
      </div>

      <div className={t.tabRow}>
        <div className={t.tabs} role="tablist" aria-label="Discounts">
          {tabs.map(x => (
            <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} data-deals-tab={x.key}
              className={`${t.tab} ${tab === x.key ? t.tabOn : ''} ${searching && x.count === 0 ? t.tabNone : ''}`}
              onClick={() => setTab(x.key)}>
              <x.Icon size={14} stroke={1.7} /> {x.label}
              {x.count != null && <span className={t.tabCount}>{x.count}</span>}
              {x.fresh > 0 && <span className={t.tabNew} title={`${x.fresh} new since you last looked`}>{x.fresh} new</span>}
            </button>
          ))}
        </div>
        {searching && <span className={s.updated}>Showing matches from both tabs</span>}
      </div>

      <div className={s.content}>
        {error && !data ? (
          <EmptyState Icon={IconDiscount2} title="Couldn't load the sales" desc={error} action={{ label: 'Try again', Icon: IconRefresh, onClick: () => load(true) }} />
        ) : (
          <>
            {!searching && showDeals && data?.taste?.length > 0 && (
              <div className={s.taste}>
                <IconSparkles size={14} /> Ranked for you: you play a lot of
                {data.taste.map(t => <span key={t} className={s.tasteChip}>{t}</span>)}
              </div>
            )}

            {showMine && alerts.length > 0 && (
              <section className={s.section} data-deals-alerts>
                <div className={s.sectionHead}>
                  <IconBell size={15} /> Price alerts
                  <span className={s.count}>{reachedCount > 0 ? `${reachedCount} at your price` : alerts.length}</span>
                </div>
                <div className={s.alerts}>
                  {alerts.map(a => <AlertRow key={a.appid} a={a} us={us} isNew={isNewAlert(a)} onFix={fixAlert} onOpen={(x) => openWindow({ ...x, mine: true }, 'prices')} />)}
                </div>
              </section>
            )}

            {/* Your Game List games on sale: the reason to open this page. While searching, only with a match. */}
            {showMine && (!searching || yours.length > 0) && <section className={s.section} data-deals-yours>
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
                  {yours.map((g, i) => <DealCard key={g.appid} g={g} i={i} us={us} isNew={isNewSale(g)} onOpen={openWindow} onMenu={openMenu} />)}
                </div>
              )}
            </section>}

            {showDeals && <section className={s.section}>
              <div className={s.sectionHead}>
                <IconDiscount2 size={15} /> Best deals for you
                {data && <span className={s.count}>{deals.length}{canFetch ? '+' : ''}</span>}
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
                  <div className={s.grid} style={zoomStyle} data-deals-grid>
                    {visibleDeals.map((g, i) => <DealCard key={g.appid} g={g} i={Math.min(i % CHUNK, 8)} us={us} onOpen={openWindow} onMenu={openMenu} />)}
                  </div>
                  {!dealsEnd && (
                    <div ref={endRef} className={s.loadMore} data-deals-more>
                      {shown >= deals.length && moreBusy && <DealsSkeleton count={3} />}
                      {shown >= deals.length && moreError && !moreBusy && (
                        <button type="button" className={s.moreRetry} onClick={() => { setMoreError(null); fetchMore() }}>
                          <IconRefresh size={14} /> {moreError} Try again
                        </button>
                      )}
                    </div>
                  )}
                  {dealsEnd && !searching0 && (
                    <p className={s.endLine} data-deals-end>That's every deal for now. KoZo checks again every few hours.</p>
                  )}
                </>
              )}
            </section>}

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
            node: <GamePrices appId={open.appid} name={open.name} banner={open.portrait} onAlertChanged={() => refreshListInfo(open.appid)} />,
          }}
          actions={<>
            {(() => {
              // Until Steam's answer about the list comes back, the card's own section says it.
              const info = listInfo?.appid === open.appid ? listInfo : null
              if (info?.owned) return <span className={s.addedNote}><IconCheck size={14} /> In your Library</span>
              if (info ? info.onList : open.mine) return <>
                <span className={s.addedNote}><IconCheck size={14} /> On your Game List</span>
                <button type="button" className={s.ghostBtn} data-deals-remove disabled={!!listBusy} onClick={() => removeFromList(open)} title="Take it off your Game List (and its price alert)">
                  {listBusy === 'remove' ? <IconLoader2 size={14} className="spin" /> : <IconTrash size={14} />} {listBusy === 'remove' ? 'Removing…' : 'Remove'}
                </button>
              </>
              return <button type="button" className={s.ghostBtn} data-deals-add disabled={!!listBusy} onClick={() => addToList(open)}>
                {listBusy === 'add' ? <IconLoader2 size={14} className="spin" /> : <IconPlus size={14} />} {listBusy === 'add' ? 'Adding…' : 'Add to Game List'}
              </button>
            })()}
            {open.elsewhere && (
              <button type="button" className={s.buyBtn} title={`${open.elsewhere.store}'s price (the store's US price, through CheapShark)`}
                onClick={() => window.kozo?.api?.shell?.openExternal?.(open.elsewhere.url)} data-deal-buy-cheaper>
                <IconBuildingStore size={14} /> {usd(open.elsewhere.price)} at {open.elsewhere.store}
              </button>
            )}
            <button type="button" className={open.elsewhere ? s.ghostBtn : s.buyBtn} onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${open.appid}`)}>
              <IconBrandSteam size={14} /> {open.price ? `${open.price.finalText} on Steam` : 'On Steam'}
            </button>
          </>}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          header={{ cover: menu.g.portrait || menu.g.capsule || null, name: menu.g.name, sub: menu.g.price?.finalText ? `${menu.g.price.finalText} on Steam` : null }}
          items={storeMenuItems(menu.g, {
            onOpen: (g) => openWindow(g),
            onList: !!menu.g.mine,
            onAdd: (g) => addToList(g),
            onRemove: (g) => removeFromList(g),
            alertSet: (data?.alerts || []).some(a => Number(a.appid) === Number(menu.g.appid)),
            onAlert: alertLowest,
            onUnalert: async (g) => { await window.kozo?.api?.deals?.setTarget?.(g.appid, null); load() },
            onLike: (g) => navigate(`/like?app=${g.appid}`),
            cheaper: menu.g.elsewhere,
          })}
        />
      )}
      <UndoBar undo={undo} onDone={() => setUndo(null)} />
      {menuError && <InfoModal variant="error" title="Couldn't set the alert" message={menuError} onClose={() => setMenuError(null)} />}
    </div>
  )
}
