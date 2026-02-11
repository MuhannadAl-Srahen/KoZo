import React, { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  IconLayoutGrid,
  IconList,
  IconHistory,
  IconChartBar,
  IconSettings,
} from '@tabler/icons-react'
import HoneycombLogo from './HoneycombLogo'
import { fileUrl } from '../lib/utils'
import s from './Sidebar.module.css'

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'P'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

const NAV_ITEMS = [
  { path: '/',            label: 'Library',     Icon: IconLayoutGrid },
  { path: '/game-list',   label: 'Game List',   Icon: IconList },
  { path: '/sessions',    label: 'Sessions',    Icon: IconHistory },
  { path: '/statistics',  label: 'Statistics',  Icon: IconChartBar },
]

function formatSessionTime(startedAt, idleSeconds = 0) {
  // Show real played time = wall time minus AFK idle, so the counter reflects
  // what actually gets credited (and visibly stops climbing while you're away).
  const diff = Math.max(0, Math.floor((Date.now() - new Date(startedAt)) / 1000) - (idleSeconds || 0))
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function Sidebar() {
  const [activeSession, setActiveSession] = useState(null)
  const [sessionTick, setSessionTick] = useState(0)
  const [profile, setProfile] = useState({ name: 'Player', avatar: '' })
  const location = useLocation()

  // Load the profile chip (name + avatar) and refresh when the Profile page saves.
  useEffect(() => {
    let cancelled = false
    async function refresh() {
      if (!window.kozo?.api?.settings) return
      const res = await window.kozo.api.settings.getAll()
      if (cancelled || !res?.ok) return
      setProfile({
        name: res.data?.profile_name || 'Player',
        avatar: res.data?.profile_avatar_path || '',
        bust: Date.now(),
      })
    }
    refresh()
    window.addEventListener('kozo:profile-updated', refresh)
    return () => { cancelled = true; window.removeEventListener('kozo:profile-updated', refresh) }
  }, [])

  // Refresh active session from the source of truth: the watcher's
  // in-memory active-session map exposed via IPC. We do this on mount,
  // on every session event, and on a slow poll so the indicator can't
  // drift out of sync with reality (e.g. a game removed mid-session).
  useEffect(() => {
    if (!window.kozo?.api?.sessions?.active) return
    let cancelled = false
    async function refresh() {
      const res = await window.kozo.api.sessions.active()
      if (cancelled) return
      const first = res?.ok ? (res.data?.[0] ?? null) : null
      setActiveSession(first || null)
    }
    refresh()
    const poll = setInterval(refresh, 15000)
    if (window.kozo?.events) {
      window.kozo.events.onSessionStarted(() => refresh())
      window.kozo.events.onSessionEnded(() => refresh())
      window.kozo.events.onGameUpdated(() => refresh())
      // Optimistic "Now Playing" — appears ~one poll after launch.
      window.kozo.events.onSessionDetected?.(() => refresh())
      window.kozo.events.onSessionUndetected?.(() => refresh())
      // Live AFK transitions: flip the card to "Away" the instant it happens.
      window.kozo.events.onSessionIdle?.(({ gameId, idle, idle_seconds }) => {
        setActiveSession(prev =>
          prev && prev.gameId === gameId ? { ...prev, idle, idle_seconds } : prev)
      })
    }
    return () => {
      cancelled = true
      clearInterval(poll)
      if (window.kozo?.events) {
        window.kozo.events.removeAll('session:started')
        window.kozo.events.removeAll('session:ended')
        window.kozo.events.removeAll('game:updated')
        window.kozo.events.removeAll('session:idle')
        window.kozo.events.removeAll('session:detected')
        window.kozo.events.removeAll('session:undetected')
      }
    }
  }, [])

  // Tick every minute to update session timer
  useEffect(() => {
    if (!activeSession) return
    const id = setInterval(() => setSessionTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [activeSession])

  return (
    <aside className={s.sidebar}>
      {/* Logo */}
      <div className={s.logoArea}>
        <HoneycombLogo size={28} />
        <div className={s.logoText}>
          <span className={s.appName}>KoZo</span>
          <span className={s.appSub}>Game Vault</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className={s.nav}>
        {NAV_ITEMS.map(({ path, label, Icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === '/'}
            className={({ isActive }) =>
              `${s.navItem} ${isActive ? s.navItemActive : ''}`
            }
          >
            <span className={s.navIcon}>
              <Icon size={17} stroke={1.6} />
            </span>
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Bottom */}
      <div className={s.bottomArea}>
        {activeSession && (
          <div className={`${s.nowPlaying} ${activeSession.idle ? s.nowPlayingIdle : ''}`}>
            <div className={s.nowPlayingHeader}>
              <span className={`${s.liveDot} ${activeSession.idle ? s.liveDotIdle : ''}`} />
              {activeSession.idle ? 'Away · paused' : 'Now Playing'}
            </div>
            <div className={s.nowPlayingName}>{activeSession.game_name}</div>
            <div className={s.nowPlayingTime}>
              {formatSessionTime(activeSession.started_at, activeSession.idle_seconds)}
              {activeSession.idle && <span className={s.nowPlayingAfk}>AFK — not counting</span>}
            </div>
          </div>
        )}

        <NavLink
          to="/profile"
          className={({ isActive }) => `${s.profileChip} ${isActive ? s.profileChipActive : ''}`}
        >
          <span className={s.profileAvatar}>
            {profile.avatar
              ? <img src={fileUrl(profile.avatar, profile.bust)} alt="" onError={e => { e.target.style.display = 'none' }} />
              : <span className={s.profileInitials}>{initials(profile.name)}</span>}
          </span>
          <span className={s.profileMeta}>
            <span className={s.profileName}>{profile.name}</span>
            <span className={s.profileLink}>View profile</span>
          </span>
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) => `${s.settingsLink} ${isActive ? s.settingsLinkActive : ''}`}
        >
          <span className={s.navIcon}><IconSettings size={16} stroke={1.6} /></span>
          Settings
        </NavLink>
      </div>
    </aside>
  )
}
