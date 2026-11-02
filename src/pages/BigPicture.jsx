import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  IconPlayerPlayFilled, IconX, IconClock, IconTrophy, IconDice5, IconCalendar, IconSearch, IconStarFilled,
  IconArrowLeft, IconLoader2, IconCheck, IconHistory, IconDeviceGamepad2, IconHeart, IconExternalLink, IconInfoCircle,
} from '@tabler/icons-react'
import { fileUrl, formatPlaytime, timeAgo, parseGenres, formatDateTime } from '../lib/utils'
import GeneratedCover from '../components/GeneratedCover'
import HoneycombLogo from '../components/HoneycombLogo'
import ContextMenu from '../components/ui/ContextMenu'
import InfoModal from '../components/ui/InfoModal'
import PickForMeModal from '../components/modals/PickForMeModal'
import RateGameModal from '../components/modals/RateGameModal'
import OnScreenKeyboard from '../components/OnScreenKeyboard'
import { ratingColor } from '../components/ui/RatingPicker'
import s from './BigPicture.module.css'

// Big Picture: KoZo full screen for the couch and the TV.
// - Tabs Home / Library / Up next (LB / RB on a controller), and a search (Y).
// - Home: the focused game fills the hero; rows Continue playing, Up next
//   (+ Pick for me), Recently added and Favorites.
// - A (or a click) on a game opens its own screen (/big?game=<id>): big art,
//   Play, rating, achievements and recent sessions. B goes back.
// - Play shows "Starting…" until KoZo sees the game running, then gets out of
//   the way (minimizes). When that session ends, KoZo comes back to the front
//   with a "Session done" card.
// It renders without the sidebar (see App.jsx) and keeps the window full screen.

const TABS = [
  { key: 'home',    label: 'Home' },
  { key: 'library', label: 'Library' },
  { key: 'next',    label: 'Up next' },
]
const START_WAIT_MS = 20000

function posterOf(g) {
  if (g.banner_local_path) return fileUrl(g.banner_local_path, g.banner_rev)
  return g.banner_url || null
}
// Wide art for the backdrop: the stored hero, else Steam's (asked once per
// game and remembered), else the poster, blurred so it doesn't look stretched.
const steamHero = new Map()
function useHeroArt(g) {
  const [, bump] = useState(0)
  const id = g?.steam_app_id
  useEffect(() => {
    if (!g || g.hero_local_path || !id || steamHero.has(id)) return
    steamHero.set(id, null)
    window.kozo?.api?.steam?.appAssets?.([id]).then(res => {
      const a = res?.ok ? res.data?.[id] : null
      steamHero.set(id, a?.hero || a?.header || null)
      bump(n => n + 1)
    }).catch(() => {})
  }, [g?.id])
  if (!g) return { src: null, wide: false }
  if (g.hero_local_path) return { src: fileUrl(g.hero_local_path), wide: true }
  if (id && steamHero.get(id)) return { src: steamHero.get(id), wide: true }
  return { src: posterOf(g), wide: false }
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

function Card({ g, live, onOpen, onFocusGame, onMenu }) {
  return (
    <div className={s.card} data-gpnav="" data-game-id={g.id}
      onMouseEnter={() => onFocusGame?.(g)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e, g) }}>
      <button type="button" className={s.cardBtn} data-gpclick="" onClick={() => onOpen(g)} onFocus={() => onFocusGame?.(g)} title={g.name}>
        <span className={s.cardArt}>
          <Poster g={g} />
          {live && <span className={s.cardLive}><span className={s.liveDot} /> Playing</span>}
        </span>
        <span className={s.cardName}>{g.name}</span>
      </button>
    </div>
  )
}

function Row({ title, Icon, games, lead, ...cardProps }) {
  if (!games.length && !lead) return null
  return (
    <section className={s.row}>
      <h2 className={s.rowTitle}>{Icon && <Icon size={22} />} {title}</h2>
      <div className={s.rowScroll}>
        {lead}
        {games.map(g => <Card key={g.id} g={g} live={cardProps.liveIds?.has(g.id)} {...cardProps} />)}
      </div>
    </section>
  )
}

// The game's own screen inside Big Picture.
function GameScreen({ g, live, liveMin, onPlay, onRate, onMenu }) {
  const [ach, setAch] = useState(null)
  const [sessions, setSessions] = useState(null)
  useEffect(() => {
    let alive = true
    window.kozo?.api?.achievements?.listForGame?.(g.id).then(r => { if (alive) setAch(r?.ok ? r.data || [] : []) })
    window.kozo?.api?.sessions?.getForGame?.(g.id).then(r => { if (alive) setSessions(r?.ok ? (r.data || []).slice(0, 5) : []) })
    return () => { alive = false }
  }, [g.id, g.total_playtime_seconds])
  const genres = parseGenres(g).slice(0, 4)
  const total = ach?.length || 0
  const unlocked = (ach || []).filter(a => a.unlocked_at)
  const pct = total ? Math.round((unlocked.length / total) * 100) : 0
  const recent = [...unlocked].sort((a, b) => new Date(b.unlocked_at) - new Date(a.unlocked_at)).slice(0, 4)
  // Next to unlock: the most common locked ones first (easiest wins).
  const next = (ach || []).filter(a => !a.unlocked_at && !a.is_hidden)
    .sort((a, b) => (b.global_unlock_percent || 0) - (a.global_unlock_percent || 0)).slice(0, 4)
  const score = g.rating ? Math.round(g.rating) : null

  return (
    <div className={s.game} key={g.id}>
      <div className={s.gameTop}>
        <div className={s.gameCover}><Poster g={g} /></div>
        <div className={s.gameInfo}>
          {live && <span className={s.livePill}><span className={s.liveDot} /> Playing now{liveMin ? `, ${liveMin} min` : ''}</span>}
          <h1 className={s.gameName}>{g.name}</h1>
          {genres.length > 0 && <div className={s.heroGenres}>{genres.join('  ·  ')}</div>}
          <div className={s.heroMeta}>
            <span><IconClock size={20} /> {g.total_playtime_seconds > 0 ? formatPlaytime(g.total_playtime_seconds) : 'Not played yet'}</span>
            {g.last_played_at && <span><IconCalendar size={20} /> {timeAgo(g.last_played_at)}</span>}
            {total > 0 && (
              <span className={s.heroAch}>
                <IconTrophy size={20} /> {unlocked.length}/{total}
                <span className={s.heroAchBar}><span style={{ width: `${pct}%` }} /></span>
              </span>
            )}
          </div>
          <div className={s.heroActions}>
            <button type="button" className={s.playBtn} onClick={() => onPlay(g)} disabled={!!live} data-gpautofocus="">
              <IconPlayerPlayFilled size={26} /> {live ? 'Playing' : 'Play'}
            </button>
            <button type="button" className={s.ghostBtn} onClick={() => onRate(g)}>
              {score
                ? <><IconStarFilled size={20} style={{ color: ratingColor(score) }} /> {score}/10</>
                : <><IconStarFilled size={20} /> Rate</>}
            </button>
            <button type="button" className={s.ghostBtn} onClick={(e) => onMenu(e, g)}>Options</button>
          </div>
        </div>
      </div>

      <div className={s.gamePanels}>
        {total > 0 && (
          <section className={s.panel}>
            <h2 className={s.panelTitle}><IconTrophy size={22} /> Achievements <span className={s.panelCount}>{pct}%</span></h2>
            {next.length > 0 && <div className={s.panelSub}>Up next to unlock</div>}
            <div className={s.achList}>
              {next.map(a => (
                <div key={a.id} className={s.ach} data-gpnav="">
                  {a.icon_url || a.icon_locked_url ? <img src={a.icon_url || a.icon_locked_url} alt="" className={s.achIconLocked} /> : <span className={s.achIconBlank} />}
                  <span className={s.achText}>
                    <span className={s.achName}>{a.display_name}</span>
                    <span className={s.achSub}>{a.global_unlock_percent != null ? `${a.global_unlock_percent.toFixed(1)}% of players have it` : a.description || ''}</span>
                  </span>
                </div>
              ))}
            </div>
            {recent.length > 0 && <div className={s.panelSub}>Recently unlocked</div>}
            <div className={s.achList}>
              {recent.map(a => (
                <div key={a.id} className={s.ach} data-gpnav="">
                  {a.icon_url ? <img src={a.icon_url} alt="" /> : <span className={s.achIconBlank} />}
                  <span className={s.achText}>
                    <span className={s.achName}>{a.display_name}</span>
                    <span className={s.achSub}>{timeAgo(a.unlocked_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className={s.panel}>
          <h2 className={s.panelTitle}><IconHistory size={22} /> Recent sessions</h2>
          {sessions === null ? null : sessions.length ? (
            <div className={s.sessList}>
              {sessions.map(x => (
                <div key={x.id} className={s.sess} data-gpnav="">
                  <span className={s.sessWhen}>{formatDateTime(x.started_at)}</span>
                  <span className={s.sessDur}>{formatPlaytime(x.duration_seconds || 0)}</span>
                  {x.achievements_unlocked > 0 && <span className={s.sessAch}><IconTrophy size={16} /> {x.achievements_unlocked}</span>}
                </div>
              ))}
            </div>
          ) : <div className={s.panelEmpty}>No sessions yet. Press Play to start one.</div>}
        </section>
      </div>
    </div>
  )
}

// Full-screen card while a game starts.
function Launching({ g, stage, onCancel }) {
  const { src } = useHeroArt(g)
  return (
    <div className={s.overlay} role="dialog" aria-label={`Starting ${g.name}`}>
      {src && <img className={s.overlayArt} src={src} alt="" />}
      <div className={s.overlayShade} />
      <div className={s.overlayBody}>
        <div className={s.overlayCover}><Poster g={g} /></div>
        <div className={s.overlayText}>
          {stage === 'starting'
            ? <><IconLoader2 size={36} className="spin" /><span className={s.overlayTitle}>Starting {g.name}</span><span className={s.overlaySub}>KoZo starts tracking as soon as the game is running.</span></>
            : <><IconLoader2 size={36} className="spin" /><span className={s.overlayTitle}>Still waiting for {g.name}</span><span className={s.overlaySub}>Some games take a moment, or open a launcher first.</span></>}
          <button type="button" className={s.ghostBtn} onClick={onCancel} data-gpautofocus="">
            <IconArrowLeft size={20} /> Back
          </button>
        </div>
      </div>
    </div>
  )
}

// Shown when a game started from Big Picture closes.
function SessionDone({ done, onClose, onPlay, onRate }) {
  const { g, seconds, achievements } = done
  const { src } = useHeroArt(g)
  return (
    <div className={s.overlay} role="dialog" aria-label="Session done">
      {src && <img className={s.overlayArt} src={src} alt="" />}
      <div className={s.overlayShade} />
      <div className={s.overlayBody}>
        <div className={s.overlayCover}><Poster g={g} /></div>
        <div className={s.overlayText}>
          <span className={s.doneKicker}><IconCheck size={20} /> Session done</span>
          <span className={s.overlayTitle}>{g.name}</span>
          <div className={s.doneStats}>
            <span className={s.doneStat}><strong>{formatPlaytime(seconds || 0)}</strong> played</span>
            <span className={s.doneStat}><strong>{achievements || 0}</strong> achievement{achievements === 1 ? '' : 's'}</span>
            <span className={s.doneStat}><strong>{formatPlaytime(g.total_playtime_seconds || 0)}</strong> in total</span>
          </div>
          <div className={s.heroActions}>
            <button type="button" className={s.playBtn} onClick={onClose} data-gpautofocus=""><IconCheck size={24} /> Done</button>
            <button type="button" className={s.ghostBtn} onClick={() => onPlay(g)}><IconPlayerPlayFilled size={20} /> Play again</button>
            <button type="button" className={s.ghostBtn} onClick={() => onRate(g)}><IconStarFilled size={20} /> Rate</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function BigPicture() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const openId = Number(params.get('game')) || null
  const [games, setGames] = useState(null)
  const [upNextIds, setUpNextIds] = useState([])
  const [ratings, setRatings] = useState({})   // game id → rating (Game List row)
  const [level, setLevel] = useState(null)
  const [focus, setFocus] = useState(null)
  const [tab, setTab] = useState('home')
  const [query, setQuery] = useState('')
  const [keyboard, setKeyboard] = useState(false)   // on-screen keyboard (controller search)
  const [installedOnly, setInstalledOnly] = useState(false)
  const [ctx, setCtx] = useState(null)
  const [msg, setMsg] = useState(null)
  const [picking, setPicking] = useState(false)
  const [rating, setRating] = useState(null)
  const [launch, setLaunch] = useState(null)   // { g, stage: 'starting' | 'waiting' }
  const [done, setDone] = useState(null)       // { g, seconds, achievements }
  const [live, setLive] = useState([])         // running sessions
  const launchedRef = useRef(new Set())        // games started from here
  const launchRef = useRef(null)
  launchRef.current = launch
  const rootRef = useRef(null)
  const searchRef = useRef(null)

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
    const [gRes, lRes, aRes, xRes] = await Promise.all([
      window.kozo?.api?.games?.list?.(),
      window.kozo?.api?.gameList?.list?.({ status: 'want_to_play', limit: 500 }),
      window.kozo?.api?.gameList?.list?.({ limit: 5000 }),
      window.kozo?.api?.stats?.xp?.(),
    ])
    const list = (gRes?.ok ? gRes.data || [] : []).filter(g => !g.is_archived && !g.is_hidden)
    const rows = lRes?.ok ? (lRes.data?.items || lRes.data || []) : []
    const all = aRes?.ok ? (aRes.data?.items || aRes.data || []) : []
    const rate = {}
    for (const r of all) if (r.game_id && r.rating) rate[r.game_id] = r.rating
    setRatings(rate)
    setGames(list.map(g => ({ ...g, rating: rate[g.id] || null })))
    setUpNextIds(rows.map(r => r.game_id).filter(Boolean))
    if (xRes?.ok) setLevel(xRes.data?.level ?? null)
  }
  useEffect(() => {
    load()
    const off = window.kozo?.events?.onGameUpdated?.(() => load())
    return () => off?.()
  }, [])

  // What's running right now, and the launch / session-done flow.
  useEffect(() => {
    const refresh = () => window.kozo?.api?.sessions?.active?.().then(r => setLive(r?.ok ? (r.data || []) : []))
    refresh()
    const running = (gameId) => {
      refresh()
      const l = launchRef.current
      if (l && Number(gameId) === l.g.id) {
        setLaunch(null)
        window.kozo?.api?.app?.minimize?.()   // the game gets the screen
      }
    }
    const offs = [
      window.kozo?.events?.onSessionStarted?.((x) => running(x?.game_id)),
      window.kozo?.events?.onSessionDetected?.((x) => running(x?.gameId)),
      window.kozo?.events?.onSessionUndetected?.(refresh),
      window.kozo?.events?.onSessionEnded?.(({ session } = {}) => {
        refresh()
        load()
        const id = Number(session?.game_id)
        if (!id || !launchedRef.current.has(id)) return
        launchedRef.current.delete(id)
        window.kozo?.api?.app?.bringToFront?.()
        setGames(cur => {
          const g = (cur || []).find(x => x.id === id)
          // The list still holds the playtime from before this session.
          if (g) setDone({ g: { ...g, total_playtime_seconds: (g.total_playtime_seconds || 0) + (session.duration_seconds || 0) }, seconds: session.duration_seconds, achievements: session.achievements_unlocked })
          return cur
        })
      }),
    ]
    const t = setInterval(refresh, 30000)
    return () => { offs.forEach(o => o?.()); clearInterval(t) }
  }, [])
  const liveIds = useMemo(() => new Set(live.map(x => x.gameId ?? x.game_id)), [live])

  // Starting… turns into "still waiting" when the game takes a while.
  useEffect(() => {
    if (launch?.stage !== 'starting') return
    const t = setTimeout(() => setLaunch(l => (l ? { ...l, stage: 'waiting' } : l)), START_WAIT_MS)
    return () => clearTimeout(t)
  }, [launch?.g?.id, launch?.stage])

  const rows = useMemo(() => {
    const list = games || []
    const byId = new Map(list.map(g => [g.id, g]))
    const recent = list.filter(g => g.last_played_at)
      .sort((a, b) => new Date(b.last_played_at) - new Date(a.last_played_at)).slice(0, 14)
    const upNext = upNextIds.map(id => byId.get(id)).filter(Boolean)
    const added = [...list].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 14)
    const favorites = list.filter(g => g.is_favorite)
    const all = [...list].sort((a, b) => a.name.localeCompare(b.name))
    return { recent, upNext, added, favorites, all, byId }
  }, [games, upNextIds])

  const q = query.trim().toLowerCase()
  const libraryList = rows.all
    .filter(g => !installedOnly || g.is_installed)
    .filter(g => !q || g.name.toLowerCase().includes(q))
  const opened = openId ? rows.byId.get(openId) : null

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

  // LB / RB switch tabs (lib/gamepadNav.js sends kozo:bp-tab in Big Picture).
  useEffect(() => {
    const on = (e) => {
      if (openId) return
      setTab(t => TABS[(TABS.findIndex(x => x.key === t) + (e.detail?.step || 1) + TABS.length) % TABS.length].key)
    }
    window.addEventListener('kozo:bp-tab', on)
    return () => window.removeEventListener('kozo:bp-tab', on)
  }, [openId])
  // A new tab or screen starts at its top.
  useEffect(() => { rootRef.current?.querySelector(`.${s.main}`)?.scrollTo({ top: 0 }) }, [tab, openId])

  function exit() {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1)
    else navigate('/')
  }
  const openGame = (g) => navigate(`/big?game=${g.id}`)
  const closeGame = () => navigate(-1)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"], [role="menu"]')) return
      if (document.activeElement === searchRef.current && query) { setQuery(''); return }
      if (openId) closeGame()
      else exit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId, query])

  async function play(g) {
    if (!g) return
    setDone(null)
    setLaunch({ g, stage: 'starting' })
    launchedRef.current.add(g.id)
    const res = await window.kozo?.api?.games?.launch?.(g.id)
    if (!res?.ok) {
      setLaunch(null)
      launchedRef.current.delete(g.id)
      setMsg({ variant: 'error', title: "Couldn't start the game", message: res?.error || 'KoZo could not start this game.' })
    } else if (res.data?.warning) {
      setMsg({ variant: 'warning', title: g.name, message: res.data.warning })
    }
  }

  const menuFor = (e, g) => setCtx({ x: e.clientX || window.innerWidth / 2, y: e.clientY || window.innerHeight / 2, g })
  const cardProps = { onOpen: openGame, onFocusGame: setFocus, onMenu: menuFor, liveIds }

  const pickTile = (
    <div className={`${s.card} ${s.pickCard}`} data-gpnav="">
      <button type="button" className={s.cardBtn} data-gpclick="" onClick={() => setPicking(true)}>
        <span className={s.cardArt}>
          <span className={s.pickInner}>
            <IconDice5 size={52} stroke={1.4} />
            <span className={s.pickLabel}>Pick for me</span>
          </span>
        </span>
        <span className={s.cardName}>KoZo chooses your next game</span>
      </button>
    </div>
  )

  const shown = opened || focus
  const { src: art, wide } = useHeroArt(shown)
  const ach = focus?._total > 0 ? `${focus._unlocked ?? 0}/${focus._total}` : null
  const achPct = focus?._total > 0 ? Math.round(((focus._unlocked ?? 0) / focus._total) * 100) : 0
  const genres = focus ? parseGenres(focus).slice(0, 3) : []
  const liveOf = (g) => g && live.find(x => (x.gameId ?? x.game_id) === g.id)
  const minutesOf = (x) => (x?.started_at ? Math.max(1, Math.round((Date.now() - new Date(x.started_at).getTime()) / 60000)) : null)
  const focusLive = liveOf(focus)

  return (
    <div className={s.root} ref={rootRef} data-bigpicture-root="">
      <div className={s.backdrop} aria-hidden="true">
        {art && <img key={art} src={art} alt="" className={`${s.backdropImg} ${wide ? '' : s.backdropSoft}`} />}
        <div className={`${s.backdropShade} ${opened ? s.backdropShadeGame : ''}`} />
      </div>

      <header className={s.top}>
        {opened ? (
          <button type="button" className={s.backBtn} onClick={closeGame} title="Back (B or Escape)">
            <IconArrowLeft size={22} /> Back
          </button>
        ) : (
          <span className={s.brand}><HoneycombLogo size={30} /> KoZo</span>
        )}
        {!opened && (
          <nav className={s.tabs} aria-label="Big Picture sections">
            {TABS.map(t => (
              <button key={t.key} type="button" className={`${s.tab} ${tab === t.key ? s.tabOn : ''}`} onClick={() => setTab(t.key)}
                aria-current={tab === t.key ? 'page' : undefined}>
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <span className={s.topSpacer} />
        {!opened && (
          <label className={s.search}>
            <IconSearch size={20} />
            <input ref={searchRef} type="search" placeholder="Search games" value={query}
              onChange={e => { setQuery(e.target.value); if (e.target.value) setTab('library') }} aria-label="Search games"
              onFocus={(e) => {
                // A controller can't type: Y (or A on the box) opens the on-screen keyboard.
                if (document.documentElement.hasAttribute('data-gamepad')) { e.target.blur(); setTab('library'); setKeyboard(true) }
              }} />
          </label>
        )}
        {level != null && <span className={s.level}>Level {level}</span>}
        <Clock />
        <button type="button" className={s.exitBtn} onClick={exit} title="Leave Big Picture">
          <IconX size={20} stroke={2} /> Exit
        </button>
      </header>

      <main className={s.main}>
        {opened ? (
          <GameScreen g={opened} live={!!liveOf(opened)} liveMin={minutesOf(liveOf(opened))} onPlay={play} onRate={setRating} onMenu={menuFor} />
        ) : tab === 'home' ? (
          <>
            <section className={s.hero}>
              {focus ? (
                <div key={focus.id} className={s.heroRow}>
                  <div className={s.heroInfo}>
                    {focusLive && <span className={s.livePill}><span className={s.liveDot} /> Playing now{minutesOf(focusLive) ? `, ${minutesOf(focusLive)} min` : ''}</span>}
                    <h1 className={s.heroName}>{focus.name}</h1>
                    {genres.length > 0 && <div className={s.heroGenres}>{genres.join('  ·  ')}</div>}
                    <div className={s.heroMeta}>
                      <span><IconClock size={18} /> {focus.total_playtime_seconds > 0 ? formatPlaytime(focus.total_playtime_seconds) : 'Not played yet'}</span>
                      {focus.last_played_at && <span><IconCalendar size={18} /> {timeAgo(focus.last_played_at)}</span>}
                      {ach && (
                        <span className={s.heroAch}>
                          <IconTrophy size={18} /> {ach}
                          <span className={s.heroAchBar}><span style={{ width: `${achPct}%` }} /></span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ) : games && games.length === 0 ? (
                <h1 className={s.heroName}>Your Library is empty</h1>
              ) : null}
            </section>
            <div className={s.rows}>
              <Row title="Continue playing" Icon={IconDeviceGamepad2} games={rows.recent} {...cardProps} />
              <Row title="Up next" Icon={IconCalendar} games={rows.upNext} lead={pickTile} {...cardProps} />
              <Row title="Favorites" Icon={IconHeart} games={rows.favorites} {...cardProps} />
              <Row title="Recently added" Icon={IconHistory} games={rows.added} {...cardProps} />
            </div>
          </>
        ) : (
          <div className={s.gridPage}>
            <div className={s.gridHead}>
              <h2 className={s.gridTitle}>{tab === 'next' ? 'Up next' : q ? `Results for "${query.trim()}"` : 'Library'}</h2>
              <span className={s.gridCount}>{tab === 'next' ? rows.upNext.length : libraryList.length} games</span>
              {tab === 'library' && (
                <div className={s.chips}>
                  <button type="button" className={`${s.chip} ${!installedOnly ? s.chipOn : ''}`} onClick={() => setInstalledOnly(false)}>All</button>
                  <button type="button" className={`${s.chip} ${installedOnly ? s.chipOn : ''}`} onClick={() => setInstalledOnly(true)}>Installed</button>
                </div>
              )}
            </div>
            <div className={s.grid}>
              {tab === 'next' && pickTile}
              {(tab === 'next' ? rows.upNext : libraryList).map(g => <Card key={g.id} g={g} live={liveIds.has(g.id)} {...cardProps} />)}
            </div>
            {tab === 'library' && !libraryList.length && <div className={s.panelEmpty}>No games match.</div>}
          </div>
        )}
      </main>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          header={{ cover: posterOf(ctx.g), name: ctx.g.name, sub: ctx.g.total_playtime_seconds > 0 ? formatPlaytime(ctx.g.total_playtime_seconds) : 'Not played yet' }}
          items={[
            { label: 'Play', Icon: IconPlayerPlayFilled, color: 'var(--a)', onClick: () => play(ctx.g) },
            !opened && { label: 'Open', Icon: IconInfoCircle, onClick: () => openGame(ctx.g) },
            { label: ctx.g.rating ? `Change rating (${Math.round(ctx.g.rating)}/10)` : 'Rate…', Icon: IconStarFilled, color: '#fbbf24', onClick: () => setRating(ctx.g) },
            { divider: true },
            { label: 'Open on the desktop', Icon: IconExternalLink, onClick: () => navigate(`/game/${ctx.g.id}`) },
          ]}
        />
      )}
      {launch && <Launching g={launch.g} stage={launch.stage} onCancel={() => { launchedRef.current.delete(launch.g.id); setLaunch(null) }} />}
      {done && !launch && <SessionDone done={done} onClose={() => setDone(null)} onPlay={play} onRate={(g) => { setDone(null); setRating(g) }} />}
      {picking && <PickForMeModal onClose={() => setPicking(false)} onChanged={load} />}
      {rating && (
        <RateGameModal
          game={{ gameId: rating.id, name: rating.name, coverUrl: posterOf(rating), rating: ratings[rating.id] || null }}
          onClose={() => { setRating(null); load() }}
        />
      )}
      {msg && <InfoModal {...msg} onClose={() => setMsg(null)} />}
      {keyboard && <OnScreenKeyboard value={query} onChange={setQuery} onClose={() => setKeyboard(false)} />}
    </div>
  )
}
