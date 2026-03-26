import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  IconChevronLeft, IconTrophy, IconLock, IconCheck, IconHistory,
  IconDotsVertical, IconTrash, IconRefresh, IconEdit, IconPlayerPlayFilled,
  IconStethoscope, IconFolderSearch, IconDeviceFloppy, IconDownload, IconLoader2,
  IconCircleCheck, IconCircleCheckFilled,
} from '@tabler/icons-react'
import { getBannerBg, getBannerIcon, formatPlaytime, formatDate, formatDateTime, fileUrl, isSteamTracked, launcherLabel } from '../lib/utils'
import AchievementModal from '../components/modals/AchievementModal'
import EditGameModal from '../components/modals/EditGameModal'
import SaveManagerModal from '../components/modals/SaveManagerModal'
import InfoModal, { PrivacyHelp } from '../components/ui/InfoModal'
import s from './GameDetail.module.css'

const STEAM_PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings'

// ── 7-day chart helpers ────────────────────────────────────────────────────
function buildWeekData(sessions) {
  const days = []
  const today = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dayStr = d.toISOString().slice(0, 10)
    const secs = sessions
      .filter(s => s.started_at?.startsWith(dayStr))
      .reduce((a, s) => a + (s.duration_seconds || 0), 0)
    const label = i === 0 ? 'Today'
      : i === 1 ? 'Yest'
      : d.toLocaleDateString('en-US', { weekday: 'short' })
    days.push({ dayStr, label, seconds: secs, isToday: i === 0 })
  }
  return days
}

function WeekChart({ sessions }) {
  const data   = buildWeekData(sessions)
  const maxSec = Math.max(...data.map(d => d.seconds), 1)

  return (
    <div className={s.chartSection}>
      <div className={s.chartTitle}>Last 7 days</div>
      <div className={s.chart}>
        {data.map((d, i) => (
          <div key={i} className={`${s.chartBar} ${d.isToday ? s.chartBarToday : ''}`}>
            <div
              className={s.chartBarFill}
              style={{ height: `${Math.max((d.seconds / maxSec) * 52, d.seconds > 0 ? 4 : 2)}px` }}
              title={formatPlaytime(d.seconds)}
            />
            <div className={s.chartBarLabel}>{d.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Achievement card (88px fixed) ──────────────────────────────────────────
function AchCard({ ach, maxUnlockSec, onClick }) {
  const unlocked = !!ach.unlocked_at

  return (
    <div className={s.achCard} onClick={() => onClick(ach)}>
      <div className={`${s.achIcon} ${unlocked ? s.achIconUnlocked : s.achIconLocked}`}>
        {ach.icon_url
          ? <img src={ach.icon_url} alt="" />
          : <IconTrophy
              size={22}
              stroke={1.4}
              style={{ color: unlocked ? 'var(--a)' : 'var(--text-muted)' }}
            />
        }
      </div>

      <div className={s.achBody}>
        <div className={s.achName}>{ach.display_name}</div>
        {ach.description
          ? <div className={s.achDesc}>{ach.description}</div>
          : !unlocked && <div className={s.achHidden}>Hidden achievement</div>
        }
        {unlocked && (
          <div className={s.achDate}>{formatDate(ach.unlocked_at)}</div>
        )}
      </div>

      <div className={s.achStatus}>
        {unlocked
          ? <IconCheck size={16} stroke={2.5} style={{ color: 'var(--a)' }} />
          : <IconLock  size={15} stroke={1.6} style={{ color: 'var(--text-muted)' }} />
        }
      </div>
    </div>
  )
}

// ── Session row ────────────────────────────────────────────────────────────
function SessionRow({ session, maxDuration }) {
  const widthPct = maxDuration > 0
    ? Math.max((session.duration_seconds / maxDuration) * 100, 2)
    : 2

  return (
    <div className={s.sessionRow}>
      <div className={s.sessionDate}>{formatDate(session.started_at)}</div>
      <div className={s.sessionTime}>
        {new Date(session.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className={s.sessionDurBar}>
        <div className={s.sessionDurFill} style={{ width: `${widthPct}%` }} />
      </div>
      <div className={s.sessionDuration}>{formatPlaytime(session.duration_seconds)}</div>
      {session.achievements_unlocked > 0 && (
        <div className={s.sessionAchs}>
          <IconTrophy size={11} stroke={1.5} />
          {session.achievements_unlocked}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
export default function GameDetail() {
  const { id }       = useParams()
  const navigate     = useNavigate()
  const [game, setGame]             = useState(null)
  const [achievements, setAch]      = useState([])
  const [sessions, setSessions]     = useState([])
  const [tab, setTab]               = useState('achievements')
  const [isLive, setIsLive]         = useState(false)
  const [selectedAch, setSelectedAch] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [menuOpen, setMenuOpen]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [showEdit, setShowEdit]     = useState(false)
  const [showSaveManager, setShowSaveManager] = useState(false)
  const [importing, setImporting]       = useState(false)
  const [refreshing, setRefreshing]     = useState(false)
  const [crackScanning, setCrackScanning] = useState(false)
  const [imgBust, setImgBust]           = useState(0)
  const [info, setInfo]                 = useState(null)
  const [crackScanInfo, setCrackScanInfo] = useState(null)
  const menuRef                     = useRef(null)

  const load = useCallback(async () => {
    if (!window.kozo?.api || !id) return
    const [gRes, aRes, sRes, activeRes] = await Promise.all([
      window.kozo.api.games.get(Number(id)),
      window.kozo.api.achievements.listForGame(Number(id)),
      window.kozo.api.sessions.getForGame(Number(id)),
      window.kozo.api.sessions.active(),
    ])
    if (gRes?.ok) setGame(gRes.data)
    if (aRes?.ok) setAch(aRes.data ?? [])
    if (sRes?.ok) setSessions(sRes.data ?? [])
    if (activeRes?.ok) {
      setIsLive((activeRes.data ?? []).some(s => s.gameId === Number(id)))
    }
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
    if (!window.kozo?.events) return
    window.kozo.events.onSessionStarted(() => load())
    window.kozo.events.onSessionEnded(()   => load())
    // Reload when an achievement syncs in (live, during a session) so the page
    // catches new unlocks without a manual refresh.
    window.kozo.events.onGameUpdated(() => load())
    window.kozo.events.onAchievementUnlocked(() => load())
    return () => {
      window.kozo.events.removeAll('session:started')
      window.kozo.events.removeAll('session:ended')
      window.kozo.events.removeAll('game:updated')
      window.kozo.events.removeAll('achievement:unlocked')
    }
  }, [load])

  // Auto-scan crack files when a cracked game page opens
  useEffect(() => {
    if (!id) return
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      const gRes = await window.kozo?.api?.games?.get(Number(id))
      if (cancelled || !gRes?.ok || !gRes.data?.is_cracked) return
      const res = await window.kozo?.api?.crack?.scanGame?.(Number(id))
      if (cancelled || !res?.ok) return
      if (res.data?.added > 0 || res.data?.hits?.length > 0) {
        const sources = [...new Set((res.data.hits || []).map(h => h.source))]
        setCrackScanInfo({ added: res.data.added, sources })
        if (res.data.added > 0) load()
      }
    }, 800)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [id])

  // Close the menu if user clicks outside
  useEffect(() => {
    function onClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false)
        setConfirmDelete(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    await window.kozo?.api?.games?.delete(Number(id))
    navigate('/')
  }

  // Automatically find this game on Steam by name and import its achievement list
  // (no App ID typing). Unlocks are then hand-ticked by clicking each achievement.
  async function handleAutoImport() {
    setImporting(true); setMenuOpen(false)
    const res = await window.kozo?.api?.achievements?.autoImport(Number(id))
    setImporting(false)
    const d = res?.data
    if (res?.ok && d?.count > 0) {
      await load()
      setInfo({ variant: 'success', title: `Imported ${d.count} achievements`,
        message: 'Click any achievement to mark it as unlocked.' })
    } else if (d?.reason === 'no_key') {
      setInfo({ variant: 'error', title: 'Steam API key needed',
        message: 'Add your Steam Web API key in Settings → Steam, then try again.' })
    } else if (d?.reason === 'no_match') {
      setInfo({ variant: 'error', title: 'Not found on Steam',
        message: `KoZo couldn't confidently match "${game.name}" to a Steam game to import its achievements.` })
    } else if (d?.reason === 'no_schema') {
      setInfo({ variant: 'error', title: 'No achievements',
        message: 'Steam lists no achievements for this game (common for unreleased titles).' })
    } else {
      setInfo({ variant: 'error', title: 'Import failed', message: res?.error || d?.error || 'Unknown error.' })
    }
  }

  // Mark this game finished (or un-finish it). Finishing awards XP via the
  // 'finished games' pillar in stats:xp. games:update broadcasts game:updated.
  async function toggleFinished() {
    if (!game) return
    const finishing = game.completion_status !== 'finished'
    setMenuOpen(false)
    await window.kozo?.api?.games?.update(Number(id), {
      completion_status: finishing ? 'finished' : null,
    })
    await load()
    if (finishing) {
      setInfo({ variant: 'success', title: 'Marked as finished',
        message: `Nice — ${game.name} counts toward your XP now. Find it on your Profile.` })
    }
  }

  async function handleLaunch() {
    const res = await window.kozo?.api?.games?.launch(Number(id))
    if (!res?.ok) {
      setInfo({
        variant: 'error', title: 'Could not launch',
        message: res?.error || 'Unknown error.',
      })
    }
  }

  async function handleRefresh() {
    if (!game?.steam_app_id) return
    setRefreshing(true)
    setMenuOpen(false)
    const res = await window.kozo?.api?.steam?.refresh(Number(id))
    setImgBust(Date.now())
    await load()
    setRefreshing(false)

    // For cracked games: Steam API failure is expected and OK — show crack results
    if (!res?.ok && game?.is_cracked) {
      setInfo({
        variant: 'info',
        title: 'Crack game — Steam sync skipped',
        message: 'Achievements are read from crack emulator files, not Steam. Make sure your install path is set correctly in Edit Game.',
      })
      return
    }

    if (!res?.ok) {
      setInfo({ variant: 'error', title: 'Sync failed', message: res?.error || 'Unknown error.' })
      return
    }

    const d = res.data || {}

    if (d.playerSyncReason === 'private' && !game?.is_cracked) {
      setInfo({
        variant: 'warning',
        title: `Couldn't read your Steam unlocks for "${game.name}"`,
        message: 'Steam returned "Profile is not public" — your unlock list is hidden.',
        children: <PrivacyHelp openSteamPrivacy={() => window.kozo?.api?.shell?.openExternal(STEAM_PRIVACY_URL)} />,
      })
      return
    }

    // A schema of 0 with no unlocks means Steam has no achievements for this game
    // (common for unreleased / early-access titles) — say so instead of a vague
    // "up to date", which reads like something went wrong.
    if (!d.achievementCount && !d.playerUnlocksAdded && !d.crackUnlocksAdded && !game?.is_cracked) {
      setInfo({
        variant: 'info',
        title: `No achievements for "${game.name}"`,
        message: 'Steam lists no achievements for this game yet (common for unreleased or early-access titles). Playtime and sessions are still tracked.',
      })
      return
    }

    const lines = []
    if (d.achievementCount)   lines.push(`${d.achievementCount} achievements in schema`)
    if (d.playerUnlocksAdded) lines.push(`${d.playerUnlocksAdded} new Steam unlock${d.playerUnlocksAdded === 1 ? '' : 's'} imported`)
    if (d.crackUnlocksAdded)  lines.push(`${d.crackUnlocksAdded} new crack unlock${d.crackUnlocksAdded === 1 ? '' : 's'} imported`)
    if (d.schemaSkipped)      lines.push('Schema unavailable from Steam — crack file scan still ran.')
    if (lines.length === 0)   lines.push('Everything is already up to date.')
    const variant = d.crackUnlocksAdded > 0 || d.playerUnlocksAdded > 0 ? 'success' : 'info'
    setInfo({ variant, title: `Synced "${game.name}"`, lines })
  }

  // Unified "Sync" for cracked games — mirrors the Steam Sync button.
  // With a Steam link we pull the schema (names + icons) AND scan crack files for
  // unlocks; without one we just scan the local crack emulator files.
  async function handleCrackSync() {
    if (game?.steam_app_id) await handleRefresh()
    else await handleCrackFiles()
  }

  async function handleCrackFiles() {
    setCrackScanning(true)
    const [scanRes, diagRes] = await Promise.all([
      window.kozo?.api?.crack?.scanGame?.(Number(id)),
      window.kozo?.api?.crack?.diagnose?.(Number(id)),
    ])
    setCrackScanning(false)

    const scan = scanRes?.ok  ? scanRes.data  : {}
    const diag = diagRes?.ok  ? diagRes.data  : {}

    if (scan.added > 0) {
      await load()
      const sources = [...new Set((scan.hits || []).map(h => h.source))]
      setCrackScanInfo({ added: scan.added, sources })
    }

    const lines = []
    const found = diag.found || []

    if (found.length > 0) {
      lines.push(...found.map(f => `${f.source}: ${f.path}`))
    }

    if (diag.appidMismatch) {
      lines.push(`⚠ AppID mismatch — KoZo: ${diag.appid} · Game folder: ${diag.detectedAppid}`)
    }

    if (scan.added > 0) {
      setInfo({
        variant: 'success',
        title: `${scan.added} new achievement${scan.added === 1 ? '' : 's'} imported`,
        lines,
      })
    } else if (found.length > 0) {
      setInfo({
        variant: 'info',
        title: 'Achievement files found — already up to date',
        lines,
      })
    } else {
      // Nothing found — give actionable guidance
      const goldbergPath = `%APPDATA%\\Goldberg SteamEmu Saves\\${diag.appid || '?'}\\achievements.json`
      setInfo({
        variant: 'warning',
        title: 'No crack achievement files found yet',
        message: diag.installPath
          ? `Checked ${diag.totalChecked || 0} locations. For ZIP-extracted games, Goldberg creates the file below only after your first unlock in-game:`
          : 'No install path set. Edit the game → Browse to the .exe — the install path is needed to find crack files.',
        lines: diag.installPath ? [goldbergPath] : [],
      })
    }
  }

  async function handleDiagnose() {
    setMenuOpen(false)
    if (!window.kozo?.api?.steam?.diagnose) {
      setInfo({
        variant: 'warning', title: 'Restart KoZo',
        message: 'The Diagnose IPC isn\'t loaded — fully quit KoZo and start it again.',
      })
      return
    }
    const res = await window.kozo.api.steam.diagnose(Number(id))
    if (!res?.ok) {
      setInfo({ variant: 'error', title: 'Diagnose failed', message: res?.error || 'Unknown error.' })
      return
    }
    const d = res.data || {}
    const lines = [
      `Steam profile: ${d.profile_name || '(none)'}`,
      `Steam App ID: ${d.steam_app_id ?? '(none)'}`,
      `Achievements in Steam's schema: ${d.schema_count ?? 0}`,
      `Unlocks Steam reports for you: ${d.steam_unlocks ?? 0}`,
      `Stored in KoZo: ${d.local_unlocked ?? 0} / ${d.local_total ?? 0}`,
    ]
    let variant = 'info', children = null
    if (d.error === 'private') {
      variant = 'warning'
      children = <PrivacyHelp openSteamPrivacy={() => window.kozo?.api?.shell?.openExternal(STEAM_PRIVACY_URL)} />
    } else if (d.error === 'no_stats_for_game') {
      variant = 'info'
      lines.push('This game has no Steam achievements at all.')
    } else if (d.error) {
      variant = 'error'
      lines.push(`Steam error: ${d.error}`)
    } else if (d.steam_unlocks > d.local_unlocked) {
      variant = 'info'
      lines.push('Steam has unlocks KoZo doesn\'t. Click "Sync" to import them.')
    } else {
      variant = 'success'
      lines.push('KoZo is up to date with Steam.')
    }
    setInfo({ variant, title: 'Steam sync diagnostic', lines, children })
  }

  if (loading) return <div className={s.emptyState}>Loading…</div>
  if (!game)   return <div className={s.emptyState}>Game not found.</div>

  const Icon         = getBannerIcon(game.name)
  const bannerBg     = getBannerBg(game.id)
  // Steam achievement UI only for games genuinely tracked via the Steam API — a
  // foreign-launcher game (Xbox/Epic/GOG…) never shows Steam sync, even if it
  // happens to carry a stray steam_app_id.
  const steamTracked = isSteamTracked(game)
  const unlocked     = achievements.filter(a => a.unlocked_at).length
  const total        = achievements.length
  const pct          = total > 0 ? Math.round((unlocked / total) * 100) : 0
  const maxDuration  = Math.max(...sessions.map(s => s.duration_seconds || 0), 1)

  // Priority: local hero (cached, wide landscape) → CDN hero → local portrait (last resort)
  const heroCdnUrl = game.steam_app_id
    ? `https://cdn.akamai.steamstatic.com/steam/apps/${game.steam_app_id}/library_hero.jpg`
    : null
  const bust = imgBust || undefined
  const heroUrl = game.hero_local_path
    ? fileUrl(game.hero_local_path, bust)
    : (heroCdnUrl ?? fileUrl(game.banner_local_path, bust))

  return (
    <div className={s.page}>
      {/* Banner */}
      <div className={s.banner} style={{ background: bannerBg }}>
        {heroUrl ? (
          <img
            key={heroUrl}
            src={heroUrl}
            className={s.bannerImg}
            alt=""
            onError={e => {
              // CDN fallback chain: hero CDN → hide
              if (heroCdnUrl && e.target.src !== heroCdnUrl) {
                e.target.src = heroCdnUrl
                e.target.onerror = () => { e.target.style.display = 'none' }
              } else {
                e.target.style.display = 'none'
              }
            }}
          />
        ) : (
          <Icon size={80} className={s.bannerPlaceholderIcon} stroke={1.0} />
        )}
        <div className={s.bannerOverlay} />

        <button className={s.bannerBack} onClick={() => navigate('/')}>
          <IconChevronLeft size={15} stroke={2} />
          Library
        </button>

        <div className={s.bannerActions}>
          {!!game.is_installed && !isLive && (
            <button
              onClick={handleLaunch}
              title={`Launch ${game.name}`}
              className={s.bannerPlayBtn}
            >
              <IconPlayerPlayFilled size={13} />
              Play
            </button>
          )}

          {/* Finished toggle — awards XP and shows a badge when set */}
          <button
            onClick={toggleFinished}
            title={game.completion_status === 'finished' ? 'Marked finished — click to undo' : 'Mark this game as finished (earns XP)'}
            className={`${s.bannerSyncBtn} ${game.completion_status === 'finished' ? s.bannerFinishedBtn : ''}`}
          >
            {game.completion_status === 'finished'
              ? <IconCircleCheckFilled size={14} />
              : <IconCircleCheck size={14} />}
            {game.completion_status === 'finished' ? 'Finished' : 'Mark finished'}
          </button>
          {steamTracked && (
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              title="Sync achievements from Steam"
              className={s.bannerSyncBtn}
            >
              {refreshing
                ? <IconRefresh size={13} style={{ animation: 'spin 1s linear infinite' }} />
                : <IconRefresh size={13} />
              }
              {refreshing ? 'Syncing…' : 'Sync'}
            </button>
          )}

          {!!game.is_cracked && (
            <button
              onClick={handleCrackSync}
              disabled={crackScanning || refreshing}
              title="Sync achievements — reads crack emulator files (and Steam schema if linked)"
              className={s.bannerSyncBtn}
            >
              {(crackScanning || refreshing)
                ? <IconRefresh size={13} style={{ animation: 'spin 1s linear infinite' }} />
                : <IconRefresh size={13} />
              }
              {(crackScanning || refreshing) ? 'Syncing…' : 'Sync'}
            </button>
          )}

          {/* Non-Steam, non-cracked → one-click auto-import of the achievement list */}
          {!steamTracked && !game.is_cracked && (
            <button
              onClick={handleAutoImport}
              disabled={importing}
              title="Find this game on Steam and import its achievement list"
              className={s.bannerSyncBtn}
            >
              <IconRefresh size={13} style={importing ? { animation: 'spin 1s linear infinite' } : undefined} />
              {importing ? 'Syncing…' : 'Sync'}
            </button>
          )}
        </div>

        {isLive && (
          <div className={s.liveBadge}>
            <span className={s.liveDot} />
            LIVE
          </div>
        )}

        {/* Game options menu */}
        <div className={s.gameMenu} ref={menuRef}>
          <button
            className={s.gameMenuTrigger}
            onClick={() => { setMenuOpen(v => !v); setConfirmDelete(false) }}
            title="Game options"
          >
            <IconDotsVertical size={16} stroke={1.8} />
          </button>

          {menuOpen && (
            <div className={s.gameMenuDropdown}>
              <button
                className={s.gameMenuItem}
                onClick={() => { setShowEdit(true); setMenuOpen(false) }}
              >
                <IconEdit size={14} stroke={1.6} />
                Edit game
              </button>

              {/* Auto-import achievement list — for launchers KoZo can't auto-track */}
              {!steamTracked && !game.is_cracked && (
                <button
                  className={s.gameMenuItem}
                  onClick={handleAutoImport}
                  disabled={importing}
                >
                  <IconDownload size={14} stroke={1.6} />
                  {importing ? 'Importing…' : (total > 0 ? 'Re-import achievements' : 'Import achievements from Steam')}
                </button>
              )}

              {steamTracked && (
                <button
                  className={s.gameMenuItem}
                  onClick={handleRefresh}
                  disabled={refreshing}
                >
                  <IconRefresh size={14} stroke={1.6} />
                  {refreshing ? 'Refreshing…' : 'Refresh achievements'}
                </button>
              )}

              {steamTracked && (
                <button className={s.gameMenuItem} onClick={handleDiagnose}>
                  <IconStethoscope size={14} stroke={1.6} />
                  Diagnose Steam sync
                </button>
              )}

              {!!game.is_cracked && (
                <button
                  className={s.gameMenuItem}
                  onClick={() => { setMenuOpen(false); handleCrackFiles() }}
                  disabled={crackScanning}
                >
                  <IconFolderSearch size={14} stroke={1.6} />
                  Find crack files
                </button>
              )}

              <button className={s.gameMenuItem} onClick={() => { setMenuOpen(false); setShowSaveManager(true) }}>
                <IconDeviceFloppy size={14} stroke={1.6} />
                Save files &amp; backup
              </button>

              {!confirmDelete ? (
                <button
                  className={`${s.gameMenuItem} ${s.gameMenuItemDanger}`}
                  onClick={() => setConfirmDelete(true)}
                >
                  <IconTrash size={14} stroke={1.6} />
                  Remove from Library
                </button>
              ) : (
                <div className={s.gameMenuConfirm}>
                  <div className={s.gameMenuConfirmText}>
                    Remove "{game.name}"? All sessions and achievements will be deleted.
                  </div>
                  <div className={s.gameMenuConfirmBtns}>
                    <button className={s.gameMenuCancelBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
                    <button className={s.gameMenuDeleteBtn} onClick={handleDelete} disabled={deleting}>
                      {deleting ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className={s.bannerBottom}>
          <div className={s.gameNameRow}>
            <div className={s.gameName}>{game.name}</div>
            {!!game.is_cracked && (
              <div className={s.crackBadge}>
                CRACKED
                {crackScanInfo?.sources?.length > 0 && (
                  <span className={s.crackBadgeSource}> · {crackScanInfo.sources.join(', ')}</span>
                )}
              </div>
            )}
          </div>
          <div className={s.bannerMeta}>
            <div className={s.metaItem}>
              <span>Playtime</span>
              <span className={s.metaValue}>{formatPlaytime(game.total_playtime_seconds)}</span>
            </div>
            {total > 0 && (
              <div className={s.achProgress}>
                <span className={s.metaItem}>
                  <IconTrophy size={12} stroke={1.5} />
                  <span className={s.metaValue}>{unlocked}/{total}</span>
                  <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>({pct}%)</span>
                </span>
                <div className={s.progressBar}>
                  <div className={s.progressFill} style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {game.first_played_at && (
              <div className={s.metaItem}>
                <span>Since</span>
                <span className={s.metaValue}>{formatDate(game.first_played_at)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className={s.tabs}>
        <button
          className={`${s.tab} ${tab === 'achievements' ? s.tabActive : ''}`}
          onClick={() => setTab('achievements')}
        >
          <IconTrophy size={14} stroke={1.6} />
          Achievements
          {total > 0 && <span className={s.tabCount}>{unlocked}/{total}</span>}
        </button>
        <button
          className={`${s.tab} ${tab === 'sessions' ? s.tabActive : ''}`}
          onClick={() => setTab('sessions')}
        >
          <IconHistory size={14} stroke={1.6} />
          Sessions
          {sessions.length > 0 && <span className={s.tabCount}>{sessions.length}</span>}
        </button>
      </div>

      {/* Tab content */}
      <div className={s.content}>
        {tab === 'achievements' && (
          <>
            {total === 0 ? (
              <div className={s.emptyState}>
                {game.is_cracked
                  ? 'No achievements found yet — they appear here once you unlock them in-game.'
                  : steamTracked
                    ? 'No achievements found. Try clicking "Sync".'
                    : <>
                        <div style={{ marginBottom: 12 }}>
                          {launcherLabel(game.source)} unlocks can't be read automatically — but KoZo can
                          pull the achievement list from Steam so you can tick off the ones you've earned.
                        </div>
                        <button className={s.importBtn} onClick={handleAutoImport} disabled={importing}>
                          {importing
                            ? <><IconLoader2 size={14} stroke={1.8} style={{ animation: 'spin 1s linear infinite' }} /> Importing…</>
                            : <><IconDownload size={14} stroke={1.8} /> Import achievements from Steam</>}
                        </button>
                      </>}
              </div>
            ) : (
              <div className={s.achGrid}>
                {achievements.map(a => (
                  <AchCard
                    key={a.id}
                    ach={a}
                    onClick={setSelectedAch}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'sessions' && (
          <>
            {sessions.length === 0 ? (
              <div className={s.emptyState}>No sessions recorded yet.</div>
            ) : (
              <>
                <WeekChart sessions={sessions} />
                <div className={s.sessionList}>
                  {sessions.map(session => (
                    <SessionRow key={session.id} session={session} maxDuration={maxDuration} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {selectedAch && (
        <AchievementModal
          achievement={selectedAch}
          game={game}
          onClose={() => setSelectedAch(null)}
          onToggle={(updated) => {
            setAch(prev => prev.map(a => a.id === updated.id ? updated : a))
            setSelectedAch(updated)
          }}
        />
      )}

      {showEdit && (
        <EditGameModal
          game={game}
          onClose={() => setShowEdit(false)}
          onSaved={(updated) => {
            if (updated) setGame(updated)
            load()
          }}
        />
      )}

      {showSaveManager && (
        <SaveManagerModal game={game} onClose={() => setShowSaveManager(false)} />
      )}

      {info && (
        <InfoModal
          variant={info.variant}
          title={info.title}
          message={info.message}
          lines={info.lines}
          actions={info.actions}
          onClose={() => setInfo(null)}
        >
          {info.children}
        </InfoModal>
      )}
    </div>
  )
}
