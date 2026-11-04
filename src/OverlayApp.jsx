import React, { useState, useEffect, useRef } from 'react'
import { IconTrophy, IconPlayerPlay, IconX, IconClock, IconDeviceGamepad2, IconSparkles, IconArrowBigUpLines, IconPlus, IconCalendarEvent } from '@tabler/icons-react'
import { applyAccent } from './context/AccentColorContext'
import { fileUrl } from './lib/utils'
import { playAchievement, playLevelUp, playSessionStart, holdAudio, releaseAudio } from './lib/sounds'
import s from './OverlayApp.module.css'

// Cover-art thumb for session toasts — local cached banner first, CDN fallback,
// hidden entirely when neither loads (returns null so the icon shows instead).
// `className` lets each toast type add its glow (achGlow / liveGlow / levelGlow).
function ToastArt({ artPath, artUrl, className }) {
  const [stage, setStage] = useState(artPath ? 'local' : (artUrl ? 'remote' : 'none'))
  if (stage === 'none') return null
  const src = stage === 'local' ? fileUrl(artPath) : artUrl
  return (
    <img
      className={`${s.toastArt} ${className || ''}`}
      src={src}
      alt=""
      onError={() => setStage(stage === 'local' && artUrl ? 'remote' : 'none')}
    />
  )
}

const DISPLAY_MS = 6000

// Compact session-time formatter for the hotkey flash: "1h 23m" / "23m 04s" / "45s".
function flashTime(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${String(ss).padStart(2, '0')}s`
  return `${ss}s`
}

// Toggle whether the overlay window captures clicks. Called on toast hover so the
// game underneath stays clickable everywhere except over a toast.
const setInteractive = (v) => { try { window.kozo?.api?.overlay?.setInteractive?.(v) } catch {} }

// Window-level click capture is ONE flag shared by every toast, so releases
// must be ownership-aware: which toast (by a private per-mount id) the cursor
// is currently over. Without this, a background toast's auto-close dropped the
// capture while the cursor sat on ANOTHER live toast — the next click fell
// straight through into the game.
let hoverSeq = 0
let hoveredToastId = null

// Shared dismiss-with-animation: plays the slide-out, then removes the toast.
// `auto` runs it on a timer; the returned `close` lets the user trigger it early
// (click anywhere on the toast or the X). Clears the auto timer so it fires once.
function useAutoClose(onDismiss, ms) {
  const [leaving, setLeaving] = useState(false)
  const timerRef = useRef(null)
  const goneRef  = useRef(false)
  const idRef    = useRef(0)
  if (!idRef.current) idRef.current = ++hoverSeq

  const close = () => {
    if (goneRef.current) return
    goneRef.current = true
    clearTimeout(timerRef.current)
    setLeaving(true)
    // Hand clicks back to the game — unless a DIFFERENT toast is hovered
    // right now, in which case the capture is that toast's to release.
    if (hoveredToastId == null || hoveredToastId === idRef.current) {
      hoveredToastId = null
      setInteractive(false)
    }
    setTimeout(onDismiss, 300)
  }

  useEffect(() => {
    timerRef.current = setTimeout(close, ms)
    return () => {
      clearTimeout(timerRef.current)
      // Unmounted while hovered (capToasts can evict a hovered toast with no
      // mouseleave ever firing) — release the capture ourselves or the window
      // stays click-swallowing until some later toast closes.
      if (hoveredToastId === idRef.current) {
        hoveredToastId = null
        setInteractive(false)
      }
    }
  }, [])

  return { leaving, close, hoverId: idRef.current }
}

// Props shared by every toast so hovering captures the mouse and the card is
// fully click-to-dismiss, with a hover-revealed X for an explicit close.
// `leaving` gates the capture: a toast re-hovered DURING its 300ms slide-out
// must not re-take the mouse — close() has already handed clicks back to the
// game, and with the window staying visible between in-session toasts a stale
// capture would be an invisible click-swallowing rectangle over the game.
function toastInteractions(close, leaving = false, hoverId = null) {
  return {
    onMouseEnter: () => { if (!leaving) { hoveredToastId = hoverId; setInteractive(true) } },
    onMouseLeave: () => {
      if (hoveredToastId === hoverId) hoveredToastId = null
      setInteractive(false)
    },
    onClick: close,
  }
}

function CloseButton({ close }) {
  return (
    <button className={s.closeBtn} title="Dismiss"
      onClick={(e) => { e.stopPropagation(); close() }}>
      <IconX size={12} stroke={2.2} />
    </button>
  )
}

// ── Session-start toast ───────────────────────────────────────────────────────

function SessionToast({ toast, onDismiss }) {
  const { leaving, close, hoverId } = useAutoClose(onDismiss, 4000)
  return (
    <div className={`${s.toast} ${s.sessionToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close, leaving, hoverId)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <span className={s.liveDot} />
        <span className={s.toastHeaderText}>Now Playing</span>
      </div>
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} className={s.liveGlow} />
        ) : (
          <div className={`${s.toastIcon} ${s.sessionIcon}`}>
            <IconPlayerPlay size={22} stroke={1.5} style={{ color: 'var(--a, #a78bfa)' }} />
          </div>
        )}
        <div className={s.toastInfo}>
          <div className={s.toastName}>{toast.gameName}</div>
          <div className={s.toastDesc}>Session started. Tracking playtime</div>
        </div>
      </div>
    </div>
  )
}

// ── Status flash toast (global hotkey) ────────────────────────────────────────

function StatusToast({ toast, onDismiss }) {
  const { leaving, close, hoverId } = useAutoClose(onDismiss, 5000)
  const { gameName, elapsedSec, unlocked, total, idle } = toast
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0
  return (
    <div className={`${s.toast} ${s.statusToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close, leaving, hoverId)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconClock size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>{idle ? 'KoZo' : 'Session'}</span>
      </div>
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} className={s.liveGlow} />
        ) : (
          <div className={`${s.toastIcon} ${s.sessionIcon}`}>
            <IconDeviceGamepad2 size={22} stroke={1.5} style={{ color: 'var(--a)' }} />
          </div>
        )}
        <div className={s.toastInfo}>
          <div className={s.toastName}>{gameName}</div>
          {idle ? (
            <div className={s.toastDesc}>No game is being tracked right now</div>
          ) : (
            <>
              <div className={s.statusTime}>{flashTime(elapsedSec)}<span className={s.statusTimeLabel}>this session</span></div>
              {total > 0 && (
                <div className={s.statusAchRow}>
                  <div className={s.statusAchBar}><div className={s.statusAchFill} style={{ width: `${pct}%` }} /></div>
                  <span className={s.statusAchText}>{unlocked}/{total}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Level-up toast ────────────────────────────────────────────────────────────

function LevelUpToast({ toast, onDismiss }) {
  const { leaving, close, hoverId } = useAutoClose(onDismiss, 7000)
  const { level, tier, totalXp } = toast
  return (
    <div className={`${s.toast} ${s.levelUpToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close, leaving, hoverId)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconArrowBigUpLines size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>Level Up!</span>
      </div>
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} className={s.levelGlow} />
        ) : (
          <div className={`${s.toastIcon} ${s.levelUpIcon}`}>
            <span className={s.levelUpNumber}>{level}</span>
          </div>
        )}
        <div className={s.toastInfo}>
          <div className={s.toastName}>Level {level} · {tier}</div>
          <div className={s.toastDesc}>{totalXp?.toLocaleString?.() ?? totalXp} XP total. Keep it up!</div>
        </div>
      </div>
    </div>
  )
}

// ── Session-end XP summary toast ──────────────────────────────────────────────

function SessionEndToast({ toast, onDismiss }) {
  const { leaving, close, hoverId } = useAutoClose(onDismiss, 6000)
  const { gameName, durationSeconds, gainedXp, toNextLevel } = toast
  return (
    <div className={`${s.toast} ${s.sessionToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close, leaving, hoverId)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconSparkles size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>Session Complete</span>
      </div>
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} />
        ) : (
          <div className={`${s.toastIcon} ${s.sessionIcon}`}>
            <span className={s.xpGain}>+{gainedXp}</span>
          </div>
        )}
        <div className={s.toastInfo}>
          <div className={s.toastName}>{gameName}</div>
          <div className={s.toastDesc}>
            {flashTime(durationSeconds || 0)} played · +{gainedXp} XP earned
          </div>
          {toNextLevel != null && (
            <div className={s.toastGame}>Only {toNextLevel} XP to the next level!</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Individual achievement toast ──────────────────────────────────────────────

function OverlayToast({ toast, onDismiss }) {
  const { leaving, close, hoverId } = useAutoClose(onDismiss, DISPLAY_MS)

  const { ach, gameName, summary } = toast
  const displayAch = summary ? summary.first : ach
  const title = summary
    ? `${summary.count} Achievements Unlocked`
    : 'Achievement Unlocked'
  // XP earned, tagged on by achievementSync (rarity-weighted). Unlocks are the
  // most frequent XP event by far, so this is where the system becomes visible.
  const gainedXp = summary
    ? (summary.totalXp || 0)
    : (ach?.xp || 0)

  return (
    <div className={`${s.toast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close, leaving, hoverId)}>
      <CloseButton close={close} />
      {/* Header bar */}
      <div className={s.toastHeader}>
        <IconTrophy size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>{title}</span>
        {gainedXp > 0 && <span className={s.toastXp}>+{gainedXp} XP</span>}
      </div>

      {/* Body — game cover first (all toasts lead with the cover), the
          achievement's own icon when no cover is cached, trophy last. The
          leading visual carries the accent glow — this is the trophy moment. */}
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} className={s.achGlow} />
        ) : displayAch?.icon_url ? (
          <div className={`${s.toastIcon} ${s.achGlow}`}>
            <img src={displayAch.icon_url} alt="" onError={e => { e.target.style.display = 'none' }} />
          </div>
        ) : (
          <div className={`${s.toastIcon} ${s.achGlow}`}>
            <IconTrophy size={28} stroke={1.3} style={{ color: 'var(--a)' }} />
          </div>
        )}
        <div className={s.toastInfo}>
          <div className={s.toastName}>
            {summary ? `${summary.count} achievements` : (displayAch?.display_name || displayAch?.steam_api_name)}
          </div>
          {!summary && displayAch?.description && (
            <div className={s.toastDesc}>{displayAch.description}</div>
          )}
          {summary && summary.first?.display_name && (
            <div className={s.toastDesc}>Including "{summary.first.display_name}"</div>
          )}
          <div className={s.toastGame}>{gameName}</div>
        </div>
      </div>

      {/* Progress timer bar */}
      <div className={s.progressTrack}>
        <div className={s.progressFill} style={{ animationDuration: `${DISPLAY_MS}ms` }} />
      </div>
    </div>
  )
}

// ── Unknown-game toast ────────────────────────────────────────────────────────
// "New game detected" now surfaces as an overlay notification (visible over any
// game or the desktop) instead of a card inside the app. "Add to library"
// brings up the main window with the Add flow prefilled; "Never" persists the
// exe so it's not offered again. localStorage is shared with the main window
// (same origin), so dismissals from the old in-app card still count.

const DISMISSED_KEY = 'kozo:dismissed-exes'

function loadDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')) }
  catch { return new Set() }
}

function dismissForever(exeName) {
  try {
    const set = loadDismissed()
    set.add(exeName.toLowerCase())
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]))
  } catch {}
}

function UnknownGameToast({ toast, onDismiss }) {
  const { leaving, close, hoverId } = useAutoClose(onDismiss, 12000)
  const folderHint = toast.install_path
    ? toast.install_path.split(/[\\/]/).slice(-2).join('\\')
    : null

  function add(e) {
    e.stopPropagation()
    try { window.kozo?.api?.overlay?.addUnknownGame?.({ exe_name: toast.exe_name, install_path: toast.install_path }) } catch {}
    close()
  }

  function never(e) {
    e.stopPropagation()
    dismissForever(toast.exe_name)
    close()
  }

  return (
    <div className={`${s.toast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close, leaving, hoverId)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconDeviceGamepad2 size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>New Game Detected</span>
      </div>
      <div className={s.toastBody}>
        <div className={s.toastIcon}>
          <IconDeviceGamepad2 size={22} stroke={1.5} style={{ color: 'var(--a)' }} />
        </div>
        <div className={s.toastInfo}>
          <div className={s.toastName}>{toast.exe_name}</div>
          {folderHint && <div className={s.toastDesc}>from {folderHint}</div>}
          <div className={s.unknownActions}>
            <button className={s.unknownAddBtn} onClick={add}>
              <IconPlus size={12} stroke={2.4} />
              Add to library
            </button>
            <button className={s.unknownNeverBtn} onClick={never}>Never ask</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Release toast ─────────────────────────────────────────────────────────────
// A tracked upcoming game's release date has passed. Informational only — the
// Game List entry has already regrouped itself under "Out now" by the time this
// shows. This is a toast rather than an OS notification on purpose (§6).

function ReleaseToast({ toast, onDismiss }) {
  const { leaving, close, hoverId } = useAutoClose(onDismiss, 10000)
  const games = toast.games || []
  const one = games.length === 1 ? games[0] : null
  return (
    <div className={`${s.toast} ${s.releaseToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close, leaving, hoverId)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconCalendarEvent size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>Out Now</span>
      </div>
      <div className={s.toastBody}>
        {/* Cover art like "Now Playing"; the calendar icon only when there's none. */}
        {(() => {
          const art = games.find(g => g.artPath || g.artUrl)
          return art
            ? <ToastArt key={art.artPath || art.artUrl} artPath={art.artPath} artUrl={art.artUrl} className={s.liveGlow} />
            : (
              <div className={`${s.toastIcon} ${s.releaseIcon}`}>
                <IconCalendarEvent size={22} stroke={1.5} style={{ color: 'var(--a)' }} />
              </div>
            )
        })()}
        <div className={s.toastInfo}>
          <div className={s.toastName}>
            {one ? one.name : `${games.length} games you're waiting for`}
          </div>
          <div className={s.toastDesc}>
            {one
              ? `Released ${one.release_date}. It's under "Out now" in your Game List`
              : games.map(g => g.name).slice(0, 4).join(', ')}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Overlay app ───────────────────────────────────────────────────────────────

// The queue is capped so a burst of unlocks can't paper the screen.
const MAX_TOASTS = 4

function capToasts(list) {
  return list.slice(-MAX_TOASTS)
}

export default function OverlayApp() {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(0)

  // Match the user's chosen accent (the overlay is its own window, so it doesn't
  // inherit the main app's applied accent — load it from settings here, and also
  // update live when the user changes the accent while the overlay exists).
  useEffect(() => {
    // Wrapped so a missing/failed settings call can never throw and abort the
    // component's effects (which would also skip the ready() handshake below).
    try {
      Promise.resolve(window.kozo?.api?.settings?.get?.('accent_color'))
        .then(res => { if (res?.ok && res.data) applyAccent(res.data) })
        .catch(() => {})
    } catch {}
    const off = window.kozo?.events?.onAccentChanged?.((hex) => { if (hex) applyAccent(hex) })
    return () => off?.()
  }, [])

  useEffect(() => {
    const offs = []
    const on = (fn, cb) => { const off = fn?.(cb); if (off) offs.push(off) }

    // A fresh renderer starts with no toasts, so nothing would ever hand clicks
    // back to the game — assert click-through once here in case this mount
    // followed a crash/reload that happened while a toast was hovered.
    setInteractive(false)

    // Audio opens as a game is found, while it is still loading, instead of with
    // the first chime in the middle of play, and closes when the game does.
    on(window.kozo?.events?.onSessionDetected, holdAudio)
    on(window.kozo?.events?.onSessionStarted, holdAudio)
    on(window.kozo?.events?.onSessionEnded, releaseAudio)
    on(window.kozo?.events?.onSessionDiscarded, releaseAudio)
    on(window.kozo?.events?.onSessionUndetected, releaseAudio)

    // Spread the FULL payload — main sends artPath/artUrl for the cover thumb.
    on(window.kozo?.events?.onSessionOverlay, (data) => {
      playSessionStart()
      setToasts(q => capToasts([...q, { id: ++nextId.current, type: 'session', ...data }]))
    })

    // Global-hotkey status flash. Replace any existing flash card so repeated
    // Alt+K presses don't stack — show a fresh snapshot each time.
    on(window.kozo?.events?.onStatusOverlay, ({ cards }) => {
      const list = (cards && cards.length)
        ? cards.map(c => ({ id: ++nextId.current, type: 'status', ...c }))
        : [{ id: ++nextId.current, type: 'status', idle: true, gameName: 'KoZo' }]
      setToasts(q => capToasts([...q.filter(t => t.type !== 'status'), ...list]))
    })

    on(window.kozo?.events?.onAchievementOverlay, ({ achievements, gameName, artPath, artUrl }) => {
      const list = achievements || []
      if (!list.length) return
      playAchievement()   // one chime per event, even when batched below
      // Batch many at once into a summary so we don't flood the screen
      const newToasts = list.length > 3
        ? [{
            id: ++nextId.current,
            summary: {
              count: list.length,
              first: list[0],
              totalXp: list.reduce((n, a) => n + (a.xp || 0), 0),
            },
            gameName, artPath, artUrl,
          }]
        : list.map(ach => ({ id: ++nextId.current, ach, gameName, artPath, artUrl }))
      setToasts(q => capToasts([...q, ...newToasts]))
    })

    // XP: level-up celebration + post-session "+N XP" summary.
    on(window.kozo?.events?.onXpOverlay, (data) => {
      playLevelUp()
      setToasts(q => capToasts([...q, { id: ++nextId.current, type: 'levelup', ...data }]))
    })
    on(window.kozo?.events?.onSessionEndOverlay, (data) => {
      setToasts(q => capToasts([...q, { id: ++nextId.current, type: 'sessionEnd', ...data }]))
    })

    // "New game detected" notification. Skips exes the user said never to ask
    // about again, and never stacks a duplicate for the same exe.
    on(window.kozo?.events?.onUnknownGameOverlay, (data) => {
      if (!data?.exe_name) return
      const key = data.exe_name.toLowerCase()
      if (loadDismissed().has(key)) return
      setToasts(q => q.some(t => t.type === 'unknown' && t.exe_name?.toLowerCase() === key)
        ? q
        : capToasts([...q, { id: ++nextId.current, type: 'unknown', ...data }]))
    })

    // A tracked upcoming game reached its release date.
    on(window.kozo?.events?.onReleaseOverlay, (data) => {
      if (!data?.games?.length) return
      setToasts(q => capToasts([...q, { id: ++nextId.current, type: 'release', ...data }]))
    })

    // Tell main both listeners are attached — it flushes any queued messages
    // (e.g. a "Test notification" fired before this window finished loading).
    window.kozo?.api?.overlay?.ready?.()

    // Cleanup is essential: without it, React StrictMode's double-mount in dev
    // registers the IPC listener twice → every event renders TWO toasts. Each
    // on* returns an unsubscribe for THAT listener — never removeAll, which is
    // process-wide and would tear down other components' listeners too.
    return () => { for (const off of offs) { try { off() } catch {} } }
  }, [])

  function dismiss(id) {
    setToasts(q => {
      const next = q.filter(t => t.id !== id)
      // Hide the overlay window when all toasts are gone
      if (next.length === 0) window.kozo?.api?.overlay?.hide?.()
      return next
    })
  }

  return (
    <div className={s.container}>
      {toasts.map(t =>
        t.type === 'session'
          ? <SessionToast    key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'status'
          ? <StatusToast     key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'levelup'
          ? <LevelUpToast    key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'sessionEnd'
          ? <SessionEndToast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'unknown'
          ? <UnknownGameToast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'release'
          ? <ReleaseToast    key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : <OverlayToast    key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      )}
    </div>
  )
}
