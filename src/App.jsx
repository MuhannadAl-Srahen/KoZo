import React, { useState, useEffect, useRef } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { AccentColorProvider } from './context/AccentColorContext'
import { AppearanceProvider, useAppearance } from './context/AppearanceContext'
import { fileUrl } from './lib/utils'
import { zoomGridAt } from './lib/useCardZoom'
import { initGamepadNav } from './lib/gamepadNav'
import Sidebar from './components/Sidebar'
import Library from './pages/Library'
import GameDetail from './pages/GameDetail'
import GameList from './pages/GameList'
import Upcoming from './pages/Upcoming'
import GamesLike from './pages/GamesLike'
import Deals from './pages/Deals'
import Activity from './pages/Activity'
import PlayPlan from './pages/PlayPlan'
import Finished from './pages/Finished'
import RateGameModal from './components/modals/RateGameModal'
import MakePlayableModal from './components/modals/MakePlayableModal'
import Profile from './pages/Profile'
import BigPicture from './pages/BigPicture'
import Settings from './pages/Settings'
import UnknownGamePrompt from './components/UnknownGamePrompt'
import Tour from './components/Tour'
import RestoreOffer from './components/RestoreOffer'
import DriveOffer from './components/DriveOffer'
import LevelUpCelebration from './components/LevelUpCelebration'
import UpdateBanner from './components/UpdateBanner'
import DriveNewsBar from './components/DriveNewsBar'
import LaunchMissCard from './components/LaunchMissCard'
import UninstalledCard from './components/UninstalledCard'
import GamepadHints from './components/GamepadHints'

// Controller navigation — must live under the router so useNavigate works.
// Set up once: `navigate` changes on every route change under HashRouter, and
// re-running the setup used to stop the controller after the first page change.
function GamepadNav() {
  const navigate = useNavigate()
  const navRef = useRef(navigate)
  navRef.current = navigate
  useEffect(() => initGamepadNav({
    // B with nothing to go back to (KoZo opened straight onto a page) goes Home.
    navigate: (to, ...rest) => (to === -1 && (window.history.state?.idx ?? 0) === 0)
      ? navRef.current('/')
      : navRef.current(to, ...rest),
    // The controller wake combo (Settings > Shortcuts) opens Big Picture.
    onBigPicture: () => navRef.current('/big'),
  }), [])
  return null
}

// Big Picture takes the whole window (no sidebar); every other page sits in
// the normal layout.
// Pages that show hundreds of store pictures. A hash route never navigates, so the
// browser keeps every picture it decoded there; leaving one clears that cache.
const PICTURE_PAGES = new Set(['/upcoming', '/deals', '/like'])
function useFreePicturesOnLeave(pathname) {
  const prev = useRef(pathname)
  useEffect(() => {
    const was = prev.current
    prev.current = pathname
    if (was === pathname || !PICTURE_PAGES.has(was) || PICTURE_PAGES.has(pathname)) return
    const t = setTimeout(() => window.kozo?.ui?.clearCache?.(), 1500)
    return () => clearTimeout(t)
  }, [pathname])
}

function Shell() {
  const location = useLocation()
  useFreePicturesOnLeave(location.pathname)
  if (location.pathname === '/big') return <BigPicture />
  return (
    <div className="app-layout">
      <Sidebar />
      <div className="app-main">
        <UpdateBanner />
        <DriveNewsBar />
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/game/:id" element={<GameDetail />} />
          <Route path="/game-list" element={<GameList />} />
          <Route path="/plan" element={<PlayPlan />} />
          <Route path="/finished" element={<Finished />} />
          <Route path="/upcoming" element={<Upcoming />} />
          <Route path="/like" element={<GamesLike />} />
          <Route path="/deals" element={<Deals />} />
          <Route path="/activity" element={<Activity />} />
          {/* The three pages Activity combined: old links land on their section. */}
          <Route path="/statistics" element={<Navigate to="/activity?tab=overview" replace />} />
          <Route path="/sessions" element={<Navigate to="/activity?tab=sessions" replace />} />
          <Route path="/achievements" element={<Navigate to="/activity?tab=achievements" replace />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  )
}

// Settings → Appearance → Start page: open there once, on launch.
function StartPage() {
  const { prefs, loaded } = useAppearance()
  const navigate = useNavigate()
  const location = useLocation()
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!loaded || done) return
    setDone(true)
    if (location.pathname === '/' && prefs.startPage && prefs.startPage !== '/') navigate(prefs.startPage, { replace: true })
  }, [loaded])
  return null
}

// Ctrl + mouse wheel works on every tab: pages with a card grid resize their
// cards (lib/useCardZoom); everywhere else it changes the whole UI scale in 5%
// steps (80 to 150%), the same setting as Settings → Appearance → UI scale.
function CtrlWheelZoom() {
  const { prefs, setPrefs } = useAppearance()
  const [pill, setPill] = useState(null)
  const scaleRef = useRef(prefs.scale || 1)
  scaleRef.current = prefs.scale || 1
  useEffect(() => {
    let hideT
    const onWheel = (e) => {
      if (!e.ctrlKey) return
      e.preventDefault()   // never Chromium's own page zoom
      if (zoomGridAt(e.target) || document.querySelector('[role="dialog"]')) return   // over a card grid: useCardZoom resizes it
      if (window.location.hash.startsWith('#/big')) return   // Big Picture keeps its own size
      const next = Math.round(Math.min(1.5, Math.max(0.8, scaleRef.current + (e.deltaY < 0 ? 0.05 : -0.05))) * 100) / 100
      scaleRef.current = next
      setPrefs({ scale: next })
      setPill(Math.round(next * 100))
      clearTimeout(hideT)
      hideT = setTimeout(() => setPill(null), 1200)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => { clearTimeout(hideT); window.removeEventListener('wheel', onWheel) }
  }, [])
  return pill ? <div className="zoom-pill" role="status">UI {pill}%</div> : null
}

// Settings → Appearance → Background: a picture behind every page, blurred and
// darkened so the cards and text on top stay readable.
function Wallpaper() {
  const { prefs } = useAppearance()
  const bg = prefs.bg
  const path = bg.mode === 'image' ? bg.image : bg.mode === 'game' ? bg.gameArt : null
  useEffect(() => {
    if (path) document.documentElement.dataset.wallpaper = ''
    else delete document.documentElement.dataset.wallpaper
  }, [path])
  if (!path) return null
  return (
    <div className="app-wallpaper" aria-hidden="true">
      <div className="app-wallpaper-img" style={{ backgroundImage: `url("${fileUrl(path)}")`, filter: `blur(${bg.blur}px)` }} />
      <div className="app-wallpaper-dim" style={{ opacity: bg.dim / 100 }} />
    </div>
  )
}

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [restoreOffer, setRestoreOffer] = useState(null)   // { found, drive } on a fresh install with a backup around
  // Another PC's backup on this Google account: the three questions. After them, a new
  // user who brought nothing in still gets the walkthrough.
  const [driveOffer, setDriveOffer] = useState(null)
  const walkthroughAfterOffer = useRef(false)
  const showDriveOffer = (offer) => { setRestoreOffer(null); setDriveOffer(offer) }
  useEffect(() => window.kozo?.events?.onDriveOffer?.(showDriveOffer), [])
  // A game was just marked Finished somewhere: ask for a 1 to 10 rating.
  const [rateGame, setRateGame] = useState(null)
  // Move to Library (Game List, Now out) hands its moved games here so the
  // "Make it playable" step can ask for each one's .exe.
  const [playable, setPlayable] = useState(null)
  useEffect(() => {
    const on = (e) => { const list = (e.detail || []).filter(g => g.needsExe); if (list.length) setPlayable(list) }
    window.addEventListener('kozo:make-playable', on)
    return () => window.removeEventListener('kozo:make-playable', on)
  }, [])
  useEffect(() => {
    const off = window.kozo?.events?.onGameFinished?.((g) => { if (g?.name) setRateGame(g) })
    return () => off?.()
  }, [])

  // While the main window is hidden, minimized or behind another window
  // (usually a game), every CSS animation pauses: live-session pulses,
  // shimmers and spinners kept the GPU drawing frames nobody could see.
  // Only here, in the main window: the overlay and tray popup run the same
  // bundle but never take focus, and their toast slide-ins must still play.
  // Windows' own answer (app:inFront) counts too: a window opened while a game
  // had focus believes it has focus and never gets a blur. Its animations kept
  // drawing behind the game, about 14% of a CPU core for the whole session.
  useEffect(() => {
    let otherAppInFront = false
    const mark = () => {
      const inactive = document.hidden || !document.hasFocus() || otherAppInFront
      if (inactive) document.documentElement.dataset.inactive = ''
      else delete document.documentElement.dataset.inactive
    }
    document.addEventListener('visibilitychange', mark)
    window.addEventListener('blur', mark)
    const ask = () => window.kozo?.api?.app?.isInFront?.().then(r => { if (r?.ok) { otherAppInFront = r.data === false; mark() } })
    // Windows' answer takes up to 2 s, so a focus event counts at once and is
    // checked after: that's the event a window opened during a game gets wrongly.
    let recheck = null
    const onFocus = () => {
      otherAppInFront = false
      mark()
      clearTimeout(recheck)
      recheck = setTimeout(ask, 2500)
    }
    window.addEventListener('focus', onFocus)
    // Someone clicking or typing here is the proof it's in front, whatever the last answer
    // said. A stale answer froze every spinner on a window in plain use.
    const onInput = () => { otherAppInFront = false; mark() }
    window.addEventListener('pointerdown', onInput, true)
    window.addEventListener('keydown', onInput, true)
    mark()
    const offFront = window.kozo?.events?.onAppInFront?.((inFront) => { otherAppInFront = inFront === false; mark() })
    ask()
    return () => {
      offFront?.()
      clearTimeout(recheck)
      document.removeEventListener('visibilitychange', mark)
      window.removeEventListener('blur', mark)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pointerdown', onInput, true)
      window.removeEventListener('keydown', onInput, true)
      delete document.documentElement.dataset.inactive
    }
  }, [])

  // Auto-show the walkthrough ONLY for genuinely new users — not anyone who has
  // already added games or a Steam key. Existing users are marked done silently.
  useEffect(() => {
    async function check() {
      if (!window.kozo?.api) return
      const done = await window.kozo.api.settings.get('onboarding_done')
      if (done?.ok && done.data === '1') return
      const [gamesRes, keyRes] = await Promise.all([
        window.kozo.api.games.list(),
        window.kozo.api.settings.get('steam_api_key'),
      ])
      const hasGames = gamesRes?.ok && (gamesRes.data?.length > 0)
      const hasKey   = keyRes?.ok && !!keyRes.data
      if (hasGames || hasKey) {
        await window.kozo.api.settings.set('onboarding_done', '1')   // existing user
        return
      }
      // A new Windows with a KoZo backup on another drive (or Google Drive
      // set up): offer it before the walkthrough.
      const [found, drive] = await Promise.all([
        window.kozo.api.backup?.findExisting?.().catch(() => null),
        window.kozo.api.drive?.status?.().catch(() => null),
      ])
      const list = found?.ok ? found.data.filter(f => f.games > 0) : []
      if (list.length || drive?.data?.configured) { walkthroughAfterOffer.current = true; setRestoreOffer({ found: list, drive: drive?.data || null }); return }
      setShowOnboarding(true)
    }
    check()

    // Manual replay from Settings → About bypasses the new-user gate entirely.
    const open = () => setShowOnboarding(true)
    window.addEventListener('kozo:show-onboarding', open)
    return () => window.removeEventListener('kozo:show-onboarding', open)
  }, [])

  return (
    <AccentColorProvider>
     <AppearanceProvider>
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <StartPage />
        <CtrlWheelZoom />
        <Wallpaper />
        <Shell />
        {/* Achievement/level-up toasts come ONLY from the always-on-top overlay
            window — an in-app copy here would show duplicates. */}
        <GamepadNav />
        <UnknownGamePrompt />
        <LaunchMissCard />
        <UninstalledCard />
        <LevelUpCelebration />
        {showOnboarding && <Tour onDone={() => setShowOnboarding(false)} />}
        {restoreOffer && <RestoreOffer found={restoreOffer.found} drive={restoreOffer.drive} onOffer={showDriveOffer} onClose={() => { walkthroughAfterOffer.current = false; setRestoreOffer(null); setShowOnboarding(true) }} />}
        {driveOffer && <DriveOffer offer={driveOffer} onClose={() => { setDriveOffer(null); if (walkthroughAfterOffer.current) { walkthroughAfterOffer.current = false; setShowOnboarding(true) } }} />}
        {rateGame && <RateGameModal game={rateGame} onClose={() => setRateGame(null)} />}
        <GamepadHints />
        {playable && <MakePlayableModal games={playable} onClose={() => setPlayable(null)} />}
      </HashRouter>
     </AppearanceProvider>
    </AccentColorProvider>
  )
}
