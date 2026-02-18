import React, { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  IconPlus, IconLayoutGrid, IconList, IconLayoutColumns,
  IconDeviceGamepad2, IconScan, IconLoader2, IconCheckbox, IconSquare,
  IconTrash, IconX, IconCheck, IconSearch,
} from '@tabler/icons-react'
import GameCard, { formatPlaytime } from '../components/GameCard'
import AddGameModal from '../components/modals/AddGameModal'
import ScanResultModal from '../components/modals/ScanResultModal'
import SearchableSelect from '../components/ui/SearchableSelect'
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
]
const SORT_VALUES = new Set(SORT_OPTIONS.map(o => o.value))

function sortGames(games, sortBy) {
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
  const weekAgo       = Date.now() - 7 * 86400000
  const weekPlaytime  = games
    .filter(g => g.last_played_at && new Date(g.last_played_at) > weekAgo)
    .reduce((a, g) => a + (g.total_playtime_seconds || 0), 0)
  return { totalPlaytime, totalUnlocked, totalAchs, weekPlaytime }
}

// Module-level cache so navigating back to the Library renders the grid + stat
// numbers instantly from memory and refreshes silently — instead of flashing
// empty/zero values on every visit.
let libraryCache = null

export default function Library() {
  const location = useLocation()
  const navigate = useNavigate()

  const [games, setGames]           = useState(libraryCache ?? [])
  const [liveIds, setLiveIds]       = useState(new Set())
  const [view, setView]             = useState(() => localStorage.getItem(VIEW_KEY) || 'big')
  const [loading, setLoading]       = useState(!libraryCache)
  const [showAddModal, setAddModal] = useState(false)
  const [prefillExe, setPrefillExe]                 = useState('')
  const [prefillInstallPath, setPrefillInstallPath] = useState('')
  const [scanning, setScanning]     = useState(false)
  const [scanModal, setScanModal]   = useState(null)  // null | scan results[]
  const [search, setSearch]         = useState('')
  const [sortBy, setSortBy]         = useState(() => {
    const saved = localStorage.getItem('kozo:sort:library')
    return SORT_VALUES.has(saved) ? saved : 'last_played'
  })

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

  function selectAll() {
    setSelectedIds(new Set(games.map(g => g.id)))
  }

  function deselectAll() {
    setSelectedIds(new Set())
  }

  const allSelected = games.length > 0 && selectedIds.size === games.length

  async function handleBulkDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setBulkDeleting(true)
    for (const id of selectedIds) {
      await window.kozo?.api?.games?.delete(id)
    }
    await loadGames()
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

  // Scan the PC for installed games right from the Library (the folder list is
  // still configured in Settings → Scan PC). Uses the saved scan paths, or the
  // platform defaults on first run, then opens the shared scan-result picker.
  const runScan = useCallback(async () => {
    if (!window.kozo?.api || scanning) return
    setScanning(true)
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
      setScanning(false)
    }
  }, [scanning])

  useEffect(() => {
    // Warm cache → refresh silently (no loading flash); cold → show the spinner.
    loadGames({ silent: !!libraryCache })
    loadActiveSessions()
    if (!window.kozo?.events) return
    window.kozo.events.onSessionStarted(() => { loadGames({ silent: true }); loadActiveSessions() })
    window.kozo.events.onSessionEnded(()   => { loadGames({ silent: true }); loadActiveSessions() })
    window.kozo.events.onGameUpdated(() => loadGames({ silent: true }))
    // Optimistic LIVE badge — light up the cover ~one poll after launch.
    window.kozo.events.onSessionDetected?.(()   => loadActiveSessions())
    window.kozo.events.onSessionUndetected?.(() => loadActiveSessions())
    return () => {
      window.kozo.events.removeAll('session:started')
      window.kozo.events.removeAll('session:ended')
      window.kozo.events.removeAll('game:updated')
      window.kozo.events.removeAll('session:detected')
      window.kozo.events.removeAll('session:undetected')
    }
  }, [loadGames, loadActiveSessions])

  const allGamesWithLive = games.map(g => ({ ...g, _isLive: liveIds.has(g.id) }))
  const filtered = allGamesWithLive.filter(g => {
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      if (!g.name.toLowerCase().includes(q) && !(g.exe_name || '').toLowerCase().includes(q)) return false
    }
    return true
  })
  const gamesWithLive = sortGames(filtered, sortBy)
  const stats = computeStats(games)
  const gridClass = view === 'big' ? s.bigGrid : view === 'small' ? s.smallGrid : s.listGrid

  return (
    <div className={s.page}>
      {/* Stats */}
      <div className={s.statsBar}>
        <div className={s.statCard}>
          <span className={s.statLabel}>Games</span>
          <span className={s.statValue}>{games.length}</span>
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
          <span className={s.statValue}>{formatPlaytime(stats.weekPlaytime)}</span>
        </div>
      </div>

      {/* ── Toolbar (changes based on selection mode) ── */}
      {!selectionMode ? (
        <div className={s.toolbar}>
          <h1 className={s.pageTitle}>My Library</h1>

          {/* Search */}
          <div className={s.searchBox}>
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

          <button
            className={s.btnSecondary}
            title="Scan your PC for installed games to add (folders configured in Settings → Scan PC)"
            disabled={scanning}
            onClick={runScan}
          >
            {scanning
              ? <IconLoader2 size={15} stroke={1.6} style={{ animation: 'spin 1s linear infinite' }} />
              : <IconScan size={15} stroke={1.6} />}
            {scanning ? 'Scanning…' : 'Scan PC'}
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

          <button className={s.btnPrimary} onClick={() => setAddModal(true)}>
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
              : <><IconSquare size={14} stroke={1.8} /> Select all ({games.length})</>
            }
          </button>

          <span className={s.selectionCount}>
            {selectedIds.size === 0
              ? 'Tap cards to select'
              : `${selectedIds.size} game${selectedIds.size !== 1 ? 's' : ''} selected`
            }
          </span>

          {selectedIds.size > 0 && (
            confirmDelete ? (
              <div className={s.confirmRow}>
                <span className={s.confirmText}>
                  Remove {selectedIds.size} game{selectedIds.size !== 1 ? 's' : ''}? This deletes all sessions and achievements.
                </span>
                <button className={s.btnSecondary} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button className={s.btnDanger} onClick={handleBulkDelete} disabled={bulkDeleting}>
                  <IconTrash size={14} stroke={1.6} />
                  {bulkDeleting ? 'Removing…' : 'Confirm'}
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

      {/* Game grid */}
      <div className={s.content}>
        {loading && (
          <div className={s.emptyState}>
            <div className={s.emptyDesc} style={{ color: 'var(--text-muted)' }}>Loading…</div>
          </div>
        )}

        {!loading && search && gamesWithLive.length === 0 && (
          <div className={s.emptyState}>
            <div className={s.emptyDesc}>No games match "{search}"</div>
          </div>
        )}

        {!loading && games.length === 0 && (
          <div className={s.emptyState}>
            <IconDeviceGamepad2 size={48} stroke={1.2} style={{ color: 'var(--text-muted)' }} />
            <div className={s.emptyTitle}>No games yet</div>
            <div className={s.emptyDesc}>
              Click "Add Game" to add your first game to the library.
            </div>
          </div>
        )}

        {!loading && games.length > 0 && (
          <div className={gridClass}>
            {gamesWithLive.map(game => (
              <GameCard
                key={game.id}
                game={game}
                view={view}
                selectionMode={selectionMode}
                selected={selectedIds.has(game.id)}
                onToggle={toggleGame}
                onFavorite={handleFavorite}
              />
            ))}
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
          onClose={() => setScanModal(null)}
          onAdd={() => { setScanModal(null); loadGames() }}
        />
      )}
    </div>
  )
}
