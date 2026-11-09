import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  IconPlus, IconLayoutGrid, IconList, IconLayoutColumns,
  IconDeviceGamepad2, IconPencil, IconSearch,
  IconCheckbox, IconSquare, IconTrash, IconX, IconCheck, IconStar, IconLoader2,
  IconBooks, IconCalendarEvent, IconDice5, IconBrandSteam, IconDiscount2,
} from '@tabler/icons-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getBannerBg, parseGenres, formatMonthKey, fileUrl } from '../lib/utils'
import { LIST_STATUSES, LIST_STATUS_ORDER } from '../lib/cardModel'
import AddGameToListModal from '../components/modals/AddGameToListModal'
import EditGameListModal from '../components/modals/EditGameListModal'
import PlanMonthModal from '../components/modals/PlanMonthModal'
import SearchableSelect from '../components/ui/SearchableSelect'
import CardSizeSlider from '../components/ui/CardSizeSlider'
import CardContextMenu from '../components/ui/CardContextMenu'
import EmptyState from '../components/ui/EmptyState'
import GeneratedCover from '../components/GeneratedCover'
import useCardZoom from '../lib/useCardZoom'
import InfoModal from '../components/ui/InfoModal'
import PickForMeModal from '../components/modals/PickForMeModal'
import WishlistImportModal from '../components/modals/WishlistImportModal'
import { CardSkeletonGrid } from '../components/ui/Skeleton'
import s from './GameList.module.css'

// Game List statuses in menu order (label + color from lib/cardModel).
const STATUS_CONFIG = Object.fromEntries(LIST_STATUS_ORDER.map(k => [k, { label: LIST_STATUSES[k].label, color: LIST_STATUSES[k].color }]))

const PAGE_SIZE = 20

// Session-lifetime cache of fetched pages, keyed by page+filters. Switching
// tabs serves the last result INSTANTLY (covers stay in the browser's image
// cache instead of re-downloading) and a silent refetch reconciles after.
const pageCache = new Map()

const VIEW_OPTIONS = [
  { key: 'big',  Icon: IconLayoutColumns, title: 'Big grid' },
  { key: 'list', Icon: IconList,          title: 'List' },
]

// ── Helpers ─────────────────────────────────────────────────────────────────

// Append a cache-busting param so a re-resolved remote cover reloads even when
// the URL is unchanged (the browser would otherwise serve the stale image).
function withBust(url, v) {
  if (!url || !v) return url
  return url + (url.includes('?') ? '&' : '?') + 'v=' + v
}

// 2x → 1x → hide (and hide the paired blur layer too).
function bannerOnError(e) {
  const img = e.target
  if (img.src.includes('_2x')) { img.src = img.src.replace('_2x', '') }
  else {
    img.style.display = 'none'
    const blur = img.previousElementSibling
    if (blur && blur.tagName === 'IMG') blur.style.display = 'none'
  }
}

// ── Card components ─────────────────────────────────────────────────────────

// "-50% $9.99" on a game you want that's on sale (deals:saleMap, from Discounts' last check).
function SaleChip({ sale }) {
  if (!sale) return null
  const title = `On sale on Steam: ${sale.finalText || ''}${sale.originalText ? `, was ${sale.originalText}` : ''}${sale.lowest ? '. Its lowest price ever' : ''}`
  return (
    <span className={`${s.saleChip} ${sale.lowest ? s.saleChipLow : ''}`} title={title} data-sale-chip="">
      <IconDiscount2 size={12} stroke={2} /> -{sale.pct}%{sale.finalText ? <b>{sale.finalText}</b> : null}
    </span>
  )
}

function GridCard({ item, sale, onClick, selectionMode, selected, onToggle, onToggleFav, onContextMenu }) {
  const cfg = STATUS_CONFIG[item.status] || { label: item.status, color: 'var(--text-muted)' }
  const bg  = getBannerBg(item.id)
  const src = withBust(item.banner_url, item.banner_rev) || fileUrl(item.game_banner_local_path)
  const genres = parseGenres(item)
  const [failed, setFailed] = useState(null)   // src that failed: show the generated cover

  function handleClick() {
    if (selectionMode) { onToggle?.(item.id) } else { onClick(item) }
  }

  return (
    <div
      className={`${s.card} ${selected ? s.cardSelected : ''}`}
      onClick={handleClick}
      data-gpclick=""
      onContextMenu={selectionMode ? undefined : (e) => { e.preventDefault(); onContextMenu?.(e, item) }}
    >
      <div className={s.cardBanner} style={{ background: bg }}>
        {src && failed !== src
          ? <img src={src} alt="" className={s.cardBannerImg} loading="lazy" decoding="async"
              onError={(e) => { if (e.target.src.includes('_2x')) e.target.src = e.target.src.replace('_2x', ''); else setFailed(src) }} />
          : <GeneratedCover name={item.name} />}
        {selectionMode && (
          <div className={`${s.cardCheckbox} ${selected ? s.cardCheckboxOn : ''}`}>
            {selected && <IconCheck size={12} stroke={3} />}
          </div>
        )}

        {/* Status LED + name/genres overlaid on the cover — mirrors GameCard. */}
        {!selectionMode && (
          <span className={s.cardStatusLed} style={{ '--state-color': cfg.color }} title={cfg.label} />
        )}
        <div className={s.cardArtScrim} aria-hidden="true" />
        <div className={s.cardArtInfo}>
          <div className={s.cardTitleRow}>
            <div className={s.cardName} title={item.name}>{item.name}</div>
            {!selectionMode && (
              <button
                className={`${s.cardFavBtn} ${item.is_favorite ? s.cardFavBtnActive : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleFav?.(item) }}
                title={item.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
                aria-label={item.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <IconStar size={14} stroke={1.8} fill={item.is_favorite === 1 ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
          {genres.length > 0 && (
            <div className={s.cardGenresLine} title={genres.join(' · ')}>{genres.slice(0, 2).join(' · ')}</div>
          )}
        </div>
      </div>

      {/* Stats strip below the art: status word + rating. */}
      <div className={s.cardInfo}>
        <div className={s.cardSubRow}>
          <span className={s.cardStatusWord} style={{ color: cfg.color }}>{cfg.label}</span>
          {item.rating != null && item.status === 'finished' && (
            <span className={s.cardRating}>★ {Number(item.rating).toFixed(1)}</span>
          )}
          {item.planned_month && (
            <span className={s.planChip} title="Planned to play this month">{formatMonthKey(item.planned_month)}</span>
          )}
          <SaleChip sale={sale} />
        </div>
      </div>
    </div>
  )
}

function ListRow({ item, sale, onClick, selectionMode, selected, onToggle, onToggleFav, onContextMenu }) {
  const cfg = STATUS_CONFIG[item.status] || { label: item.status, color: 'var(--text-muted)' }
  const bg  = getBannerBg(item.id)
  const src = withBust(item.banner_url, item.banner_rev) || fileUrl(item.game_banner_local_path)
  const genres = parseGenres(item)

  function handleClick() {
    if (selectionMode) { onToggle?.(item.id) } else { onClick(item) }
  }

  return (
    <div
      className={`${s.listRow} ${selected ? s.listRowSelected : ''}`}
      onClick={handleClick}
      data-gpnav=""
      onContextMenu={selectionMode ? undefined : (e) => { e.preventDefault(); onContextMenu?.(e, item) }}
    >
      {/* Portrait thumbnail with blurred fill */}
      <div className={s.listThumb} style={{ background: bg }}>
        <IconDeviceGamepad2 size={20} stroke={1.1} style={{ color: 'rgba(255,255,255,0.12)', position: 'relative', zIndex: 0 }} />
        {src && <img src={src} alt="" className={s.listThumbImg} loading="lazy" decoding="async" onError={bannerOnError} />}
        {selectionMode && (
          <div className={s.listThumbCheck}>
            <div className={`${s.listCheckbox} ${selected ? s.listCheckboxOn : ''}`}>
              {selected && <IconCheck size={12} stroke={3} />}
            </div>
          </div>
        )}
      </div>

      {/* Name + genres */}
      <div className={s.listInfo}>
        {/* title attr: the name truncates and nothing else in the row reveals it */}
        <div className={s.listName} title={item.name}>{item.name}</div>
        <div className={s.listSub}>
          {genres.length > 0 && (
            <div className={s.listCategory}>{genres.slice(0, 3).join(' · ')}</div>
          )}
        </div>
      </div>

      {/* Right meta */}
      {!selectionMode && (
        <div className={s.listMeta}>
          <button
            className={`${s.listFavBtn} ${item.is_favorite ? s.listFavBtnActive : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleFav?.(item) }}
            title={item.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
          >
            <IconStar size={15} stroke={1.8} fill={item.is_favorite === 1 ? 'currentColor' : 'none'} />
          </button>
          {item.rating != null && item.status === 'finished' && (
            <span className={s.listRating}>★ {Number(item.rating).toFixed(1)}</span>
          )}
          {item.planned_month && (
            <span className={s.planChip} title="Planned to play this month">{formatMonthKey(item.planned_month)}</span>
          )}
          <SaleChip sale={sale} />
          <div
            className={s.listStatusBadge}
            style={{ color: cfg.color, borderColor: `color-mix(in srgb, ${cfg.color} 33%, transparent)`, background: `color-mix(in srgb, ${cfg.color} 9%, transparent)` }}
          >
            {cfg.label}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { value: 'want_to_play', label: 'Want to play' },
  { value: 'playing',      label: 'Playing' },
  { value: 'on_hold',      label: 'On hold' },
  { value: 'finished',     label: 'Finished' },
  { value: 'dropped',      label: 'Dropped' },
  { value: 'upcoming',     label: 'Upcoming' },
]

export default function GameList() {
  const [items, setItems]       = useState([])
  const [total, setTotal]       = useState(0)
  // Unfiltered count. `total` is whatever the CURRENT filter returned, so using
  // it for the "All" chip and the page title made both shrink to the size of
  // the active filter — the All chip literally disagreeing with itself.
  const [allTotal, setAllTotal] = useState(0)
  // How many chunks of PAGE_SIZE are on screen. Scrolling near the end loads the next one
  // (the maker asked for that over page numbers); every reload asks for all of them at once.
  const [page, setPage]         = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)
  const moreRef = useRef(null)          // the sentinel under the cards
  const [statusFilter, setStatusFilter] = useState('')
  const [genreFilter, setGenreFilter]   = useState('')
  // The month filter moved to its own tab (Play Plan); the Game List no longer filters by month.
  const monthFilter = ''
  const [planIds, setPlanIds]           = useState(null)   // ids for the Plan-for-month modal
  const [searchText, setSearchText]     = useState('')
  const [genreOptions, setGenreOptions] = useState([])
  const [customLists, setCustomLists]   = useState([])
  const [counts, setCounts]             = useState(null)   // per status, for the header and chips
  const loadCounts = () => window.kozo?.api?.gameList?.statusCounts?.().then(r => { if (r?.ok) setCounts(r.data) })
  useEffect(() => { loadCounts() }, [allTotal, items])
  const [activeListId, setActiveListId] = useState(null)   // null = All
  // Big grid or list (Small grid is gone: Ctrl + mouse wheel sizes the cards).
  const [view, setView]         = useState(() => (localStorage.getItem('kozo:view:gamelist') === 'list' ? 'list' : 'big'))
  const zoomStyle = useCardZoom('gamelist', view, { big: 220 }, { min: 140, max: 380 })   // Ctrl + mouse wheel card size
  const [loading, setLoading]   = useState(true)
  const [switching, setSwitching] = useState(false)   // filter change with grid kept on screen
  const itemsRef = useRef([])
  useEffect(() => { itemsRef.current = items }, [items])
  // Games on sale (by Steam id), refreshed when Discounts gets a new answer.
  const [sales, setSales] = useState({})
  useEffect(() => {
    const load = () => window.kozo?.api?.deals?.saleMap?.().then(r => { if (r?.ok) setSales(r.data || {}) })
    load()
    const off = window.kozo?.events?.onDealsUpdated?.(load)
    return () => { try { off?.() } catch {} }
  }, [])

  const [showAdd, setShowAdd]   = useState(false)
  const [picking, setPicking]   = useState(false)   // Pick for me
  const [wishlist, setWishlist] = useState(false)   // Steam wishlist import
  const location = useLocation()
  const navigate = useNavigate()
  // ?wishlist=1: Settings > Features > Steam wishlist
  useEffect(() => {
    if (new URLSearchParams(location.search).get('wishlist') === '1') {
      setWishlist(true)
      navigate('/game-list', { replace: true })
    }
  }, [location.search])
  const [editItem, setEditItem] = useState(null)
  const [ctxMenu, setCtxMenu]   = useState(null)     // null | { x, y, item }
  const [dragOverId, setDragOverId] = useState(null) // drop-target highlight
  const dragIdRef = useRef(null)

  // Drag-reorder within the cards shown. The main process splices their new order
  // into the whole list (gameList:reorderPage, from row 0), so favorites keep leading.
  async function handleCardDrop(targetId) {
    const dragId = dragIdRef.current
    dragIdRef.current = null
    setDragOverId(null)
    if (dragId == null || dragId === targetId) return
    const pageItems = [...items]
    const from = pageItems.findIndex(i => i.id === dragId)
    const to   = pageItems.findIndex(i => i.id === targetId)
    if (from === -1 || to === -1) return
    const [moved] = pageItems.splice(from, 1)
    pageItems.splice(to, 0, moved)
    setItems(pageItems)
    const filters = {}
    if (statusFilter) filters.status = statusFilter
    if (genreFilter)  filters.genre = genreFilter
    if (monthFilter)  filters.month = monthFilter
    if (activeListId) filters.listId = activeListId
    if (searchText?.trim()) filters.search = searchText.trim()
    await window.kozo?.api?.gameList?.reorderPage?.(filters, 0, pageItems.map(i => i.id))
    pageCache.clear()
    loadItems(page, { silent: true })
  }

  // ── Selection mode ──────────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds]     = useState(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting]           = useState(false)
  const [moving, setMoving]               = useState(false)
  const [moveResult, setMoveResult]       = useState(null)   // InfoModal payload after Move to Library

  function enterSelection() { setSelectionMode(true); setSelectedIds(new Set()); setConfirmDelete(false) }
  function exitSelection()  { setSelectionMode(false); setSelectedIds(new Set()); setConfirmDelete(false) }

  function toggleItem(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Every game in the current filter, also the ones further down that haven't loaded yet.
  const [selectingAll, setSelectingAll] = useState(false)
  async function selectAll() {
    if (items.length >= total) { setSelectedIds(new Set(items.map(i => i.id))); return }
    setSelectingAll(true)
    const res = await window.kozo?.api?.gameList?.list({ ...currentFilters(), limit: total + 50, offset: 0 })
    setSelectingAll(false)
    setSelectedIds(new Set((res?.ok ? res.data?.items ?? [] : items).map(i => i.id)))
  }
  function deselectAll() { setSelectedIds(new Set()) }
  const allSelected = total > 0 && selectedIds.size >= total

  // Toggle favorite (pins to top). Optimistic: flip local state immediately so
  // the star fills with no reload flash, then persist + silently re-fetch.
  async function toggleFav(item) {
    const next = item.is_favorite ? 0 : 1
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_favorite: next } : i))
    await window.kozo?.api?.gameList?.update?.(item.id, { is_favorite: next })
    loadItems(page, { silent: true })
  }

  // Game List → Library for the given list rows (bulk or one card). The
  // move itself is quick (art downloads later); then App's "Make it playable"
  // step asks for each game's .exe.
  async function moveToLibrary(ids) {
    if (!ids.length) return
    setMoving(true)
    const res = await window.kozo?.api?.gameList?.moveToLibrary?.(ids)
    setMoving(false)
    if (!res?.ok) {
      setMoveResult({ variant: 'error', title: 'Could not move to Library', message: res?.error || 'Unknown error' })
      return
    }
    window.dispatchEvent(new CustomEvent('kozo:make-playable', { detail: res.data || [] }))
    pageCache.clear()
    loadItems(page, { silent: true })
    if (selectionMode) exitSelection()
  }

  async function handleBulkDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    for (const id of selectedIds) {
      await window.kozo?.api?.gameList?.delete(id)
    }
    // Deleting shifts every page, so the whole cache is stale, not just page 1.
    pageCache.clear()
    await loadItems(1)
    setPage(1)
    // Same refresh the single-item delete does — without these the custom-list
    // chips and genre dropdown keep counting rows that no longer exist.
    loadLists()
    loadGenres()
    loadAllTotal()
    setDeleting(false)
    exitSelection()
  }

  const loadLists = useCallback(async () => {
    const res = await window.kozo?.api?.customLists?.list()
    if (res?.ok) setCustomLists(res.data ?? [])
  }, [])

  const loadGenres = useCallback(async () => {
    const res = await window.kozo?.api?.genres?.distinct()
    if (res?.ok) setGenreOptions(res.data ?? [])
  }, [])

  // One cheap unfiltered row just for its `total`. Refreshed alongside the
  // lists and genres, i.e. after every mutation that can change the count.
  const loadAllTotal = useCallback(async () => {
    const res = await window.kozo?.api?.gameList?.list({ limit: 1, offset: 0 })
    if (res?.ok) setAllTotal(res.data?.total ?? 0)
  }, [])

  const loadItems = useCallback(async (pg = 1, { silent = false, status = statusFilter, genre = genreFilter, month = monthFilter, listId = activeListId, search = searchText } = {}) => {
    if (!window.kozo?.api) return
    const cacheKey = JSON.stringify([pg, status, genre, month, listId, (search || '').trim()])
    // A silent reload is always a post-mutation reconcile (favorite toggled,
    // status changed, item dropped). Serving the cache there re-applied the
    // PRE-mutation rows on top of the optimistic update, so the star visibly
    // flicked back off until the refetch landed. Cache is for navigation only.
    const cached = silent ? null : pageCache.get(cacheKey)
    if (cached) {
      // Serve instantly — no spinner, no unmount, no cover re-download.
      setItems(cached.items)
      setTotal(cached.total)
    } else if (!silent && itemsRef.current.length === 0) {
      // Full "Loading…" only when there's nothing on screen (cold mount).
      setLoading(true)
    } else if (!silent) {
      // Keep the current grid rendered while the new tab loads — swapping to a
      // spinner unmounted every card and made covers re-request + jump around.
      setSwitching(true)
    }
    const filters = { limit: pg * PAGE_SIZE, offset: 0 }
    if (status) filters.status = status
    if (genre)  filters.genre = genre
    if (month)  filters.month = month
    if (listId) filters.listId = listId
    if (search?.trim()) filters.search = search.trim()
    const res = await window.kozo.api.gameList.list(filters)
    if (res?.ok) {
      const items = res.data?.items ?? []
      const total = res.data?.total ?? 0
      pageCache.set(cacheKey, { items, total })
      setItems(items)
      setTotal(total)
    }
    setLoading(false)
    setSwitching(false)
  }, [statusFilter, genreFilter, monthFilter, activeListId, searchText])

  function currentFilters() {
    const f = {}
    if (statusFilter) f.status = statusFilter
    if (genreFilter)  f.genre = genreFilter
    if (monthFilter)  f.month = monthFilter
    if (activeListId) f.listId = activeListId
    if (searchText?.trim()) f.search = searchText.trim()
    return f
  }

  const moreBusy = useRef(false)
  const loadMore = useCallback(async () => {
    if (moreBusy.current || loading || switching) return
    const have = itemsRef.current.length
    if (have >= total) return
    moreBusy.current = true
    setLoadingMore(true)
    const res = await window.kozo?.api?.gameList?.list({ ...currentFilters(), limit: PAGE_SIZE, offset: have })
    if (res?.ok) {
      const seen = new Set(itemsRef.current.map(i => i.id))
      const next = [...itemsRef.current, ...(res.data?.items ?? []).filter(i => !seen.has(i.id))]
      const pg = Math.ceil(next.length / PAGE_SIZE)
      itemsRef.current = next
      setItems(next)
      setTotal(res.data?.total ?? total)
      setPage(pg)
      pageCache.set(JSON.stringify([pg, statusFilter, genreFilter, monthFilter, activeListId, (searchText || '').trim()]), { items: next, total: res.data?.total ?? total })
    }
    setLoadingMore(false)
    moreBusy.current = false
  }, [loading, switching, total, statusFilter, genreFilter, monthFilter, activeListId, searchText])

  // The sentinel under the cards: near the bottom of the scroll panel, load more. Watched
  // against the panel itself, so the 600 px head start isn't cut off by its edges.
  const loadMoreRef = useRef(loadMore)
  useEffect(() => { loadMoreRef.current = loadMore }, [loadMore])
  const hasMore = !loading && items.length > 0 && items.length < total
  useEffect(() => {
    const el = moreRef.current
    if (!el || !hasMore) return
    let root = el.parentElement
    while (root && root !== document.body) {
      const oy = getComputedStyle(root).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      root = root.parentElement
    }
    const io = new IntersectionObserver((ents) => { if (ents.some(e => e.isIntersecting)) loadMoreRef.current?.() },
      { root: root && root !== document.body ? root : null, rootMargin: '0px 0px 600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, items.length])

  useEffect(() => {
    loadLists()
    loadGenres()
    loadAllTotal()
    loadItems(1, { status: '', genre: '', month: '', listId: null })
  }, [])

  // Debounced server-side search — skips the initial mount (loadItems above).
  const searchInit = useRef(true)
  useEffect(() => {
    if (searchInit.current) { searchInit.current = false; return }
    const t = setTimeout(() => { setPage(1); loadItems(1, { search: searchText }) }, 250)
    return () => clearTimeout(t)
  }, [searchText])

  function handleStatusChange(v) {
    setStatusFilter(v)
    setPage(1)
    loadItems(1, { status: v })
  }

  function handleGenreChange(v) {
    setGenreFilter(v)
    setPage(1)
    loadItems(1, { genre: v })
  }

  async function savePlan(month) {
    await window.kozo?.api?.gameList?.planMonth?.(planIds, month)
    setPlanIds(null)
    pageCache.clear()
    loadGenres()
    loadItems(page, { silent: true })
    if (selectionMode) exitSelection()
  }

  function handleListChange(listId) {
    setActiveListId(listId)
    setPage(1)
    loadItems(1, { listId })
  }

  function afterSave() {
    setShowAdd(false)
    setEditItem(null)
    loadItems(page)
    loadLists()
    loadGenres()
    loadAllTotal()
  }

  async function afterDelete() {
    setEditItem(null)
    pageCache.clear()
    await loadItems(page, { silent: true })
    loadLists()
    loadGenres()
    loadAllTotal()
  }

  const activeList = customLists.find(l => l.id === activeListId)

  return (
    <div className={s.page}>
      {/* Toolbar — two modes */}
      {!selectionMode ? (
        <div className={`${s.toolbar} ${s.oneRow}`}>
          <h1 className={s.pageTitle}>
            Game List
            {switching && (
              <IconLoader2
                size={14}
                stroke={1.8}
                className="spin"
                style={{ marginLeft: 6, color: 'var(--text-muted)' }}
              />
            )}
          </h1>

          {/* Search */}
          <div className={`${s.searchBox} hasRing`}>
            <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
            <input
              className={s.searchInput}
              placeholder="Search…" aria-label="Search games"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
            {searchText && (
              <button className={s.searchClear} onClick={() => setSearchText('')}>
                <IconX size={12} stroke={2} />
              </button>
            )}
          </div>

          <div className={s.filters}>
            {genreOptions.length > 0 && (
              <SearchableSelect
                value={genreFilter}
                onChange={handleGenreChange}
                placeholder="All genres"
                width="100%"
                options={genreOptions.map(g => ({ value: g, label: g }))}
              />
            )}
          </div>

          {items.length > 0 && (
            <button className={s.btnSecondary} onClick={enterSelection} title="Select games" aria-label="Select games">
              <IconCheckbox size={14} stroke={1.6} />
              <span className={s.btnLabel}>Select</span>
            </button>
          )}

          <div className={s.viewToggle}>
            {VIEW_OPTIONS.map(({ key, Icon, title }) => (
              <button
                key={key}
                className={`${s.viewBtn} ${view === key ? s.viewBtnActive : ''}`}
                title={title}
                onClick={() => { setView(key); localStorage.setItem('kozo:view:gamelist', key) }}
              >
                <Icon size={15} stroke={1.6} />
              </button>
            ))}
          </div>

          <button className={s.btnSecondary} onClick={() => setPicking(true)} aria-label="Pick for me" title="Pick for me: KoZo chooses your next game from Want to play, weighted by your favorite genres">
            <IconDice5 size={14} stroke={1.7} />
            <span className={s.btnLabel}>Pick for me</span>
          </button>

          <button className={s.btnSecondary} onClick={() => setWishlist(true)} aria-label="Steam wishlist" title="Steam wishlist: bring in the games on it">
            <IconBrandSteam size={14} stroke={1.7} />
            <span className={s.btnLabel}>Steam wishlist</span>
          </button>

          <CardSizeSlider pageKey="gamelist" view={view} defaults={{ big: 220 }} opts={{ min: 140, max: 380 }} />

          <button className={s.btnPrimary} onClick={() => setShowAdd(true)}>
            <IconPlus size={15} stroke={2} />
            Add games
          </button>
        </div>
      ) : (
        /* Selection toolbar */
        <div className={s.toolbar}>
          <button className={s.btnSecondary} onClick={exitSelection}>
            <IconX size={14} stroke={2} />
            Done
          </button>

          <button className={s.btnSecondary} onClick={allSelected ? deselectAll : selectAll}>
            {allSelected
              ? <><IconCheckbox size={14} stroke={1.8} /> Deselect all</>
              : selectingAll
                ? <><IconLoader2 size={14} stroke={1.8} className="spin" /> Selecting…</>
                : <><IconSquare size={14} stroke={1.8} /> Select all ({total})</>
            }
          </button>

          <span className={s.selectionCount}>
            {selectedIds.size === 0 ? 'Tap items to select' : `${selectedIds.size} selected`}
          </span>

          {selectedIds.size > 0 && !confirmDelete && (
            <button className={s.btnSecondary} onClick={() => setPlanIds([...selectedIds])}>
              <IconCalendarEvent size={14} stroke={1.6} />
              Plan for month
            </button>
          )}

          {selectedIds.size > 0 && !confirmDelete && (
            <button className={s.btnSecondary} onClick={() => moveToLibrary([...selectedIds])} disabled={moving}>
              <IconBooks size={14} stroke={1.6} />
              {moving ? 'Moving…' : `Move ${selectedIds.size} to Library`}
            </button>
          )}

          {selectedIds.size > 0 && (
            confirmDelete ? (
              <div className={s.confirmRow}>
                <span className={s.confirmText}>
                  Remove {selectedIds.size} item{selectedIds.size !== 1 ? 's' : ''} from list?
                </span>
                <button className={s.btnSecondary} onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className={s.btnDanger} onClick={handleBulkDelete} disabled={deleting}>
                  <IconTrash size={14} stroke={1.6} />
                  {deleting ? 'Removing…' : 'Confirm'}
                </button>
              </div>
            ) : (
              <button className={s.btnDanger} onClick={handleBulkDelete}>
                <IconTrash size={14} stroke={1.6} />
                Remove {selectedIds.size}
              </button>
            )
          )}
        </div>
      )}

      {/* Status tabs. Custom lists were removed from the page (the user found
          them clutter); the lists in the database stay untouched. */}
      {!selectionMode && (
        <div className={s.listsBar} onWheel={(e) => {
          // One row that scrolls sideways in a narrow window instead of
          // wrapping over the cards; the wheel scrolls it.
          const el = e.currentTarget
          if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
        }}>
          <div className={s.statusTabs} role="tablist" aria-label="Status">
            <button type="button" role="tab" aria-selected={!statusFilter}
              className={`${s.statusTab} ${!statusFilter ? s.statusTabOn : ''}`} onClick={() => handleStatusChange('')}>
              All <span className={s.listChipCount}>{counts?.all ?? allTotal}</span>
            </button>
            {STATUS_TABS.map(t => (
              <button key={t.value} type="button" role="tab" aria-selected={statusFilter === t.value}
                className={`${s.statusTab} ${statusFilter === t.value ? s.statusTabOn : ''}`} style={{ '--st': STATUS_CONFIG[t.value]?.color }}
                onClick={() => handleStatusChange(statusFilter === t.value ? '' : t.value)}>
                <span className={s.statusTabDot} />{t.label} <span className={s.listChipCount}>{counts?.[t.value] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <div className={s.content}>
        {loading && (
          <CardSkeletonGrid
            gridClassName={view === 'list' ? s.list : (view === 'big' ? s.bigGrid : s.grid)}
            count={view === 'list' ? 6 : 12}
          />
        )}

        {!loading && items.length === 0 && (
          <EmptyState
            Icon={IconDeviceGamepad2}
            title="No games here yet"
            desc="Add games to your backlog, wishlist, or track what you're playing."
          />
        )}

        {!loading && items.length > 0 && view === 'big' && (
          <div className={s.bigGrid} style={zoomStyle}>
            {items.map(item => {
              const draggable = !selectionMode
              return (
                <div
                  key={item.id}
                  data-gpnav=""
                  className={dragOverId === item.id ? s.cardDragOver : undefined}
                  draggable={draggable || undefined}
                  onDragStart={draggable ? (e) => {
                    dragIdRef.current = item.id
                    e.dataTransfer.setData('text/plain', String(item.id))
                    e.dataTransfer.effectAllowed = 'move'
                  } : undefined}
                  onDragOver={draggable ? (e) => { e.preventDefault(); setDragOverId(item.id) } : undefined}
                  onDragLeave={draggable ? () => setDragOverId(prev => prev === item.id ? null : prev) : undefined}
                  onDrop={draggable ? (e) => { e.preventDefault(); handleCardDrop(item.id) } : undefined}
                  onDragEnd={draggable ? () => { dragIdRef.current = null; setDragOverId(null) } : undefined}
                >
                  <GridCard
                    item={item}
                    sale={item.steam_app_id ? sales[item.steam_app_id] : null}
                    onClick={setEditItem}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(item.id)}
                    onToggle={toggleItem}
                    onToggleFav={toggleFav}
                    onContextMenu={(e, it) => setCtxMenu({ x: e.clientX, y: e.clientY, item: it })}
                  />
                </div>
              )
            })}
          </div>
        )}

        {!loading && items.length > 0 && view === 'list' && (
          <div className={s.list}>
            {items.map(item => (
              <ListRow
                key={item.id}
                item={item}
                sale={item.steam_app_id ? sales[item.steam_app_id] : null}
                onClick={setEditItem}
                selectionMode={selectionMode}
                selected={selectedIds.has(item.id)}
                onToggle={toggleItem}
                onToggleFav={toggleFav}
                onContextMenu={(e, it) => setCtxMenu({ x: e.clientX, y: e.clientY, item: it })}
              />
            ))}
          </div>
        )}

        {/* More cards load as this comes into view (scroll), never page numbers. */}
        {hasMore && (
          <div ref={moreRef} className={s.loadMore} data-gamelist-more aria-hidden={!loadingMore}>
            {loadingMore && <><IconLoader2 size={14} stroke={1.8} className="spin" /> Loading more games…</>}
          </div>
        )}
      </div>

      {picking && <PickForMeModal onClose={() => setPicking(false)} onChanged={() => loadItems(page, { silent: true })} />}
      {wishlist && <WishlistImportModal onClose={() => setWishlist(false)} onImported={() => { setWishlist(false); afterSave() }} />}

      {showAdd && (
        <AddGameToListModal
          onClose={() => setShowAdd(false)}
          onSaved={afterSave}
        />
      )}

      {planIds && (
        <PlanMonthModal
          count={planIds.length}
          current={planIds.length === 1 ? items.find(i => i.id === planIds[0])?.planned_month : null}
          onClose={() => setPlanIds(null)}
          onSave={savePlan}
        />
      )}

      {moveResult && (
        <InfoModal {...moveResult} onClose={() => setMoveResult(null)} />
      )}

      {editItem && !selectionMode && (
        <EditGameListModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onSaved={afterSave}
          onDeleted={afterDelete}
        />
      )}

      {ctxMenu && !selectionMode && (
        <CardContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          game={ctxMenu.item}
          steamAppId={ctxMenu.item.steam_app_id || null}
          onClose={() => setCtxMenu(null)}
          statuses={STATUS_CONFIG}
          statusField="status"
          clearable={false}
          onSetStatus={(item, status) => {
            if (!status) return
            // Optimistic badge update; the silent reload reconciles from the DB.
            setItems(prev => prev.map(i => i.id === item.id ? { ...i, status } : i))
            window.kozo?.api?.gameList?.update(item.id, { status })
            loadItems(page, { silent: true })
          }}
          onToggleFavorite={toggleFav}
          onEdit={(it) => setEditItem({ ...it, _openTab: 'edit' })}
          onDelete={async (item) => {
            await window.kozo?.api?.gameList?.delete(item.id)
            await afterDelete()
          }}
          extraItems={[
            { label: 'Plan for month…', Icon: IconCalendarEvent, onClick: (it) => setPlanIds([it.id]) },
            { label: 'Move to Library', Icon: IconBooks, onClick: (it) => moveToLibrary([it.id]) },
          ]}
          deleteLabel="Remove from list"
          deleteHint="Removes this entry from your Game List. Library data is not affected."
        />
      )}
    </div>
  )
}
