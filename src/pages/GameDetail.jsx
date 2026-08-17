import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  IconChevronLeft, IconTrophy, IconLock, IconCheck, IconHistory,
  IconDotsVertical, IconTrash, IconRefresh, IconEdit, IconPlayerPlayFilled,
  IconStethoscope, IconFolderOpen, IconDeviceFloppy, IconDownload,
  IconCircleCheck, IconCircleOff, IconEye, IconEyeOff, IconChevronDown,
  IconChevronRight, IconAlertTriangle, IconDeviceGamepad2,
} from '@tabler/icons-react'
import { getBannerBg, getBannerIcon, formatPlaytime, formatDate, formatDateTime, fileUrl, isSteamTracked, launcherLabel, localDayKey } from '../lib/utils'
import { STATUS_META } from '../components/GameCard'
import AchievementModal from '../components/modals/AchievementModal'
import EditGameModal from '../components/modals/EditGameModal'
import SaveManagerModal from '../components/modals/SaveManagerModal'
import InfoModal, { PrivacyHelp } from '../components/ui/InfoModal'
import EmptyState from '../components/ui/EmptyState'
import { HeroSkeleton, PanelSkeleton } from '../components/ui/Skeleton'
import s from './GameDetail.module.css'

const STEAM_PRIVACY_URL = 'https://steamcommunity.com/my/edit/settings'

// toggleManual doesn't return the new unlock row's id, and only its presence
// decides "unlocked" — the real id arrives with the reload its game:updated
// broadcast triggers. Mirrors the sentinel AchievementModal patches with.
const OPTIMISTIC_UNLOCK_ID = -1

// ── 7-day chart helpers ────────────────────────────────────────────────────
function buildWeekData(sessions) {
  const days = []
  const today = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    // Local day buckets — the labels below say "Today"/"Yest" in local terms and
    // started_at is UTC, so a prefix match would credit late-night play to the
    // previous bar.
    const dayStr = localDayKey(d)
    const secs = sessions
      .filter(s => localDayKey(s.started_at) === dayStr)
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
          <div
            key={i}
            className={`${s.chartBar} ${d.isToday ? s.chartBarToday : ''} ${d.seconds === 0 ? s.chartBarZero : ''}`}
          >
            <div
              className={s.chartBarFill}
              style={{ height: `${Math.max((d.seconds / maxSec) * 52, d.seconds > 0 ? 4 : 2)}px` }}
              title={`${d.label} — ${formatPlaytime(d.seconds)}`}
            />
            <div className={s.chartBarLabel}>{d.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function isUnlocked(ach) {
  return ach?.unlock_id != null || ach?.unlocked_at != null
}

// ── Achievement card ───────────────────────────────────────────────────────
// One compact line per achievement. The description used to render on every
// tile, which turned a 50-achievement game into a wall of text — it now lives
// in the row's tooltip, where it is there when you want it and silent when you
// don't.
function AchCard({ ach, onClick, onQuickToggle }) {
  // unlock_id is the row's existence; unlocked_at can legitimately be NULL when
  // Steam reported no date (unlocktime 0). The unlocked_at half stays as a
  // safety net for any patch that forgets the id.
  const unlocked = isUnlocked(ach)
  const hint = ach.description || (unlocked ? '' : 'Hidden achievement')

  // Rarity tint for the unlocked icon's ring — same tier cuts as rarityLabel()
  // (lib/utils.js) and the modal's badge, on the fixed --rarity-* tokens that
  // never follow the accent. No global % → the CSS falls back to the accent
  // via var(--rar, var(--a)).
  const gp = ach.global_unlock_percent
  const rarityColor = gp == null ? null
    : gp < 5  ? 'var(--rarity-ultra)'
    : gp < 15 ? 'var(--rarity-very)'
    : gp < 30 ? 'var(--rarity-rare)'
    : gp < 50 ? 'var(--rarity-uncommon)'
    :           'var(--rarity-common)'

  return (
    <div
      className={`${s.achCard} ${unlocked ? '' : s.achCardLocked}`}
      onClick={() => onClick(ach)}
    >
      <div
        className={`${s.achIcon} ${unlocked ? s.achIconUnlocked : s.achIconLocked}`}
        style={unlocked && rarityColor ? { '--rar': rarityColor } : undefined}
      >
        {ach.icon_url
          ? <img src={ach.icon_url} alt="" loading="lazy" decoding="async" />
          : <IconTrophy size={20} stroke={1.4} />
        }
      </div>

      <div className={s.achBody}>
        <div className={s.achName}>{ach.display_name}</div>
        {hint && <div className={s.achDesc}>{hint}</div>}
        {unlocked && (
          <div className={s.achDate}>
            {ach.unlocked_at ? formatDate(ach.unlocked_at) : 'No date'}
          </div>
        )}
      </div>

      <button
        className={`${s.achStatus} ${unlocked ? s.achStatusOn : ''}`}
        title={unlocked ? 'Mark as locked' : 'Mark as unlocked (manual)'}
        onClick={(e) => { e.stopPropagation(); onQuickToggle?.(ach) }}
      >
        {unlocked
          ? <IconCheck size={14} stroke={2.5} />
          : <IconLock  size={13} stroke={1.6} />
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
      <div className={s.sessionDate} title={formatDateTime(session.started_at)}>
        {formatDate(session.started_at)}
      </div>
      <div className={s.sessionTime}>
        {new Date(session.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className={s.sessionDurBar} title={formatPlaytime(session.duration_seconds)}>
        <div className={s.sessionDurFill} style={{ width: `${widthPct}%` }} />
      </div>
      <div className={s.sessionDuration}>{formatPlaytime(session.duration_seconds)}</div>
      {session.achievements_unlocked > 0 && (
        <div className={s.sessionAchs} title={`${session.achievements_unlocked} achievements unlocked this session`}>
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

  // Notes were removed from this page at the user's request. The
  // DB column and games:update path still accept `notes`, so nothing is lost
  // if the surface ever comes back.

  // Per-game reset. The route has no key, so /game/A → /game/B (the tray's
  // now-playing item does exactly that) reuses this instance with only `id`
  // changing — reset per-game state so game A never renders under game B's URL.
  useEffect(() => {
    setLoading(true)
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
    if (gRes?.ok) setGame(gRes.data)
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
    // Unsubscribe THIS page's own listeners only — removeAll() is window-wide
    // and would tear down the always-mounted Sidebar's listeners too.
    const offs = [
      window.kozo.events.onSessionStarted(() => load()),
      window.kozo.events.onSessionEnded(()   => load()),
      // Reload when an achievement syncs in (live, during a session) so the page
      // catches new unlocks without a manual refresh.
      window.kozo.events.onGameUpdated(() => load()),
      window.kozo.events.onAchievementUnlocked(() => load()),
    ]
    return () => { for (const off of offs) off?.() }
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

  // Hero art source ladder: cached local hero → Steam's CDN hero → the generated
  // placeholder icon. Held in state rather than by mutating the <img> element,
  // because the blurred-fill pair means TWO elements share one source.
  const bust = imgBust || undefined
  const heroCdnUrl = game?.steam_app_id
    ? `https://cdn.akamai.steamstatic.com/steam/apps/${game.steam_app_id}/library_hero.jpg`
    : null
  const heroPrimary = !game ? null
    : game.hero_local_path ? fileUrl(game.hero_local_path, bust)
    : (heroCdnUrl ?? fileUrl(game.banner_local_path, bust))
  const [heroStage, setHeroStage] = useState(0)
  useEffect(() => { setHeroStage(0) }, [heroPrimary])
  const heroUrl = heroStage === 0 ? heroPrimary : heroStage === 1 ? heroCdnUrl : null
  function handleHeroError() {
    setHeroStage(st => (st === 0 && heroCdnUrl && heroPrimary !== heroCdnUrl) ? 1 : 2)
  }

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
    } else if (res?.data?.warning) {
      setInfo({ variant: 'warning', title: game?.name || 'Launched', message: res.data.warning })
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
      lines.push(`AppID in the game's own config: ${diag.configAppIds.join(', ')}`)
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

      case 'unreadable-format': {
        const emu = diag.emulator || 'This crack\'s emulator'
        setInfo({
          variant: 'warning',
          title: 'KoZo can\'t read this crack\'s achievement file yet',
          message: `${emu} IS saving to its achievements file — it's been modified since it was created — but in a layout KoZo's parser doesn't recognize. This isn't "never saves to disk"; it's a format gap on KoZo's end. You can mark achievements manually below for now while this gets sorted out.`,
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
          message: 'KoZo found xlive.dll in the install folder — this build predates Steam achievements entirely (its achievements lived in the long-dead GFWL service), so NO tool can read unlocks from it. To get automatic tracking you\'d need the Complete Edition build with a Steam emulator. The achievement list is loaded, but there is no automatic unlock source for this build — mark achievements manually by clicking one below.',
          lines,
        })
        break

      case 'no-emulator':
        setInfo({
          variant: 'warning',
          title: 'No Steam emulator found in this crack',
          message: 'KoZo checked the install folder (configs AND dlls) and found no Steam emulator at all — so this crack doesn\'t produce unlock files anywhere (some, like this one, use their own launcher\'s stats system instead of Steam). The achievement list is loaded, but there is no automatic unlock source for this build — mark achievements manually by clicking one below. If the game DOES show achievement popups in-game, play a bit and run this check again — the deep scan will catch any file the crack writes under this game\'s AppID.',
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
          unlock_id: res.data.unlocked ? (a.unlock_id ?? OPTIMISTIC_UNLOCK_ID) : null,
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

  // A ghost hero + panel, not a bare "Loading…": the real layout lands without a
  // reflow, and the page never reads as empty while the four queries resolve.
  if (loading) {
    return (
      <div className={s.page}>
        <HeroSkeleton height={240} />
        <div className={s.content}>
          <div className={s.contentInner}>
            <PanelSkeleton lines={6} />
          </div>
        </div>
      </div>
    )
  }

  if (!game) {
    return (
      <div className={s.page}>
        <div className={s.content}>
          <div className={s.contentInner}>
            <EmptyState
              Icon={IconDeviceGamepad2}
              title="Game not found"
              desc="This game is no longer in your library — it may have been removed."
              action={{ label: 'Back to Library', Icon: IconChevronLeft, onClick: () => navigate('/') }}
            />
          </div>
        </div>
      </div>
    )
  }

  const Icon         = getBannerIcon(game.name)
  const bannerBg     = getBannerBg(game.id)
  // Steam achievement UI only for games genuinely tracked via the Steam API — a
  // foreign-launcher game (Xbox/Epic/GOG…) never shows Steam sync, even if it
  // happens to carry a stray steam_app_id.
  const steamTracked = isSteamTracked(game)
  const unlocked     = achievements.filter(isUnlocked).length
  const total        = achievements.length
  const pct          = total > 0 ? Math.round((unlocked / total) * 100) : 0
  const maxDuration  = Math.max(...sessions.map(s => s.duration_seconds || 0), 1)
  const status       = STATUS_META[game.completion_status]

  return (
    <div className={s.page}>
      {/* One scroller wraps hero + tabs + panels: the hero is a sticky
          collapsing header (big at rest, pins to a compact strip on scroll)
          and the tabs pin right beneath it. */}
      <div className={s.scroll}>
      {/* ── Hero ── */}
      <div className={s.hero}>
        {/* Only the ART layer clips; the hero itself stays overflow: visible so
            the dropdowns below can extend past it. */}
        <div className={s.heroArt} style={{ background: bannerBg }}>
          <Icon size={72} stroke={1} className={s.heroIcon} />
          {heroUrl && (
            <React.Fragment key={heroUrl}>
              <img
                src={heroUrl} className={s.heroBlur} alt="" aria-hidden="true"
                decoding="async" onError={handleHeroError}
              />
              <img
                src={heroUrl} className={s.heroImg} alt=""
                decoding="async" onError={handleHeroError}
              />
            </React.Fragment>
          )}
          <div className={s.heroScrim} />
        </div>

        <div className={s.heroTop}>
          <button className={s.backBtn} onClick={() => navigate('/')} title="Back to Library">
            <IconChevronLeft size={15} stroke={2} />
            Library
          </button>

          <div className={s.heroActions}>
            {!!game.is_installed && !isLive && (
              <button onClick={handleLaunch} title={`Launch ${game.name}`} className={s.playBtn}>
                <IconPlayerPlayFilled size={13} />
                Play
              </button>
            )}

            {/* Status picker — Playing / Finished / Dropped / On hold, synced with the Game List */}
            <div className={s.statusWrap} ref={statusMenuRef}>
              <button
                onClick={() => setStatusMenuOpen(v => !v)}
                title={status ? `Status: ${status.label} — click to change` : 'Set a status for this game (finishing earns XP)'}
                className={`${s.statusBtn} ${
                  game.completion_status === 'finished' ? s.statusBtnFinished : status ? s.statusBtnSet : ''
                }`}
                style={status ? { '--st': status.color } : undefined}
              >
                {status ? <status.Icon size={14} /> : <IconCircleCheck size={14} />}
                {status ? status.label : 'Set status'}
                <IconChevronDown size={12} stroke={2} />
              </button>

              {statusMenuOpen && (
                <div className={s.statusDropdown}>
                  {Object.entries(STATUS_META).map(([key, st]) => (
                    <button
                      key={key}
                      className={s.menuItem}
                      onClick={() => setStatus(game.completion_status === key ? null : key)}
                    >
                      <st.Icon size={14} style={{ color: st.color }} />
                      {st.label}
                      {game.completion_status === key && <IconCheck size={13} stroke={2} style={{ marginLeft: 'auto' }} />}
                    </button>
                  ))}
                  {game.completion_status && (
                    <button className={s.menuItem} onClick={() => setStatus(null)}>
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
              <span className={s.heroSyncing} title="Syncing achievements…">
                <IconRefresh size={13} className="spin" />
              </span>
            )}
          </div>

          <div className={s.heroTopSpacer} />

          {isLive && (
            <div className={s.liveBadge} title="A session is running right now">
              <span className={s.liveDot} />
              LIVE
            </div>
          )}

          {/* Game options menu */}
          <div className={s.gameMenu} ref={menuRef}>
            <button
              className={s.menuTrigger}
              onClick={() => { setMenuOpen(v => !v); setConfirmDelete(false) }}
              title="Game options"
            >
              <IconDotsVertical size={16} stroke={1.8} />
            </button>

            {menuOpen && (
              <div className={s.menuDropdown}>
                <button
                  className={s.menuItem}
                  onClick={() => { setShowEdit(true); setMenuOpen(false) }}
                >
                  <IconEdit size={14} stroke={1.6} />
                  Edit game
                </button>

                {/* Auto-import achievement list — for launchers KoZo can't auto-track */}
                {!steamTracked && !game.is_cracked && (
                  <button
                    className={`${s.menuItem} ${importing ? s.menuItemBusy : ''}`}
                    onClick={handleAutoImport}
                    aria-busy={importing || undefined}
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
                    className={`${s.menuItem} ${(crackScanning || refreshing) ? s.menuItemBusy : ''}`}
                    onClick={() => { setMenuOpen(false); (game.is_cracked ? handleCrackFiles : handleSteamCheck)() }}
                    aria-busy={(crackScanning || refreshing) || undefined}
                  >
                    <IconStethoscope size={14} stroke={1.6} />
                    {(crackScanning || refreshing) ? 'Checking…' : 'Check achievements'}
                  </button>
                )}

                <button className={s.menuItem} onClick={() => { setMenuOpen(false); setShowSaveManager(true) }}>
                  <IconDeviceFloppy size={14} stroke={1.6} />
                  Save files &amp; backup
                </button>

                {!!game.install_path && (
                  <button className={s.menuItem} onClick={handleOpenFolder}>
                    <IconFolderOpen size={14} stroke={1.6} />
                    Open game folder
                  </button>
                )}

                <button className={s.menuItem} onClick={toggleHidden}
                  title="Hidden games leave the Library grid but keep tracking time, achievements and XP">
                  {game.is_hidden ? <IconEye size={14} stroke={1.6} /> : <IconEyeOff size={14} stroke={1.6} />}
                  {game.is_hidden ? 'Unhide from library' : 'Hide from library'}
                </button>

                {!confirmDelete ? (
                  <button
                    className={`${s.menuItem} ${s.menuItemDanger}`}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <IconTrash size={14} stroke={1.6} />
                    Remove from Library
                  </button>
                ) : (
                  <div className={s.menuConfirm}>
                    <div className={s.menuConfirmText}>
                      Remove "{game.name}"? All sessions and achievements will be deleted.
                    </div>
                    <div className={s.menuConfirmBtns}>
                      <button className={s.menuCancelBtn} onClick={() => setConfirmDelete(false)}>Cancel</button>
                      <button
                        className={`${s.menuDeleteBtn} ${deleting ? s.menuItemBusy : ''}`}
                        onClick={handleDelete}
                        aria-busy={deleting || undefined}
                      >
                        {deleting ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={s.heroBottom}>
          <div className={s.gameNameRow}>
            <div className={s.gameName} title={game.name}>{game.name}</div>
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
                  <span key={g} className={s.genreChip} title={g}>{g}</span>
                ))}
              </div>
            )
          })()}

          <div className={s.heroMeta}>
            <div className={s.metaItem}>
              <span>Playtime</span>
              <span className={s.metaValue}>{formatPlaytime(game.total_playtime_seconds)}</span>
            </div>
            {total > 0 && (
              <div className={s.achProgress}>
                <span className={s.metaItem}>
                  <IconTrophy size={12} stroke={1.5} />
                  <span className={s.metaValue}>{unlocked}/{total}</span>
                  <span className={s.metaPct}>({pct}%)</span>
                </span>
                <div
                  className={s.progressBar}
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Achievements unlocked"
                  title={`${unlocked} of ${total} achievements unlocked`}
                >
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
        <div className={s.contentInner}>
          {tab === 'achievements' && (
            <>
              {syncPrivacyError && (
                <div className={s.privacyBanner}>
                  <IconAlertTriangle size={15} stroke={1.8} className={s.privacyIcon} />
                  <div>
                    {syncPrivacyError === 'profile_not_found'
                      ? 'Your Steam profile could not be read — check the Steam ID in Settings → Steam.'
                      : 'Steam won\'t return unlocks for this game over the web — usually because it isn\'t owned on your Steam account (Steam reports that as "profile is not public" either way), or because your profile\'s Game details are private. KoZo still reads unlocks from the Steam app on this PC, so this only costs you Steam\'s unlock dates.'}
                  </div>
                </div>
              )}

              {total === 0 ? (
                game.is_cracked ? (
                  <EmptyState
                    Icon={IconTrophy}
                    title="No achievements yet"
                    desc="They appear here as soon as the crack writes your first unlock to disk."
                  />
                ) : steamTracked ? (
                  <EmptyState
                    Icon={IconTrophy}
                    title="No achievements found"
                    desc={'Run "Check achievements" from the ⋮ menu to pull this game\'s list from Steam.'}
                  />
                ) : (
                  <EmptyState
                    Icon={IconTrophy}
                    title="No achievements imported"
                    desc={`${launcherLabel(game.source)} unlocks can't be read automatically — but KoZo can pull the achievement list from Steam so you can tick off the ones you've earned.`}
                    action={{
                      label: importing ? 'Importing…' : 'Import achievements from Steam',
                      Icon: IconDownload,
                      onClick: handleAutoImport,
                    }}
                  />
                )
              ) : (
                // Split rather than one long mixed list: what you have earned and
                // what is left are two different questions, and answering both in
                // one 50-row grid is what made this page unreadable.
                (() => {
                  const unlockedAchs = achievements.filter(isUnlocked)
                  const lockedAchs   = achievements.filter(a => !isUnlocked(a))
                  const section = (label, list) => list.length > 0 && (
                    <div className={s.achSection}>
                      <div className={s.achSectionHead}>
                        {label}<span className={s.achSectionCount}>{list.length}</span>
                      </div>
                      <div className={s.achGrid}>
                        {list.map(a => (
                          <AchCard
                            key={a.id}
                            ach={a}
                            onClick={setSelectedAch}
                            onQuickToggle={quickToggleAch}
                          />
                        ))}
                      </div>
                    </div>
                  )
                  return (
                    <>
                      {section('Unlocked', unlockedAchs)}
                      {section('Locked', lockedAchs)}
                    </>
                  )
                })()
              )}
            </>
          )}

          {tab === 'sessions' && (
            sessions.length === 0 ? (
              <EmptyState
                Icon={IconHistory}
                title="No sessions recorded"
                desc="KoZo logs one automatically the next time you play this game."
              />
            ) : (
              <>
                <WeekChart sessions={sessions} />
                <div className={s.sessionList}>
                  {sessions.map(session => (
                    <SessionRow key={session.id} session={session} maxDuration={maxDuration} />
                  ))}
                </div>
              </>
            )
          )}
        </div>
      </div>
      </div>

      {selectedAch && (
        <AchievementModal
          achievement={selectedAch}
          game={game}
          onClose={() => setSelectedAch(null)}
          onToggle={(updated) => {
            // The modal already patches unlock_id (the truth) and unlocked_at
            // (display-only, legitimately null) — take its row as-is so the two
            // surfaces can't disagree about what's unlocked.
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
