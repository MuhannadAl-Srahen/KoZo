import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  IconChevronLeft, IconTrophy, IconLock, IconCheck, IconHistory,
  IconDotsVertical, IconTrash, IconRefresh, IconEdit, IconPlayerPlayFilled,
  IconStethoscope, IconFolderOpen, IconDeviceFloppy, IconDownload, IconLoader2,
  IconCircleCheck, IconCircleOff, IconEye, IconEyeOff, IconChevronDown,
  IconChevronRight, IconAlertTriangle,
} from '@tabler/icons-react'
import { getBannerBg, getBannerIcon, formatPlaytime, formatDate, formatDateTime, fileUrl, isSteamTracked, launcherLabel } from '../lib/utils'
import { STATUS_META } from '../components/GameCard'
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
function AchCard({ ach, maxUnlockSec, onClick, onQuickToggle }) {
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

      <button
        className={s.achStatus}
        title={unlocked ? 'Mark as locked' : 'Mark as unlocked (manual)'}
        onClick={(e) => { e.stopPropagation(); onQuickToggle?.(ach) }}
      >
        {unlocked
          ? <IconCheck size={16} stroke={2.5} style={{ color: 'var(--a)' }} />
          : <IconLock  size={15} stroke={1.6} style={{ color: 'var(--text-muted)' }} />
        }
      </button>
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
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const statusMenuRef               = useRef(null)
  const [syncPrivacyError, setSyncPrivacyError] = useState(null)

  // Notes — debounced autosave, flushed on unmount so nothing is lost.
  const [notes, setNotes]           = useState('')
  const [notesOpen, setNotesOpen]   = useState(false)   // opened on load when notes exist
  const [notesSaved, setNotesSaved] = useState(false)
  const notesTimer   = useRef(null)
  const notesDirty   = useRef(null)   // pending unsaved text (null = clean)
  const notesLoaded  = useRef(false)

  function persistNotes(text) {
    notesDirty.current = null
    window.kozo?.api?.games?.update(Number(id), { notes: text })
    setNotesSaved(true)
    setTimeout(() => setNotesSaved(false), 1500)
  }

  function handleNotesChange(text) {
    setNotes(text)
    notesDirty.current = text
    clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(() => persistNotes(text), 800)
  }

  useEffect(() => () => {
    // Flush pending notes when leaving the page.
    clearTimeout(notesTimer.current)
    if (notesDirty.current != null) {
      window.kozo?.api?.games?.update(Number(id), { notes: notesDirty.current })
    }
  }, [id])

  // Automatic achievement sync — fires silently once per page visit so nobody
  // ever has to press a sync button. Live sessions are already covered by the
  // file watchers + periodic sync; this catches unlocks earned while KoZo was
  // closed or before the watchers attached.
  const autoSyncedRef = useRef(null)
  useEffect(() => {
    if (loading || !game?.id || autoSyncedRef.current === game.id) return
    autoSyncedRef.current = game.id
    ;(async () => {
      try {
        if (game.is_cracked) {
          await window.kozo?.api?.crack?.scanGame?.(game.id)
        } else if (game.steam_app_id) {
          await window.kozo?.api?.steam?.refresh?.(game.id)
        }
        load()   // reflect anything the sync found
      } catch { /* silent — manual sync in the menu surfaces errors */ }
    })()
  }, [loading, game?.id])

  const load = useCallback(async () => {
    if (!window.kozo?.api || !id) return
    const [gRes, aRes, sRes, activeRes, privRes] = await Promise.all([
      window.kozo.api.games.get(Number(id)),
      window.kozo.api.achievements.listForGame(Number(id)),
      window.kozo.api.sessions.getForGame(Number(id)),
      window.kozo.api.sessions.active(),
      window.kozo.api.steam?.lastSyncError?.(Number(id)),
    ])
    if (gRes?.ok) {
      setGame(gRes.data)
      // Seed notes once per game — don't clobber live typing on background reloads.
      if (!notesLoaded.current) {
        setNotes(gRes.data?.notes || '')
        setNotesOpen(!!gRes.data?.notes)   // expanded only when there's something to read
        notesLoaded.current = true
      }
    }
    if (aRes?.ok) setAch(aRes.data ?? [])
    if (sRes?.ok) setSessions(sRes.data ?? [])
    if (activeRes?.ok) {
      setIsLive((activeRes.data ?? []).some(s => s.gameId === Number(id)))
    }
    setSyncPrivacyError(privRes?.ok ? privRes.data : null)
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
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target)) {
        setStatusMenuOpen(false)
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
    } else if (d?.reason === 'no_match') {
      setInfo({ variant: 'error', title: 'Not found on Steam',
        message: `KoZo couldn't confidently match "${game.name}" to a Steam game to import its achievements.` })
    } else if (d?.reason === 'no_schema') {
      setInfo({ variant: 'error', title: 'No achievements',
        message: 'Steam lists no achievements for this game (common for unreleased titles).' })
    } else {
      setInfo({ variant: 'error', title: 'Import failed',
        message: res?.error || d?.error || (d?.reason ? `Import failed (${d.reason}).` : 'Unknown error.') })
    }
  }

  // Set the game's status (Playing/Finished/Dropped/On hold, or null to clear).
  // Finishing awards XP via the 'finished games' pillar in stats:xp; the change
  // is mirrored onto any linked Game List entry by statusSync in the backend.
  async function setStatus(status) {
    if (!game) return
    setStatusMenuOpen(false)
    await window.kozo?.api?.games?.update(Number(id), { completion_status: status })
    await load()
    if (status === 'finished' && game.completion_status !== 'finished') {
      setInfo({ variant: 'success', title: 'Marked as finished',
        message: `Nice — ${game.name} counts toward your XP now. Find it on your Profile.` })
    }
  }

  // Hide/unhide from the Library grid. Time, achievements, and XP keep counting.
  async function toggleHidden() {
    if (!game) return
    setMenuOpen(false)
    await window.kozo?.api?.games?.update(Number(id), { is_hidden: game.is_hidden ? 0 : 1 })
    await load()
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

  // "Check achievements" for Steam-tracked games — sync first (schema + unlocks),
  // THEN diagnose so the report reflects what the sync just imported. One modal.
  async function handleSteamCheck() {
    if (!game?.steam_app_id) return
    setRefreshing(true)
    const res = await window.kozo?.api?.steam?.refresh(Number(id))
    const diagRes = await window.kozo?.api?.steam?.diagnose?.(Number(id))
    setImgBust(Date.now())
    await load()
    setRefreshing(false)

    const d = res?.ok ? (res.data || {}) : {}
    const diag = diagRes?.ok ? (diagRes.data || {}) : null

    if (d.playerSyncReason === 'private' || diag?.error === 'private') {
      setInfo({
        variant: 'warning',
        title: `Couldn't read your Steam unlocks for "${game.name}"`,
        message: 'Steam returned "Profile is not public" — your unlock list is hidden.',
        children: <PrivacyHelp openSteamPrivacy={() => window.kozo?.api?.shell?.openExternal(STEAM_PRIVACY_URL)} />,
      })
      return
    }

    if (!res?.ok) {
      setInfo({ variant: 'error', title: 'Achievement check failed', message: res?.error || 'Unknown error.' })
      return
    }

    // A schema of 0 with no unlocks means Steam has no achievements for this game
    // (common for unreleased / early-access titles) — say so instead of a vague
    // "up to date", which reads like something went wrong.
    if (!d.achievementCount && !d.playerUnlocksAdded && !d.crackUnlocksAdded) {
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
    if (diag && !diag.error) {
      lines.push(`Unlocks Steam reports for you: ${diag.steam_unlocks ?? 0}`)
      lines.push(`Stored in KoZo: ${diag.local_unlocked ?? 0} / ${diag.local_total ?? 0}`)
    }
    let variant = d.crackUnlocksAdded > 0 || d.playerUnlocksAdded > 0 ? 'success' : 'info'
    if (diag) {
      if (diag.error === 'no_stats_for_game') {
        lines.push('This game has no Steam achievements at all.')
      } else if (diag.error) {
        variant = 'error'
        lines.push(`Steam error: ${diag.error}`)
      } else if (diag.steam_unlocks > diag.local_unlocked) {
        lines.push('Steam still reports more unlocks than KoZo stored — its recent-unlock cache can lag a minute or two; check again shortly.')
      } else {
        if (variant === 'info') variant = 'success'
        lines.push('KoZo is up to date with Steam.')
      }
    }
    if (lines.length === 0) lines.push('Everything is already up to date.')
    setInfo({ variant, title: `Achievement check — "${game.name}"`, lines })
  }

  // "Check achievements" — scan crack files, then explain in plain language what
  // was found (emulator, appids, per-file unlock counts) and what to do about it.
  async function handleCrackFiles() {
    setCrackScanning(true)
    const [scanRes, diagRes] = await Promise.all([
      window.kozo?.api?.crack?.scanGame?.(Number(id)),
      window.kozo?.api?.crack?.diagnose?.(Number(id)),
    ])
    setCrackScanning(false)

    const scan = scanRes?.ok  ? scanRes.data  : {}
    const diag = diagRes?.ok  ? diagRes.data  : {}

    // Always reload — even with no new unlocks, the check may have just
    // imported the achievement LIST (keyless schema fetch) for the first time.
    await load()
    if (scan.added > 0) {
      const sources = [...new Set((scan.hits || []).map(h => h.source))]
      setCrackScanInfo({ added: scan.added, sources })
    }

    const lines = []
    if (diag.emulator)      lines.push(`Emulator detected: ${diag.emulator}`)
    if (diag.storedAppId)   lines.push(`AppID KoZo uses: ${diag.storedAppId}`)
    if (diag.configAppIds?.length && diag.mismatch) {
      lines.push(`⚠ AppID in the game's own config: ${diag.configAppIds.join(', ')}`)
    }
    if (diag.crackDir)      lines.push(`Save folder KoZo watches: ${diag.crackDir}`)
    for (const c of (diag.candidates || [])) {
      lines.push(`${c.source}: ${c.path} — ${c.parsedUnlockCount} unlock${c.parsedUnlockCount === 1 ? '' : 's'} readable`)
    }

    if (scan.added > 0) {
      setInfo({
        variant: 'success',
        title: `${scan.added} new achievement${scan.added === 1 ? '' : 's'} imported`,
        lines,
      })
      return
    }

    switch (diag.verdict) {
      case 'ok':
        setInfo({
          variant: 'info',
          title: 'Achievement files found — already up to date',
          lines,
        })
        break

      case 'emu-not-persisting': {
        const emu = diag.emulator || 'This crack\'s emulator'
        setInfo({
          variant: 'warning',
          title: 'Your crack never saves achievements to disk',
          message: `${emu} created its achievements file but has never written a single unlock to it — even though the game shows popups. KoZo can't read what the crack doesn't save. You can mark achievements manually (click any achievement below → "Mark as Unlocked"), or replace the emulator with Goldberg/GSE, which does save unlocks.`,
          lines,
        })
        break
      }

      case 'appid-mismatch': {
        const suggested = diag.configAppIds?.[0]
        setInfo({
          variant: 'warning',
          title: 'AppID mismatch — KoZo may be watching the wrong folder',
          message: `The game's own config says AppID ${diag.configAppIds.join(', ')}, but KoZo is using ${diag.storedAppId ?? 'none'}. Emulator save folders are named after the config AppID.`,
          lines,
          actions: suggested ? [
            {
              label: `Use AppID ${suggested} and rescan`,
              variant: 'primary',
              onClick: async () => {
                setInfo(null)
                await window.kozo?.api?.games?.update(Number(id), { manual_appid: Number(suggested) })
                await load()
                handleCrackFiles()
              },
            },
            { label: 'Close', variant: 'secondary', onClick: () => setInfo(null) },
          ] : undefined,
        })
        break
      }

      case 'no-schema':
        // Unlocks parse fine but there's no achievement list to match them to —
        // falling into "no files found" here would be actively misleading.
        setInfo({
          variant: 'warning',
          title: 'Unlocks found — but no achievement list to match them against',
          message: 'Your crack is saving unlocks, but KoZo couldn\'t fetch this game\'s achievement list from Steam yet. Check the AppID (Edit game), or add a Steam API key in Settings → Steam, then run this check again.',
          lines,
        })
        break

      case 'crack-no-ach-config':
        // Goldberg without steam_settings\achievements.json never tracks a
        // single unlock — and KoZo can repair that in one click.
        setInfo({
          variant: 'warning',
          title: 'This crack has achievements disabled',
          message: 'The Goldberg emulator in this crack ships without an achievements list (steam_settings\\achievements.json is missing), so the game never tracks or saves ANY unlock — no matter how long you play. KoZo can write the list into the crack so tracking starts working. Unlocks from earlier sessions can\'t be recovered (the emulator never recorded them) — mark those manually below.',
          lines,
          actions: [
            {
              label: 'Enable achievement tracking',
              variant: 'primary',
              onClick: async () => {
                setInfo(null)
                const r = await window.kozo?.api?.crack?.enableAchievements?.(Number(id))
                if (r?.ok && r.data?.ok) {
                  setInfo({
                    variant: 'success',
                    title: `Achievement tracking enabled (${r.data.count} achievements)`,
                    message: 'Restart the game — from the next launch the crack will save every unlock, and KoZo will show it instantly.',
                  })
                } else {
                  const reason = r?.data?.reason
                  setInfo({
                    variant: 'error',
                    title: 'Could not enable tracking',
                    message: r?.data?.error || r?.error ||
                      (reason === 'no_schema'   ? 'KoZo couldn\'t fetch this game\'s achievement list from Steam to write into the crack.'
                     : reason === 'no_goldberg' ? 'Couldn\'t find the emulator\'s folder inside the game\'s install path.'
                     : 'Unknown error.'),
                  })
                }
              },
            },
            { label: 'Close', variant: 'secondary', onClick: () => setInfo(null) },
          ],
        })
        break

      case 'gfwl':
        setInfo({
          variant: 'warning',
          title: 'This is the Games for Windows LIVE version',
          message: 'KoZo found xlive.dll in the install folder — this build predates Steam achievements entirely (its achievements lived in the long-dead GFWL service), so NO tool can read unlocks from it. To get automatic tracking you\'d need the Complete Edition build with a Steam emulator. The achievement list is loaded. While you play, KoZo also watches the screen for the game\'s own unlock popups (OCR) and marks a match automatically — anything it misses you can click below.',
          lines,
        })
        break

      case 'no-emulator':
        setInfo({
          variant: 'warning',
          title: 'No Steam emulator found in this crack',
          message: 'KoZo checked the install folder (configs AND dlls) and found no Steam emulator at all — so this crack doesn\'t produce unlock files anywhere (some, like this one, use their own launcher\'s stats system instead of Steam). The achievement list is loaded. While you play, KoZo watches the screen for the game\'s own unlock popups (OCR) and marks a match automatically — anything it misses you can click below. If the game DOES show achievement popups in-game, play a bit and run this check again — the deep scan will catch any file the crack writes under this game\'s AppID.',
          lines,
        })
        break

      default:   // 'no-files'
        setInfo({
          variant: 'warning',
          title: 'No crack achievement files found yet',
          message: diag.installPath
            ? 'Most emulators create their achievements file only after your first unlock in-game. KoZo also deep-scanned every save folder on this PC for this game\'s AppID and found nothing yet. Play a bit, unlock something, then check again. If the game shows popups but nothing ever appears here, the crack may not save unlocks at all — you can always mark achievements manually (click one below).'
            : 'No install path set. Edit the game → Browse to the .exe — the install path is needed to detect the crack\'s emulator and its save files.',
          lines,
        })
    }
  }

  // One-click manual unlock toggle on an achievement row (checkmark/lock icon).
  // Routes through toggleManual so unlocking fires the toast/notification/XP flow.
  async function quickToggleAch(ach) {
    const res = await window.kozo?.api?.achievements?.toggleManual?.(ach.id)
    if (!res?.ok) return
    setAch(prev => prev.map(a => a.id === ach.id
      ? { ...a,
          unlocked_at: res.data.unlocked ? res.data.unlocked_at : null,
          unlock_source: res.data.unlocked ? 'manual' : null }
      : a))
  }

  async function handleOpenFolder() {
    setMenuOpen(false)
    const res = await window.kozo?.api?.shell?.openPath(game.install_path)
    if (!res?.ok) {
      setInfo({
        variant: 'error', title: 'Could not open folder',
        message: res?.error || `Windows couldn't open "${game.install_path}" — the folder may have been moved or deleted.`,
      })
    }
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

          {/* Status picker — Playing / Finished / Dropped / On hold, synced with the Game List */}
          <div className={s.statusWrap} ref={statusMenuRef}>
            {(() => {
              const st = STATUS_META[game.completion_status]
              return (
                <button
                  onClick={() => setStatusMenuOpen(v => !v)}
                  title={st ? `Status: ${st.label} — click to change` : 'Set a status for this game (finishing earns XP)'}
                  className={`${s.bannerSyncBtn} ${game.completion_status === 'finished' ? s.bannerFinishedBtn : ''}`}
                  style={st && game.completion_status !== 'finished' ? { color: st.color, borderColor: st.color + '55' } : undefined}
                >
                  {st ? <st.Icon size={14} /> : <IconCircleCheck size={14} />}
                  {st ? st.label : 'Set status'}
                  <IconChevronDown size={12} stroke={2} />
                </button>
              )
            })()}
            {statusMenuOpen && (
              <div className={s.statusDropdown}>
                {Object.entries(STATUS_META).map(([key, st]) => (
                  <button
                    key={key}
                    className={s.gameMenuItem}
                    onClick={() => setStatus(game.completion_status === key ? null : key)}
                  >
                    <st.Icon size={14} style={{ color: st.color }} />
                    {st.label}
                    {game.completion_status === key && <IconCheck size={13} stroke={2} style={{ marginLeft: 'auto' }} />}
                  </button>
                ))}
                {game.completion_status && (
                  <button className={s.gameMenuItem} onClick={() => setStatus(null)}>
                    <IconCircleOff size={14} />
                    Clear status
                  </button>
                )}
              </div>
            )}
          </div>
          {/* Achievements sync automatically (on open + live during sessions);
              a subtle spinner appears while a background sync is running.
              Manual sync/diagnose now live in the ⋯ menu for the rare case. */}
          {(refreshing || crackScanning || importing) && (
            <span className={s.bannerSyncing} title="Syncing achievements…">
              <IconRefresh size={13} style={{ animation: 'spin 1s linear infinite' }} />
            </span>
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

              {/* ONE combined check — syncs for new unlocks AND shows the
                  diagnostic report, via the right pipeline for the game type
                  (crack files vs Steam). */}
              {(steamTracked || !!game.is_cracked) && (
                <button
                  className={s.gameMenuItem}
                  onClick={() => { setMenuOpen(false); (game.is_cracked ? handleCrackFiles : handleSteamCheck)() }}
                  disabled={crackScanning || refreshing}
                >
                  <IconStethoscope size={14} stroke={1.6} />
                  {(crackScanning || refreshing) ? 'Checking…' : 'Check achievements'}
                </button>
              )}

              <button className={s.gameMenuItem} onClick={() => { setMenuOpen(false); setShowSaveManager(true) }}>
                <IconDeviceFloppy size={14} stroke={1.6} />
                Save files &amp; backup
              </button>

              {!!game.install_path && (
                <button className={s.gameMenuItem} onClick={handleOpenFolder}>
                  <IconFolderOpen size={14} stroke={1.6} />
                  Open game folder
                </button>
              )}

              <button className={s.gameMenuItem} onClick={toggleHidden}
                title="Hidden games leave the Library grid but keep tracking time, achievements and XP">
                {game.is_hidden ? <IconEye size={14} stroke={1.6} /> : <IconEyeOff size={14} stroke={1.6} />}
                {game.is_hidden ? 'Unhide from library' : 'Hide from library'}
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
          {(() => {
            let genres = []
            try { genres = JSON.parse(game.genres || '[]') } catch {}
            if (!genres.length) return null
            return (
              <div className={s.genreChips}>
                {genres.slice(0, 5).map(g => (
                  <span key={g} className={s.genreChip}>{g}</span>
                ))}
              </div>
            )
          })()}
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

      {/* Notes — mods installed, save locations, where you left off.
          Collapsible + height-capped so it can never bury the achievements. */}
      <div className={s.notesCard}>
        <button className={s.notesHeader} onClick={() => setNotesOpen(v => !v)}>
          {notesOpen ? <IconChevronDown size={13} stroke={1.8} /> : <IconChevronRight size={13} stroke={1.8} />}
          <IconEdit size={13} stroke={1.6} />
          Notes
          {!notesOpen && (
            <span className={s.notesPreview}>
              {notes ? notes.split('\n')[0] : 'Add notes…'}
            </span>
          )}
          {notesSaved && <span className={s.notesSaved}>Saved</span>}
        </button>
        {notesOpen && (
          <textarea
            className={s.notesTextarea}
            value={notes}
            onChange={e => handleNotesChange(e.target.value)}
            placeholder="Mods installed, save locations, where you left off…"
            rows={3}
            spellCheck={false}
          />
        )}
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
            {syncPrivacyError && (
              <div className={s.privacyBanner}>
                <IconAlertTriangle size={14} stroke={1.8} />
                {syncPrivacyError === 'profile_not_found'
                  ? 'Your Steam profile could not be read — check the Steam ID in Settings → Steam.'
                  : 'Your Steam profile\'s Game details are private, so KoZo can\'t read your unlocks. Set Steam Privacy → Game details to Public, or add an API key in Settings → Steam.'}
              </div>
            )}
            {total === 0 ? (
              <div className={s.emptyState}>
                {game.is_cracked
                  ? 'No achievements found yet — they appear here once you unlock them in-game.'
                  : steamTracked
                    ? 'No achievements found. Try "Check achievements" in the ⋮ menu.'
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
                    onQuickToggle={quickToggleAch}
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
