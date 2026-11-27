import React, { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { IconCalendar, IconBrandSteam, IconHourglass, IconBookmarkFilled, IconSearch, IconX } from '@tabler/icons-react'
import SteamCalendar from '../components/SteamCalendar'
import ReleasedPanel from '../components/ReleasedPanel'
import EditGameListModal from '../components/modals/EditGameListModal'
import CardSizeSlider from '../components/ui/CardSizeSlider'
import s from './Upcoming.module.css'
import t from '../styles/pillTabs.module.css'

// Upcoming = the Steam release calendar. Games you track are marked on it and
// listed under its "Tracked" shelf; tracking is a release watch on the Game
// List row (game_list.release_watch), so it survives status changes: a tracked
// game set to Want to play still gets its "Out now" alert.
//
// Laid out like the rest of KoZo (the maker: Tracked and TBA were "literally not part of the
// same design"): one toolbar row (title, search, card size), then the Steam / TBA / Tracked
// tabs as the Library's pill row, then the view. The search filters whichever view is open,
// counts the matches on each tab, and asks Steam's store for games that aren't on the page.
// The view is remembered (kozo:calendar:view) and can come in the address (?view=tracked),
// which is how a release notification opens Tracked.
// The tracked rows from the last visit, so Tracked paints at once and only shows its skeleton
// the first time (it said "You aren't tracking any releases yet" until the list came in).
let trackedCache = null

const VIEW_TABS = [
  { key: 'steam',   label: 'Steam',   Icon: IconBrandSteam,     title: "Steam's release calendar" },
  { key: 'tba',     label: 'TBA',     Icon: IconHourglass,      title: 'Games without a release date' },
  { key: 'tracked', label: 'Tracked', Icon: IconBookmarkFilled, title: 'Releases you track' },
]
const VIEW_KEYS = VIEW_TABS.map(v => v.key)
// Strip, Week and Month are gone: a saved one opens Steam's calendar.
function savedView() {
  try { const v = localStorage.getItem('kozo:calendar:view'); return VIEW_KEYS.includes(v) ? v : 'steam' } catch { return 'steam' }
}

export default function Upcoming() {
  // Game List rows with a Steam appid: appid → { id, status, watch }.
  const [byAppId, setByAppId] = useState(() => new Map())
  const [items, setItems] = useState([])     // every Game List row, for the edit window
  const [tracked, setTracked] = useState(() => trackedCache || [])   // release-watched rows (any status)
  const [trackedLoaded, setTrackedLoaded] = useState(() => trackedCache != null)
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState(() => (VIEW_KEYS.includes(params.get('view')) ? params.get('view') : savedView()))
  const [query, setQuery] = useState('')
  const [counts, setCounts] = useState({})    // SteamCalendar: games (or matches) per view
  const [editId, setEditId] = useState(null)  // a Game List row with no Steam page
  const searchRef = useRef(null)

  // A link with ?view= (a notification) picks the view, also when Upcoming is already open.
  useEffect(() => {
    const v = params.get('view')
    if (VIEW_KEYS.includes(v) && v !== view) setView(v)
  }, [params])   // eslint-disable-line react-hooks/exhaustive-deps

  // Steam, TBA or Tracked, remembered. It went with Strip, Week and Month once, and every click
  // on those buttons threw (the maker: "I can't click anywhere").
  function setViewMode(v) {
    setView(v)
    try { localStorage.setItem('kozo:calendar:view', v) } catch {}
    if (params.get('view')) setParams({}, { replace: true })
  }

  async function load() {
    const [all, watched] = await Promise.all([
      window.kozo?.api?.gameList?.list?.({ limit: 100000, offset: 0 }),
      window.kozo?.api?.gameList?.tracked?.(),
    ])
    if (watched?.ok) { trackedCache = watched.data || []; setTracked(trackedCache) }
    setTrackedLoaded(true)
    if (all?.ok) {
      const watchIds = new Set((watched?.ok ? watched.data : []).map(r => r.id))
      setItems(all.data?.items || [])
      setByAppId(new Map((all.data?.items || [])
        .filter(i => i.steam_app_id)
        .map(i => [Number(i.steam_app_id), { id: i.id, status: i.status, watch: watchIds.has(i.id) }])))
    }
  }

  useEffect(() => {
    load()
    // Warm store details for tracked games and backfill their release dates.
    window.kozo?.api?.gameList?.refreshUpcomingInfo?.()
    const off = window.kozo?.events?.onGameUpdated?.(() => load())
    return () => off?.()
  }, [])

  // Track: a game already on your list just starts being watched; anything
  // else is added as Upcoming (which watches it).
  async function trackGame(g) {
    const info = byAppId.get(Number(g.appid))
    if (info) await window.kozo?.api?.gameList?.update?.(info.id, { release_watch: 1 })
    else {
      await window.kozo?.api?.gameList?.add?.({
        name: g.name,
        steam_app_id: g.appid,
        status: 'upcoming',
        release_date: g.release || null,
      })
    }
    await load()
  }

  // Right-click → Want to play: a game on your list changes status (its watch
  // stays), anything else is added as Want to play and watched.
  async function wantGame(g) {
    const info = byAppId.get(Number(g.appid))
    if (info) await window.kozo?.api?.gameList?.update?.(info.id, { status: 'want_to_play' })
    else {
      await window.kozo?.api?.gameList?.add?.({
        name: g.name,
        steam_app_id: g.appid,
        status: 'want_to_play',
        release_date: g.release || null,
        release_watch: 1,
      })
    }
    await load()
  }

  async function untrackGame(g) {
    const info = byAppId.get(Number(g.appid)) || (g._listId ? { id: g._listId } : null)
    if (!info) return
    await window.kozo?.api?.gameList?.untrack?.(info.id)
    await load()
  }

  const searching = !!query.trim()
  const count = (k) => counts[k] ?? (k === 'tracked' && trackedLoaded ? tracked.length : null)
  // Searching and nothing matches here: say where there is something.
  const here = count(view)
  const elsewhere = searching && here === 0 ? VIEW_TABS.find(v => v.key !== view && count(v.key) > 0) : null
  // Nothing on the page matches anywhere (Steam's store results still come below).
  const nowhere = searching && here === 0 && !elsewhere && VIEW_TABS.every(v => count(v.key) != null)
  const editItem = editId != null ? items.find(i => i.id === editId) : null

  return (
    <div className={s.page}>
      <div className={s.toolbar} data-tour="upcoming-tabs">
        <h1 className={s.pageTitle}>
          <IconCalendar size={16} stroke={1.7} /> Upcoming
        </h1>
        <div className={`${s.searchBox} hasRing`} data-upcoming-search>
          <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
          <input
            ref={searchRef}
            className={s.searchInput}
            placeholder="Search upcoming games…" aria-label="Search upcoming games"
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
        {view !== 'steam' && <CardSizeSlider pageKey="calendar" view={view} defaults={{ steam: 290, tba: 230, tracked: 240 }} />}
      </div>

      <div className={t.tabRow}>
        <div className={t.tabs} role="tablist" aria-label="Calendar layout">
          {VIEW_TABS.map(v => {
            const n = count(v.key)
            return (
              <button key={v.key} type="button" role="tab" aria-selected={view === v.key} title={v.title} data-upcoming-tab={v.key}
                className={`${t.tab} ${view === v.key ? t.tabOn : ''} ${searching && n === 0 ? t.tabNone : ''}`}
                onClick={() => setViewMode(v.key)}>
                <v.Icon size={14} stroke={1.7} /> {v.label}
                {n != null && (v.key !== 'steam' || searching) && <span className={t.tabCount}>{n}</span>}
              </button>
            )
          })}
        </div>
        {searching && <span className={s.hint}>Counts are the games matching “{query.trim()}”</span>}
      </div>

      <div className={s.content}>
        <div className={s.inner}>
          <ReleasedPanel onChanged={load} />
          {elsewhere && (
            <div className={s.elsewhere} data-upcoming-elsewhere>
              Nothing in {VIEW_TABS.find(v => v.key === view).label} matches “{query.trim()}”.
              <button type="button" className={s.elsewhereBtn} onClick={() => setViewMode(elsewhere.key)}>
                Show {count(elsewhere.key)} in {elsewhere.label}
              </button>
            </div>
          )}
          {nowhere && (
            <div className={s.elsewhere} data-upcoming-nomatch>
              Nothing on Steam's calendar, in TBA or in Tracked matches “{query.trim()}”. Steam's store is searched below: track a game from there.
            </div>
          )}
          <SteamCalendar byAppId={byAppId} trackedRows={tracked} trackedLoaded={trackedLoaded}
            view={view} query={query} onCounts={setCounts} onOpenListRow={setEditId}
            onTrack={trackGame} onUntrack={untrackGame} onWant={wantGame} />
        </div>
      </div>

      {editItem && (
        <EditGameListModal item={editItem} onClose={() => setEditId(null)}
          onSaved={() => { setEditId(null); load() }} onDeleted={() => { setEditId(null); load() }} />
      )}
    </div>
  )
}
