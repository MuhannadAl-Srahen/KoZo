import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconPlayerPlayFilled, IconX, IconClock, IconTrophy, IconDice5, IconCalendar, IconExternalLink,
} from '@tabler/icons-react'
import { fileUrl, formatPlaytime, timeAgo } from '../lib/utils'
import GeneratedCover from '../components/GeneratedCover'
import HoneycombLogo from '../components/HoneycombLogo'
import ContextMenu from '../components/ui/ContextMenu'
import InfoModal from '../components/ui/InfoModal'
import PickForMeModal from '../components/modals/PickForMeModal'
import s from './BigPicture.module.css'

// Big Picture: KoZo full screen for the couch and the TV. Large posters in
// rows (Continue playing, Up next, All games); the focused game fills the
// hero at the top with its art, stats and a big Play button. Driven by the
// controller (lib/gamepadNav.js: A play, X options, B leave) as well as mouse
// and keyboard. It renders without the sidebar (see App.jsx) and puts the
// window in full screen while it's open.

function posterOf(g) {
  if (g.banner_local_path) return fileUrl(g.banner_local_path, g.banner_rev)
  return g.banner_url || null
}
function heroOf(g) {
  if (g.hero_local_path) return fileUrl(g.hero_local_path)
  return posterOf(g)
}

function Poster({ g }) {
  const [failed, setFailed] = useState(false)
  const src = posterOf(g)
  return src && !failed
    ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    : <GeneratedCover name={g.name} />
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(t)
  }, [])
  return <span className={s.clock}>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
}

function Row({ title, games, onFocusGame, onPlay, onMenu, lead }) {
  if (!games.length && !lead) return null
  return (
    <section className={s.row}>
      <h2 className={s.rowTitle}>{title}</h2>
      <div className={s.rowScroll}>
        {lead}
        {games.map(g => (
          <div
            key={g.id}
            className={s.card}
            data-gpnav=""
            data-game-id={g.id}
            onMouseEnter={() => onFocusGame(g)}
            onContextMenu={(e) => { e.preventDefault(); onMenu(e, g) }}
          >
            <button type="button" className={s.cardBtn} data-gpclick="" onClick={() => onPlay(g)} onFocus={() => onFocusGame(g)} title={g.name}>
              <Poster g={g} />
              <span className={s.cardName}>{g.name}</span>
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function BigPicture() {
  const navigate = useNavigate()
  const [games, setGames] = useState(null)
  const [upNextIds, setUpNextIds] = useState([])
  const [level, setLevel] = useState(null)
  const [focus, setFocus] = useState(null)
  const [ctx, setCtx] = useState(null)
  const [msg, setMsg] = useState(null)
  const [picking, setPicking] = useState(false)
  const rootRef = useRef(null)

  // Full screen while open; back to a normal window on the way out.
  useEffect(() => {
    document.documentElement.setAttribute('data-bigpicture', '')
    window.kozo?.api?.app?.setFullScreen?.(true)
    return () => {
      document.documentElement.removeAttribute('data-bigpicture')
      window.kozo?.api?.app?.setFullScreen?.(false)
    }
  }, [])

  async function load() {
    const [gRes, lRes, xRes] = await Promise.all([
      window.kozo?.api?.games?.list?.(),
      window.kozo?.api?.gameList?.list?.({ status: 'want_to_play', limit: 500 }),
      window.kozo?.api?.stats?.xp?.(),
    ])
    const list = (gRes?.ok ? gRes.data || [] : []).filter(g => !g.is_archived && !g.is_hidden)
    setGames(list)
    const rows = lRes?.ok ? (lRes.data?.items || lRes.data || []) : []
    setUpNextIds(rows.map(r => r.game_id).filter(Boolean))
    if (xRes?.ok) setLevel(xRes.data?.level ?? null)
  }
  useEffect(() => {
    load()
    const off = window.kozo?.events?.onGameUpdated?.(() => load())
    return () => off?.()
  }, [])

  const rows = useMemo(() => {
    const list = games || []
    const byId = new Map(list.map(g => [g.id, g]))
    const recent = list.filter(g => g.last_played_at)
      .sort((a, b) => new Date(b.last_played_at) - new Date(a.last_played_at)).slice(0, 12)
    const upNext = upNextIds.map(id => byId.get(id)).filter(Boolean)
    const all = [...list].sort((a, b) => a.name.localeCompare(b.name))
    return { recent, upNext, all }
  }, [games, upNextIds])

  // The hero follows the controller ring too (gamepadNav sets data-gpfocus).
  useEffect(() => {
    const root = rootRef.current
    if (!root || !games) return
    const byId = new Map(games.map(g => [String(g.id), g]))
    const mo = new MutationObserver(() => {
      const el = root.querySelector('[data-gpfocus][data-game-id]')
      if (el) setFocus(byId.get(el.dataset.gameId) || null)
    })
    mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-gpfocus'] })
    return () => mo.disconnect()
  }, [games])

  useEffect(() => {
    if (!focus && games?.length) setFocus(rows.recent[0] || rows.all[0])
  }, [games])

  function exit() {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1)
    else navigate('/')
  }
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"], [role="menu"]')) return
      exit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function play(g) {
    if (!g) return
    const res = await window.kozo?.api?.games?.launch?.(g.id)
    if (!res?.ok) setMsg({ variant: 'error', title: "Couldn't start the game", message: res?.error || 'KoZo could not start this game.' })
    else if (res.data?.warning) setMsg({ variant: 'warning', title: g.name, message: res.data.warning })
  }

  const pickTile = (
    <div className={`${s.card} ${s.pickCard}`} data-gpnav="">
      <button type="button" className={s.cardBtn} data-gpclick="" onClick={() => setPicking(true)}>
        <IconDice5 size={48} stroke={1.4} />
        <span className={s.pickLabel}>Pick for me</span>
        <span className={s.pickSub}>KoZo chooses from Up next</span>
      </button>
    </div>
  )

  const art = focus ? heroOf(focus) : null
  const ach = focus?._total > 0 ? `${focus._unlocked ?? 0}/${focus._total}` : null

  return (
    <div className={s.root} ref={rootRef} data-bigpicture-root="">
      <div className={s.backdrop} aria-hidden="true">
        {art && <img key={art} src={art} alt="" className={s.backdropImg} />}
        <div className={s.backdropShade} />
      </div>

      <header className={s.top}>
        <span className={s.brand}><HoneycombLogo size={30} /> KoZo</span>
        <span className={s.topSpacer} />
        {level != null && <span className={s.level}>Level {level}</span>}
        <Clock />
        <button type="button" className={s.exitBtn} onClick={exit} title="Leave Big Picture (B or Escape)">
          <IconX size={20} stroke={2} /> Exit
        </button>
      </header>

      <section className={s.hero}>
        {focus ? (
          <>
            <h1 className={s.heroName}>{focus.name}</h1>
            <div className={s.heroMeta}>
              <span><IconClock size={18} /> {focus.total_playtime_seconds > 0 ? formatPlaytime(focus.total_playtime_seconds) : 'Not played yet'}</span>
              {focus.last_played_at && <span><IconCalendar size={18} /> {timeAgo(focus.last_played_at)}</span>}
              {ach && <span><IconTrophy size={18} /> {ach}</span>}
            </div>
            <div className={s.heroActions}>
              <button type="button" className={s.playBtn} onClick={() => play(focus)}>
                <IconPlayerPlayFilled size={22} /> Play
              </button>
            </div>
          </>
        ) : games && games.length === 0 ? (
          <h1 className={s.heroName}>Your Library is empty</h1>
        ) : null}
      </section>

      <div className={s.rows}>
        <Row title="Continue playing" games={rows.recent} onFocusGame={setFocus} onPlay={play} onMenu={(e, g) => setCtx({ x: e.clientX, y: e.clientY, g })} />
        <Row title="Up next" games={rows.upNext} lead={pickTile} onFocusGame={setFocus} onPlay={play} onMenu={(e, g) => setCtx({ x: e.clientX, y: e.clientY, g })} />
        <Row title="All games" games={rows.all} onFocusGame={setFocus} onPlay={play} onMenu={(e, g) => setCtx({ x: e.clientX, y: e.clientY, g })} />
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          header={{ cover: posterOf(ctx.g), name: ctx.g.name, sub: ctx.g.total_playtime_seconds > 0 ? formatPlaytime(ctx.g.total_playtime_seconds) : 'Not played yet' }}
          items={[
            { label: 'Play', Icon: IconPlayerPlayFilled, color: 'var(--a)', onClick: () => play(ctx.g) },
            { label: 'Open game page', Icon: IconExternalLink, onClick: () => navigate(`/game/${ctx.g.id}`) },
          ]}
        />
      )}
      {picking && <PickForMeModal onClose={() => setPicking(false)} onChanged={load} />}
      {msg && <InfoModal {...msg} onClose={() => setMsg(null)} />}
    </div>
  )
}
