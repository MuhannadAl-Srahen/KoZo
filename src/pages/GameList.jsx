import React, { useState, useEffect, useCallback } from 'react'
import {
  IconPlus, IconLayoutGrid, IconList, IconLayoutColumns,
  IconDeviceGamepad2, IconSettings,
  IconCheckbox, IconSquare, IconTrash, IconX, IconCheck, IconStar,
} from '@tabler/icons-react'
import { getBannerBg } from '../lib/utils'
import AddGameToListModal from '../components/modals/AddGameToListModal'
import ManageCategoriesModal from '../components/modals/ManageCategoriesModal'
import EditGameListModal from '../components/modals/EditGameListModal'
import SearchableSelect from '../components/ui/SearchableSelect'
import s from './GameList.module.css'

const STATUS_CONFIG = {
  want_to_play: { label: 'Want to play', color: 'var(--a)' },
  playing:      { label: 'Playing',      color: 'var(--status-playing)' },
  finished:     { label: 'Finished',     color: 'var(--status-finished)' },
  dropped:      { label: 'Dropped',      color: 'var(--status-dropped)' },
  upcoming:     { label: 'Upcoming',     color: 'var(--status-upcoming)' },
}

const PAGE_SIZE = 20
const VIEW_OPTIONS = [
  { key: 'big',  Icon: IconLayoutColumns, title: 'Big grid' },
  { key: 'grid', Icon: IconLayoutGrid,    title: 'Small grid' },
  { key: 'list', Icon: IconList,          title: 'List' },
]

// ── Card components ─────────────────────────────────────────────────────────

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

function GridCard({ item, onClick, selectionMode, selected, onToggle, onToggleFav }) {
  const cfg = STATUS_CONFIG[item.status] || { label: item.status, color: 'var(--text-muted)' }
  const bg  = getBannerBg(item.id)
  const src = withBust(item.banner_url, item._imgBust)

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
        {item.category_name && (
          <div className={s.cardCategory}>{item.category_emoji} {item.category_name}</div>
        )}
      </div>
    </div>
  )
}

function ListRow({ item, onClick, selectionMode, selected, onToggle, onToggleFav }) {
  const cfg = STATUS_CONFIG[item.status] || { label: item.status, color: 'var(--text-muted)' }
  const bg  = getBannerBg(item.id)
  const src = withBust(item.banner_url, item._imgBust)

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

      {/* Name + category */}
      <div className={s.listInfo}>
        <div className={s.listName}>{item.name}</div>
        <div className={s.listSub}>
          {item.category_name && (
            <div className={s.listCategory}>{item.category_emoji} {item.category_name}</div>
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
  const [statusFilter, setStatusFilter]     = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [categories, setCategories]         = useState([])
  const [view, setView]         = useState(() => localStorage.getItem('kozo:view:gamelist') || 'big')
  const [loading, setLoading]   = useState(true)

  const [showAdd, setShowAdd]               = useState(false)
  const [showManage, setShowManage]         = useState(false)
  const [editItem, setEditItem]             = useState(null)

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
  // the star fills with no reload flash, then persist + silently re-fetch (so
  // the server-side favorites-first ordering settles in without the grid
  // unmounting and reloading every cover image).
  async function toggleFav(item) {
    const next = item.is_favorite ? 0 : 1
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, is_favorite: next } : i))
    await window.kozo?.api?.gameList?.update?.(item.id, { is_favorite: next })
    loadItems(page, statusFilter, categoryFilter, { silent: true })
  }

  async function handleBulkDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    for (const id of selectedIds) {
      await window.kozo?.api?.gameList?.delete(id)
    }
    await loadItems(1, statusFilter, categoryFilter)
    setPage(1)
    setDeleting(false)
    exitSelection()
  }

  const loadCategories = useCallback(async () => {
    if (!window.kozo?.api) return
    const res = await window.kozo.api.categories.list()
    if (res?.ok) setCategories(res.data ?? [])
  }, [])

  const loadItems = useCallback(async (pg = 1, status = statusFilter, cat = categoryFilter, { silent = false } = {}) => {
    if (!window.kozo?.api) return
    if (!silent) setLoading(true)
    const filters = { limit: PAGE_SIZE, offset: (pg - 1) * PAGE_SIZE }
    if (status)  filters.status = status
    if (cat)     filters.categoryId = Number(cat)
    const res = await window.kozo.api.gameList.list(filters)
    if (res?.ok) {
      setItems(res.data?.items ?? [])
      setTotal(res.data?.total ?? 0)
    }
    if (!silent) setLoading(false)
  }, [statusFilter, categoryFilter])

  useEffect(() => {
    loadCategories()
    loadItems(1, '', '')
  }, [])

  function handleStatusChange(v) {
    setStatusFilter(v)
    setPage(1)
    loadItems(1, v, categoryFilter)
  }

  function handleCategoryChange(v) {
    setCategoryFilter(v)
    setPage(1)
    loadItems(1, statusFilter, v)
  }

  function handlePage(p) {
    setPage(p)
    loadItems(p, statusFilter, categoryFilter)
  }

  function afterSave() {
    setShowAdd(false)
    setEditItem(null)
    loadItems(page, statusFilter, categoryFilter)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

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

            <SearchableSelect
              value={categoryFilter}
              onChange={handleCategoryChange}
              placeholder="All categories"
              width={160}
              options={categories.map(c => ({
                value: String(c.id),
                label: (c.emoji ? `${c.emoji} ` : '') + c.name,
              }))}
            />
          </div>

          <button className={s.btnSecondary} onClick={() => setShowManage(true)}>
            <IconSettings size={14} stroke={1.6} />
            Categories
          </button>

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
            <div className={s.emptyTitle}>No games here yet</div>
            <div className={s.emptyDesc}>
              Add games to your backlog, wishlist, or track what you're playing.
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
          categories={categories}
          onClose={() => { setShowAdd(false); loadCategories() }}
          onSaved={afterSave}
        />
      )}

      {editItem && !selectionMode && (
        <EditGameListModal
          item={editItem}
          categories={categories}
          onClose={() => setEditItem(null)}
          onSaved={afterSave}
          onDeleted={afterSave}
        />
      )}

      {showManage && (
        <ManageCategoriesModal
          onClose={() => { setShowManage(false); loadCategories() }}
        />
      )}
    </div>
  )
}
