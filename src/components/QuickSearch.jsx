import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconSearch, IconX, IconBooks, IconListCheck, IconBrandSteam, IconLayoutGrid, IconLoader2, IconPlus, IconCheck,
  IconCornerDownLeft,
} from '@tabler/icons-react'
import SteamGameModal from './SteamGameModal'
import GeneratedCover from './GeneratedCover'
import { fileUrl } from '../lib/utils'
import s from './QuickSearch.module.css'

// Quick search (the maker's ask): Ctrl+K anywhere in KoZo, or the search button in the
// sidebar. One box for your Library, your Game List, KoZo's pages and Steam. Up/Down to move,
// Enter to open, Esc to close. A Steam game opens its store window with Add to Game List.

const PAGES = [
  { label: 'Library', to: '/' },
  { label: 'Game List', to: '/game-list' },
  { label: 'Play Plan', to: '/plan' },
  { label: 'Finished', to: '/finished' },
  { label: 'Upcoming', to: '/upcoming' },
  { label: 'Games like', to: '/like' },
  { label: 'Discounts', to: '/deals' },
  { label: 'Activity', to: '/activity?tab=overview' },
  { label: 'Sessions', to: '/activity?tab=sessions' },
  { label: 'Achievements', to: '/activity?tab=achievements' },
  { label: 'Year review', to: '/activity?tab=year' },
  { label: 'Profile', to: '/profile' },
  { label: 'Big Picture', to: '/big' },
  { label: 'Settings', to: '/settings' },
  { label: 'Appearance', to: '/settings?tab=appearance', hint: 'Settings' },
  { label: 'Shortcuts', to: '/settings?tab=shortcuts', hint: 'Settings' },
  { label: 'Tracking', to: '/settings?tab=tracking', hint: 'Settings' },
  { label: 'Connections', to: '/settings?tab=accounts', hint: 'Settings' },
  { label: 'Backups', to: '/settings?tab=backups', hint: 'Settings' },
  { label: 'Storage', to: '/settings?tab=storage', hint: 'Settings' },
  { label: 'About and updates', to: '/settings?tab=about', hint: 'Settings' },
]

// "need for speed" finds "Need for Speed™ Most Wanted": marks and punctuation ignored.
function key(v) { return String(v || '').toLowerCase().replace(/[™®©:'’".,!?\-–—_/()[\]]/g, ' ').replace(/\s+/g, ' ').trim() }
function hit(name, q) { return key(name).includes(q) }

export default function QuickSearch() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [games, setGames] = useState([])
  const [listRows, setListRows] = useState([])
  const [steam, setSteam] = useState(null)        // null = not asked yet
  const [steamBusy, setSteamBusy] = useState(false)
  const [active, setActive] = useState(0)
  const [store, setStore] = useState(null)        // a Steam hit opened in its store window
  const [added, setAdded] = useState(() => new Set())
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Ctrl+K anywhere, and the sidebar's search button (kozo:quick-search).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('kozo:quick-search', onOpen)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('kozo:quick-search', onOpen) }
  }, [])

  // Fresh library each time it opens; the box starts empty.
  useEffect(() => {
    if (!open) return
    setQuery(''); setActive(0); setSteam(null); setListRows([])
    window.kozo?.api?.games?.list?.().then(r => { if (r?.ok) setGames(r.data || []) })
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const q = key(query)

  // Game List and Steam answer from the main process, a moment after typing stops.
  useEffect(() => {
    if (!open) return
    if (!q) { setListRows([]); setSteam(null); setSteamBusy(false); return }
    let alive = true
    const t1 = setTimeout(() => {
      window.kozo?.api?.gameList?.list?.({ search: query.trim(), limit: 8, offset: 0 }).then(r => { if (alive && r?.ok) setListRows(r.data?.items || []) })
    }, 120)
    let t2 = null
    if (q.length >= 2) {
      setSteamBusy(true)
      t2 = setTimeout(async () => {
        const r = await window.kozo?.api?.steam?.search?.(query.trim())
        if (!alive) return
        setSteamBusy(false)
        setSteam(r?.ok ? (r.data || []) : [])
      }, 350)
    } else { setSteam(null); setSteamBusy(false) }
    return () => { alive = false; clearTimeout(t1); clearTimeout(t2) }
  }, [q, open])

  // One flat list, in sections, so Up/Down walk through all of it.
  const sections = useMemo(() => {
    if (!q) return [{ title: 'Go to', items: PAGES.slice(0, 8).map(p => ({ kind: 'page', id: p.to, label: p.label, hint: p.hint, to: p.to })) }]
    const lib = games.filter(g => hit(g.name, q)).slice(0, 6)
      .map(g => ({ kind: 'game', id: `g${g.id}`, label: g.name, hint: g.is_archived ? 'Removed' : g.is_installed === 0 ? 'Not installed' : null, game: g }))
    const libSteam = new Set(games.map(g => Number(g.steam_app_id)).filter(Boolean))
    const libNames = new Set(games.map(g => key(g.name)))
    const list = listRows.filter(r => !r.game_id && !libNames.has(key(r.name))).slice(0, 6)
      .map(r => ({ kind: 'list', id: `l${r.id}`, label: r.name, hint: r.status ? r.status.replace(/_/g, ' ') : null, row: r }))
    const listSteam = new Set(listRows.map(r => Number(r.steam_app_id)).filter(Boolean))
    const pages = PAGES.filter(p => hit(p.label, q)).slice(0, 4).map(p => ({ kind: 'page', id: p.to, label: p.label, hint: p.hint, to: p.to }))
    const st = (steam || []).filter(h => !libSteam.has(Number(h.steam_app_id)) && !listSteam.has(Number(h.steam_app_id))).slice(0, 6)
      .map(h => ({ kind: 'steam', id: `s${h.steam_app_id}`, label: h.name, steam: h }))
    return [
      { title: 'Library', Icon: IconBooks, items: lib },
      { title: 'Game List', Icon: IconListCheck, items: list },
      { title: 'Pages', Icon: IconLayoutGrid, items: pages },
      { title: 'On Steam', Icon: IconBrandSteam, items: st, busy: steamBusy },
    ].filter(sec => sec.items.length || sec.busy)
  }, [q, games, listRows, steam, steamBusy])

  const flat = useMemo(() => sections.flatMap(sec => sec.items), [sections])
  useEffect(() => { setActive(0) }, [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-qs-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function close() { setOpen(false) }
  function choose(item) {
    if (!item) return
    if (item.kind === 'page') { close(); navigate(item.to) }
    else if (item.kind === 'game') { close(); navigate(`/game/${item.game.id}`) }
    else if (item.kind === 'list') { close(); navigate(`/game-list?open=${item.row.id}`) }
    else if (item.kind === 'steam') { setStore(item.steam) }
  }
  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(flat.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active]) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
  }
  async function addToList(h) {
    const r = await window.kozo?.api?.gameList?.add?.({ steam_app_id: h.steam_app_id, name: h.name, banner_url: null, status: 'want_to_play', rating: null, game_id: null })
    if (r?.ok) setAdded(a => new Set(a).add(h.steam_app_id))
  }

  if (!open) return null
  let n = -1
  return (
    <>
      <div className={s.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) close() }} data-quick-search="">
        <div className={s.box} role="dialog" aria-label="Quick search">
          <div className={s.inputRow}>
            <IconSearch size={17} stroke={1.8} className={s.inputIcon} />
            <input
              ref={inputRef}
              className={s.input}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search your games, Game List, pages and Steam"
              aria-label="Quick search"
              spellCheck={false}
            />
            {query
              ? <button type="button" className={s.clear} onClick={() => { setQuery(''); inputRef.current?.focus() }} aria-label="Clear"><IconX size={14} stroke={2} /></button>
              : <kbd className={s.kbd}>Esc</kbd>}
          </div>
          <div className={s.results} ref={listRef}>
            {sections.map(sec => (
              <div key={sec.title} className={s.section}>
                <div className={s.sectionHead}>
                  {sec.Icon && <sec.Icon size={12} stroke={2} />} {sec.title}
                  {sec.busy && <IconLoader2 size={12} className="spin" />}
                </div>
                {sec.items.map(item => {
                  n += 1
                  const i = n
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`${s.row} ${i === active ? s.rowOn : ''}`}
                      data-qs-index={i}
                      data-qs-kind={item.kind}
                      data-gpnav=""
                      onMouseMove={() => { if (active !== i) setActive(i) }}
                      onClick={() => choose(item)}
                    >
                      <Thumb item={item} />
                      <span className={s.label}>{item.label}</span>
                      {item.hint && <span className={s.hint}>{item.hint}</span>}
                      {i === active && <IconCornerDownLeft size={13} stroke={2} className={s.enter} />}
                    </button>
                  )
                })}
              </div>
            ))}
            {q && !flat.length && !steamBusy && (
              <div className={s.empty}>Nothing found for “{query.trim()}”.</div>
            )}
          </div>
          <div className={s.foot}>
            <span><kbd className={s.kbd}>↑</kbd><kbd className={s.kbd}>↓</kbd> move</span>
            <span><kbd className={s.kbd}>Enter</kbd> open</span>
            <span><kbd className={s.kbd}>Ctrl</kbd><kbd className={s.kbd}>K</kbd> anywhere in KoZo</span>
          </div>
        </div>
      </div>
      {store && (
        <SteamGameModal
          appId={store.steam_app_id}
          name={store.name}
          art={{ header: store.header_image, capsule: store.capsule }}
          onClose={() => setStore(null)}
          actions={added.has(store.steam_app_id)
            ? <span className={s.added}><IconCheck size={14} /> On your Game List</span>
            : <button type="button" className={s.addBtn} onClick={() => addToList(store)}><IconPlus size={14} /> Add to Game List</button>}
        />
      )}
    </>
  )
}

function Thumb({ item }) {
  const [failed, setFailed] = useState(false)
  if (item.kind === 'page') return <span className={s.thumbIcon}><IconLayoutGrid size={14} stroke={1.8} /></span>
  const src = item.kind === 'game'
    ? (item.game.banner_local_path ? fileUrl(item.game.banner_local_path, null, { card: true }) : item.game.banner_url)
    : item.kind === 'list' ? (item.row.banner_url || (item.row.game_banner_local_path ? fileUrl(item.row.game_banner_local_path) : null))
    : (item.steam.capsule || item.steam.header_image)
  const wide = item.kind === 'steam'
  return (
    <span className={`${s.thumb} ${wide ? s.thumbWide : ''}`}>
      {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <GeneratedCover name={item.label} compact />}
    </span>
  )
}
