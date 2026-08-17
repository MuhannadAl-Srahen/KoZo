import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  IconPlus, IconLayoutGrid, IconList, IconLayoutColumns,
  IconDeviceGamepad2, IconPencil, IconSearch,
  IconCheckbox, IconSquare, IconTrash, IconX, IconCheck, IconStar, IconLoader2,
} from '@tabler/icons-react'
import { getBannerBg, parseGenres } from '../lib/utils'
import AddGameToListModal from '../components/modals/AddGameToListModal'
import AddGamesToCustomListModal from '../components/modals/AddGamesToCustomListModal'
import CreateEditListModal from '../components/modals/CreateEditListModal'
import EditGameListModal from '../components/modals/EditGameListModal'
import SearchableSelect from '../components/ui/SearchableSelect'
import CardContextMenu from '../components/ui/CardContextMenu'
import EmptyState from '../components/ui/EmptyState'
import { CardSkeletonGrid } from '../components/ui/Skeleton'
import s from './GameList.module.css'

const STATUS_CONFIG = {
  want_to_play: { label: 'Want to play', color: 'var(--a)' },
  playing:      { label: 'Playing',      color: 'var(--status-playing)' },
  finished:     { label: 'Finished',     color: 'var(--status-finished)' },
  on_hold:      { label: 'On hold',      color: 'var(--status-onhold)' },
  dropped:      { label: 'Dropped',      color: 'var(--status-dropped)' },
  upcoming:     { label: 'Upcoming',     color: 'var(--status-upcoming)' },
}

const PAGE_SIZE = 20

// Session-lifetime cache of fetched pages, keyed by page+filters. Switching
// tabs serves the last result INSTANTLY (covers stay in the browser's image
// cache instead of re-downloading) and a silent refetch reconciles after.
const pageCache = new Map()

const VIEW_OPTIONS = [
  { key: 'big',  Icon: IconLayoutColumns, title: 'Big grid' },
  { key: 'grid', Icon: IconLayoutGrid,    title: 'Small grid' },
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

function GridCard({ item, onClick, selectionMode, selected, onToggle, onToggleFav, onContextMenu }) {
  const cfg = STATUS_CONFIG[item.status] || { label: item.status, color: 'var(--text-muted)' }
  const bg  = getBannerBg(item.id)
  const src = withBust(item.banner_url, item._imgBust)
  const genres = parseGenres(item)

  function handleClick() {
    if (selectionMode) { onToggle?.(item.id) } else { onClick(item) }
  }

  return (
    <div
      className={`${s.card} ${selected ? s.cardSelected : ''}`}
      onClick={handleClick}
      onContextMenu={selectionMode ? undefined : (e) => { e.preventDefault(); onContextMenu?.(e, item) }}
    >
      <div className={s.cardBanner} style={{ background: bg }}>
        {src
          ? <>
              <img src={src} alt="" aria-hidden="true" className={s.cardBannerBlur} loading="lazy" decoding="async" onError={bannerOnError} />
              <img src={src} alt="" className={s.cardBannerImg} loading="lazy" decoding="async" onError={bannerOnError} />
            </>
          : <IconDeviceGamepad2 size={28} stroke={1.1} style={{ color: 'rgba(255,255,255,0.12)' }} />
        }
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
        </div>
      </div>
    </div>
  )
}

function ListRow({ item, onClick, selectionMode, selected, onToggle, onToggleFav, onContextMenu }) {
  const cfg = STATUS_CONFIG[item.status] || { label: item.status, color: 'var(--text-muted)' }
  const bg  = getBannerBg(item.id)
  const src = withBust(item.banner_url, item._imgBust)
  const genres = parseGenres(item)

  function handleClick() {
    if (selectionMode) { onToggle?.(item.id) } else { onClick(item) }
  }

  return (
    <div
      className={`${s.listRow} ${selected ? s.listRowSelected : ''}`}
      onClick={handleClick}
      onContextMenu={selectionMode ? undefined : (e) => { e.preventDefault(); onContextMenu?.(e, item) }}
    >
      {/* Portrait thumbnail with blurred fill */}
      <div className={s.listThumb} style={{ background: bg }}>
        <IconDeviceGamepad2 size={20} stroke={1.1} style={{ color: 'rgba(255,255,255,0.12)', position: 'relative', zIndex: 0 }} />
        {src && (
          <>
            <img src={src} alt="" aria-hidden="true" className={s.listThumbBlur} onError={bannerOnError} />
            <img src={src} alt="" className={s.listThumbImg} onError={bannerOnError} />
          </>
        )}
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
          <div
            className={s.listStatusBadge}
            style={{ color: cfg.color, borderColor: cfg.color + '55', background: cfg.color + '18' }}
          >
            {cfg.label}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function GameList() {
  const [items, setItems]       = useState([])
  const [total, setTotal]       = useState(0)
  const [page, setPage]         = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [genreFilter, setGenreFilter]   = useState('')
  const [searchText, setSearchText]     = useState('')
  const [genreOptions, setGenreOptions] = useState([])
  const [customLists, setCustomLists]   = useState([])
  const [activeListId, setActiveListId] = useState(null)   // null = All
  const [view, setView]         = useState(() => localStorage.getItem('kozo:view:gamelist') || 'big')
  const [loading, setLoading]   = useState(true)
  const [switching, setSwitching] = useState(false)   // filter change with grid kept on screen
  const itemsRef = useRef([])
  useEffect(() => { itemsRef.current = items }, [items])

  const [showAdd, setShowAdd]   = useState(false)
  const [listModal, setListModal] = useState(null)   // 'new' | list object | null
  const [editItem, setEditItem] = useState(null)
  const [ctxMenu, setCtxMenu]   = useState(null)     // null | { x, y, item }
  const [addToList, setAddToList] = useState(false)  // add-games picker for the active custom list
  const [dragOverId, setDragOverId] = useState(null) // drop-target highlight
  const dragIdRef = useRef(null)

  // Drag-reorder within the current page/filter view. Persists sequential
  // display_order values offset by the page, so pages stay in sequence; rows
  // never dragged (display_order NULL) always sort after ordered ones.
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
    const base = (page - 1) * PAGE_SIZE
    for (let i = 0; i < pageItems.length; i++) {
      if (pageItems[i].display_order !== base + i) {
        await window.kozo?.api?.gameList?.update?.(pageItems[i].id, { display_order: base + i })
      }
    }
    loadItems(page, { silent: true })
  }

  // ── Selection mode ──────────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds]     = useState(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting]           = useState(false)

  function enterSelection() { setSelectionMode(true); setSelectedIds(new Set()); setConfirmDelete(false) }
  function exitSelection()  { setSelectionMode(false); setSelectedIds(new Set()); setConfirmDelete(false) }

  function toggleItem(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function selectAll() { setSelectedIds(new Set(items.map(i => i.id))) }
  function deselectAll() { setSelectedIds(new Set()) }
  const allSelected = items.length > 0 && selectedIds.size === items.length

  // Toggle favorite (pins to top). Optimistic: flip local state immediately so
  // the star fills with no reload flash, then persist + silently re-fetch.
  async function toggleFav(item) {
    const next = item.is_favorite ? 0 : 1
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_favorite: next } : i))
    await window.kozo?.api?.gameList?.update?.(item.id, { is_favorite: next })
    loadItems(page, { silent: true })
  }

  async function handleBulkDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    for (const id of selectedIds) {
      await window.kozo?.api?.gameList?.delete(id)
    }
    await loadItems(1)
    setPage(1)
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

  const loadItems = useCallback(async (pg = 1, { silent = false, status = statusFilter, genre = genreFilter, listId = activeListId, search = searchText } = {}) => {
    if (!window.kozo?.api) return
    const cacheKey = JSON.stringify([pg, status, genre, listId, (search || '').trim()])
    const cached = pageCache.get(cacheKey)
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
    const filters = { limit: PAGE_SIZE, offset: (pg - 1) * PAGE_SIZE }
    if (status) filters.status = status
    if (genre)  filters.genre = genre
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
  }, [statusFilter, genreFilter, activeListId, searchText])

  useEffect(() => {
    loadLists()
    loadGenres()
    loadItems(1, { status: '', genre: '', listId: null })
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

  function handleListChange(listId) {
    setActiveListId(listId)
    setPage(1)
    loadItems(1, { listId })
  }

  function handlePage(p) {
    setPage(p)
    loadItems(p)
  }

  function afterSave() {
    setShowAdd(false)
    setEditItem(null)
    loadItems(page)
    loadLists()
    loadGenres()
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const activeList = customLists.find(l => l.id === activeListId)

  return (
    <div className={s.page}>
      {/* Toolbar — two modes */}
      {!selectionMode ? (
        <div className={s.toolbar}>
          <h1 className={s.pageTitle}>
            Game List
            {total > 0 && <span className={s.pageTitleCount}>{total}</span>}
            {switching && (
              <IconLoader2
                size={14}
                stroke={1.8}
                style={{ marginLeft: 6, color: 'var(--text-muted)', animation: 'spin 1s linear infinite' }}
              />
            )}
          </h1>

          {/* Search */}
          <div className={`${s.searchBox} hasRing`}>
            <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
            <input
              className={s.searchInput}
              placeholder="Search games…"
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
            <SearchableSelect
              value={statusFilter}
              onChange={handleStatusChange}
              searchable={false}
              placeholder="All statuses"
              width={145}
              options={[
                { value: 'want_to_play', label: 'Want to play' },
                { value: 'playing',      label: 'Playing' },
                { value: 'finished',     label: 'Finished' },
                { value: 'on_hold',      label: 'On hold' },
                { value: 'dropped',      label: 'Dropped' },
                { value: 'upcoming',     label: 'Upcoming' },
              ]}
            />
            {genreOptions.length > 0 && (
              <SearchableSelect
                value={genreFilter}
                onChange={handleGenreChange}
                placeholder="All genres"
                width={140}
                options={genreOptions.map(g => ({ value: g, label: g }))}
              />
            )}
          </div>

          {items.length > 0 && (
            <button className={s.btnSecondary} onClick={enterSelection}>
              <IconCheckbox size={14} stroke={1.6} />
              Select
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

          <button className={s.btnPrimary} onClick={() => setShowAdd(true)}>
            <IconPlus size={15} stroke={2} />
            Add Game
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
              : <><IconSquare size={14} stroke={1.8} /> Select all ({items.length})</>
            }
          </button>

          <span className={s.selectionCount}>
            {selectedIds.size === 0 ? 'Tap items to select' : `${selectedIds.size} selected`}
          </span>

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

      {/* Custom lists — one slim row of chips (genre filtering moved into the
          toolbar dropdown, so the header stays compact) */}
      {!selectionMode && (
        <div className={s.listsBar}>
          <button
            className={`${s.listChip} ${activeListId == null ? s.listChipActive : ''}`}
            onClick={() => handleListChange(null)}
          >
            All
            <span className={s.listChipCount}>{total}</span>
          </button>
          {customLists.map(l => (
            <button
              key={l.id}
              className={`${s.listChip} ${activeListId === l.id ? s.listChipActive : ''}`}
              onClick={() => handleListChange(l.id)}
              style={activeListId === l.id && l.color
                ? { borderColor: l.color, background: l.color + '22', color: l.color }
                : undefined}
            >
              {l.color && <span className={s.listChipDot} style={{ background: l.color }} />}
              {l.emoji ? `${l.emoji} ` : ''}{l.name}
              <span className={s.listChipCount}>{l.game_count}</span>
              <span
                className={s.listChipEdit}
                title="Edit list"
                onClick={(e) => { e.stopPropagation(); setListModal(l) }}
              >
                <IconPencil size={12} stroke={1.8} />
              </span>
            </button>
          ))}
          <button className={s.listChipNew} onClick={() => setListModal('new')}>
            <IconPlus size={13} stroke={2} />
            New list
          </button>
          {activeList && (
            <button
              className={s.addToListBtn}
              onClick={() => setAddToList(true)}
              title={`Pick games from your Game List to add to "${activeList.name}"`}
            >
              <IconPlus size={14} stroke={2} />
              Add games to "{activeList.name.length > 16 ? activeList.name.slice(0, 16) + '…' : activeList.name}"
            </button>
          )}
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
            title={activeList ? `Nothing in "${activeList.name}" yet` : 'No games here yet'}
            desc={activeList
              ? 'Pick games from your Game List, or open any game and tick this list.'
              : "Add games to your backlog, wishlist, or track what you're playing."}
            action={activeList ? { label: 'Add games', Icon: IconPlus, onClick: () => setAddToList(true) } : undefined}
          />
        )}

        {!loading && items.length > 0 && (view === 'big' || view === 'grid') && (
          <div className={view === 'big' ? s.bigGrid : s.grid}>
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

        {!loading && totalPages > 1 && (
          <div className={s.pagination}>
            <button className={s.pageBtn} onClick={() => handlePage(page - 1)} disabled={page <= 1}>‹</button>

            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
              .reduce((acc, p, i, arr) => {
                if (i > 0 && p - arr[i - 1] > 1) acc.push('…')
                acc.push(p)
                return acc
              }, [])
              .map((p, i) =>
                p === '…'
                  ? <span key={`e${i}`} className={s.pageInfo}>…</span>
                  : <button
                      key={p}
                      className={`${s.pageBtn} ${p === page ? s.pageBtnActive : ''}`}
                      onClick={() => handlePage(p)}
                    >{p}</button>
              )
            }

            <button className={s.pageBtn} onClick={() => handlePage(page + 1)} disabled={page >= totalPages}>›</button>
          </div>
        )}
      </div>

      {showAdd && (
        <AddGameToListModal
          onClose={() => setShowAdd(false)}
          onSaved={afterSave}
        />
      )}

      {editItem && !selectionMode && (
        <EditGameListModal
          item={editItem}
          onClose={() => setEditItem(null)}
          onSaved={afterSave}
          onDeleted={afterSave}
        />
      )}

      {listModal && (
        <CreateEditListModal
          list={listModal === 'new' ? null : listModal}
          onClose={() => setListModal(null)}
          onSaved={() => { setListModal(null); loadLists() }}
          onDeleted={() => {
            setListModal(null)
            if (listModal !== 'new' && activeListId === listModal.id) handleListChange(null)
            loadLists()
          }}
        />
      )}

      {addToList && activeList && (
        <AddGamesToCustomListModal
          list={activeList}
          onClose={() => setAddToList(false)}
          onAdded={() => {
            setAddToList(false)
            loadItems(1, { listId: activeListId })
            setPage(1)
            loadLists()
          }}
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
          onEdit={setEditItem}
          onDelete={async (item) => {
            await window.kozo?.api?.gameList?.delete(item.id)
            await loadItems(page)
            loadLists()
            loadGenres()
          }}
          deleteLabel="Remove from list"
          deleteHint="Removes this entry from your Game List. Library data is not affected."
        />
      )}
    </div>
  )
}
