import React, { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  IconPlus, IconLayoutGrid, IconList, IconLayoutColumns,
  IconDeviceGamepad2, IconScan, IconLoader2, IconCheckbox, IconSquare,
  IconX, IconCheck, IconSearch, IconEyeOff, IconChevronRight, IconChevronDown,
  IconArchive, IconFlag, IconCalendarEvent, IconTrash,
} from '@tabler/icons-react'
import GameCard, { formatPlaytime, STATUS_META } from '../components/GameCard'
import AddGameModal from '../components/modals/AddGameModal'
import ScanResultModal from '../components/modals/ScanResultModal'
import SearchableSelect from '../components/ui/SearchableSelect'
import CardContextMenu from '../components/ui/CardContextMenu'
import EmptyState from '../components/ui/EmptyState'
import ReleasedPanel from '../components/ReleasedPanel'
import PlanMonthModal from '../components/modals/PlanMonthModal'
import { formatMonthKey } from '../lib/utils'
import useCardZoom from '../lib/useCardZoom'
import { CardSkeletonGrid } from '../components/ui/Skeleton'
import s from './Library.module.css'

const VIEW_OPTIONS = [
  { key: 'big',   label: 'Big grid',   Icon: IconLayoutColumns },
  { key: 'small', label: 'Small grid', Icon: IconLayoutGrid },
  { key: 'list',  label: 'List',       Icon: IconList },
]

const SORT_OPTIONS = [
  { value: 'last_played', label: 'Last played'  },
  { value: 'last_added',  label: 'Last added'   },
  { value: 'most_played', label: 'Most played'  },
  { value: 'achievements',label: 'Achievements' },
  { value: 'custom',      label: 'Custom order' },
]
const SORT_VALUES = new Set(SORT_OPTIONS.map(o => o.value))

function sortGames(games, sortBy) {
  // Custom order: exactly the user's drag order — no favorite pinning, no
  // fallback sorts. Unordered games (never dragged) go last, newest first.
  if (sortBy === 'custom') {
    return [...games].sort((a, b) =>
      (a.display_order == null) - (b.display_order == null) ||
      (a.display_order ?? 0) - (b.display_order ?? 0) ||
      (b.id || 0) - (a.id || 0))
  }
  return [...games].sort((a, b) => {
    // Favorites always pin to the top, regardless of the chosen sort. (The DB
    // already returns them first, but this client-side sort would otherwise
    // re-order them back in.)
    const fav = (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0)
    if (fav !== 0) return fav
    switch (sortBy) {
      case 'most_played':  return (b.total_playtime_seconds || 0) - (a.total_playtime_seconds || 0)
      case 'achievements': {
        const pa = a._total > 0 ? (a._unlocked / a._total) : -1
        const pb = b._total > 0 ? (b._unlocked / b._total) : -1
        return pb - pa
      }
      case 'last_added': return (b.id || 0) - (a.id || 0)
      default: // last_played
        if (!a.last_played_at && !b.last_played_at) return a.name.localeCompare(b.name)
        if (!a.last_played_at) return 1
        if (!b.last_played_at) return -1
        return new Date(b.last_played_at) - new Date(a.last_played_at)
    }
  })
}

const VIEW_KEY = 'kozo:view:library'

function computeStats(games) {
  const totalPlaytime = games.reduce((a, g) => a + (g.total_playtime_seconds || 0), 0)
  const totalUnlocked = games.reduce((a, g) => a + (Number(g._unlocked) || 0), 0)
  const totalAchs     = games.reduce((a, g) => a + (Number(g._total)    || 0), 0)
  return { totalPlaytime, totalUnlocked, totalAchs }
}

// Module-level cache so navigating back to the Library renders the grid + stat
// numbers instantly from memory and refreshes silently — instead of flashing
// empty/zero values on every visit.
let libraryCache = null
let weekCache = null

export default function Library() {
  const location = useLocation()
  const navigate = useNavigate()

  const [games, setGames]           = useState(libraryCache ?? [])
  const [weekSeconds, setWeekSeconds] = useState(weekCache ?? 0)
  const [liveIds, setLiveIds]       = useState(new Set())
  const [view, setView]             = useState(() => localStorage.getItem(VIEW_KEY) || 'big')
  const zoomStyle = useCardZoom('library', view, undefined, { min: 140, max: 380 })   // Ctrl + mouse wheel card size
  const [loading, setLoading]       = useState(!libraryCache)
  const [showAddModal, setAddModal] = useState(false)
  const [prefillExe, setPrefillExe]                 = useState('')
  const [prefillInstallPath, setPrefillInstallPath] = useState('')
  const [scanning, setScanning]     = useState(false)
  const [scanProgress, setScanProgress] = useState(null)   // { stage, done, total }
  const [scanModal, setScanModal]   = useState(null)  // null | scan results[]

  const [search, setSearch]         = useState('')
  const [sortBy, setSortBy]         = useState(() => {
    const saved = localStorage.getItem('kozo:sort:library')
    return SORT_VALUES.has(saved) ? saved : 'last_played'
  })
  // Collapsible shelves under the grid: finished/dropped, hidden, archived.
  const [shelfOpen, setShelfOpen] = useState(() => {
    try { return JSON.parse(localStorage.getItem('kozo:library-shelves') || 'null') || { hidden: localStorage.getItem('kozo:show-hidden') === '1' } }
    catch { return {} }
  })
  function toggleShelf(key) {
    setShelfOpen(prev => {
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem('kozo:library-shelves', JSON.stringify(next)) } catch {}
      return next
    })
  }
  const [statusFilter, setStatusFilter] = useState(() => localStorage.getItem('kozo:status:library') || '')
  // Play plan month, same filter as the Game List: 'YYYY-MM' | 'none' | ''
  const [monthFilter, setMonthFilter] = useState(() => localStorage.getItem('kozo:month:library') || '')
  const [planIds, setPlanIds] = useState(null)   // game ids for the Plan-for-month modal
  const [ctxMenu, setCtxMenu]       = useState(null)  // null | { x, y, game }
  const [dragOverId, setDragOverId] = useState(null)  // drop-target highlight (custom sort)
  const dragIdRef = React.useRef(null)

  // Drop the dragged card before the target and persist the full new order.
  // Dragging works in ANY sort: the current visual order becomes the starting
  // point, the sort switches to "Custom order", and the drop is applied.
  function handleCardDrop(targetId) {
    const dragId = dragIdRef.current
    dragIdRef.current = null
    setDragOverId(null)
    if (dragId == null || dragId === targetId) return
    const baseSort = sortBy
    if (baseSort !== 'custom') {
      setSortBy('custom')
      localStorage.setItem('kozo:sort:library', 'custom')
    }
    setGames(prev => {
      // Seed from what the user currently SEES, not the stored custom order.
      const ordered = sortGames(prev.map(g => ({ ...g })), baseSort)
      const from = ordered.findIndex(g => g.id === dragId)
      const to   = ordered.findIndex(g => g.id === targetId)
      if (from === -1 || to === -1) return prev
      const [moved] = ordered.splice(from, 1)
      ordered.splice(to, 0, moved)
      ordered.forEach((g, i) => { g.display_order = i })
      window.kozo?.api?.games?.reorder?.(ordered.map(g => g.id))
      // Map the new orders back onto the unsorted state array.
      const orderById = new Map(ordered.map(g => [g.id, g.display_order]))
      const next = prev.map(g => orderById.has(g.id) ? { ...g, display_order: orderById.get(g.id) } : g)
      libraryCache = next
      return next
    })
  }

  // Auto-open Add Game modal when navigated with ?add=1 (e.g. from unknown-process prompt)
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('add') === '1') {
      const exe          = sessionStorage.getItem('kozo:prefill-exe') || ''
      const installPath  = sessionStorage.getItem('kozo:prefill-install-path') || ''
      sessionStorage.removeItem('kozo:prefill-exe')
      sessionStorage.removeItem('kozo:prefill-install-path')
      setPrefillExe(exe)
      setPrefillInstallPath(installPath)
      setAddModal(true)
      navigate('/', { replace: true })
    }
    // ?scan=1: Settings → Features → Scan PC
    if (params.get('scan') === '1') {
      navigate('/', { replace: true })
      runScan()
    }
  }, [location.search])

  // ── Selection mode ──────────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode]         = useState(false)
  const [selectedIds, setSelectedIds]             = useState(new Set())
  const [confirmDelete, setConfirmDelete]         = useState(false)
  const [bulkDeleting, setBulkDeleting]           = useState(false)

  function changeView(v) {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  function enterSelection() {
    setSelectionMode(true)
    setSelectedIds(new Set())
    setConfirmDelete(false)
  }

  function exitSelection() {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setConfirmDelete(false)
  }

  function toggleGame(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Only ever select what is actually on screen. Hidden games and games filtered
  // out by the search/status filter have no card to untick in selection mode, so
  // including them meant "Select all" → "Remove" could delete games the user
  // never saw. (Safe despite gamesWithLive being declared below — this runs on
  // click, long after render.)
  function selectAll() {
    setSelectedIds(new Set(gamesWithLive.map(g => g.id)))
  }

  function deselectAll() {
    setSelectedIds(new Set())
  }

  // "Remove" archives: the games leave the Library but keep playtime,
  // sessions and achievements (restore any time from the Archived shelf).
  // Remove the selected games: keep their history (archive) or delete it too.
  async function handleBulkDelete(withHistory = false) {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBulkDeleting(true)
    if (withHistory) await window.kozo?.api?.games?.delete([...selectedIds])
    else await window.kozo?.api?.games?.archive([...selectedIds])
    await loadGames()
    loadWeekPlaytime({ invalidate: true })
    setBulkDeleting(false)
    exitSelection()
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  // `silent` reloads (from live events like a favorite toggle or session change)
  // refresh the data in place WITHOUT flipping the full-screen loading state —
  // otherwise the whole grid unmounts/remounts and every cover image reloads,
  // which looked like a flicker when starring a game.
  const loadGames = useCallback(async ({ silent = false } = {}) => {
    if (!window.kozo?.api) return
    if (!silent) setLoading(true)
    const res = await window.kozo.api.games.list()
    if (res?.ok) { libraryCache = res.data ?? []; setGames(libraryCache) }
    if (!silent) setLoading(false)
  }, [])

  // Optimistic favorite toggle — flip local state immediately so the star fills
  // and the card re-pins to the top with no round-trip flash; persist + the
  // game:updated event then reconcile silently.
  const handleFavorite = useCallback((game) => {
    const next = game.is_favorite ? 0 : 1
    setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, is_favorite: next } : g); libraryCache = u; return u })
    window.kozo?.api?.games?.update(game.id, { is_favorite: next })
  }, [])

  const loadActiveSessions = useCallback(async () => {
    if (!window.kozo?.api) return
    const res = await window.kozo.api.sessions.active()
    if (res?.ok) setLiveIds(new Set((res.data ?? []).map(s => s.gameId)))
  }, [])

  // "This Week" must be time played IN the last 7 days — summing the lifetime
  // playtime of games merely touched this week inflated it by hundreds of hours.
  // stats:get always returns weeklyPlaytime for the trailing 7 days; refreshed
  // on session end and on delete only (it runs ~10 queries, so not on every
  // game:updated — that fires on favorite/status/hidden toggles too).
  // `invalidate` drops the module cache up front: deleting a game cascades its
  // sessions away, so the cached figure is provably wrong from that moment and
  // must not be re-seeded as the first paint if the page remounts mid-refetch.
  const loadWeekPlaytime = useCallback(async ({ invalidate = false } = {}) => {
    if (!window.kozo?.api?.stats?.get) return
    if (invalidate) weekCache = null
    const res = await window.kozo.api.stats.get('7d')
    if (res?.ok) { weekCache = res.data?.weeklyPlaytime?.seconds || 0; setWeekSeconds(weekCache) }
  }, [])

  // Scan the PC for installed games right from the Library (the folder list is
  // still configured in Settings → Scan PC). Uses the saved scan paths, or the
  // platform defaults on first run, then opens the shared scan-result picker.
  const runScan = useCallback(async () => {
    if (!window.kozo?.api || scanning) return
    setScanning(true)
    setScanProgress(null)
    const off = window.kozo.events?.onScanProgress?.(setScanProgress)
    try {
      let paths = []
      const saved = await window.kozo.api.settings.get('scan_paths')
      if (saved?.ok && saved.data) {
        try { const arr = JSON.parse(saved.data); if (Array.isArray(arr)) paths = arr } catch {}
      }
      if (paths.length === 0) {
        const def = await window.kozo.api.scanner?.getDefaultPaths?.()
        if (def?.ok) paths = def.data || []
      }
      const res = await window.kozo.api.scanner?.scan?.(paths)
      if (res?.ok) setScanModal(res.data || [])
    } finally {
      off?.()
      setScanning(false)
    }
  }, [scanning])

  useEffect(() => {
    // Warm cache → refresh silently (no loading flash); cold → show the spinner.
    loadGames({ silent: !!libraryCache })
    loadActiveSessions()
    loadWeekPlaytime()
    if (!window.kozo?.events) return
    // Unsubscribe THIS page's own listeners only — removeAll() is window-wide
    // and would tear down the always-mounted Sidebar's listeners too.
    const offs = [
      window.kozo.events.onSessionStarted(() => { loadGames({ silent: true }); loadActiveSessions() }),
      window.kozo.events.onSessionEnded(()   => { loadGames({ silent: true }); loadActiveSessions(); loadWeekPlaytime() }),
      window.kozo.events.onGameUpdated(() => loadGames({ silent: true })),
      // Optimistic LIVE badge — light up the cover ~one poll after launch.
      window.kozo.events.onSessionDetected?.(()   => loadActiveSessions()),
      window.kozo.events.onSessionUndetected?.(() => loadActiveSessions()),
    ]
    return () => { for (const off of offs) off?.() }
  }, [loadGames, loadActiveSessions, loadWeekPlaytime])

  const allGamesWithLive = games.map(g => ({ ...g, _isLive: liveIds.has(g.id) }))
  // Shared search/status predicate for both the main grid and the hidden section.
  const matchesFilters = g => {
    if (statusFilter && g.completion_status !== statusFilter) return false
    if (monthFilter === 'none' ? !!g.planned_month : monthFilter && g.planned_month !== monthFilter) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      if (!g.name.toLowerCase().includes(q) && !(g.exe_name || '').toLowerCase().includes(q)) return false
    }
    return true
  }
  // Finished/dropped games move to their own shelf so the grid shows what you
  // still play — unless you filter for that status explicitly.
  const isDone = g => !statusFilter && !monthFilter && (g.completion_status === 'finished' || g.completion_status === 'dropped')
  const filtered = allGamesWithLive.filter(g => !g.is_hidden && !g.is_archived && !isDone(g) && matchesFilters(g))
  const gamesWithLive = sortGames(filtered, sortBy)
  const allSelected = gamesWithLive.length > 0 && selectedIds.size === gamesWithLive.length
  const shelves = [
    { key: 'done', label: 'Finished & dropped', Icon: IconFlag,
      games: sortGames(allGamesWithLive.filter(g => !g.is_hidden && !g.is_archived && isDone(g) && matchesFilters(g)), sortBy) },
    { key: 'hidden', label: 'Hidden', Icon: IconEyeOff,
      games: sortGames(allGamesWithLive.filter(g => g.is_hidden && !g.is_archived && matchesFilters(g)), sortBy) },
    { key: 'archived', label: 'Archived', Icon: IconArchive,
      hint: 'Removed from the Library. Playtime, sessions and achievements are kept.',
      games: sortGames(allGamesWithLive.filter(g => g.is_archived && matchesFilters(g)), sortBy) },
  ]
  // Header stats include hidden games — hiding only affects grid visibility,
  // not playtime/achievement totals.
  const stats = computeStats(games)
  const monthOptions = (() => {
    const counts = new Map()
    for (const g of games) if (g.planned_month && !g.is_archived) counts.set(g.planned_month, (counts.get(g.planned_month) || 0) + 1)
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  })()

  async function savePlan(month) {
    await window.kozo?.api?.games?.planMonth?.(planIds, month)
    setPlanIds(null)
    loadGames({ silent: true })
  }
  const gridClass = view === 'big' ? s.bigGrid : view === 'small' ? s.smallGrid : s.listGrid

  // One grid card with drag-to-reorder.
  function renderCard(game) {
    const draggable = !selectionMode
    return (
      <div
        key={game.id}
        data-gpnav=""
        className={dragOverId === game.id ? s.cardDragOver : undefined}
        draggable={draggable || undefined}
        onDragStart={draggable ? (e) => {
          dragIdRef.current = game.id
          e.dataTransfer.setData('text/plain', String(game.id))
          e.dataTransfer.effectAllowed = 'move'
        } : undefined}
        onDragOver={draggable ? (e) => { e.preventDefault(); setDragOverId(game.id) } : undefined}
        onDragLeave={draggable ? () => setDragOverId(prev => prev === game.id ? null : prev) : undefined}
        onDrop={draggable ? (e) => { e.preventDefault(); handleCardDrop(game.id) } : undefined}
        onDragEnd={draggable ? () => { dragIdRef.current = null; setDragOverId(null) } : undefined}
      >
        <GameCard
          game={game}
          view={view}
          selectionMode={selectionMode}
          selected={selectedIds.has(game.id)}
          onToggle={toggleGame}
          onFavorite={handleFavorite}
          onContextMenu={(e, g) => setCtxMenu({ x: e.clientX, y: e.clientY, game: g })}
        />
      </div>
    )
  }

  return (
    <div className={s.page}>
      {/* Stats */}
      <div className={s.statsBar} data-tour="library-stats">
        <div className={s.statCard}>
          <span className={s.statLabel}>Games</span>
          <span className={s.statValue}>{games.filter(g => !g.is_archived).length}</span>
        </div>
        <div className={s.statCard}>
          <span className={s.statLabel}>Playtime</span>
          <span className={s.statValue}>{formatPlaytime(stats.totalPlaytime)}</span>
        </div>
        <div className={s.statCard}>
          <span className={s.statLabel}>Achievements</span>
          <span className={s.statValue}>{stats.totalUnlocked}/{stats.totalAchs}</span>
        </div>
        <div className={s.statCard}>
          <span className={s.statLabel}>This Week</span>
          <span className={s.statValue}>{formatPlaytime(weekSeconds)}</span>
        </div>
      </div>

      {/* ── Toolbar (changes based on selection mode) ── */}
      {!selectionMode ? (
        <div className={s.toolbar}>
          <h1 className={s.pageTitle}>My Library</h1>

          {/* Search */}
          <div className={`${s.searchBox} hasRing`}>
            <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
            <input
              className={s.searchInput}
              placeholder="Search games…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className={s.searchClear} onClick={() => setSearch('')}>
                <IconX size={12} stroke={2} />
              </button>
            )}
          </div>

          {/* Sort */}
          <SearchableSelect
            value={sortBy}
            onChange={v => {
              // Clearing (X) resets to the default sort rather than no-op'ing.
              const next = v || 'last_played'
              setSortBy(next)
              localStorage.setItem('kozo:sort:library', next)
            }}
            options={SORT_OPTIONS}
            placeholder="Sort by"
            searchable={false}
            width={148}
          />

          {/* Status filter — filter out dropped/on-hold etc. without hiding */}
          <SearchableSelect
            value={statusFilter}
            onChange={v => {
              const next = v || ''
              setStatusFilter(next)
              localStorage.setItem('kozo:status:library', next)
            }}
            options={Object.entries(STATUS_META).map(([value, st]) => ({ value, label: st.label }))}
            placeholder="All statuses"
            searchable={false}
            width={140}
          />

          {/* Play plan month, same as the Game List filter */}
          <SearchableSelect
            value={monthFilter}
            onChange={v => {
              const next = v || ''
              setMonthFilter(next)
              localStorage.setItem('kozo:month:library', next)
            }}
            options={[
              ...monthOptions.map(([m, n]) => ({ value: m, label: `${formatMonthKey(m)} (${n})` })),
              { value: 'none', label: 'Not planned' },
            ]}
            placeholder="Any month"
            searchable={false}
            width={150}
          />

          <button
            className={s.btnSecondary}
            data-tour="scan-pc"
            title="Scan your PC for installed games to add (folders configured in Settings → Scan PC)"
            disabled={scanning}
            aria-busy={scanning || undefined}
            onClick={runScan}
          >
            {scanning
              ? <IconLoader2 size={15} stroke={1.6} style={{ animation: 'spin 1s linear infinite' }} />
              : <IconScan size={15} stroke={1.6} />}
            {!scanning ? 'Scan PC'
              : scanProgress?.stage === 'matching' ? `Matching ${scanProgress.done}/${scanProgress.total}`
              : 'Scanning…'}
          </button>

          {games.length > 0 && (
            <button className={s.btnSecondary} onClick={enterSelection}>
              <IconCheckbox size={15} stroke={1.6} />
              Select
            </button>
          )}

          <div className={s.viewToggle}>
            {VIEW_OPTIONS.map(({ key, label, Icon }) => (
              <button
                key={key}
                className={`${s.viewBtn} ${view === key ? s.viewBtnActive : ''}`}
                title={label}
                onClick={() => changeView(key)}
              >
                <Icon size={15} stroke={1.6} />
              </button>
            ))}
          </div>

          <button className={s.btnPrimary} data-tour="add-game" onClick={() => setAddModal(true)}>
            <IconPlus size={15} stroke={2} />
            Add Game
          </button>
        </div>
      ) : (
        /* ── Selection toolbar ── */
        <div className={s.toolbar}>
          <button className={s.btnSecondary} onClick={exitSelection}>
            <IconX size={14} stroke={2} />
            Done
          </button>

          <button
            className={s.btnSecondary}
            onClick={allSelected ? deselectAll : selectAll}
          >
            {allSelected
              ? <><IconCheckbox size={14} stroke={1.8} /> Deselect all</>
              : <><IconSquare size={14} stroke={1.8} /> Select all ({gamesWithLive.length})</>
            }
          </button>

          <span className={s.selectionCount}>
            {selectedIds.size === 0
              ? 'Tap cards to select'
              : `${selectedIds.size} game${selectedIds.size !== 1 ? 's' : ''} selected`
            }
          </span>

          {selectedIds.size > 0 && !confirmDelete && (
            <button className={s.btnSecondary} onClick={() => setPlanIds([...selectedIds])}>
              <IconCalendarEvent size={14} stroke={1.6} />
              Plan for month
            </button>
          )}

          {selectedIds.size > 0 && (
            confirmDelete ? (
              <div className={s.confirmRow}>
                <span className={s.confirmText}>
                  Remove {selectedIds.size} game{selectedIds.size !== 1 ? 's' : ''}?
                </span>
                <button className={s.btnSecondary} onClick={() => setConfirmDelete(false)} disabled={bulkDeleting}>
                  Cancel
                </button>
                <button className={s.btnSecondary} onClick={() => handleBulkDelete(false)} disabled={bulkDeleting}>
                  <IconArchive size={14} stroke={1.6} />
                  Keep history
                </button>
                <button className={s.btnDanger} onClick={() => handleBulkDelete(true)} disabled={bulkDeleting}>
                  <IconTrash size={14} stroke={1.6} />
                  {bulkDeleting ? 'Removing…' : 'Delete with history'}
                </button>
              </div>
            ) : (
              <button className={s.btnDanger} onClick={() => handleBulkDelete()}>
                <IconTrash size={14} stroke={1.6} />
                Remove {selectedIds.size}
              </button>
            )
          )}
        </div>
      )}

      {/* Game grid */}
      <div className={s.content}>
        <ReleasedPanel onChanged={() => loadGames({ silent: true })} />
        {/* Three distinct states. The old version could show two messages at
            once (empty search AND empty library), and showed NOTHING at all
            when a status filter matched nothing — a blank page with no
            explanation and no way back out. */}
        {loading && (
          <CardSkeletonGrid gridClassName={gridClass} count={view === 'list' ? 6 : 12} />
        )}

        {!loading && games.length === 0 && (
          <EmptyState
            Icon={IconDeviceGamepad2}
            title="No games yet"
            desc="Add a game manually, or scan your PC to find what you already have installed."
          />
        )}

        {!loading && games.length > 0 && gamesWithLive.length === 0 && (
          <EmptyState
            Icon={IconDeviceGamepad2}
            title={search ? `No games match "${search}"` : 'Nothing matches these filters'}
            desc="Try a different search, or clear the filters to see your whole library."
            action={{
              label: 'Clear filters',
              Icon: IconX,
              onClick: () => {
                setSearch('')
                setStatusFilter('')
                localStorage.setItem('kozo:status:library', '')
              },
            }}
          />
        )}

        {!loading && games.length > 0 && (
          <div className={gridClass} style={zoomStyle}>
            {gamesWithLive.map(renderCard)}
          </div>
        )}


        {/* Shelves — collapsed sections at the bottom instead of mixing into
            the grid; expand to manage them (right-click still works) */}
        {!loading && !selectionMode && shelves.filter(sh => sh.games.length > 0).map(sh => (
          <React.Fragment key={sh.key}>
            <button className={s.hiddenHeader} onClick={() => toggleShelf(sh.key)} title={sh.hint}>
              {shelfOpen[sh.key] ? <IconChevronDown size={14} stroke={1.8} /> : <IconChevronRight size={14} stroke={1.8} />}
              <sh.Icon size={13} stroke={1.6} />
              {sh.label} ({sh.games.length})
            </button>
            {shelfOpen[sh.key] && (
              <div className={gridClass} style={zoomStyle}>
                {sh.games.map(game => (
                  <GameCard
                    key={game.id}
                    game={game}
                    view={view}
                    selectionMode={false}
                    onFavorite={handleFavorite}
                    onContextMenu={(e, g) => setCtxMenu({ x: e.clientX, y: e.clientY, game: g })}
                  />
                ))}
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {showAddModal && (
        <AddGameModal
          prefillExe={prefillExe}
          prefillInstallPath={prefillInstallPath}
          onClose={() => { setAddModal(false); setPrefillExe(''); setPrefillInstallPath('') }}
          onAdded={() => { setAddModal(false); setPrefillExe(''); setPrefillInstallPath(''); loadGames() }}
        />
      )}

      {scanModal && (
        <ScanResultModal
          results={scanModal}
          onClose={() => setScanModal(null)}
          onAdd={() => { setScanModal(null); loadGames() }}
        />
      )}

      {ctxMenu && (
        <CardContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          game={ctxMenu.game}
          steamAppId={ctxMenu.game.steam_app_id || ctxMenu.game.manual_appid || null}
          onClose={() => setCtxMenu(null)}
          onSetStatus={(game, status) => {
            // Optimistic badge update; game:updated reconciles from the DB.
            setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, completion_status: status } : g); libraryCache = u; return u })
            window.kozo?.api?.games?.update(game.id, { completion_status: status })
          }}
          onToggleHidden={(game) => {
            const next = game.is_hidden ? 0 : 1
            setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, is_hidden: next } : g); libraryCache = u; return u })
            window.kozo?.api?.games?.update(game.id, { is_hidden: next })
          }}
          onToggleFavorite={handleFavorite}
          onDelete={ctxMenu.game.is_archived ? undefined : async (game) => {
            setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, is_archived: 1 } : g); libraryCache = u; return u })
            await window.kozo?.api?.games?.archive([game.id])
            loadGames({ silent: true })
          }}
          onRestore={ctxMenu.game.is_archived ? async (game) => {
            setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, is_archived: 0 } : g); libraryCache = u; return u })
            await window.kozo?.api?.games?.unarchive([game.id])
            loadGames({ silent: true })
          } : undefined}
          deleteIsArchive
          deleteLabel="Remove from library"
          onDeleteForever={async (game) => {
            setGames(prev => { const u = prev.filter(g => g.id !== game.id); libraryCache = u; return u })
            await window.kozo?.api?.games?.delete(game.id)
            loadGames({ silent: true })
            loadWeekPlaytime({ invalidate: true })
          }}
          extraItems={[
            { label: 'Plan for month…', Icon: IconCalendarEvent, onClick: (g) => setPlanIds([g.id]) },
          ]}
        />
      )}

      {planIds && (
        <PlanMonthModal
          count={planIds.length}
          current={planIds.length === 1 ? games.find(g => g.id === planIds[0])?.planned_month : null}
          onClose={() => setPlanIds(null)}
          onSave={savePlan}
        />
      )}
    </div>
  )
}
