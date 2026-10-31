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
import Activity from './pages/Activity'
import PlayPlan from './pages/PlayPlan'
import Finished from './pages/Finished'
import RateGameModal from './components/modals/RateGameModal'
import Profile from './pages/Profile'
import Settings from './pages/Settings'
import UnknownGamePrompt from './components/UnknownGamePrompt'
import Tour from './components/Tour'
import LevelUpCelebration from './components/LevelUpCelebration'
import UpdateBanner from './components/UpdateBanner'

// Controller navigation — must live under the router so useNavigate works.
function GamepadNav() {
  const navigate = useNavigate()
  useEffect(() => initGamepadNav({ navigate }), [navigate])
  return null
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
  // A game was just marked Finished somewhere: ask for a 1 to 10 rating.
  const [rateGame, setRateGame] = useState(null)
  useEffect(() => {
    const off = window.kozo?.events?.onGameFinished?.((g) => { if (g?.name) setRateGame(g) })
    return () => off?.()
  }, [])

  // While the main window is hidden, minimized or behind another window
  // (usually a game), every CSS animation pauses: live-session pulses,
  // shimmers and spinners kept the GPU drawing frames nobody could see.
  // Only here, in the main window: the overlay and tray popup run the same
  // bundle but never take focus, and their toast slide-ins must still play.
  useEffect(() => {
    const mark = () => {
      const inactive = document.hidden || !document.hasFocus()
      if (inactive) document.documentElement.dataset.inactive = ''
      else delete document.documentElement.dataset.inactive
    }
    document.addEventListener('visibilitychange', mark)
    window.addEventListener('blur', mark)
    window.addEventListener('focus', mark)
    mark()
    return () => {
      document.removeEventListener('visibilitychange', mark)
      window.removeEventListener('blur', mark)
      window.removeEventListener('focus', mark)
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
        <div className="app-layout">
          <Sidebar />
          <div className="app-main">
            <UpdateBanner />
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/game/:id" element={<GameDetail />} />
              <Route path="/game-list" element={<GameList />} />
              <Route path="/plan" element={<PlayPlan />} />
              <Route path="/finished" element={<Finished />} />
              <Route path="/upcoming" element={<Upcoming />} />
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
        {/* Achievement/level-up toasts come ONLY from the always-on-top overlay
            window — an in-app copy here would show duplicates. */}
        <GamepadNav />
        <UnknownGamePrompt />
        <LevelUpCelebration />
        {showOnboarding && <Tour onDone={() => setShowOnboarding(false)} />}
        {rateGame && <RateGameModal game={rateGame} onClose={() => setRateGame(null)} />}
      </HashRouter>
     </AppearanceProvider>
    </AccentColorProvider>
  )
}
