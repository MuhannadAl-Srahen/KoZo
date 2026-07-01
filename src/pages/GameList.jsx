import React, { useState, useEffect, useCallback } from 'react'
import {
  IconPlus, IconLayoutGrid, IconList, IconLayoutColumns,
  IconDeviceGamepad2, IconPencil, IconSparkles,
  IconCheckbox, IconSquare, IconTrash, IconX, IconCheck, IconStar,
} from '@tabler/icons-react'
import { getBannerBg } from '../lib/utils'
import AddGameToListModal from '../components/modals/AddGameToListModal'
import CreateEditListModal from '../components/modals/CreateEditListModal'
import EditGameListModal from '../components/modals/EditGameListModal'
import SearchableSelect from '../components/ui/SearchableSelect'
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
const VIEW_OPTIONS = [
  { key: 'big',  Icon: IconLayoutColumns, title: 'Big grid' },
  { key: 'grid', Icon: IconLayoutGrid,    title: 'Small grid' },
  { key: 'list', Icon: IconList,          title: 'List' },
]

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseGenres(item) {
  try { return JSON.parse(item.genres || '[]') } catch { return [] }
}

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

function GridCard({ item, onClick, selectionMode, selected, onToggle, onToggleFav }) {
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
    >
      <div className={s.cardBanner} style={{ background: bg }}>
        {src
          ? <>
              <img src={src} alt="" aria-hidden="true" className={s.cardBannerBlur} onError={bannerOnError} />
              <img src={src} alt="" className={s.cardBannerImg} onError={bannerOnError} />
            </>
          : <IconDeviceGamepad2 size={28} stroke={1.1} style={{ color: 'rgba(255,255,255,0.12)' }} />
        }
        {!selectionMode && (
          <>
            <div
              className={s.cardStatusBadge}
              style={{ color: cfg.color, borderColor: cfg.color + '55', background: cfg.color + '18' }}
            >
              {cfg.label}
            </div>
            {item.rating != null && item.status === 'finished' && (
              <div className={s.cardRating}>★ {Number(item.rating).toFixed(1)}</div>
            )}
            <button
              className={`${s.cardFavBtn} ${item.is_favorite ? s.cardFavBtnActive : ''}`}
              onClick={(e) => { e.stopPropagation(); onToggleFav?.(item) }}
              title={item.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
            >
              <IconStar size={15} stroke={1.8} fill={item.is_favorite === 1 ? 'currentColor' : 'none'} />
            </button>
          </>
        )}
        {selectionMode && (
          <div className={`${s.cardCheckbox} ${selected ? s.cardCheckboxOn : ''}`}>
            {selected && <IconCheck size={12} stroke={3} />}
          </div>
        )}
      </div>
      <div className={s.cardInfo}>
        <div className={s.cardName}>{item.name}</div>
        {genres.length > 0 && (
          <div className={s.cardCategory}>{genres.slice(0, 2).join(' · ')}</div>
        )}
      </div>
    </div>
  )
}

function ListRow({ item, onClick, selectionMode, selected, onToggle, onToggleFav }) {
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
        <div className={s.listName}>{item.name}</div>
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
  const [genreOptions, setGenreOptions] = useState([])
  const [customLists, setCustomLists]   = useState([])
  const [activeListId, setActiveListId] = useState(null)   // null = All
  const [view, setView]         = useState(() => localStorage.getItem('kozo:view:gamelist') || 'big')
  const [loading, setLoading]   = useState(true)
  const [backfilling, setBackfilling] = useState(false)

  const [showAdd, setShowAdd]   = useState(false)
  const [listModal, setListModal] = useState(null)   // 'new' | list object | null
  const [editItem, setEditItem] = useState(null)

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

  const loadItems = useCallback(async (pg = 1, { silent = false, status = statusFilter, genre = genreFilter, listId = activeListId } = {}) => {
    if (!window.kozo?.api) return
    if (!silent) setLoading(true)
    const filters = { limit: PAGE_SIZE, offset: (pg - 1) * PAGE_SIZE }
    if (status) filters.status = status
    if (genre)  filters.genre = genre
    if (listId) filters.listId = listId
    const res = await window.kozo.api.gameList.list(filters)
    if (res?.ok) {
      setItems(res.data?.items ?? [])
      setTotal(res.data?.total ?? 0)
    }
    if (!silent) setLoading(false)
  }, [statusFilter, genreFilter, activeListId])

  useEffect(() => {
    loadLists()
    loadGenres()
    loadItems(1, { status: '', genre: '', listId: null })
  }, [])

  function handleStatusChange(v) {
    setStatusFilter(v)
    setPage(1)
    loadItems(1, { status: v })
  }

  function handleGenreChange(v) {
    const next = v === genreFilter ? '' : v
    setGenreFilter(next)
    setPage(1)
    loadItems(1, { genre: next })
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

  // One-time genre backfill for rows added before genres existed.
  async function handleBackfillGenres() {
    setBackfilling(true)
    await window.kozo?.api?.genres?.backfill()
    await Promise.all([loadGenres(), loadItems(page, { silent: true })])
    setBackfilling(false)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const activeList = customLists.find(l => l.id === activeListId)
  const hasMissingGenres = items.some(i => i.steam_app_id && !i.genres)

  return (
    <div className={s.page}>
      {/* Toolbar — two modes */}
      {!selectionMode ? (
        <div className={s.toolbar}>
          <h1 className={s.pageTitle}>
            Game List
            {total > 0 && <span className={s.pageTitleCount}>{total}</span>}
          </h1>

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
                { value: 'dropped',      label: 'Dropped' },
                { value: 'upcoming',     label: 'Upcoming' },
              ]}
            />
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

      {/* Custom lists rail — your playlists */}
      {!selectionMode && (
        <div className={s.listsRail}>
          <button
            className={`${s.listChip} ${activeListId == null ? s.listChipActive : ''}`}
            onClick={() => handleListChange(null)}
          >
            All
          </button>
          {customLists.map(l => (
            <button
              key={l.id}
              className={`${s.listChip} ${activeListId === l.id ? s.listChipActive : ''}`}
              onClick={() => handleListChange(l.id)}
            >
              {l.emoji ? `${l.emoji} ` : ''}{l.name}
              <span className={s.listChipCount}>{l.game_count}</span>
              {activeListId === l.id && (
                <span
                  className={s.listChipEdit}
                  title="Edit list"
                  onClick={(e) => { e.stopPropagation(); setListModal(l) }}
                >
                  <IconPencil size={12} stroke={1.8} />
                </span>
              )}
            </button>
          ))}
          <button className={s.listChipNew} onClick={() => setListModal('new')}>
            <IconPlus size={13} stroke={2} />
            New list
          </button>
        </div>
      )}

      {/* Genre chips — auto-grouping from Steam store genres */}
      {!selectionMode && (genreOptions.length > 0 || hasMissingGenres) && (
        <div className={s.genreBar}>
          {genreOptions.map(g => (
            <button
              key={g}
              className={`${s.genreChip} ${genreFilter === g ? s.genreChipActive : ''}`}
              onClick={() => handleGenreChange(g)}
            >
              {g}
            </button>
          ))}
          {hasMissingGenres && (
            <button
              className={s.genreChipFetch}
              onClick={handleBackfillGenres}
              disabled={backfilling}
              title="Fetch Steam genres for games that don't have them yet"
            >
              <IconSparkles size={12} stroke={1.8} />
              {backfilling ? 'Fetching genres…' : 'Fetch genres'}
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className={s.content}>
        {loading && (
          <div className={s.emptyState}>
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className={s.emptyState}>
            <IconDeviceGamepad2 size={48} stroke={1.2} />
            <div className={s.emptyTitle}>
              {activeList ? `Nothing in "${activeList.name}" yet` : 'No games here yet'}
            </div>
            <div className={s.emptyDesc}>
              {activeList
                ? 'Open any game and tick this list to add it here.'
                : 'Add games to your backlog, wishlist, or track what you\'re playing.'}
            </div>
          </div>
        )}

        {!loading && items.length > 0 && (view === 'big' || view === 'grid') && (
          <div className={view === 'big' ? s.bigGrid : s.grid}>
            {items.map(item => (
              <GridCard
                key={item.id}
                item={item}
                onClick={setEditItem}
                selectionMode={selectionMode}
                selected={selectedIds.has(item.id)}
                onToggle={toggleItem}
                onToggleFav={toggleFav}
              />
            ))}
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
    </div>
  )
}
