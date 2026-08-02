import React, { useState, useEffect, useRef } from 'react'
import { IconTrophy, IconPlayerPlay, IconX, IconClock, IconDeviceGamepad2, IconSparkles, IconArrowBigUpLines, IconPlus, IconCheck } from '@tabler/icons-react'
import { applyAccent } from './context/AccentColorContext'
import { fileUrl } from './lib/utils'
import { playAchievement, playLevelUp, playSessionStart } from './lib/sounds'
import s from './OverlayApp.module.css'

// Cover-art thumb for session toasts — local cached banner first, CDN fallback,
// hidden entirely when neither loads (returns null so the icon shows instead).
function ToastArt({ artPath, artUrl }) {
  const [stage, setStage] = useState(artPath ? 'local' : (artUrl ? 'remote' : 'none'))
  if (stage === 'none') return null
  const src = stage === 'local' ? fileUrl(artPath) : artUrl
  return (
    <img
      className={s.toastArt}
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

// Shared dismiss-with-animation: plays the slide-out, then removes the toast.
// `auto` runs it on a timer; the returned `close` lets the user trigger it early
// (click anywhere on the toast or the X). Clears the auto timer so it fires once.
function useAutoClose(onDismiss, ms) {
  const [leaving, setLeaving] = useState(false)
  const timerRef = useRef(null)
  const goneRef  = useRef(false)

  const close = () => {
    if (goneRef.current) return
    goneRef.current = true
    clearTimeout(timerRef.current)
    setLeaving(true)
    setInteractive(false)          // hand clicks back to the game
    setTimeout(onDismiss, 300)
  }

  useEffect(() => {
    timerRef.current = setTimeout(close, ms)
    return () => clearTimeout(timerRef.current)
  }, [])

  return { leaving, close }
}

// Props shared by every toast so hovering captures the mouse and the card is
// fully click-to-dismiss, with a hover-revealed X for an explicit close.
function toastInteractions(close) {
  return {
    onMouseEnter: () => setInteractive(true),
    onMouseLeave: () => setInteractive(false),
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
  const { leaving, close } = useAutoClose(onDismiss, 4000)
  return (
    <div className={`${s.toast} ${s.sessionToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <span className={s.liveDot} />
        <span className={s.toastHeaderText}>Now Playing</span>
      </div>
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} />
        ) : (
          <div className={`${s.toastIcon} ${s.sessionIcon}`}>
            <IconPlayerPlay size={22} stroke={1.5} style={{ color: 'var(--a, #a78bfa)' }} />
          </div>
        )}
        <div className={s.toastInfo}>
          <div className={s.toastName}>{toast.gameName}</div>
          <div className={s.toastDesc}>Session started — tracking playtime</div>
        </div>
      </div>
    </div>
  )
}

// ── Status flash toast (global hotkey) ────────────────────────────────────────

function StatusToast({ toast, onDismiss }) {
  const { leaving, close } = useAutoClose(onDismiss, 5000)
  const { gameName, elapsedSec, unlocked, total, idle } = toast
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0
  return (
    <div className={`${s.toast} ${s.statusToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconClock size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>{idle ? 'KoZo' : 'Session'}</span>
      </div>
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} />
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

// ── Achievement list toast (Alt+J, read-only) ─────────────────────────────────
// "Where am I, and what's left" — NOT a dump of the whole list. Nobody reads
// fifty rows in the nine seconds this is up, and mixing unlocked ones in made
// it look like an arbitrary sample of completed achievements. So: progress bar,
// then the LOCKED ones rarest-first (the ones actually worth chasing), then a
// short strip of what you most recently earned.
// Deliberately no way to mark anything from here — this stays read-only.

function rarityLabel(pct) {
  if (pct == null) return null
  if (pct < 5)  return 'ultra rare'
  if (pct < 15) return 'rare'
  if (pct < 40) return 'uncommon'
  return null            // common — not worth the ink
}

function AchRow({ a, done, showHint }) {
  const rare = rarityLabel(a.rarity)
  return (
    <div className={`${s.achListRow} ${done ? s.achListRowDone : ''}`}>
      {a.icon_url
        ? <img className={s.achListIcon} src={a.icon_url} alt="" onError={e => { e.target.style.visibility = 'hidden' }} />
        : <IconTrophy size={14} stroke={1.5} className={s.achListIconFallback} />}
      <span className={s.achListText}>
        <span className={s.achListName}>{a.name}</span>
        {/* The requirement, straight from Steam's own description — the whole
            point of glancing at this mid-game is "what do I actually have to do
            for this one", and alt-tabbing to find out defeats the purpose.
            Locked rows only; an unlocked one needs no instructions. */}
        {showHint && !done && (
          <span className={s.achListHint}>
            {a.description || 'Hidden until unlocked'}
          </span>
        )}
      </span>
      {done
        ? <IconCheck size={13} stroke={2.4} className={s.achListCheck} />
        : a.rarity != null && (
            <span className={`${s.achListRarity} ${rare ? s.achListRarityHot : ''}`}>
              {a.rarity < 10 ? a.rarity.toFixed(1) : Math.round(a.rarity)}%
            </span>
          )}
    </div>
  )
}

function AchListToast({ toast, onDismiss }) {
  const { leaving, close } = useAutoClose(onDismiss, 9000)
  const { gameName, unlocked, total, percent, remaining = [], recent = [], idle } = toast
  return (
    <div className={`${s.toast} ${s.achListToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconTrophy size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>{idle ? 'KoZo' : `Achievements — ${gameName}`}</span>
      </div>
      {idle ? (
        <div className={s.toastBody}>
          <div className={s.toastIcon}>
            <IconTrophy size={22} stroke={1.5} style={{ color: 'var(--a)' }} />
          </div>
          <div className={s.toastInfo}>
            <div className={s.toastDesc}>No game is being tracked right now</div>
          </div>
        </div>
      ) : !total ? (
        <div className={s.toastBody}>
          <div className={s.toastInfo}>
            <div className={s.toastDesc}>No achievement list for this game yet</div>
          </div>
        </div>
      ) : (
        <>
          <div className={s.achListProgress}>
            <div className={s.achListProgressTop}>
              <span className={s.achListCount}>{unlocked}<span className={s.achListCountTotal}>/{total}</span></span>
              <span className={s.achListPct}>{percent}%</span>
            </div>
            <div className={s.achListBar}><div className={s.achListFill} style={{ width: `${percent}%` }} /></div>
          </div>

          {remaining.length > 0 ? (
            <>
              <div className={s.achListLabel}>Still locked — rarest first</div>
              <div className={s.achListRows}>
                {remaining.map((a, i) => <AchRow key={`r${i}`} a={a} done={false} showHint />)}
              </div>
            </>
          ) : (
            <div className={s.achListAllDone}>
              <IconCheck size={14} stroke={2.4} /> Every achievement unlocked
            </div>
          )}

          {recent.length > 0 && (
            <>
              <div className={s.achListLabel}>Recently unlocked</div>
              <div className={s.achListRecent}>
                {recent.map((a, i) => <AchRow key={`d${i}`} a={a} done />)}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Level-up toast ────────────────────────────────────────────────────────────

function LevelUpToast({ toast, onDismiss }) {
  const { leaving, close } = useAutoClose(onDismiss, 7000)
  const { level, tier, totalXp } = toast
  return (
    <div className={`${s.toast} ${s.levelUpToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close)}>
      <CloseButton close={close} />
      <div className={s.toastHeader}>
        <IconArrowBigUpLines size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>Level Up!</span>
      </div>
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} />
        ) : (
          <div className={`${s.toastIcon} ${s.levelUpIcon}`}>
            <span className={s.levelUpNumber}>{level}</span>
          </div>
        )}
        <div className={s.toastInfo}>
          <div className={s.toastName}>Level {level} — {tier}</div>
          <div className={s.toastDesc}>{totalXp?.toLocaleString?.() ?? totalXp} XP total. Keep it up!</div>
        </div>
      </div>
    </div>
  )
}

// ── Session-end XP summary toast ──────────────────────────────────────────────

function SessionEndToast({ toast, onDismiss }) {
  const { leaving, close } = useAutoClose(onDismiss, 6000)
  const { gameName, durationSeconds, gainedXp, toNextLevel } = toast
  return (
    <div className={`${s.toast} ${s.sessionToast} ${leaving ? s.toastOut : s.toastIn}`}
      {...toastInteractions(close)}>
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
            {flashTime(durationSeconds || 0)} played — +{gainedXp} XP earned
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
  const { leaving, close } = useAutoClose(onDismiss, DISPLAY_MS)
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    const start = Date.now()
    const tick = setInterval(() => {
      const pct = Math.max(0, 100 - ((Date.now() - start) / DISPLAY_MS) * 100)
      setProgress(pct)
      if (pct <= 0) clearInterval(tick)
    }, 50)
    return () => clearInterval(tick)
  }, [])

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
      {...toastInteractions(close)}>
      <CloseButton close={close} />
      {/* Header bar */}
      <div className={s.toastHeader}>
        <IconTrophy size={11} stroke={2} style={{ color: 'var(--a)', flexShrink: 0 }} />
        <span className={s.toastHeaderText}>{title}</span>
        {gainedXp > 0 && <span className={s.toastXp}>+{gainedXp} XP</span>}
      </div>

      {/* Body — game cover first (all toasts lead with the cover), the
          achievement's own icon when no cover is cached, trophy last */}
      <div className={s.toastBody}>
        {(toast.artPath || toast.artUrl) ? (
          <ToastArt artPath={toast.artPath} artUrl={toast.artUrl} />
        ) : displayAch?.icon_url ? (
          <div className={s.toastIcon}>
            <img src={displayAch.icon_url} alt="" onError={e => { e.target.style.display = 'none' }} />
          </div>
        ) : (
          <div className={s.toastIcon}>
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
        <div className={s.progressFill} style={{ width: `${progress}%` }} />
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
  const { leaving, close } = useAutoClose(onDismiss, 12000)
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
      {...toastInteractions(close)}>
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

// ── Overlay app ───────────────────────────────────────────────────────────────

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
    window.kozo?.events?.onAccentChanged?.((hex) => { if (hex) applyAccent(hex) })
    return () => window.kozo?.events?.removeAll?.('accent:changed')
  }, [])

  useEffect(() => {
    // Spread the FULL payload — main sends artPath/artUrl for the cover thumb.
    window.kozo?.events?.onSessionOverlay?.((data) => {
      playSessionStart()
      setToasts(q => [...q, { id: ++nextId.current, type: 'session', ...data }].slice(-4))
    })

    // Global-hotkey status flash. Replace any existing flash card so repeated
    // Alt+K presses don't stack — show a fresh snapshot each time.
    window.kozo?.events?.onStatusOverlay?.(({ cards }) => {
      const list = (cards && cards.length)
        ? cards.map(c => ({ id: ++nextId.current, type: 'status', ...c }))
        : [{ id: ++nextId.current, type: 'status', idle: true, gameName: 'KoZo' }]
      setToasts(q => [...q.filter(t => t.type !== 'status'), ...list].slice(-4))
    })

    // Global-hotkey achievement list (Alt+J), read-only. Replaces any existing
    // list toast so repeated presses refresh in place instead of stacking.
    window.kozo?.events?.onAchListOverlay?.((data) => {
      const toast = { id: ++nextId.current, type: 'achList', ...data }
      setToasts(q => [...q.filter(t => t.type !== 'achList'), toast].slice(-4))
    })

    window.kozo?.events?.onAchievementOverlay?.(({ achievements, gameName, artPath, artUrl }) => {
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
      setToasts(q => [...q, ...newToasts].slice(-4))
    })

    // XP: level-up celebration + post-session "+N XP" summary.
    window.kozo?.events?.onXpOverlay?.((data) => {
      playLevelUp()
      setToasts(q => [...q, { id: ++nextId.current, type: 'levelup', ...data }].slice(-4))
    })
    window.kozo?.events?.onSessionEndOverlay?.((data) => {
      setToasts(q => [...q, { id: ++nextId.current, type: 'sessionEnd', ...data }].slice(-4))
    })

    // "New game detected" notification. Skips exes the user said never to ask
    // about again, and never stacks a duplicate for the same exe.
    window.kozo?.events?.onUnknownGameOverlay?.((data) => {
      if (!data?.exe_name) return
      const key = data.exe_name.toLowerCase()
      if (loadDismissed().has(key)) return
      setToasts(q => q.some(t => t.type === 'unknown' && t.exe_name?.toLowerCase() === key)
        ? q
        : [...q, { id: ++nextId.current, type: 'unknown', ...data }].slice(-4))
    })

    // Tell main both listeners are attached — it flushes any queued messages
    // (e.g. a "Test notification" fired before this window finished loading).
    window.kozo?.api?.overlay?.ready?.()

    // Cleanup is essential: without it, React StrictMode's double-mount in dev
    // registers the IPC listener twice → every event renders TWO toasts.
    return () => {
      window.kozo?.events?.removeAll?.('session:overlay')
      window.kozo?.events?.removeAll?.('achievement:overlay')
      window.kozo?.events?.removeAll?.('status:overlay')
      window.kozo?.events?.removeAll?.('achList:overlay')
      window.kozo?.events?.removeAll?.('xp:overlay')
      window.kozo?.events?.removeAll?.('sessionEnd:overlay')
      window.kozo?.events?.removeAll?.('unknownGame:overlay')
    }
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
          : t.type === 'achList'
          ? <AchListToast    key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'levelup'
          ? <LevelUpToast    key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'sessionEnd'
          ? <SessionEndToast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : t.type === 'unknown'
          ? <UnknownGameToast key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
          : <OverlayToast    key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      )}
    </div>
  )
}
