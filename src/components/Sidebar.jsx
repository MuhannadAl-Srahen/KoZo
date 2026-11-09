import React, { useState, useEffect, useRef } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  IconLayoutGrid,
  IconList,
  IconCalendar,
  IconSparkles,
  IconDiscount2,
  IconCalendarEvent,
  IconFlag,
  IconChartBar,
  IconSettings, IconDeviceTv, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand,
  IconDownload, IconLoader2, IconRefresh,
} from '@tabler/icons-react'
import HoneycombLogo from './HoneycombLogo'
import { fileUrl } from '../lib/utils'
import { useAppearance } from '../context/AppearanceContext'
import s from './Sidebar.module.css'

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 'P'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

// What the Update button says, from appUpdater's state (pure, so the words stay in one place).
// Null = no button: KoZo is up to date (or the check hasn't found anything).
export function updateLabel(u) {
  if (!u || !['downloading', 'ready', 'failed'].includes(u.state)) return null
  const v = u.version ? `KoZo ${u.version}` : 'The new version'
  const pct = u.state === 'downloading' && u.percent ? `${u.percent}%` : ''
  if (u.installing) return { title: 'Updating', sub: 'KoZo restarts by itself', busy: true }
  if (u.afterGame) return { title: 'Update waiting', sub: 'Starts when your game closes', busy: true }
  if (u.state === 'ready') return { title: 'Update now', sub: `${v} is ready` }
  if (u.state === 'failed') return { title: 'Update KoZo', sub: 'Download stopped. Try again' }
  if (u.wanted) return { title: 'Updating', sub: pct ? `Downloading ${pct}` : 'Downloading', busy: true, percent: u.percent || 0 }
  return { title: u.version ? `Update to ${u.version}` : 'Update KoZo', sub: pct ? `Downloading ${pct}` : 'Downloading', percent: u.percent || 0 }
}

// Shown only when a newer KoZo exists. One click updates: restart now when it's downloaded,
// or the moment the download is done (after the game, if one is running).
function UpdateButton() {
  const [u, setU] = useState(null)
  useEffect(() => {
    const api = window.kozo?.api?.app
    if (!api) return
    let alive = true
    api.updateState?.().then(r => { if (alive && r?.ok) setU(r.data) })
    const off = window.kozo.events.onAppUpdate?.((st) => setU(st))
    return () => { alive = false; off?.() }
  }, [])
  const label = updateLabel(u)
  if (!label) return null
  const Icon = label.busy ? IconLoader2 : u.state === 'ready' ? IconRefresh : IconDownload
  return (
    <button
      type="button"
      data-gpnav=""
      data-update-btn={u.state}
      className={`${s.updateBtn} ${u.state === 'ready' ? s.updateReady : ''}`}
      title={`${label.title}: ${label.sub}`}
      onClick={() => { if (!u.installing && !u.afterGame) window.kozo.api.app.installUpdate?.() }}
    >
      <span className={s.updateIcon}><Icon size={16} stroke={1.9} className={label.busy ? 'spin' : undefined} /></span>
      <span className={s.updateText}>
        <span className={s.updateTitle}>{label.title}</span>
        <span className={s.updateSub}>{label.sub}</span>
      </span>
      {u.state === 'downloading' && <span className={s.updateBar} style={{ width: `${Math.max(3, u.percent || 0)}%` }} />}
    </button>
  )
}

export const NAV_ITEMS = [
  { path: '/',              label: 'Library',      Icon: IconLayoutGrid,    group: 'Play' },
  { path: '/game-list',     label: 'Game List',    Icon: IconList,          group: 'Play' },
  { path: '/plan',          label: 'Play Plan',    Icon: IconCalendarEvent, group: 'Play' },
  { path: '/finished',      label: 'Finished',     Icon: IconFlag,          group: 'Play' },
  { path: '/upcoming',      label: 'Upcoming',     Icon: IconCalendar,      group: 'Discover' },
  { path: '/like',          label: 'Games like',   Icon: IconSparkles,      group: 'Discover' },
  { path: '/deals',         label: 'Discounts',    Icon: IconDiscount2,     group: 'Discover' },
  // Statistics, Sessions and Achievements live together under Activity.
  { path: '/activity',      label: 'Activity',     Icon: IconChartBar,      group: 'Discover' },
]

// Group titles show only while each group's tabs sit together (a custom tab
// order that mixes them just drops the titles).
function withGroups(items) {
  const runs = items.reduce((n, it, i) => n + (i === 0 || items[i - 1].group !== it.group ? 1 : 0), 0)
  const groups = new Set(items.map(i => i.group)).size
  return items.map((it, i) => ({ ...it, head: runs === groups && (i === 0 || items[i - 1].group !== it.group) ? it.group : null }))
}

function formatSessionTime(startedAt, idleSeconds = 0) {
  // Show real played time = wall time minus AFK idle, so the counter reflects
  // what actually gets credited (and visibly stops climbing while you're away).
  const diff = Math.max(0, Math.floor((Date.now() - new Date(startedAt)) / 1000) - (idleSeconds || 0))
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const sec = diff % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

// The Now Playing timer ticks on its own, so only these few characters redraw each second
// instead of the whole sidebar. Every second while the window is in front, nothing while
// it's hidden or behind a game (html[data-inactive], App.jsx), and still while away.
function LiveElapsed({ startedAt, idleSeconds, idle }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (idle) return
    const id = setInterval(() => {
      if (!document.documentElement.hasAttribute('data-inactive')) setTick(t => t + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [idle, startedAt])
  return formatSessionTime(startedAt, idleSeconds)
}

export default function Sidebar() {
  // Tab order and hidden tabs come from Settings → Appearance.
  const { prefs, setPrefs } = useAppearance()
  const navItems = withGroups(prefs.nav
    .filter(n => !n.hidden)
    .map(n => NAV_ITEMS.find(i => i.path === n.path))
    .filter(Boolean))
  const rail = prefs.sidebar === 'rail'
  const [activeSession, setActiveSession] = useState(null)
  const [profile, setProfile] = useState({ name: 'Player', avatar: '' })
  // Tracked games released but not yet acknowledged → badge on "Upcoming".
  const [newReleases, setNewReleases] = useState(0)
  useEffect(() => {
    let alive = true
    window.kozo?.api?.releases?.unseen?.().then(res => { if (alive && res?.ok) setNewReleases((res.data || []).length) })
    const off = window.kozo?.events?.onReleasesChanged?.((list) => setNewReleases((list || []).length))
    return () => { alive = false; off?.() }
  }, [])
  // Game List games newly on sale (services/deals.js) → badge on "Discounts".
  const [newDeals, setNewDeals] = useState(0)
  useEffect(() => {
    let alive = true
    window.kozo?.api?.deals?.unseen?.().then(res => { if (alive && res?.ok) setNewDeals((res.data || []).length) })
    const off = window.kozo?.events?.onDealsChanged?.((n) => setNewDeals(Number(n) || 0))
    return () => { alive = false; off?.() }
  }, [])
  const [xp, setXp] = useState(null)
  const location = useLocation()

  // Live level progress on the profile chip. Levelling takes tens of hours at
  // higher levels, so the level-up toast alone made the whole XP system feel
  // dead between celebrations — this keeps progress visible all the time.
  //
  // NOTE: the XP-moving events (session:ended, game:updated) are already
  // subscribed by the session effect below, so the refresh is triggered FROM
  // that effect via this ref rather than duplicating the subscriptions.
  const refreshXp = useRef(() => {})
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const res = await window.kozo?.api?.stats?.xp?.()
      if (!cancelled && res?.ok) setXp(res.data)
    }
    refreshXp.current = run
    run()
    window.addEventListener('kozo:profile-updated', run)
    return () => {
      cancelled = true
      refreshXp.current = () => {}
      window.removeEventListener('kozo:profile-updated', run)
    }
  }, [])

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
  // in-memory active-session map exposed via IPC. We do this on mount, on
  // every session event, and whenever the window becomes visible again — that
  // last one is a safety net for drift while hidden (e.g. a game removed
  // mid-session) without running a poll every 15s forever, hidden or not.
  useEffect(() => {
    if (!window.kozo?.api?.sessions?.active) return
    let cancelled = false
    async function refresh() {
      const res = await window.kozo.api.sessions.active()
      if (cancelled) return
      const first = res?.ok ? (res.data?.[0] ?? null) : null
      setActiveSession(first || null)
      refreshXp.current()   // same events move XP — see refreshXp above
    }
    refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    const offs = []
    if (window.kozo?.events) {
      offs.push(
        window.kozo.events.onSessionStarted(() => refresh()),
        window.kozo.events.onSessionEnded(() => refresh()),
        // A session too short to keep ends with this event, not session:ended.
        window.kozo.events.onSessionDiscarded?.(() => refresh()),
        window.kozo.events.onGameUpdated(() => refresh()),
        // Optimistic "Now Playing" — appears ~one poll after launch.
        window.kozo.events.onSessionDetected?.(() => refresh()),
        window.kozo.events.onSessionUndetected?.(() => refresh()),
        // Live AFK transitions: flip the card to "Away" the instant it happens.
        window.kozo.events.onSessionIdle?.(({ gameId, idle, idle_seconds }) => {
          setActiveSession(prev =>
            prev && prev.gameId === gameId ? { ...prev, idle, idle_seconds } : prev)
        }),
      )
    }
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      for (const off of offs) off?.()
    }
  }, [])


  // The running game's art for the Now Playing card.
  const [playingArt, setPlayingArt] = useState(null)
  useEffect(() => {
    const id = activeSession?.gameId
    if (!id) { setPlayingArt(null); return }
    let alive = true
    window.kozo?.api?.games?.get?.(id).then(r => {
      const g = r?.ok ? r.data : null
      if (!alive || !g) return
      setPlayingArt(g.hero_local_path ? fileUrl(g.hero_local_path) : g.banner_local_path ? fileUrl(g.banner_local_path, g.banner_rev) : g.banner_url || null)
    })
    return () => { alive = false }
  }, [activeSession?.gameId])

  return (
    <aside className={`${s.sidebar} ${rail ? s.rail : ''}`}>
     <div className={s.panel}>
      {/* Logo */}
      <div className={s.logoArea}>
        <HoneycombLogo size={28} />
        <div className={s.logoText}>
          <span className={s.appName}>KoZo</span>
        </div>
        {/* Full and slim sidebar, one click (also in Settings → Appearance). */}
        <button
          type="button"
          className={s.collapseBtn}
          onClick={() => setPrefs({ sidebar: rail ? 'full' : 'rail' })}
          title={rail ? 'Show the full sidebar' : 'Make the sidebar slim'}
          aria-label={rail ? 'Show the full sidebar' : 'Make the sidebar slim'}
        >
          {rail ? <IconLayoutSidebarLeftExpand size={17} stroke={1.7} /> : <IconLayoutSidebarLeftCollapse size={17} stroke={1.7} />}
        </button>
      </div>

      {/* Navigation */}
      <nav className={s.nav}>
        {navItems.map(({ path, label, Icon, head }) => (
          <React.Fragment key={path}>
            {head && <div className={s.groupHead}>{head}</div>}
            <NavLink
              to={path}
              end={path === '/'}
              data-gpnav=""
              data-tour={`nav-${path === '/' ? 'library' : path.slice(1)}`}
              title={rail ? label : undefined}
              className={({ isActive }) => `${s.navItem} ${isActive ? s.navItemActive : ''}`}
            >
              <span className={s.navIcon}>
                <Icon size={17} stroke={1.7} />
              </span>
              <span className={s.navLabel}>{label}</span>
              {path === '/upcoming' && newReleases > 0 && (
                <span className={s.navBadge} title={`${newReleases} tracked game${newReleases !== 1 ? 's' : ''} just released`}>{newReleases}</span>
              )}
              {path === '/deals' && newDeals > 0 && (
                <span className={s.navBadge} title={`${newDeals} game${newDeals !== 1 ? 's' : ''} on your Game List just went on sale`}>{newDeals}</span>
              )}
            </NavLink>
          </React.Fragment>
        ))}
      </nav>

      {/* Bottom */}
      <div className={s.bottomArea}>
        <UpdateButton />
        {activeSession && (
          <NavLink
            to={`/game/${activeSession.gameId}`}
            data-gpnav=""
            title={activeSession.game_name}
            className={`${s.nowPlaying} ${activeSession.idle ? s.nowPlayingIdle : ''}`}
          >
            {playingArt && <img className={s.nowPlayingArt} src={playingArt} alt="" />}
            <span className={s.nowPlayingShade} />
            <span className={s.nowPlayingBody}>
              <span className={s.nowPlayingHeader}>
                <span className={`${s.liveDot} ${activeSession.idle ? s.liveDotIdle : ''}`} />
                <span className={s.navLabel}>{activeSession.idle ? 'Away, paused' : activeSession.pending ? 'Starting' : 'Now playing'}</span>
              </span>
              <span className={s.nowPlayingName}>{activeSession.game_name}</span>
              <span className={s.nowPlayingElapsed}>
                <LiveElapsed startedAt={activeSession.started_at} idleSeconds={activeSession.idle_seconds} idle={!!activeSession.idle} />
              </span>
            </span>
          </NavLink>
        )}

        <NavLink
          to="/profile"
          data-gpnav=""
          data-tour="nav-profile"
          className={({ isActive }) => `${s.profileChip} ${isActive ? s.profileChipActive : ''}`}
        >
          {/* The ring around the avatar is the progress to the next level. */}
          <span className={s.avatarRing} style={{ '--xp': `${xp?.progress ?? 0}%` }}
            title={xp ? `${xp.toNextLevel.toLocaleString()} XP to level ${xp.level + 1}` : undefined}>
            <span className={s.profileAvatar}>
              {profile.avatar
                ? <img src={fileUrl(profile.avatar, profile.bust)} alt="" onError={e => { e.target.style.display = 'none' }} />
                : <span className={s.profileInitials}>{initials(profile.name)}</span>}
            </span>
            {xp && <span className={s.levelBadge}>{xp.level}</span>}
          </span>
          <span className={s.profileMeta}>
            <span className={s.profileName} title={profile.name}>{profile.name}</span>
            <span className={s.profileTier}>{xp ? `${xp.tier} · ${Math.round(xp.progress)}%` : 'View profile'}</span>
          </span>
        </NavLink>

        <div className={s.footRow}>
          <NavLink
            to="/big"
            data-gpnav=""
            className={s.footBtn}
            title="Big Picture: full screen for the TV and the controller (or hold the controller shortcut from Settings > Shortcuts)"
          >
            <IconDeviceTv size={17} stroke={1.7} />
            <span className={s.navLabel}>Big Picture</span>
          </NavLink>
          <NavLink
            to="/settings"
            data-gpnav=""
            data-tour="nav-settings"
            title="Settings"
            className={({ isActive }) => `${s.footBtn} ${s.footIcon} ${isActive ? s.footBtnActive : ''}`}
          >
            <IconSettings size={17} stroke={1.7} />
          </NavLink>
        </div>
      </div>
     </div>
    </aside>
  )
}
