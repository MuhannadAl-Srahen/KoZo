import React, { useState, useEffect, useCallback, useMemo, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  IconPlus, IconList, IconLayoutColumns,
  IconDeviceGamepad2, IconScan, IconLoader2, IconCheckbox, IconSquare,
  IconX, IconCheck, IconSearch, IconEyeOff, IconChevronRight,
  IconArchive, IconCalendarEvent, IconTrash, IconDownload, IconEdit, IconArrowBackUp,
} from '@tabler/icons-react'
import GameCard from '../components/GameCard'
import AddGameModal from '../components/modals/AddGameModal'
import EditGameModal from '../components/modals/EditGameModal'
import InfoModal from '../components/ui/InfoModal'
import ScanResultModal from '../components/modals/ScanResultModal'
import SearchableSelect from '../components/ui/SearchableSelect'
import CardSizeSlider from '../components/ui/CardSizeSlider'
import CardContextMenu from '../components/ui/CardContextMenu'
import EmptyState from '../components/ui/EmptyState'
import ReleasedPanel from '../components/ReleasedPanel'
import PlanMonthModal from '../components/modals/PlanMonthModal'
import BulkEditModal from '../components/modals/BulkEditModal'
import UndoBar from '../components/ui/UndoBar'
import useCardZoom from '../lib/useCardZoom'
import { LIBRARY_TABS, tabOf, countTabs, shownTabs, settleTab, startTab, matchesStatus } from '../lib/libraryTabs'
import { useAppearance } from '../context/AppearanceContext'
import { CardSkeletonGrid } from '../components/ui/Skeleton'
import s from './Library.module.css'

const VIEW_OPTIONS = [
  { key: 'big',   label: 'Big grid',   Icon: IconLayoutColumns },
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

// electron/services/cardCovers.js CARD_W: how wide the card-size cover copies are.
const CARD_COVER_W = 360

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

// The tabs under the toolbar (lib/libraryTabs.js). A tab shows only while it holds a game.
const TAB_META = {
  current:  { label: 'Current',  color: 'var(--a)', hint: 'Playing, on hold and not started yet' },
  finished: { label: 'Finished', color: 'var(--status-finished)' },
  dropped:  { label: 'Dropped',  color: 'var(--status-dropped)' },
  hidden:   { label: 'Hidden',   Icon: IconEyeOff, color: 'var(--text-muted)', hint: 'Hidden games are still tracked and still count in your stats' },
  removed:  { label: 'Removed',  Icon: IconArchive, color: 'var(--text-muted)', hint: 'Not in your Library. Hours, sessions and achievements are kept' },
}
// The status dropdown on Current (Finished and Dropped are tabs).
const CURRENT_STATUSES = [
  { value: 'playing', label: 'Playing' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'none',    label: 'No status' },
]
const CURRENT_STATUS_VALUES = new Set(CURRENT_STATUSES.map(o => o.value))

// Module-level cache so navigating back to the Library renders the grid instantly from
// memory and refreshes silently, instead of flashing empty on every visit. (The Games,
// Playtime, Achievements and This week boxes are gone from the top: Activity has them, and
// the maker asked for them off the Library.)
let libraryCache = null
// The tab in use, for this run only: back from a game page lands on the tab you left, and a
// restart opens Current again (a Removed tab coming back by itself is the "it's still there").
let libraryTab = null

export default function Library() {
  const location = useLocation()
  const navigate = useNavigate()

  const [games, setGames]           = useState(libraryCache ?? [])
  const [liveIds, setLiveIds]       = useState(new Set())
  // Big grid or list. The old Small grid view is gone (Ctrl + mouse wheel sizes
  // the cards now), so a saved 'small' opens the grid.
  const [view, setView]             = useState(() => (localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'big'))
  const zoomStyle = useCardZoom('library', view, undefined, { min: 140, max: 380 })   // Ctrl + mouse wheel card size
  const [loading, setLoading]       = useState(!libraryCache)
  const [showAddModal, setAddModal] = useState(false)
  const [prefillExe, setPrefillExe]                 = useState('')
  const [prefillInstallPath, setPrefillInstallPath] = useState('')
  const [scanning, setScanning]     = useState(false)
  const [scanProgress, setScanProgress] = useState(null)   // { stage, done, total }
  const [scanModal, setScanModal]   = useState(null)  // null | scan results[]
  // Launcher games (Epic, GOG, Xbox) found in the background: "N new games found".
  const [launcherNew, setLauncherNew] = useState(0)

  const [search, setSearch]         = useState('')
  const [sortBy, setSortBy]         = useState(() => {
    const saved = localStorage.getItem('kozo:sort:library')
    return SORT_VALUES.has(saved) ? saved : 'last_played'
  })
  // Which tab is shown: Current, Finished, Dropped, Hidden or Removed.
  const [tab, setTabState] = useState(() => {
    let savedStatus = ''
    try { savedStatus = localStorage.getItem('kozo:status:library') || '' } catch {}
    return startTab({ show: new URLSearchParams(location.search).get('show'), remembered: libraryTab, savedStatus })
  })
  const [statusFilter, setStatusFilter] = useState(() => {
    try { const v = localStorage.getItem('kozo:status:library') || ''; return CURRENT_STATUS_VALUES.has(v) ? v : '' } catch { return '' }
  })
  // Once: the old folding rows' saved state goes, and an old Finished / Dropped filter is a tab now.
  useEffect(() => {
    try {
      localStorage.removeItem('kozo:library-shelves')
      localStorage.removeItem('kozo:show-hidden')
      if (!CURRENT_STATUS_VALUES.has(localStorage.getItem('kozo:status:library') || '')) localStorage.setItem('kozo:status:library', '')
    } catch {}
  }, [])
  const [planIds, setPlanIds] = useState(null)   // game ids for the Plan-for-month modal
  const [editIds, setEditIds] = useState(null)   // game ids for Edit (status, favorite, hidden)
  const [undo, setUndo] = useState(null)         // { text, run }: the Undo bar after a change to many games
  const [ctxMenu, setCtxMenu]       = useState(null)  // null | { x, y, game }
  const [editGame, setEditGame]     = useState(null)  // game opened in Edit from the card menu
  const [launchMsg, setLaunchMsg]   = useState(null)  // { variant, title, message } after Play from the menu
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
    // ?show=removed (or any tab): a link straight to that tab.
    const show = params.get('show')
    if (LIBRARY_TABS.includes(show)) {
      changeTab(show)
      navigate('/', { replace: true })
    }
  }, [location.search])

  // New launcher games found in the background (main process, on launch).
  useEffect(() => {
    window.kozo?.api?.launchers?.pending?.().then(r => { if (r?.ok) setLauncherNew((r.data || []).length) })
    const off = window.kozo?.events?.onLaunchersFound?.((n) => setLauncherNew(n || 0))
    return () => off?.()
  }, [])

  // Closing the scan window counts as seen: the strip doesn't come back for those launcher games.
  function closeScanModal() {
    const keys = (scanModal || []).map(g => g.key).filter(Boolean)
    if (keys.length) { window.kozo?.api?.launchers?.dismiss?.(keys); setLauncherNew(0) }
    setScanModal(null)
  }

  // ── Selection mode ──────────────────────────────────────────────────────────
  const [selectionMode, setSelectionMode]         = useState(false)
  const [selectedIds, setSelectedIds]             = useState(new Set())
  const [confirmDelete, setConfirmDelete]         = useState(false)
  const [bulkDeleting, setBulkDeleting]           = useState(false)

  function changeView(v) {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  function changeTab(k) {
    libraryTab = k
    setTabState(k)
    setSelectedIds(new Set())
    setConfirmDelete(false)
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

  // Stable handlers (useCallback) let the memoized cards skip redrawing: with inline arrows,
  // opening a menu or dragging over a card redrew every card in the Library.
  const toggleGame = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const openCardMenu = useCallback((e, g) => setCtxMenu({ x: e.clientX, y: e.clientY, game: g }), [])

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

  // "Remove" with Keep history archives: the games leave the Library but keep playtime,
  // sessions and achievements, and can come back from the Removed tab (or Undo right away).
  // Delete with history deletes them for good.
  async function handleBulkDelete(withHistory = false) {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBulkDeleting(true)
    const ids = [...selectedIds]
    if (withHistory) await window.kozo?.api?.games?.delete(ids)
    else await window.kozo?.api?.games?.archive(ids)
    await loadGames()
    setBulkDeleting(false)
    exitSelection()
    if (!withHistory && ids.length) {
      setUndo({
        text: `Removed ${gamesWord(ids.length)} from the Library`,
        run: async () => { await window.kozo?.api?.games?.unarchive(ids); loadGames({ silent: true }) },
      })
    }
  }

  // The Removed tab: bring the selected games back.
  async function handleBulkRestore() {
    const ids = [...selectedIds]
    if (!ids.length) return
    await window.kozo?.api?.games?.unarchive(ids)
    await loadGames({ silent: true })
    exitSelection()
    setUndo({
      text: `Restored ${gamesWord(ids.length)}`,
      run: async () => { await window.kozo?.api?.games?.archive(ids); loadGames({ silent: true }) },
    })
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
    if (!window.kozo?.events) return
    // Unsubscribe THIS page's own listeners only — removeAll() is window-wide
    // and would tear down the always-mounted Sidebar's listeners too.
    const offs = [
      window.kozo.events.onSessionStarted(() => { loadGames({ silent: true }); loadActiveSessions() }),
      window.kozo.events.onSessionEnded(()   => { loadGames({ silent: true }); loadActiveSessions() }),
      window.kozo.events.onSessionDiscarded?.(() => { loadGames({ silent: true }); loadActiveSessions() }),
      window.kozo.events.onGameUpdated(() => loadGames({ silent: true })),
      // Optimistic LIVE badge — light up the cover ~one poll after launch.
      window.kozo.events.onSessionDetected?.(()   => loadActiveSessions()),
      window.kozo.events.onSessionUndetected?.(() => loadActiveSessions()),
    ]
    return () => { for (const off of offs) off?.() }
  }, [loadGames, loadActiveSessions])

  // Memoized: new objects on every render made every (memoized) card redraw anyway.
  const allGamesWithLive = useMemo(() => games.map(g => ({ ...g, _isLive: liveIds.has(g.id) })), [games, liveIds])
  // One grid, one tab at a time: every game has exactly one tab (lib/libraryTabs.js), and each
  // tab gets the same search, sort, sizes, select mode and menus.
  const q = search.trim().toLowerCase()
  const matchesSearch = useCallback(
    g => !q || g.name.toLowerCase().includes(q) || (g.exe_name || '').toLowerCase().includes(q), [q])
  // Settings > Appearance > Show or hide: the Hidden and Removed tabs can be left out, and then
  // those games are nowhere in the Library (Ctrl+K still finds them, their page can restore).
  const { prefs: look } = useAppearance()
  const offTabs = useMemo(() => [look.hideLibraryHiddenTab && 'hidden', look.hideLibraryRemovedTab && 'removed'].filter(Boolean),
    [look.hideLibraryHiddenTab, look.hideLibraryRemovedTab])
  const tabCounts = useMemo(() => countTabs(allGamesWithLive), [allGamesWithLive])
  // While searching, each tab's number is its matches, so a game in another tab is one click away.
  const tabMatches = useMemo(() => (q ? countTabs(allGamesWithLive, matchesSearch) : tabCounts), [q, allGamesWithLive, tabCounts, matchesSearch])
  const visibleTabs = shownTabs(tabCounts, offTabs)
  const gamesWithLive = useMemo(() => sortGames(
    allGamesWithLive.filter(g => tabOf(g) === tab && matchesSearch(g) && (tab !== 'current' || matchesStatus(g, statusFilter))),
    sortBy), [allGamesWithLive, tab, matchesSearch, statusFilter, sortBy])
  const allSelected = gamesWithLive.length > 0 && selectedIds.size === gamesWithLive.length
  // Matches for the search that sit in other tabs.
  const elsewhere = q ? visibleTabs.filter(k => k !== tab && tabMatches[k] > 0) : []
  // A tab that emptied (the last removed game restored, the last finished one set back) closes.
  useEffect(() => {
    if (loading) return
    const t = settleTab(tab, tabCounts, offTabs)
    if (t !== tab) changeTab(t)
  }, [loading, tabCounts, tab, offTabs])

  const gamesWord = (n) => `${n} game${n !== 1 ? 's' : ''}`
  async function savePlan(month) {
    const ids = planIds
    // What each game was planned for, so Undo can put every one back.
    const before = new Map()
    for (const id of ids) {
      const m = allGamesWithLive.find(g => g.id === id)?.planned_month || null
      if (!before.has(m)) before.set(m, [])
      before.get(m).push(id)
    }
    await window.kozo?.api?.games?.planMonth?.(ids, month)
    setPlanIds(null)
    loadGames({ silent: true })
    setUndo({
      text: month ? `Planned ${gamesWord(ids.length)}` : `Cleared the plan of ${gamesWord(ids.length)}`,
      run: async () => {
        for (const [m, group] of before) await window.kozo?.api?.games?.planMonth?.(group, m)
        loadGames({ silent: true })
      },
    })
  }

  // Edit: the same change for every selected game, then Undo for 20 seconds.
  async function saveEdit(patch) {
    const ids = editIds
    const res = await window.kozo?.api?.games?.bulkUpdate?.(ids, patch)
    setEditIds(null)
    loadGames({ silent: true })
    if (res?.ok) {
      const before = res.data?.before || []
      setUndo({
        text: `Changed ${gamesWord(before.length)}`,
        run: async () => { await window.kozo?.api?.games?.bulkRestore?.(before); loadGames({ silent: true }) },
      })
    } else {
      setLaunchMsg({ variant: 'error', title: 'Could not change the games', message: res?.error || 'Unknown error.' })
    }
  }
  const gridClass = view === 'list' ? s.listGrid : s.bigGrid

  // Card-size covers (electron/services/cardCovers.js) only while a card is drawn no wider
  // than the copy, in device pixels (Windows scaling and KoZo's zoom included), so a bigger
  // card keeps the full cover and never looks softer.
  const gridRef = useRef(null)
  const [cardCover, setCardCover] = useState(true)
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => {
      const w = grid.firstElementChild?.getBoundingClientRect().width
      if (w) setCardCover(w * (window.devicePixelRatio || 1) <= CARD_COVER_W)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(grid)
    return () => ro.disconnect()
  }, [view, zoomStyle?.['--card-min'], loading, tab, gamesWithLive.length])

  // One grid card with drag-to-reorder.
  function renderCard(game) {
    const draggable = !selectionMode && tab !== 'removed'
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
          onContextMenu={openCardMenu}
          cardCover={cardCover}
        />
      </div>
    )
  }

  return (
    <div className={s.page}>
      {/* ── Toolbar (changes based on selection mode) ── */}
      {!selectionMode ? (
        <div className={`${s.toolbar} ${s.oneRow}`}>
          <h1 className={s.pageTitle}>My Library</h1>

          {/* Search */}
          <div className={`${s.searchBox} hasRing`}>
            <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
            <input
              className={s.searchInput}
              placeholder="Search…" aria-label="Search games"
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
          <div className={s.selectSlot} style={{ '--slot': '148px' }}>
          <SearchableSelect
            value={sortBy}
            onChange={v => {
              const next = v || 'last_played'
              setSortBy(next)
              localStorage.setItem('kozo:sort:library', next)
            }}
            options={SORT_OPTIONS}
            placeholder="Sort by"
            searchable={false}
            clearable={false}
            width="100%"
          />
          </div>

          {/* Status filter, on Current only: Finished and Dropped are tabs */}
          {tab === 'current' && (
          <div className={s.selectSlot} style={{ '--slot': '140px' }}>
          <SearchableSelect
            value={statusFilter}
            onChange={v => {
              const next = v || ''
              setStatusFilter(next)
              localStorage.setItem('kozo:status:library', next)
            }}
            options={CURRENT_STATUSES}
            placeholder="All statuses"
            searchable={false}
            width="100%"
          />
          </div>
          )}

          <button
            className={s.btnSecondary}
            data-tour="scan-pc"
            title="Scan PC: find installed games to add, also from Epic, GOG and Xbox (folders are in Settings, Tracking)"
            aria-label="Scan PC"
            disabled={scanning}
            aria-busy={scanning || undefined}
            onClick={runScan}
          >
            {scanning
              ? <IconLoader2 size={15} stroke={1.6} className="spin" />
              : <IconScan size={15} stroke={1.6} />}
            {!scanning ? <span className={s.btnLabel}>Scan PC</span>
              : scanProgress?.stage === 'matching' ? `Matching ${scanProgress.done}/${scanProgress.total}`
              : 'Scanning…'}
          </button>

          {games.length > 0 && (
            <button className={s.btnSecondary} onClick={enterSelection} title="Select games" aria-label="Select games">
              <IconCheckbox size={15} stroke={1.6} />
              <span className={s.btnLabel}>Select</span>
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

          <CardSizeSlider pageKey="library" view={view} opts={{ min: 140, max: 380 }} />

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
            {tab !== 'current' ? ` in ${TAB_META[tab].label}` : ''}
          </span>

          {selectedIds.size > 0 && !confirmDelete && tab !== 'removed' && (
            <button className={s.btnSecondary} onClick={() => setEditIds([...selectedIds])} data-bulk-edit>
              <IconEdit size={14} stroke={1.6} />
              Edit
            </button>
          )}
          {selectedIds.size > 0 && !confirmDelete && tab !== 'removed' && (
            <button className={s.btnSecondary} onClick={() => setPlanIds([...selectedIds])}>
              <IconCalendarEvent size={14} stroke={1.6} />
              Plan for month
            </button>
          )}

          {/* Removed tab: bring them back, or delete them for good */}
          {selectedIds.size > 0 && tab === 'removed' && !confirmDelete && (
            <button className={s.btnSecondary} onClick={handleBulkRestore} data-bulk-restore>
              <IconArrowBackUp size={14} stroke={1.6} />
              Restore {selectedIds.size}
            </button>
          )}
          {selectedIds.size > 0 && tab === 'removed' && (
            confirmDelete ? (
              <div className={s.confirmRow}>
                <span className={s.confirmText}>
                  Delete {gamesWord(selectedIds.size)} with their hours, sessions and achievements? This can't be undone.
                </span>
                <button className={s.btnSecondary} onClick={() => setConfirmDelete(false)} disabled={bulkDeleting}>
                  Cancel
                </button>
                <button className={s.btnDanger} onClick={() => handleBulkDelete(true)} disabled={bulkDeleting}>
                  <IconTrash size={14} stroke={1.6} />
                  {bulkDeleting ? 'Deleting…' : 'Delete with history'}
                </button>
              </div>
            ) : (
              <button className={s.btnDanger} onClick={() => setConfirmDelete(true)}>
                <IconTrash size={14} stroke={1.6} />
                Delete {selectedIds.size}
              </button>
            )
          )}

          {selectedIds.size > 0 && tab !== 'removed' && (
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

      {/* Tabs: one row, only the tabs that hold games, hidden while there is just Current */}
      {!selectionMode && !loading && visibleTabs.length > 1 && (
        <div className={s.tabRow} onWheel={(e) => {
          // One row that scrolls sideways in a narrow window; the wheel scrolls it.
          const el = e.currentTarget
          if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
        }}>
          <div className={s.tabs} role="tablist" aria-label="Show">
            {visibleTabs.map(k => {
              const meta = TAB_META[k]
              const sep = k === 'hidden' || (k === 'removed' && !visibleTabs.includes('hidden'))
              return (
                <React.Fragment key={k}>
                  {sep && <span className={s.tabSep} aria-hidden="true" />}
                  <button type="button" role="tab" data-lib-tab={k} aria-selected={tab === k} title={meta.hint}
                    className={`${s.tab} ${tab === k ? s.tabOn : ''} ${q && !tabMatches[k] ? s.tabNone : ''}`}
                    style={{ '--st': meta.color }}
                    onClick={() => changeTab(k)}>
                    {meta.Icon ? <meta.Icon size={13} stroke={1.7} /> : <span className={s.tabDot} />}
                    {meta.label} <span className={s.tabCount}>{q ? tabMatches[k] : tabCounts[k]}</span>
                  </button>
                </React.Fragment>
              )
            })}
          </div>
        </div>
      )}

      {/* Game grid */}
      <div className={s.content}>
        {tab === 'current' && launcherNew > 0 && (
          <div className={s.launcherStrip} role="status">
            <IconDownload size={16} stroke={1.7} />
            <span>
              {launcherNew} game{launcherNew === 1 ? '' : 's'} found in your Epic, GOG and Xbox launchers.
            </span>
            <button type="button" className={s.launcherReview} onClick={runScan}>Review</button>
            <button type="button" className={s.launcherClose} aria-label="Dismiss"
              onClick={async () => {
                const r = await window.kozo?.api?.launchers?.pending?.()
                const keys = (r?.ok ? r.data || [] : []).map(g => g.key)
                window.kozo?.api?.launchers?.dismiss?.(keys)
                setLauncherNew(0)
              }}>
              <IconX size={14} stroke={2} />
            </button>
          </div>
        )}
        {tab === 'current' && <ReleasedPanel onChanged={() => loadGames({ silent: true })} />}
        {!loading && tab === 'hidden' && gamesWithLive.length > 0 && (
          <div className={s.tabNote} data-lib-note>
            <IconEyeOff size={14} stroke={1.7} />
            Hidden from the other tabs and from Big Picture. Still tracked and counted.
          </div>
        )}
        {!loading && tab === 'removed' && gamesWithLive.length > 0 && (
          <div className={s.tabNote} data-lib-note>
            <IconArchive size={14} stroke={1.7} />
            Not in your Library. Hours, sessions and achievements are kept. Right-click one to restore it, or play it to bring it back.
          </div>
        )}
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

        {/* The search found nothing here, but it did in another tab: say where */}
        {!loading && games.length > 0 && gamesWithLive.length === 0 && elsewhere.length > 0 && (
          <EmptyState
            Icon={IconSearch}
            title={`No games match "${search}" in ${TAB_META[tab].label}`}
            desc={`Found in ${elsewhere.map(k => `${TAB_META[k].label} (${tabMatches[k]})`).join(', ')}.`}
            action={{
              label: `Show ${TAB_META[elsewhere[0]].label}`,
              Icon: IconChevronRight,
              onClick: () => changeTab(elsewhere[0]),
            }}
          />
        )}

        {/* Every game is finished, dropped, hidden or removed */}
        {!loading && games.length > 0 && gamesWithLive.length === 0 && !elsewhere.length && tab === 'current' && !q && !statusFilter && (
          <EmptyState
            Icon={IconDeviceGamepad2}
            title="Nothing left to play"
            desc="Every game here is finished, dropped, hidden or removed. Scan your PC or add a game."
            action={{ label: 'Scan PC', Icon: IconScan, onClick: runScan }}
          />
        )}

        {!loading && games.length > 0 && gamesWithLive.length === 0 && !elsewhere.length && (q || statusFilter || tab !== 'current') && (
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
          <div className={gridClass} style={zoomStyle} ref={gridRef}>
            {gamesWithLive.map(renderCard)}
          </div>
        )}
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
          onClose={closeScanModal}
          onAdd={() => { closeScanModal(); loadGames() }}
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
          onToggleHidden={ctxMenu.game.is_archived ? undefined : (game) => {
            const next = game.is_hidden ? 0 : 1
            setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, is_hidden: next } : g); libraryCache = u; return u })
            window.kozo?.api?.games?.update(game.id, { is_hidden: next })
          }}
          onToggleFavorite={handleFavorite}
          onPlay={ctxMenu.game.is_archived ? undefined : async (game) => {
            const res = await window.kozo?.api?.games?.launch(game.id)
            if (!res?.ok) setLaunchMsg({ variant: 'error', title: "Couldn't launch", message: `${game.name}: ${res?.error || 'Failed to launch'}` })
            else if (res?.data?.warning) setLaunchMsg({ variant: 'warning', title: game.name, message: res.data.warning })
          }}
          onEdit={(game) => setEditGame(game)}
          onDelete={ctxMenu.game.is_archived ? undefined : async (game) => {
            setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, is_archived: 1 } : g); libraryCache = u; return u })
            await window.kozo?.api?.games?.archive([game.id])
            loadGames({ silent: true })
            // Where did it go, and a way back.
            setUndo({
              text: `Removed ${game.name} from the Library`,
              run: async () => { await window.kozo?.api?.games?.unarchive([game.id]); loadGames({ silent: true }) },
            })
          }}
          onRestore={ctxMenu.game.is_archived ? async (game) => {
            setGames(prev => { const u = prev.map(g => g.id === game.id ? { ...g, is_archived: 0 } : g); libraryCache = u; return u })
            await window.kozo?.api?.games?.unarchive([game.id])
            loadGames({ silent: true })
            setUndo({
              text: `Restored ${game.name}`,
              run: async () => { await window.kozo?.api?.games?.archive([game.id]); loadGames({ silent: true }) },
            })
          } : undefined}
          deleteIsArchive
          deleteLabel="Remove from library"
          onDeleteForever={async (game) => {
            setGames(prev => { const u = prev.filter(g => g.id !== game.id); libraryCache = u; return u })
            await window.kozo?.api?.games?.delete(game.id)
            loadGames({ silent: true })
          }}
          extraItems={ctxMenu.game.is_archived ? [] : [
            { label: 'Plan for month…', Icon: IconCalendarEvent, onClick: (g) => setPlanIds([g.id]) },
          ]}
        />
      )}

      {editGame && (
        <EditGameModal
          game={editGame}
          onClose={() => setEditGame(null)}
          onSaved={() => loadGames({ silent: true })}
        />
      )}
      {launchMsg && <InfoModal {...launchMsg} onClose={() => setLaunchMsg(null)} />}

      {planIds && (
        <PlanMonthModal
          count={planIds.length}
          current={planIds.length === 1 ? games.find(g => g.id === planIds[0])?.planned_month : null}
          onClose={() => setPlanIds(null)}
          onSave={savePlan}
        />
      )}
      {editIds && <BulkEditModal count={editIds.length} onClose={() => setEditIds(null)} onSave={saveEdit} />}
      <UndoBar undo={undo} onDone={() => setUndo(null)} />
    </div>
  )
}
