import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconFlag, IconStarFilled, IconClock, IconTrophy, IconPlayerPlayFilled, IconExternalLink, IconInfoCircle,
  IconBrandSteam, IconListCheck, IconDeviceGamepad2, IconPlayerPause, IconClockHour4, IconX,
} from '@tabler/icons-react'
import { fileUrl, formatPlaytime, formatDate } from '../lib/utils'
import GeneratedCover from '../components/GeneratedCover'
import EmptyState from '../components/ui/EmptyState'
import RateGameModal from '../components/modals/RateGameModal'
import FinishedGameModal from '../components/modals/FinishedGameModal'
import ContextMenu from '../components/ui/ContextMenu'
import InfoModal from '../components/ui/InfoModal'
import useCardZoom from '../lib/useCardZoom'
import { ratingColor } from '../components/ui/RatingPicker'
import s from './Finished.module.css'

// Every game you've finished, Library and Game List together, grouped by the
// year you finished it, with your 1 to 10 rating (click it to change). A card
// opens FinishedGameModal: the run's stats, rating, game page and Play again.

const SORTS = [
  { key: 'recent', label: 'Recently finished' },
  { key: 'rating', label: 'Highest rated' },
  { key: 'name',   label: 'A to Z' },
]

function coverOf(g) {
  if (g.banner_local_path) return fileUrl(g.banner_local_path, g.banner_rev)
  return g.list_banner || g.banner_url || null
}

// A finished game as a trophy: the cover with your score as a big coloured
// badge (click it to rate), a medal for 100% achievements, then three fixed
// cells (playtime, achievements, finish date) and the achievement bar along
// the bottom edge. Every cell is always there, so every card is the same size.
function FinishedCard({ g, onRate, onOpen, onContextMenu }) {
  const [failed, setFailed] = useState(false)
  const src = coverOf(g)
  const score = g.rating ? Math.round(g.rating) : null
  const achPct = g.ach_total > 0 ? Math.min(100, Math.round((g.ach_unlocked / g.ach_total) * 100)) : 0
  const perfect = g.ach_total > 0 && g.ach_unlocked >= g.ach_total
  return (
    <div className={s.card} data-gpnav="" onContextMenu={(e) => { e.preventDefault(); onContextMenu(e) }}>
      <button className={s.cover} onClick={onOpen} title={g.name} data-gpclick="">
        {src && !failed
          ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
          : <GeneratedCover name={g.name} />}
        <span className={s.shade} />
        {perfect && <span className={s.perfect}><IconTrophy size={12} stroke={2} /> 100%</span>}
        <span className={s.artInfo}>
          <span className={s.name}>{g.name}</span>
          <span className={s.finishedOn}>
            <IconFlag size={11} stroke={2} />
            {g.finished_at ? `Finished ${formatDate(g.finished_at)}` : 'Finished'}
          </span>
        </span>
      </button>
      <button
        className={`${s.score} ${score ? '' : s.scoreEmpty}`}
        style={score ? { '--score': ratingColor(score) } : undefined}
        onClick={onRate}
        title={score ? `Your rating: ${score}/10. Click to change` : 'Rate this game'}
      >
        {score ? <><strong>{score}</strong><span>/10</span></> : <><IconStarFilled size={12} /> Rate</>}
      </button>
      <div className={s.cells}>
        <span className={`${s.cell} ${g.total_playtime_seconds > 0 ? '' : s.cellEmpty}`} title="Time played">
          <IconClock size={13} stroke={1.7} />
          {g.total_playtime_seconds > 0 ? formatPlaytime(g.total_playtime_seconds) : 'No time'}
        </span>
        <span className={`${s.cell} ${g.ach_total > 0 ? '' : s.cellEmpty}`} title="Achievements">
          <IconTrophy size={13} stroke={1.7} />
          {g.ach_total > 0 ? `${g.ach_unlocked}/${g.ach_total}` : 'None'}
        </span>
      </div>
      <span className={s.achBar} aria-hidden="true"><span style={{ width: `${achPct}%` }} /></span>
    </div>
  )
}

export default function Finished() {
  const [games, setGames] = useState(null)
  const [sort, setSort] = useState(() => localStorage.getItem('kozo:finished:sort') || 'recent')
  const [rating, setRating] = useState(null)   // game being rated
  const [summary, setSummary] = useState(null) // game whose popup is open
  const [ctx, setCtx] = useState(null)
  const [launchError, setLaunchError] = useState(null)
  const navigate = useNavigate()
  const zoomStyle = useCardZoom('finished', 'grid', { grid: 200 }, { min: 140, max: 380 })   // Ctrl + mouse wheel

  async function load() {
    const r = await window.kozo?.api?.games?.finished?.()
    setGames(r?.ok ? r.data || [] : [])
  }
  useEffect(() => {
    load()
    const off = window.kozo?.events?.onGameUpdated?.(() => load())
    return () => off?.()
  }, [])

  const groups = useMemo(() => {
    const list = [...(games || [])]
    const t = (g) => (g.finished_at ? new Date(g.finished_at).getTime() : 0)
    if (sort === 'rating') list.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || t(b) - t(a))
    else if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    else list.sort((a, b) => t(b) - t(a))
    if (sort !== 'recent') return [{ key: 'all', label: null, games: list }]
    const byYear = new Map()
    for (const g of list) {
      const y = g.finished_at ? String(new Date(g.finished_at).getFullYear()) : 'Earlier'
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y).push(g)
    }
    return [...byYear.entries()].map(([key, gs]) => ({ key, label: key, games: gs }))
  }, [games, sort])

  const rated = (games || []).filter(g => g.rating)
  const avg = rated.length ? (rated.reduce((a, g) => a + g.rating, 0) / rated.length).toFixed(1) : null

  function rateOf(g) {
    return { gameId: g.game_id, listId: g.list_id, name: g.name, coverPath: g.banner_local_path, coverUrl: g.list_banner || g.banner_url, rating: g.rating }
  }

  // Moving a game out of Finished: Library games change their own status
  // (statusSync mirrors it to the Game List), list-only rows change the row.
  async function setStatus(g, status) {
    if (g.game_id) await window.kozo?.api?.games?.update?.(g.game_id, { completion_status: status === 'want_to_play' ? null : status })
    if (g.list_id && (!g.game_id || status === 'want_to_play')) await window.kozo?.api?.gameList?.update?.(g.list_id, { status })
    load()
  }

  async function play(g) {
    const res = await window.kozo?.api?.games?.launch?.(g.game_id)
    if (!res?.ok) setLaunchError(res?.error || 'KoZo could not start this game.')
  }

  function menuFor(g) {
    return [
      g.game_id && { label: 'Play again', Icon: IconPlayerPlayFilled, color: 'var(--a)', onClick: () => play(g) },
      g.game_id && { label: 'Open game page', Icon: IconExternalLink, onClick: () => navigate(`/game/${g.game_id}`) },
      { label: 'Details', Icon: IconInfoCircle, onClick: () => setSummary(g) },
      { label: g.rating ? `Change rating (${Math.round(g.rating)}/10)` : 'Rate it…', Icon: IconStarFilled, color: '#fbbf24', onClick: () => setRating(rateOf(g)) },
      { label: 'Move out of Finished', Icon: IconListCheck, sub: [
        { label: 'Playing', Icon: IconDeviceGamepad2, color: 'var(--status-playing)', onClick: () => setStatus(g, 'playing') },
        { label: 'On hold', Icon: IconPlayerPause, color: 'var(--status-onhold)', onClick: () => setStatus(g, 'on_hold') },
        { label: 'Want to play', Icon: IconClockHour4, color: 'var(--a)', onClick: () => setStatus(g, 'want_to_play') },
        { label: 'Dropped', Icon: IconX, color: 'var(--status-dropped)', onClick: () => setStatus(g, 'dropped') },
      ] },
      g.steam_app_id && { divider: true },
      g.steam_app_id && { label: 'Steam page', Icon: IconBrandSteam, onClick: () => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.steam_app_id}`) },
    ]
  }

  function pickSort(k) { setSort(k); try { localStorage.setItem('kozo:finished:sort', k) } catch {} }

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconFlag size={16} stroke={1.7} /> Finished</h1>
        {games && <span className={s.count}>{games.length}</span>}
        {avg && <span className={s.avg}><IconStarFilled size={12} /> {avg} average</span>}
        <div className={s.spacer} />
        <div className={s.sorts} role="radiogroup" aria-label="Sort">
          {SORTS.map(o => (
            <button key={o.key} className={`${s.sortBtn} ${sort === o.key ? s.sortOn : ''}`} onClick={() => pickSort(o.key)}>{o.label}</button>
          ))}
        </div>
      </div>

      <div className={s.content}>
        {games && games.length === 0 && (
          <EmptyState Icon={IconFlag} title="No finished games yet"
            desc="Mark a game as Finished in the Library or the Game List and it shows up here with your rating." />
        )}
        {groups.map(gr => (
          <section key={gr.key} className={s.section}>
            {gr.label && (
              <div className={s.sectionHead}>
                <span className={s.sectionTitle}>{gr.label}</span>
                <span className={s.sectionCount}>{gr.games.length}</span>
              </div>
            )}
            <div className={s.grid} style={zoomStyle}>
              {gr.games.map(g => (
                <FinishedCard
                  key={(g.game_id ? 'g' : 'l') + (g.game_id || g.list_id)}
                  g={g}
                  onOpen={() => setSummary(g)}
                  onRate={() => setRating(rateOf(g))}
                  onContextMenu={(e) => setCtx({ x: e.clientX, y: e.clientY, g })}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          header={{
            cover: coverOf(ctx.g),
            name: ctx.g.name,
            sub: [ctx.g.rating ? `${Math.round(ctx.g.rating)}/10` : 'Not rated', ctx.g.finished_at && `Finished ${formatDate(ctx.g.finished_at)}`].filter(Boolean).join(' · '),
          }}
          items={menuFor(ctx.g)}
        />
      )}
      {launchError && <InfoModal variant="error" title="Couldn't start the game" message={launchError} onClose={() => setLaunchError(null)} />}
      {summary && <FinishedGameModal g={summary} onClose={() => setSummary(null)} onChanged={load} />}
      {rating && <RateGameModal game={rating} onClose={() => { setRating(null); load() }} />}
    </div>
  )
}
