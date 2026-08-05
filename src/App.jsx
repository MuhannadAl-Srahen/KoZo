import React, { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { AccentColorProvider } from './context/AccentColorContext'
import { initGamepadNav } from './lib/gamepadNav'
import Sidebar from './components/Sidebar'
import Library from './pages/Library'
import GameDetail from './pages/GameDetail'
import GameList from './pages/GameList'
import AchievementsHub from './pages/AchievementsHub'
import Upcoming from './pages/Upcoming'
import Sessions from './pages/Sessions'
import Statistics from './pages/Statistics'
import Profile from './pages/Profile'
import Settings from './pages/Settings'
import UnknownGamePrompt from './components/UnknownGamePrompt'
import OnboardingModal from './components/OnboardingModal'
import LevelUpCelebration from './components/LevelUpCelebration'

// Controller navigation — must live under the router so useNavigate works.
function GamepadNav() {
  const navigate = useNavigate()
  useEffect(() => initGamepadNav({ navigate }), [navigate])
  return null
}

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState(false)

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
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <div className="app-layout">
          <Sidebar />
          <div className="app-main">
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/game/:id" element={<GameDetail />} />
              <Route path="/game-list" element={<GameList />} />
              <Route path="/achievements" element={<AchievementsHub />} />
              <Route path="/upcoming" element={<Upcoming />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/statistics" element={<Statistics />} />
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
        {showOnboarding && <OnboardingModal onDone={() => setShowOnboarding(false)} />}
      </HashRouter>
    </AccentColorProvider>
  )
}
