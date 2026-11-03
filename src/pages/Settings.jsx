import React, { useState, useEffect, useId, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  IconKey, IconCheck, IconX, IconLoader2, IconClock, IconEye, IconEyeOff, IconLayoutGrid,
  IconUser, IconRefresh, IconExternalLink, IconAlertTriangle,
  IconPalette, IconInfoCircle, IconRocket, IconDeviceGamepad2,
  IconBrandSteam, IconBrandDiscord, IconDeviceTv, IconKeyboard, IconSettings, IconSparkles,
  IconSearch, IconPlus, IconMinus, IconFolder, IconTrophy,
  IconDownload, IconUpload, IconDeviceFloppy, IconArchive, IconCloud,
  IconHistory, IconList, IconChartBar, IconBell, IconBolt, IconShieldCheck, IconCopy, IconChevronDown,
  IconStar, IconStethoscope, IconLock, IconCode, IconChevronRight, IconArrowUp, IconArrowDown, IconPhoto, IconLayoutCards, IconTextSize, IconLayoutSidebar,
  IconPlugConnected, IconBrandGoogleDrive,
} from '@tabler/icons-react'
import { useAccentColor } from '../context/AccentColorContext'
import { useAppearance, DEFAULT_APPEARANCE, FONTS, bgTone } from '../context/AppearanceContext'
import ColorPicker from '../components/ui/ColorPicker'
import GameCard from '../components/GameCard'
import { NAV_ITEMS } from '../components/Sidebar'
import { fileUrl, timeAgo } from '../lib/utils'
import HoneycombLogo from '../components/HoneycombLogo'
import ScanResultModal from '../components/modals/ScanResultModal'
import SaveManagerModal from '../components/modals/SaveManagerModal'
import BackupsTab from '../components/BackupsTab'
import DriveSetupModal from '../components/DriveSetupModal'
import s from './Settings.module.css'

// ── Shared bits ──────────────────────────────────────────────────────────────

// Every "did it work" strip on this page. The variant is an explicit state
// value: this page used to encode it in the message STRING — setBannerMsg('❌ …')
// then bannerMsg.startsWith('❌') to pick the colour, and detectMsg.startsWith(
// 'Detected') / 'Signed in' / 'Waiting' to pick an icon. That put an emoji in a
// no-emoji codebase and broke the moment any copy was reworded.
const STATUS_VARIANT = {
  success: s.statusSuccess,
  error:   s.statusError,
  warning: s.statusWarning,
  info:    s.statusInfo,
  pending: s.statusInfo,
  neutral: s.statusNeutral,
}

function StatusIcon({ type }) {
  switch (type) {
    case 'success': return <IconCheck size={13} stroke={2.5} className={s.statusIcon} />
    case 'error':   return <IconX size={13} stroke={2.5} className={s.statusIcon} />
    case 'warning': return <IconAlertTriangle size={13} stroke={2} className={s.statusIcon} />
    case 'pending': return <IconLoader2 size={13} stroke={1.8} className={`${s.statusIcon} spin`} />
    case 'neutral': return null
    default:        return <IconInfoCircle size={13} stroke={1.8} className={s.statusIcon} />
  }
}

function StatusLine({ type = 'info', icon = true, className = '', children }) {
  return (
    <div
      className={`${s.statusLine} ${STATUS_VARIANT[type] || s.statusInfo} ${className}`}
      role={type === 'error' ? 'alert' : 'status'}
    >
      {icon && <StatusIcon type={type} />}
      <span>{children}</span>
    </div>
  )
}

// A { type, text } state object rendered straight through.
function Message({ msg }) {
  if (!msg?.text) return null
  return <StatusLine type={msg.type}>{msg.text}</StatusLine>
}

// The switch was a bare <button> with no role and no aria-checked, wrapped in a
// <label> that contained no labelable control — so assistive tech read an
// unlabelled button of unknown state, and the label element did nothing at all.
// The row is genuinely clickable now (it always looked like it was).
// Adult (18+) games stay behind a password so only the owner can turn them on.
// Only the SHA-256 of the password lives here. Turning the option OFF never
// asks; while it is on the toggle shows directly so it can be switched off.
const RESTRICTED_HASH = '76eb6786bd76e44f0652bdfbbb35c5c847b3c822d932c05811fd18ccad0e641a'
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
function RestrictedContent() {
  const [showAdult, setShowAdult] = useState(false)
  useEffect(() => {
    window.kozo?.api?.settings?.get?.('show_adult_games').then(r => setShowAdult(r?.ok && r.data === '1'))
  }, [])
  async function onChange(v) {
    setShowAdult(v)
    await window.kozo?.api?.settings?.set?.('show_adult_games', v ? '1' : '0')
    window.dispatchEvent(new Event('kozo:adult-changed'))
  }
  const [unlocked, setUnlocked] = useState(false)
  const [pw, setPw] = useState('')
  const [wrong, setWrong] = useState(false)
  async function unlock() {
    if ((await sha256Hex(pw)) === RESTRICTED_HASH) { setUnlocked(true); setPw(''); setWrong(false) }
    else setWrong(true)
  }
  if (unlocked || showAdult) {
    return (
      <div className={s.toggleList}>
        <ToggleRow
          label="Show adult (18+) games"
          desc="Include adult only titles in game search and the Steam calendar. Steam hides them unless this is on."
          checked={showAdult}
          onChange={onChange}
        />
      </div>
    )
  }
  return (
    <>
      <p className={s.sectionDesc}>
        <IconLock size={13} stroke={1.8} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        Restricted content is locked. Enter the password to change it.
      </p>
      <div className={s.keyRow}>
        <div className={`${s.keyInputWrap} hasRing`}>
          <input type="password" className={s.keyInput} placeholder="Password" value={pw}
            aria-label="Password for restricted content"
            onChange={e => { setPw(e.target.value); setWrong(false) }}
            onKeyDown={e => { if (e.key === 'Enter' && pw) unlock() }}
            autoComplete="off" spellCheck={false} />
        </div>
        <button type="button" className={s.testBtn} onClick={unlock} disabled={!pw}>Unlock</button>
      </div>
      {wrong && <StatusLine type="error">Wrong password.</StatusLine>}
    </>
  )
}

function ToggleRow({ label, desc, checked, onChange, busy = false, disabled = false }) {
  const labelId = useId()
  const toggle = () => { if (!busy && !disabled) onChange(!checked) }
  return (
    <div className={`${s.toggleRow} ${disabled ? s.toggleRowOff : ''}`} onClick={toggle} aria-disabled={disabled || undefined}>
      <div className={s.toggleInfo}>
        <div className={s.toggleLabel} id={labelId}>{label}</div>
        <div className={s.toggleDesc}>{desc}</div>
      </div>
      {busy ? (
        <IconLoader2 size={16} className={`${s.toggleBusy} spin`} />
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          disabled={disabled}
          className={`${s.toggle} ${checked ? s.toggleOn : ''}`}
          onClick={e => { e.stopPropagation(); toggle() }}
        >
          <span className={s.toggleThumb} />
        </button>
      )}
    </div>
  )
}

// ── Tab: General ─────────────────────────────────────────────────────────────

// Module cache so re-opening General doesn't flash toggles from their default
// before the async settings load resolves.
let generalTabCache = null

function GeneralTab() {
  const [openAtLogin, setOpenAtLogin]     = useState(generalTabCache?.openAtLogin ?? false)
  const [startMinimized, setStartMinimized] = useState(generalTabCache?.startMinimized ?? false)
  const [startupLoaded, setStartupLoaded] = useState(!!generalTabCache)   // avoids off→on flicker on open
  const [startupMsg, setStartupMsg]   = useState(null)   // { type, text }

  useEffect(() => {
    async function load() {
      if (!window.kozo?.api) return
      const res = await window.kozo.api.settings.getAll()
      const c = generalTabCache || {}
      const startup = await window.kozo.api.app?.getStartup?.()
      if (startup?.ok) { c.openAtLogin = startup.data?.openAtLogin ?? false; setOpenAtLogin(c.openAtLogin) }
      const minRes = await window.kozo.api.app?.getStartMinimized?.()
      if (minRes?.ok) { c.startMinimized = !!minRes.data; setStartMinimized(c.startMinimized) }
      generalTabCache = c
      setStartupLoaded(true)
    }
    load()
  }, [])


  async function toggleStartup(val) {
    setOpenAtLogin(val)
    if (generalTabCache) generalTabCache.openAtLogin = val
    setStartupMsg(null)
    const res = await window.kozo?.api?.app?.setStartup?.(val)
    // IPC replies are enveloped as { ok, data } — the handler's own result is in
    // `data`. Reading res.method directly (as this used to) is always undefined,
    // so neither the success message nor a failure ever surfaced.
    const r = res?.ok ? (res.data || {}) : null

    if (!val) {
      // Turning it OFF can genuinely fail — a scheduled task made with /rl
      // HIGHEST may need admin to delete. Saying nothing left the toggle
      // reading "off" while Windows kept launching KoZo at boot.
      if (!r || r.openAtLogin) {
        setOpenAtLogin(true)
        if (generalTabCache) generalTabCache.openAtLogin = true
        setStartupMsg({ type: 'error', text: r?.error || 'Could not remove KoZo from Windows startup.' })
      }
      return
    }

    if (!r) {
      setOpenAtLogin(false)
      if (generalTabCache) generalTabCache.openAtLogin = false
      setStartupMsg({ type: 'error', text: 'Could not register startup: ' + (res?.error || 'unknown error') })
    } else if (r.ok === false) {
      setOpenAtLogin(false)
      if (generalTabCache) generalTabCache.openAtLogin = false
      setStartupMsg({ type: 'error', text: 'Could not register startup: ' + (r.error || 'unknown error') })
    } else if (r.method === 'task_scheduler') {
      setStartupMsg({ type: 'success', text: 'Registered via Task Scheduler. Works even when KoZo runs as administrator.' })
    } else if (r.method === 'registry') {
      setStartupMsg({ type: 'success', text: 'Registered in Windows startup registry.' })
    }
  }

  async function toggleStartMinimized(val) {
    setStartMinimized(val)
    if (generalTabCache) generalTabCache.startMinimized = val
    await window.kozo?.api?.app?.setStartMinimized?.(val)
  }

  return (
    <div className={s.tabContent}>
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconRocket size={15} stroke={1.6} />
          <span>Launch Behavior</span>
        </div>
        <div className={s.toggleList}>
          <ToggleRow
            label="Launch on startup"
            desc="Start KoZo automatically when Windows boots"
            checked={openAtLogin}
            busy={!startupLoaded}
            onChange={toggleStartup}
          />
          <ToggleRow
            label="Start minimized to tray"
            desc={openAtLogin
              ? 'When KoZo starts with Windows, keep it in the tray. Opening it yourself always shows the window.'
              : 'Turn on Launch on startup to use this.'}
            checked={startMinimized}
            busy={!startupLoaded}
            disabled={!openAtLogin}
            onChange={toggleStartMinimized}
          />
        </div>
        <Message msg={startupMsg} />
      </section>


      <GraphicsSection />
    </div>
  )
}

// Idle / AFK: stop counting playtime after this long with no input.
let idleCache = null
function IdleSection() {
  const [idlePause, setIdlePause] = useState(idleCache ?? '5')      // minutes, 0 = off
  useEffect(() => {
    window.kozo?.api?.settings?.get?.('idle_pause_min').then(r => {
      if (r?.ok) { idleCache = r.data || '5'; setIdlePause(idleCache) }
    })
  }, [])
  // Saves the moment it changes.
  function pickIdle(v) {
    setIdlePause(v)
    idleCache = v
    window.kozo?.api?.settings?.set('idle_pause_min', String(parseInt(v) || 0))
  }
  return (
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconClock size={15} stroke={1.6} />
          <span>Idle / AFK Detection</span>
        </div>
        <p className={s.sectionDesc}>
          Stop counting playtime after this long with no input, so leaving a game open while
          you're away doesn't inflate your stats. Controller input counts too.
        </p>
        <div className={s.sensitivityRow} role="group" aria-label="Idle timeout">
          {[['0', 'Off'], ['1', '1m'], ['2', '2m'], ['5', '5m'], ['10', '10m'], ['15', '15m'], ['30', '30m']].map(([v, label]) => (
            <button key={v}
              type="button"
              aria-pressed={idlePause === v}
              className={`${s.sensitivityBtn} ${idlePause === v ? s.sensitivityActive : ''}`}
              onClick={() => pickIdle(v)}>
              {label}
            </button>
          ))}
        </div>
        <p className={s.sectionDescQuiet}>Sessions shorter than a minute aren't kept.</p>
      </section>
  )
}

// Settings → Shortcuts: every keyboard shortcut and controller button.
const KEYBOARD_GROUPS = [
  { title: 'Anywhere in Windows', rows: [
    ['Ctrl + Shift + K', 'Open KoZo, even when it is closed to the tray'],
    ['Alt + K', 'While playing: show your session time and achievements over the game'],
    ['Alt + J', 'While playing: show the achievements you still have left over the game'],
  ] },
  { title: 'Inside KoZo', rows: [
    ['Ctrl + mouse wheel', 'Over a card grid: card size. Anywhere else: the size of the whole app'],
    ['Esc', 'Close the open menu or dialog; in Big Picture, leave it'],
    ['Right click', 'The options menu for a game, a row or a card'],
    ['Enter', 'Open or start the focused item'],
  ] },
]

// Xbox layout, which is what Chromium reports for every XInput pad.
const PAD_GROUPS = [
  { title: 'Moving around', rows: [
    [['D-pad', 'L stick'], 'Move between cards, buttons and tabs'],
    [['R stick'], 'Scroll the page or the open dialog'],
    [['LB', 'RB'], 'Previous / next page in the sidebar'],
    [['LT', 'RT'], 'Previous / next tab inside the page (Play Plan views, Activity)'],
  ] },
  { title: 'Doing things', rows: [
    [['A'], 'Select: open the game, press the button, type in the field'],
    [['B'], 'Close the menu or dialog, else go back'],
    [['X'], 'Options: the right-click menu of the focused game'],
    [['Y'], 'Jump to the search box'],
    [['Menu'], 'Open Settings'],
  ] },
]

// The held combo that brings KoZo up from anywhere (services/controllerWake.js).
const WAKE_COMBOS = [
  { value: 'guide',    label: 'Xbox button', keys: ['Xbox'] },
  { value: 'lbrbmenu', label: 'LB + RB + Menu', keys: ['LB + RB + Menu'] },
  { value: 'viewmenu', label: 'View + Menu', keys: ['View + Menu'] },
  { value: 'off',      label: 'Off', keys: null },
]
let wakeComboCache = null
const PAD_COLORS = { A: '#3fb950', B: '#f85149', X: '#4493f8', Y: '#e3b341' }

function Keys({ keys }) {
  return (
    <span className={s.shortcutKeys}>
      {keys.split(' + ').map((k, i) => (
        <React.Fragment key={k}>{i > 0 && <span className={s.shortcutPlus}>+</span>}<kbd>{k}</kbd></React.Fragment>
      ))}
    </span>
  )
}

function PadKeys({ keys }) {
  return (
    <span className={s.shortcutKeys}>
      {keys.map((k, i) => (
        <React.Fragment key={k}>
          {i > 0 && <span className={s.shortcutPlus}>{'/'}</span>}
          {k.split(' + ').map((p, j) => (
            <React.Fragment key={p}>
              {j > 0 && <span className={s.shortcutPlus}>+</span>}
              <kbd className={PAD_COLORS[p] ? s.padFace : s.padKey} style={PAD_COLORS[p] ? { '--pad': PAD_COLORS[p] } : undefined}>{p}</kbd>
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </span>
  )
}

// Whether a controller is connected right now (Chromium only lists a pad
// after a button press, so "not seen" tells you to press one).
function usePadName() {
  const [name, setName] = useState(null)
  useEffect(() => {
    const read = () => {
      const gp = Array.from(navigator.getGamepads?.() || []).find(g => g && g.connected)
      setName(gp ? gp.id.replace(/\s*\(.*$/, '') || 'Controller' : null)
    }
    read()
    window.addEventListener('gamepadconnected', read)
    window.addEventListener('gamepaddisconnected', read)
    const t = setInterval(read, 2000)
    return () => {
      window.removeEventListener('gamepadconnected', read)
      window.removeEventListener('gamepaddisconnected', read)
      clearInterval(t)
    }
  }, [])
  return name
}

function WakeComboPicker() {
  const [combo, setCombo] = useState(wakeComboCache || 'guide')
  useEffect(() => {
    window.kozo?.api?.settings?.get?.('pad_wake_combo').then(r => {
      if (r?.ok && WAKE_COMBOS.some(c => c.value === r.data)) { wakeComboCache = r.data; setCombo(r.data) }
    })
  }, [])
  function pick(v) {
    setCombo(v)
    wakeComboCache = v
    window.kozo?.api?.settings?.set('pad_wake_combo', v)
  }
  const cur = WAKE_COMBOS.find(c => c.value === combo)
  return (
    <div className={s.shortcutGroup}>
      <div className={s.shortcutGroupTitle}>From anywhere</div>
      <Segmented label="Open KoZo with" value={combo} options={WAKE_COMBOS} onChange={pick} wrap />
      <div className={s.shortcutList}>
        <div className={s.shortcutRow}>
          {cur.keys ? <PadKeys keys={cur.keys} /> : <span className={s.shortcutKeys}><kbd className={s.padKey}>Off</kbd></span>}
          <span className={s.shortcutWhat}>
            {cur.keys
              ? 'Hold for a second: bring KoZo up in Big Picture, even from the tray or a game'
              : "The controller can't open KoZo from the tray. Ctrl + Shift + K still works"}
          </span>
        </div>
      </div>
      {combo === 'guide' && (
        <p className={s.sectionDescQuiet}>
          A quick press of the Xbox button still opens Windows Game Bar; holding it opens KoZo.
          If your controller doesn't report the Xbox button, LB + RB + Menu works instead.
        </p>
      )}
    </div>
  )
}

function ShortcutsTab() {
  const pad = usePadName()
  return (
    <div className={s.tabContent}>
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconKeyboard size={15} stroke={1.6} />
          <span>Keyboard and mouse</span>
        </div>
        {KEYBOARD_GROUPS.map(g => (
          <div key={g.title} className={s.shortcutGroup}>
            <div className={s.shortcutGroupTitle}>{g.title}</div>
            <div className={s.shortcutList}>
              {g.rows.map(([keys, what]) => (
                <div key={keys} className={s.shortcutRow}>
                  <Keys keys={keys} />
                  <span className={s.shortcutWhat}>{what}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconDeviceGamepad2 size={15} stroke={1.6} />
          <span>Controller</span>
          <span className={`${s.padStatus} ${pad ? s.padOn : ''}`}>
            <span className={s.padDot} /> {pad ? `${pad} connected` : 'No controller seen yet. Press any button on it.'}
          </span>
        </div>
        <p className={s.sectionDesc}>An Xbox controller (or any controller Windows sees as one) drives every page and Big Picture. A ring shows where you are; moving the mouse hides it.</p>
        {PAD_GROUPS.map(g => (
          <div key={g.title} className={s.shortcutGroup}>
            <div className={s.shortcutGroupTitle}>{g.title}</div>
            <div className={s.shortcutList}>
              {g.rows.map(([keys, what]) => (
                <div key={keys.join()} className={s.shortcutRow}>
                  <PadKeys keys={keys} />
                  <span className={s.shortcutWhat}>{what}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
        <WakeComboPicker />
      </section>
    </div>
  )
}

// Graphics acceleration: on by default; off fixes graphics drivers that time
// out with KoZo open. Applies after a restart (main.js reads gpu.json).
function GraphicsSection() {
  const [state, setState] = useState(null)   // { acceleration, active }
  useEffect(() => { window.kozo?.api?.app?.getGpu?.().then(r => { if (r?.ok) setState(r.data) }) }, [])
  if (!state) return null
  const pending = state.acceleration !== state.active
  async function toggle(v) {
    setState(st => ({ ...st, acceleration: v }))
    await window.kozo?.api?.app?.setGpu?.(v)
  }
  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <IconBolt size={15} stroke={1.6} />
        <span>Graphics</span>
      </div>
      <div className={s.toggleList}>
        <ToggleRow
          label="Graphics acceleration"
          desc="Smoother animations. If your graphics driver times out or crashes while KoZo is open (seen with some AMD cards), turn this off."
          checked={state.acceleration}
          onChange={toggle}
        />
      </div>
      {pending && (
        <div className={s.keyRow}>
          <StatusLine type="info">Restart KoZo to apply this.</StatusLine>
          <button type="button" className={s.testBtn} onClick={() => window.kozo?.api?.app?.relaunch?.()}>
            <IconRefresh size={13} stroke={1.8} /> Restart now
          </button>
        </div>
      )}
    </section>
  )
}

// Discord Rich Presence (services/discordPresence.js). Discord shows a game
// under the name of a Discord "application", so the user makes a free one and
// pastes its Application ID here. Everything saves as it changes.
const DISCORD_STATUS = {
  off:         null,
  no_id:       { type: 'warning', text: 'Paste your Application ID to finish.' },
  idle:        { type: 'success', text: 'Ready. Discord shows your game while you play.' },
  connecting:  { type: 'pending', text: 'Connecting to Discord…' },
  connected:   { type: 'success', text: 'Connected. Discord is showing your game.' },
  not_running: { type: 'info',    text: 'Discord isn\'t open. KoZo connects when it is.' },
  bad_id:      { type: 'error',   text: 'Discord refused this Application ID. Check it and paste it again.' },
}
// Discord Rich Presence state for the Connections page: the switch, the
// optional own Application ID (saved a moment after typing), the status.
function useDiscord() {
  const [on, setOn] = useState(false)
  const [id, setId] = useState('')
  const [status, setStatus] = useState('off')
  const loaded = useRef(false)
  async function refreshStatus() {
    const r = await window.kozo?.api?.discord?.apply?.()
    if (r?.ok) setStatus(r.data)
  }
  useEffect(() => {
    window.kozo?.api?.settings?.getAll?.().then(res => {
      // An ID equal to the built-in one isn't "your own app".
      window.kozo?.api?.dialog?.builtInKeys?.().then(k => {
        const builtIn = k?.ok ? k.data?.discordId : null
        const mine = res?.data?.discord_client_id || ''
        if (res?.ok) { setOn(res.data?.discord_presence === '1'); setId(builtIn && mine === builtIn ? '' : mine) }
        loaded.current = true
      })
    })
    window.kozo?.api?.discord?.status?.().then(r => { if (r?.ok) setStatus(r.data) })
  }, [])
  useEffect(() => {
    if (!loaded.current) return
    const t = setTimeout(async () => {
      await window.kozo?.api?.settings?.set?.('discord_client_id', id.trim())
      refreshStatus()
    }, 600)
    return () => clearTimeout(t)
  }, [id])
  async function toggle(v) {
    setOn(v)
    await window.kozo?.api?.settings?.set?.('discord_presence', v ? '1' : '0')
    refreshStatus()
  }
  return { on, toggle, id, setId, status, msg: on ? DISCORD_STATUS[status] : null }
}

// ── Tab: Steam ────────────────────────────────────────────────────────────────
// Module cache so re-opening the Steam tab shows the key/ID/profile instantly
// instead of flashing empty fields + reloading the profile card every time.
let steamTabCache = null

function SteamTab() {
  const [apiKey, setApiKey]         = useState(steamTabCache?.apiKey ?? '')
  const [showKey, setShowKey]       = useState(false)
  const [testState, setTestState]   = useState('idle')
  const [testMsg, setTestMsg]       = useState('')
  const [steamUserId, setSteamUserId] = useState(steamTabCache?.steamUserId ?? '')
  const [saved, setSaved]           = useState(false)
  const savedKeyRef                 = useRef(steamTabCache?.apiKey ?? null)   // what the DB holds
  const [bannerRefreshing, setBannerRefreshing] = useState(false)
  const [bannerMsg, setBannerMsg]   = useState(null)   // { type, text }
  const [profile, setProfile]       = useState(steamTabCache?.profile ?? null)
  const [profileState, setProfileState] = useState(steamTabCache?.profile ? 'found' : 'idle')
  const [profileMsg, setProfileMsg] = useState('')
  const [detectMsg, setDetectMsg]   = useState(null)   // { type, text }
  const [signingIn, setSigningIn]   = useState(false)
  const [steamPersona, setSteamPersona] = useState(steamTabCache?.steamPersona ?? '')
  // Persisted by achievementSync whenever Steam refuses to hand over unlocks.
  // Library-wide, so it belongs here rather than only on one game's page.
  const [privacyError, setPrivacyError] = useState('')
  const [privacyChecking, setPrivacyChecking] = useState(false)

  useEffect(() => {
    const off = window.kozo?.events?.onSteamPrivacyChanged?.(v => setPrivacyError(v || ''))
    return () => off?.()
  }, [])

  useEffect(() => {
    async function load() {
      if (!window.kozo?.api) return
      const res = await window.kozo.api.settings.getAll()
      if (res?.ok) {
        const key = res.data?.steam_api_key || ''
        const sid = res.data?.steam_user_id || ''
        const persona = res.data?.steam_persona || ''
        savedKeyRef.current = key
        setApiKey(key)
        setSteamUserId(sid)
        setSteamPersona(persona)
        setPrivacyError(res.data?.steam_profile_private || '')
        steamTabCache = { ...(steamTabCache || {}), apiKey: key, steamUserId: sid, steamPersona: persona }
        // Only re-fetch the profile card if we don't already have it cached.
        if (key && sid && !steamTabCache.profile) loadProfile(key, sid)
      }
    }
    load()
  }, [])

  // Banner-refresh progress lives in the MAIN process, so switching tabs
  // mid-run and coming back re-seeds the live counter instead of looking idle.
  useEffect(() => {
    let cancelled = false
    function applyState(st) {
      if (cancelled || !st) return
      if (st.running) {
        setBannerRefreshing(true)
        setBannerMsg({ type: 'pending', text: `Refreshing covers… ${st.done}/${st.total}` })
      } else {
        setBannerRefreshing(false)
        if (st.total > 0) setBannerMsg({ type: 'success', text: 'Cover images refreshed at 2× quality.' })
      }
    }
    window.kozo?.api?.steam?.bannerRefreshStatus?.().then(res => {
      const st = res?.ok ? res.data : res
      if (st?.running) applyState(st)
    })
    const off = window.kozo?.events?.onBannerRefreshProgress?.(applyState)
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  async function loadProfile(key, sid) {
    setProfileState('loading')
    setProfileMsg('')
    setProfile(null)
    const res = await window.kozo?.api?.steam?.getProfile({ apiKey: key, steamId: sid })
    if (res?.ok && res.data?.ok) {
      setProfile(res.data.profile)
      steamTabCache = { ...(steamTabCache || {}), profile: res.data.profile }
      setProfileState('found')
    } else {
      setProfileState('error')
      const reason = res?.data?.reason
      setProfileMsg(
        reason === 'no_api_key'  ? 'Save your API key first.' :
        reason === 'no_steam_id' ? 'Save your Steam ID first.' :
        reason === 'not_found'   ? 'Steam ID not found or profile is private.' :
        'Could not load profile.'
      )
    }
  }

  async function testKey() {
    if (!apiKey.trim()) return
    setTestState('testing')
    setTestMsg('')
    const res = await window.kozo.api.steam.testKey(apiKey.trim())
    if (res?.ok) {
      setTestState(res.data?.valid ? 'valid' : 'invalid')
      setTestMsg(res.data?.message || '')
    } else {
      setTestState('invalid')
      setTestMsg('Test failed')
    }
  }

  // The key saves on its own a moment after typing stops (and on blur). The
  // Steam ID is managed by detect / sign-in.
  async function save() {
    if (!window.kozo?.api) return
    const key = apiKey.trim()
    if (savedKeyRef.current === null || key === savedKeyRef.current) return
    savedKeyRef.current = key
    await window.kozo.api.settings.set('steam_api_key', key)
    steamTabCache = { ...(steamTabCache || {}), apiKey: key, profile: null }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    if (key && steamUserId) loadProfile(key, steamUserId)
  }
  useEffect(() => {
    const t = setTimeout(save, 700)
    return () => clearTimeout(t)
  }, [apiKey])

  async function doRefreshBanners() {
    setBannerRefreshing(true)
    setBannerMsg({ type: 'pending', text: 'Refreshing covers…' })
    // Covers BOTH systems (Library local banners + Game List remote covers) in
    // one main-process run; the progress event stream drives the message.
    const res = await window.kozo?.api?.steam?.refreshAllBanners?.()
    if (res?.ok === false) {
      setBannerRefreshing(false)
      setBannerMsg({ type: 'error', text: res?.error || 'Could not refresh images.' })
    }
  }

  async function detectFromPc() {
    const r = await window.kozo?.api?.steam?.detectUser?.()
    const d = r?.ok ? r.data : r
    if (d?.steamId) {
      setSteamUserId(d.steamId)
      setSteamPersona(d.personaName || '')
      await window.kozo?.api?.settings?.set('steam_user_id', d.steamId)
      if (d.personaName) await window.kozo?.api?.settings?.set('steam_persona', d.personaName)
      setProfileState('idle'); setProfile(null)
      setDetectMsg({ type: 'success', text: d.personaName ? `Detected: ${d.personaName}` : 'Detected your Steam account' })
      if (apiKey.trim()) loadProfile(apiKey.trim(), d.steamId)
    } else {
      setDetectMsg({
        type: 'error',
        text: d?.error === 'steam_not_found'
          ? 'Steam installation not found on this PC.'
          : 'Could not detect a logged-in Steam account.',
      })
    }
  }

  async function signInWithSteam() {
    setSigningIn(true)
    setDetectMsg({ type: 'pending', text: 'Waiting for you to sign in with Steam in the browser…' })
    const r = await window.kozo?.api?.steam?.signIn?.()
    setSigningIn(false)
    const d = r?.ok ? r.data : r
    if (d?.steamId) {
      setSteamUserId(d.steamId)
      setSteamPersona(d.personaName || '')
      setProfileState('idle'); setProfile(null)
      setDetectMsg({ type: 'success', text: d.personaName ? `Signed in as ${d.personaName}` : 'Signed in with Steam' })
      if (apiKey.trim()) loadProfile(apiKey.trim(), d.steamId)
    } else {
      setDetectMsg({
        type: 'error',
        text: d?.error === 'timeout' ? 'Sign-in timed out. Try again.' : 'Steam sign-in failed. Try again.',
      })
    }
  }

  const discord = useDiscord()
  const sgdb = useSgdb()
  const [drive, setDrive] = useState(null)
  const [driveBusy, setDriveBusy] = useState(false)
  const [driveSetup, setDriveSetup] = useState(false)
  const [showKeys, setShowKeys] = useState({})
  const navigate = useNavigate()
  useEffect(() => {
    window.kozo?.api?.drive?.status?.().then(r => { if (r?.ok) setDrive(r.data) })
    const off = window.kozo?.events?.onDriveStatus?.(setDrive)
    return () => { try { off?.() } catch {} }
  }, [])
  async function connectDrive() {
    setDriveBusy(true)
    await window.kozo?.api?.drive?.connect?.()
    setDriveBusy(false)
    window.kozo?.api?.drive?.status?.().then(r => { if (r?.ok) setDrive(r.data) })
  }
  const keyInput = (id, label, value, onChange, placeholder, extra = null) => (
    <div className={s.advField}>
      <label className={s.advLabel}>{label}</label>
      <div className={s.keyRow}>
        <div className={`${s.keyInputWrap} hasRing`}>
          <input type={showKeys[id] ? 'text' : 'password'} className={s.keyInput} placeholder={placeholder} value={value}
            aria-label={label} onChange={e => onChange(e.target.value)} spellCheck={false} autoComplete="off" />
          <button type="button" className={s.keyToggle} onClick={() => setShowKeys(k => ({ ...k, [id]: !k[id] }))}
            aria-label={showKeys[id] ? 'Hide' : 'Show'}>
            {showKeys[id] ? <IconEyeOff size={14} stroke={1.6} /> : <IconEye size={14} stroke={1.6} />}
          </button>
        </div>
        {extra}
      </div>
    </div>
  )

  return (
    <div className={s.tabContent}>
      <section className={s.section}>
        <div className={s.sectionHeader}><IconPlugConnected size={15} stroke={1.6} /><span>Connections</span></div>
        <p className={s.sectionDesc}>Everything works without typing a key. Each one only needs a click.</p>
        <div className={s.connList}>
          <ConnRow
            icon={profile?.avatar ? <img src={profile.avatar} alt="" /> : <IconBrandSteam size={20} />}
            name="Steam"
            tone={steamUserId ? 'ok' : 'muted'}
            status={steamUserId ? <>Connected as <b>{steamPersona || profile?.persona_name || steamUserId}</b></> : 'Not connected. KoZo reads the account the Steam app is signed in to.'}>
            <button type="button" className={s.testBtn} onClick={detectFromPc} title="Read the account from the Steam app on this PC">Detect</button>
            <button type="button" className={s.testBtn} disabled={signingIn} onClick={signInWithSteam}>
              {signingIn ? <><IconLoader2 size={13} className="spin" /> Waiting…</> : (steamUserId ? 'Change account' : 'Sign in')}
            </button>
          </ConnRow>
          <ConnRow icon={<IconBrandDiscord size={20} />} name="Discord"
            tone={discord.on && discord.msg?.type === 'success' ? 'ok' : discord.on && discord.msg ? 'warn' : 'muted'}
            status={discord.on ? (discord.msg?.text || 'On. Shows your game while you play.') : 'Off. Turn on to show the game you play on Discord.'}>
            <button type="button" role="switch" aria-checked={discord.on} aria-label="Show my game on Discord"
              className={`${s.toggle} ${discord.on ? s.toggleOn : ''}`} onClick={() => discord.toggle(!discord.on)}>
              <span className={s.toggleThumb} />
            </button>
          </ConnRow>
          <ConnRow icon={<IconPhoto size={20} />} name="Covers for non-Steam games"
            tone={sgdb.working ? 'ok' : 'warn'}
            status={sgdb.saved ? 'From SteamGridDB with your key' : sgdb.builtIn ? 'From SteamGridDB, built in' : 'Needs a SteamGridDB key (Advanced, below)'}>
            <button type="button" className={s.testBtn} disabled={bannerRefreshing} onClick={doRefreshBanners} title="Download every cover again at 2x quality">
              {bannerRefreshing ? <><IconLoader2 size={13} className="spin" /> Refreshing…</> : <><IconRefresh size={13} /> Refresh covers</>}
            </button>
          </ConnRow>
          {/* Only when KoZo has a Google client (built in, or the maker's own
              under Advanced): users never see a setup step. */}
          {drive?.configured && (
            <ConnRow icon={<IconBrandGoogleDrive size={20} />} name="Google Drive"
              tone={drive.connected && !drive.error ? 'ok' : drive.error ? 'warn' : 'muted'}
              status={drive.connected ? <>Backups copied to <b>{drive.email || 'your Drive'}</b>{drive.lastSync ? `, ${timeAgo(drive.lastSync)}` : ''}</>
                : 'Keeps your saves and library safe off this PC'}>
              {!drive.connected && (
                <button type="button" className={s.testBtn} onClick={connectDrive} disabled={driveBusy}>
                  {driveBusy ? <><IconLoader2 size={13} className="spin" /> Waiting for Google…</> : 'Sign in with Google'}
                </button>
              )}
              {drive.connected && <button type="button" className={s.testBtn} onClick={() => navigate('/settings?tab=data')}>Backups</button>}
            </ConnRow>
          )}
        </div>
        <Message msg={detectMsg} />
        <Message msg={bannerMsg} />
        {privacyError && (
          <div className={s.privacyBanner}>
            <IconAlertTriangle size={15} stroke={1.8} className={s.privacyIcon} />
            <div>
              {privacyError === 'profile_not_found'
                ? <>KoZo couldn't read your Steam profile. Try Detect or Sign in again.</>
                : <>
                    Steam won't share unlock dates because your profile's <strong>Game details</strong> are private.
                    Achievements still work (KoZo reads them from the Steam app on this PC); only Steam's exact
                    unlock times are missing. Set Game details to Public, then Re-check.
                  </>}
              <div className={s.keyRow}>
                <button type="button" className={s.testBtn}
                  onClick={() => window.kozo?.api?.shell?.openExternal?.('https://steamcommunity.com/my/edit/settings')}>
                  Open Steam privacy settings
                </button>
                <button type="button" className={s.testBtn} disabled={privacyChecking}
                  onClick={async () => {
                    setPrivacyChecking(true)
                    const res = await window.kozo?.api?.steam?.recheckPrivacy?.()
                    setPrivacyChecking(false)
                    const d = res?.ok ? res.data : null
                    if (d?.checked && !d.private) setPrivacyError('')
                  }}>
                  {privacyChecking ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Checking…</> : <><IconRefresh size={13} stroke={1.8} /> Re-check now</>}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {driveSetup && <DriveSetupModal onClose={() => setDriveSetup(false)} onDone={() => window.kozo?.api?.drive?.status?.().then(r => { if (r?.ok) setDrive(r.data) })} />}

      {/* Every key and ID, in one place, folded away */}
      <details className={`${s.section} ${s.foldSection}`}>
        <summary className={s.sectionHeader}>
          <IconKey size={15} stroke={1.6} />
          <span>Advanced: your own keys (optional)</span>
          <IconChevronDown size={14} className={s.foldChev} />
        </summary>
        <p className={s.sectionDesc}>Nothing here is needed. Use them only if you want your own.</p>

        {keyInput('steam', 'Steam Web API key', apiKey, v => { setApiKey(v); setTestState('idle') }, 'For private profiles and owned-games data',
          <button type="button" className={s.testBtn} onClick={testKey} disabled={!apiKey.trim() || testState === 'testing'}>
            {testState === 'testing' ? <IconLoader2 size={13} stroke={1.8} className="spin" /> : 'Test'}
          </button>)}
        <p className={s.sectionDescQuiet}>
          Get one at{' '}
          <button type="button" className={s.linkBtn} onClick={() => window.kozo?.api?.shell?.openExternal('https://steamcommunity.com/dev/apikey')}>steamcommunity.com/dev/apikey</button>.
        </p>
        {testState !== 'idle' && testState !== 'testing' && <StatusLine type={testState === 'valid' ? 'success' : 'error'}>{testMsg}</StatusLine>}
        {saved && testState === 'idle' && <StatusLine type="success">{apiKey.trim() ? 'Key saved.' : 'Key removed.'}</StatusLine>}

        {keyInput('sgdb', 'SteamGridDB key', sgdb.key, v => sgdb.setKey(v), sgdb.builtIn ? 'Empty = KoZo\'s built-in key' : 'Needed for covers of non-Steam games',
          <button type="button" className={s.testBtn} onClick={sgdb.save} disabled={sgdb.state === 'saving' || !sgdb.key.trim()}>
            {sgdb.state === 'saving' ? <IconLoader2 size={13} stroke={1.8} className="spin" /> : 'Check'}
          </button>)}
        <p className={s.sectionDescQuiet}>
          <button type="button" className={s.linkBtn} onClick={() => window.kozo?.api?.shell?.openExternal?.(SGDB_KEY_URL)}>Get a free key</button>.
        </p>
        {(sgdb.state === 'ok' || sgdb.state === 'error') && <StatusLine type={sgdb.state === 'ok' ? 'success' : 'error'}>{sgdb.msg}</StatusLine>}

        <div className={s.advField}>
          <label className={s.advLabel}>Your own Discord app ID</label>
          <div className={s.keyRow}>
            <div className={`${s.keyInputWrap} hasRing`}>
              <input className={s.keyInput} placeholder="Empty = shows as KoZo" value={discord.id}
                aria-label="Discord Application ID" inputMode="numeric"
                onChange={e => discord.setId(e.target.value.replace(/\D/g, ''))} spellCheck={false} autoComplete="off" />
            </div>
          </div>
          <p className={s.sectionDescQuiet}>
            To show another name or picture, make an app in the{' '}
            <button type="button" className={s.linkBtn} onClick={() => window.kozo?.api?.shell?.openExternal?.('https://discord.com/developers/applications')}>Discord Developer Portal</button>.
          </p>
        </div>

        <div className={s.advField}>
          <label className={s.advLabel}>Your own Google client (for Google Drive)</label>
          <div className={s.keyRow}>
            <button type="button" className={s.testBtn} onClick={() => setDriveSetup(true)}>
              <IconBrandGoogleDrive size={13} /> {drive?.configured ? 'Change Google client' : 'Use your own Google client'}
            </button>
          </div>
          <p className={s.sectionDescQuiet}>Only for whoever builds KoZo: once a client is set, everyone just signs in with Google.</p>
        </div>
      </details>
    </div>
  )
}

// SteamGridDB key (covers for games that aren't on Steam): the built-in key,
// or the user's own, saved and checked a moment after typing.
const SGDB_KEY_URL = 'https://www.steamgriddb.com/profile/preferences/api'
function useSgdb() {
  const [builtIn, setBuiltIn] = useState(false)
  const [key, setKey]     = useState('')
  const [saved, setSaved] = useState('')
  const [state, setState] = useState('idle')   // idle | saving | ok | error
  const [msg, setMsg]     = useState('')
  const loadedRef = useRef(false)
  useEffect(() => {
    window.kozo?.api?.dialog?.builtInKeys?.().then(r => { if (r?.ok) setBuiltIn(!!r.data?.steamgriddb) })
    window.kozo?.api?.settings?.get?.('steamgriddb_key').then(res => {
      if (res?.ok && res.data) { setKey(res.data); setSaved(res.data) }
      loadedRef.current = true
    })
  }, [])
  useEffect(() => {
    if (!loadedRef.current || key.trim() === saved) return
    const t = setTimeout(save, 800)
    return () => clearTimeout(t)
  }, [key])
  async function save() {
    setState('saving')
    const res = await window.kozo?.api?.sgdb?.setKey?.(key).catch(e => ({ ok: false, error: e?.message }))
    const d = res?.ok ? res.data : null
    if (d?.valid) {
      setSaved(key.trim()); setState('ok')
      setMsg(key.trim() ? 'Saved. Covers for your non-Steam games are being fetched.' : 'Key removed.')
    } else { setState('error'); setMsg(d?.message || res?.error || 'Could not check the key.') }
  }
  return { builtIn, key, setKey, saved, state, msg, save, working: builtIn || !!saved }
}

function ConnRow({ icon, name, status, tone = 'muted', children }) {
  return (
    <div className={s.connRow}>
      <span className={s.connIcon}>{icon}</span>
      <div className={s.connText}>
        <strong>{name}</strong>
        <span className={`${s.connStatus} ${s['conn_' + tone]}`}>{status}</span>
      </div>
      <div className={s.connActions}>{children}</div>
    </div>
  )
}

// Emulator save folders on this PC that hold real achievement progress for a
// game the library doesn't have. services/crackDiscovery.js + its two IPC
// channels were fully implemented but nothing ever called them — this is the
// surface that was missing. It only ever LISTS; adding is the user's choice.
function CrackedOnThisPC() {
  const [found, setFound]   = useState(null)   // null = not run yet
  const [busy, setBusy]     = useState(false)
  const [addingId, setAdding] = useState(null)
  const [msg, setMsg]       = useState(null)

  async function scan() {
    setBusy(true); setMsg(null)
    const res = await window.kozo?.api?.crack?.discover?.()
    setBusy(false)
    if (!res?.ok) { setMsg({ type: 'error', text: 'Lookup failed: ' + (res?.error || 'unknown') }); return }
    setFound(res.data || [])
  }

  async function add(g) {
    setAdding(g.appId)
    const res = await window.kozo?.api?.games?.add?.({
      name: g.name || `App ${g.appId}`,
      steam_app_id: String(g.appId),
      exe_name: '',
      install_path: null,
      is_cracked: 1,
      source: 'cracked',
    })
    setAdding(null)
    if (res?.ok) {
      setFound(prev => (prev || []).filter(x => x.appId !== g.appId))
      setMsg({ type: 'success', text: `Added ${g.name || g.appId}. Set its executable in Edit to track playtime.` })
    } else {
      setMsg({ type: 'error', text: 'Could not add: ' + (res?.error || 'unknown') })
    }
  }

  async function dismiss(g) {
    await window.kozo?.api?.crack?.dismissDiscovered?.(g.appId)
    setFound(prev => (prev || []).filter(x => x.appId !== g.appId))
  }

  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <IconTrophy size={15} stroke={1.6} />
        <span>Achievement data on this PC</span>
      </div>
      <p className={s.sectionDesc}>
        Looks for emulator save folders holding unlocked achievements for games that aren't
        in your library yet. Nothing is added automatically.
      </p>

      <div className={s.keyRow}>
        <button type="button" className={s.testBtn} onClick={scan} disabled={busy}>
          {busy
            ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Looking…</>
            : <><IconSearch size={13} stroke={1.8} /> Look for achievement data</>
          }
        </button>
      </div>

      {found && found.length === 0 && (
        <StatusLine type="neutral">
          Nothing found that isn't already in your library.
        </StatusLine>
      )}

      {found && found.length > 0 && (
        <div className={s.pathList}>
          {found.map(g => (
            <div key={g.appId} className={s.pathRow}>
              <span className={s.pathText} title={g.path}>
                {g.name || `App ${g.appId}`} · {g.unlocked} unlocked · {g.source}
              </span>
              <button type="button" className={s.testBtn} disabled={addingId === g.appId}
                onClick={() => add(g)} style={{ marginRight: 6 }}>
                {addingId === g.appId ? 'Adding…' : 'Add'}
              </button>
              <button type="button" className={s.pathRemoveBtn} aria-label={`Never ask about ${g.name || g.appId}`}
                title="Never ask about this one again" onClick={() => dismiss(g)}>
                <IconMinus size={12} stroke={2} />
              </button>
            </div>
          ))}
        </div>
      )}

      <Message msg={msg} />
    </section>
  )
}

// ── Tab: Scan PC ─────────────────────────────────────────────────────────────
function ScanPCTab() {
  const [paths, setPaths]           = useState([])
  const [scanning, setScanning]     = useState(false)
  const [scanModal, setScanModal]   = useState(null)  // null | results[]
  const [scanMsg, setScanMsg]       = useState(null)  // { type, text }
  const [addedCount, setAddedCount] = useState(0)

  useEffect(() => {
    async function load() {
      if (!window.kozo?.api) return
      // Prefer the user's saved list; fall back to platform defaults on first run.
      const saved = await window.kozo.api.settings.get('scan_paths')
      if (saved?.ok && saved.data) {
        try {
          const arr = JSON.parse(saved.data)
          if (Array.isArray(arr)) { setPaths(arr); return }
        } catch {}
      }
      const res = await window.kozo.api.scanner?.getDefaultPaths?.()
      if (res?.ok) setPaths(res.data || [])
    }
    load()
  }, [])

  // Persist the current path list so it survives leaving/returning to Settings.
  async function persistPaths(next) {
    setPaths(next)
    await window.kozo?.api?.settings?.set('scan_paths', JSON.stringify(next))
  }

  async function runScan() {
    setScanning(true)
    setScanMsg(null)
    const res = await window.kozo?.api?.scanner?.scan?.(paths)
    setScanning(false)
    if (!res?.ok) { setScanMsg({ type: 'error', text: 'Scan failed: ' + (res?.error || 'unknown') }); return }
    const results = res.data || []
    if (results.length === 0) {
      setScanMsg({ type: 'neutral', text: 'No games found in the selected folders. Try adding a custom folder.' })
      return
    }
    setScanModal(results)
  }

  async function addFolder() {
    const res = await window.kozo?.api?.dialog?.pickFolder?.()
    if (res?.ok && res.data && !paths.includes(res.data)) {
      persistPaths([...paths, res.data])
    }
  }

  return (
    <>
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconFolder size={15} stroke={1.6} />
          <span>Scan PC for Games</span>
        </div>
        <p className={s.sectionDesc}>
          Scans your folders for installed games (Steam, Epic, GOG, cracked) and skips system apps. You pick which to add.
        </p>

        <div className={s.pathList}>
          {paths.map((p, i) => (
            <div key={i} className={s.pathRow}>
              <span className={s.pathText} title={p}>{p}</span>
              <button type="button" className={s.pathRemoveBtn} aria-label={`Remove ${p}`}
                onClick={() => persistPaths(paths.filter((_, j) => j !== i))}>
                <IconMinus size={12} stroke={2} />
              </button>
            </div>
          ))}
          <button type="button" className={s.pathAddBtn} onClick={addFolder}>
            <IconPlus size={13} stroke={2} /> Add folder
          </button>
        </div>

        <div className={s.keyRow}>
          <button type="button" className={s.testBtn} onClick={runScan} disabled={scanning || paths.length === 0}>
            {scanning
              ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Scanning…</>
              : <><IconSearch size={13} stroke={1.8} /> Scan now</>
            }
          </button>
          {addedCount > 0 && (
            <StatusLine type="success">
              {addedCount} game{addedCount === 1 ? '' : 's'} added to library
            </StatusLine>
          )}
        </div>

        <Message msg={scanMsg} />
      </section>

      <CrackedOnThisPC />

      {/* Results modal */}
      {scanModal && (
        <ScanResultModal
          results={scanModal}
          onClose={() => setScanModal(null)}
          onAdd={(count) => {
            setAddedCount(prev => prev + count)
            setScanModal(null)
          }}
        />
      )}
    </>
  )
}

function TrackingTab() {
  return (
    <div className={s.tabContent}>
      <IdleSection />
      <ScanPCTab />
    </div>
  )
}

// Segmented choice row (UI scale, spacing, corners, background mode, start
// page). `wrap` lets a long set of choices flow onto a second line.
function Segmented({ value, options, onChange, label, wrap = false }) {
  return (
    <div className={s.segRow}>
      <span className={s.segLabel}>{label}</span>
      <div className={`${s.seg} ${wrap ? s.segWrap : ''}`} role="radiogroup" aria-label={label}>
        {options.map(o => (
          <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value}
            className={`${s.segBtn} ${value === o.value ? s.segBtnOn : ''}`} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function SliderRow({ label, value, min, max, unit, onChange }) {
  return (
    <label className={s.segRow}>
      <span className={s.segLabel}>{label}</span>
      <input type="range" className={s.slider} min={min} max={max} value={value}
        onChange={e => onChange(Number(e.target.value))} />
      <span className={s.sliderValue}>{value}{unit}</span>
    </label>
  )
}

// Background → A game's art: click a game's wide art to use it. Search
// narrows the strip; the picked one carries an accent ring.
function GameArtPicker({ games, value, onPick }) {
  const [q, setQ] = useState('')
  const shown = games
    .filter(g => !q.trim() || g.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (String(a.id) === String(value) ? -1 : String(b.id) === String(value) ? 1 : (b.total_playtime_seconds || 0) - (a.total_playtime_seconds || 0)))
  return (
    <div className={s.artPicker}>
      <div className={s.segRow}>
        <span className={s.segLabel}>Game</span>
        <input className={s.artSearch} value={q} onChange={e => setQ(e.target.value)} placeholder="Search your games" />
      </div>
      <div className={s.artStrip} role="radiogroup" aria-label="Game art">
        {shown.length === 0 && <span className={s.artNone}>No games with art match.</span>}
        {shown.map(g => {
          const on = String(g.id) === String(value)
          return (
            <button key={g.id} type="button" role="radio" aria-checked={on} title={g.name}
              className={`${s.artTile} ${on ? s.artTileOn : ''}`} onClick={() => onPick(g)}>
              <img src={fileUrl(g.hero_local_path || g.banner_local_path)} alt="" loading="lazy" decoding="async" />
              <span className={s.artName}>{g.name}</span>
              {on && <span className={s.artCheck}><IconCheck size={13} stroke={2.4} /></span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const START_PAGES = [
  ...NAV_ITEMS.map(n => ({ value: n.path, label: n.label })),
  { value: '/profile', label: 'Profile' },
]

// Settings → Appearance: color, theme, fonts, cards, layout, what's shown,
// and sharing a look (LookCustomize); size, sidebar, start page and the
// background picture (AppearanceCustomize). Every change applies at once.
const THEMES = [
  { value: 'midnight', label: 'Midnight', bg: '#10101a', s2: '#161624' },
  { value: 'tint',     label: 'Accent tint', tint: true },
  { value: 'custom',   label: 'Custom', custom: true },
  { value: 'oled',     label: 'OLED black', bg: '#000000', s2: '#0b0b0f' },
  { value: 'slate',    label: 'Slate', bg: '#11151b', s2: '#19202a' },
  { value: 'nord',     label: 'Nord', bg: '#1d2230', s2: '#272e3d' },
  { value: 'mocha',    label: 'Mocha', bg: '#181412', s2: '#231d1a' },
  { value: 'forest',   label: 'Forest', bg: '#0e1411', s2: '#151f1a' },
  { value: 'crimson',  label: 'Crimson', bg: '#150e10', s2: '#201618' },
]

const CARD_STYLES = [
  { value: 'classic', label: 'Classic', desc: 'Name on the art, stats below' },
  { value: 'poster',  label: 'Poster', desc: 'Just the cover, details on hover' },
  { value: 'glass',   label: 'Glass', desc: 'Name and stats on a tinted band' },
  { value: 'minimal', label: 'Minimal', desc: 'Cover and name, nothing else' },
]

// A real Library card for the preview: the most played game with art.
function useSampleGame() {
  const [game, setGame] = useState(null)
  useEffect(() => {
    window.kozo?.api?.games?.list?.().then(r => {
      if (!r?.ok) return
      const withArt = (r.data || []).filter(g => g.banner_local_path || g.banner_url)
      withArt.sort((a, b) => (b.total_playtime_seconds || 0) - (a.total_playtime_seconds || 0))
      setGame(withArt[0] || (r.data || [])[0] || null)
    })
  }, [])
  return game
}

function LookCustomize() {
  const { prefs, setPrefs } = useAppearance()
  const { accent, setAccent, presets } = useAccentColor()
  const sample = useSampleGame()
  const art = sample ? (sample.banner_local_path ? fileUrl(sample.banner_local_path) : sample.banner_url) : null
  const [code, setCode] = useState('')
  const [codeMsg, setCodeMsg] = useState(null)
  function exportLook() {
    const json = JSON.stringify({ v: 1, accent, prefs: { ...prefs, nav: undefined, bg: { ...prefs.bg, image: null, gameArt: null, gameId: null } } })
    const out = 'KOZO-' + btoa(unescape(encodeURIComponent(json)))
    navigator.clipboard?.writeText(out).then(() => setCodeMsg({ type: 'success', text: 'Copied. Paste it on another PC, or send it to a friend.' }))
      .catch(() => { setCode(out); setCodeMsg({ type: 'info', text: 'Copy the code from the box.' }) })
  }
  function importLook() {
    try {
      const raw = code.trim().replace(/^KOZO-/, '')
      const data = JSON.parse(decodeURIComponent(escape(atob(raw))))
      if (!data?.prefs) throw new Error()
      setPrefs(p => ({ ...p, ...data.prefs, nav: p.nav, bg: { ...p.bg, ...data.prefs.bg, image: p.bg.image, gameArt: p.bg.gameArt, gameId: p.bg.gameId } }))
      if (data.accent) setAccent(data.accent)
      setCode(''); setCodeMsg({ type: 'success', text: 'Look applied.' })
    } catch { setCodeMsg({ type: 'error', text: "That code doesn't look right." }) }
  }
  return (
    <>
      <section className={s.section}>
        <div className={s.sectionHeader}><IconPalette size={15} stroke={1.6} /><span>Color</span></div>
        <p className={s.sectionDesc}>The highlight color for buttons, active tabs and badges.</p>
        <div className={s.swatchGrid}>
          {presets.map(p => (
            <button key={p.value} type="button" aria-pressed={accent === p.value}
              className={`${s.swatch} ${accent === p.value ? s.swatchActive : ''}`}
              style={{ '--sw': p.value }} onClick={() => setAccent(p.value)} title={p.label}>
              <span className={s.swatchDot} />
              {accent === p.value && <IconCheck size={12} stroke={2.5} className={s.swatchCheck} />}
              <span className={s.swatchLabel}>{p.label}</span>
            </button>
          ))}
        </div>
        <div className={s.colorRows}>
          <div className={s.colorRow}>
            <span className={s.segLabel}>Any color</span>
            <ColorPicker value={accent} onChange={setAccent} presets={presets} label="Accent color" />
            <span className={s.sectionDescQuiet}>Very dark colors are brightened so text stays readable.</span>
          </div>
          <div className={s.colorRow}>
            <span className={s.segLabel}>Second color</span>
            <ColorPicker value={prefs.accent2} onChange={v => setPrefs({ accent2: v })} presets={presets} label="Second color"
              allowClear clearLabel="Same as accent" />
            <span className={s.sectionDescQuiet}>Blends into progress bars, the XP ring, the Upcoming banner and the moving glow.</span>
          </div>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconPalette size={15} stroke={1.6} /><span>Theme</span></div>
        <div className={s.themeGrid}>
          {THEMES.map(t => (
            <button key={t.value} type="button" aria-pressed={prefs.theme === t.value}
              className={`${s.themeBtn} ${prefs.theme === t.value ? s.themeOn : ''}`} onClick={() => setPrefs({ theme: t.value })}
              style={t.tint
                ? { '--tbg': `color-mix(in srgb, ${accent} 12%, #0b0b10)`, '--ts2': `color-mix(in srgb, ${accent} 22%, #121218)` }
                : t.custom
                  ? (() => { const c = bgTone(prefs.bgColor); return { '--tbg': `hsl(${c.h} ${c.s}% ${c.l}%)`, '--ts2': `hsl(${c.h} ${c.s}% ${c.l + 3.2}%)` } })()
                  : { '--tbg': t.bg, '--ts2': t.s2 }}>
              <span className={s.themeSwatch}><span /><span /></span>
              {t.label}
            </button>
          ))}
        </div>
        <div className={s.colorRows}>
          <div className={s.colorRow}>
            <span className={s.segLabel}>Background color</span>
            <ColorPicker value={prefs.bgColor} onChange={v => v && setPrefs({ bgColor: v, theme: 'custom' })} presets={presets} label="Background color" />
            <span className={s.sectionDescQuiet}>Any color, kept dark so text and cards stay readable. Picking one switches to Custom.</span>
          </div>
        </div>
        <p className={s.sectionDescQuiet}>Accent tint colors the background with your accent color.</p>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconTextSize size={15} stroke={1.6} /><span>Text</span></div>
        <p className={s.sectionDesc}>One font for all of KoZo: menus, cards, titles and Big Picture.</p>
        <div className={s.fontGrid}>
          {Object.entries(FONTS).map(([value, f]) => (
            <button key={value} type="button" aria-pressed={prefs.font === value}
              className={`${s.fontTile} ${prefs.font === value ? s.fontTileOn : ''}`} onClick={() => setPrefs({ font: value })}
              style={{ fontFamily: f.css, letterSpacing: f.track || 'normal' }}>
              <span className={s.fontSample}>{sample?.name || 'Hollow Knight'}</span>
              <span className={s.fontName}>{f.label}{f.note ? <em> · {f.note}</em> : null}</span>
            </button>
          ))}
        </div>
        <div className={s.segList}>
          <Segmented label={`Text size ${Math.round((prefs.textScale || 1) * 100)}%`} value={prefs.textScale} onChange={v => setPrefs({ textScale: v })}
            options={[0.9, 1, 1.05, 1.1, 1.2].map(v => ({ value: v, label: `${Math.round(v * 100)}%` }))} />
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconLayoutCards size={15} stroke={1.6} /><span>Game page</span></div>
        <p className={s.sectionDesc}>The layout of a game's own page. The switch at the top of every game page changes it too.</p>
        <div className={s.cardStyles} role="radiogroup" aria-label="Game page layout">
          {[
            { value: 'store', label: 'Store', desc: 'Cover beside the name, your stats in a side panel' },
            { value: 'cinematic', label: 'Cinematic', desc: 'Big art with the name and stats over it' },
          ].map(c => (
            <button key={c.value} type="button" role="radio" aria-checked={prefs.gamePage === c.value}
              className={`${s.cardStyleTile} ${prefs.gamePage === c.value ? s.cardStyleOn : ''}`} onClick={() => setPrefs({ gamePage: c.value })}>
              <span className={s.cardStyleText}><strong>{c.label}</strong><small>{c.desc}</small></span>
              {prefs.gamePage === c.value && <IconCheck size={14} stroke={2.6} className={s.cardStyleCheck} />}
            </button>
          ))}
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconLayoutCards size={15} stroke={1.6} /><span>Game cards</span></div>
        <p className={s.sectionDesc}>How cards look in the Library and the Game List.</p>
        <div className={s.cardStudio}>
          <div className={s.cardStyles} role="radiogroup" aria-label="Card style">
            {CARD_STYLES.map(c => (
              <button key={c.value} type="button" role="radio" aria-checked={prefs.cardStyle === c.value}
                className={`${s.cardStyleTile} ${prefs.cardStyle === c.value ? s.cardStyleOn : ''}`} onClick={() => setPrefs({ cardStyle: c.value })}>
                <span className={`${s.mini} ${s['mini_' + c.value]}`}>
                  {art ? <img src={art} alt="" /> : <span className={s.miniArt} />}
                  <span className={s.miniName}>{sample?.name || 'Game name'}</span>
                  <span className={s.miniStats}><i /><i /><i /></span>
                </span>
                <span className={s.cardStyleText}><strong>{c.label}</strong><small>{c.desc}</small></span>
                {prefs.cardStyle === c.value && <IconCheck size={14} stroke={2.6} className={s.cardStyleCheck} />}
              </button>
            ))}
          </div>
          <div className={s.cardPreview} aria-hidden="true" onClickCapture={e => { e.stopPropagation(); e.preventDefault() }}>
            {sample ? <GameCard game={{ ...sample, _isLive: false }} view="big" /> : <div className={s.cardPreviewEmpty}>Add a game to see it here</div>}
            <span className={s.cardPreviewLabel}>Live preview</span>
          </div>
        </div>
        <div className={s.segList}>
          <Segmented label="Border" value={prefs.cardBorder} onChange={v => setPrefs({ cardBorder: v })}
            options={[{ value: 'none', label: 'None' }, { value: 'subtle', label: 'Subtle' }, { value: 'accent', label: 'Accent' }]} />
          <Segmented label="Hover glow" value={prefs.cardGlow} onChange={v => setPrefs({ cardGlow: v })}
            options={[{ value: 'off', label: 'Off' }, { value: 'soft', label: 'Soft' }, { value: 'strong', label: 'Strong' }]} />
          <Segmented label="Shadow" value={prefs.cardShadow} onChange={v => setPrefs({ cardShadow: v })}
            options={[{ value: 'flat', label: 'Flat' }, { value: 'normal', label: 'Normal' }, { value: 'deep', label: 'Deep' }]} />
        </div>
        <div className={s.chipToggles}>
          {[['genres', 'Genres'], ['stats', 'Stats row'], ['progress', 'Achievement bar'], ['statusDot', 'Status dot'], ['planChip', 'Play plan month']].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={!!prefs.cards[k]} className={`${s.chipToggle} ${prefs.cards[k] ? s.chipToggleOn : ''}`}
              onClick={() => setPrefs(p => ({ ...p, cards: { ...p.cards, [k]: !p.cards[k] } }))}>
              {prefs.cards[k] ? <IconCheck size={12} stroke={2.6} /> : <IconX size={12} stroke={2.2} />} {l}
            </button>
          ))}
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconLayoutSidebar size={15} stroke={1.6} /><span>Layout and effects</span></div>
        <div className={s.segList}>
          <Segmented label="Accent glow" value={prefs.glow} onChange={v => setPrefs({ glow: v })}
            options={[{ value: 'off', label: 'Off' }, { value: 'soft', label: 'Soft' }, { value: 'strong', label: 'Strong' }]} />
          <Segmented label="Sidebar side" value={prefs.sidebarSide} onChange={v => setPrefs({ sidebarSide: v })}
            options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />
          <Segmented label="Sidebar width" value={prefs.sidebarWidth} onChange={v => setPrefs({ sidebarWidth: v })}
            options={[{ value: 180, label: 'Narrow' }, { value: 205, label: 'Normal' }, { value: 240, label: 'Wide' }]} />
          <Segmented label="Page width" value={prefs.pageWidth} onChange={v => setPrefs({ pageWidth: v })}
            options={[{ value: 'full', label: 'Full window' }, { value: 'centered', label: 'Centered' }]} />
          <Segmented label="Moving glow" value={prefs.ambient} onChange={v => setPrefs({ ambient: v })}
            options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]} />
          <Segmented label="Scrollbars" value={prefs.scrollbar} onChange={v => setPrefs({ scrollbar: v })}
            options={[{ value: 'thin', label: 'Thin' }, { value: 'hidden', label: 'Hidden' }]} />
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconEye size={15} stroke={1.6} /><span>Show or hide</span></div>
        <div className={s.toggleList}>
          <ToggleRow label="Library numbers" desc="The Games, Playtime, Achievements and This week boxes above the Library." checked={!prefs.hideLibraryStats} onChange={v => setPrefs({ hideLibraryStats: !v })} />
          <ToggleRow label="Upcoming banner" desc="The big rotating banner and This week row on Upcoming." checked={!prefs.hideUpcomingHero} onChange={v => setPrefs({ hideUpcomingHero: !v })} />
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconCopy size={15} stroke={1.6} /><span>Share your look</span></div>
        <p className={s.sectionDesc}>Copy your whole look (colors, theme, fonts, cards, layout) as a code, or paste one to use it.</p>
        <div className={s.keyRow}>
          <button type="button" className={s.testBtn} onClick={exportLook}><IconCopy size={13} /> Copy my look</button>
          <div className={`${s.keyInputWrap} hasRing`}>
            <input className={s.keyInput} placeholder="Paste a KOZO- code" value={code} onChange={e => setCode(e.target.value)} spellCheck={false} aria-label="Look code" />
          </div>
          <button type="button" className={s.testBtn} onClick={importLook} disabled={!code.trim()}>Use it</button>
        </div>
        {codeMsg && <StatusLine type={codeMsg.type}>{codeMsg.text}</StatusLine>}
      </section>
    </>
  )
}

function AppearanceCustomize() {
  const { prefs, setPrefs } = useAppearance()
  const [games, setGames] = useState([])
  useEffect(() => {
    window.kozo?.api?.games?.list?.().then(r => {
      if (r?.ok) setGames((r.data || []).filter(g => g.hero_local_path || g.banner_local_path))
    })
  }, [])
  const setCard = (k, v) => setPrefs(p => ({ ...p, cards: { ...p.cards, [k]: v } }))
  const setBg = (patch) => setPrefs(p => ({ ...p, bg: { ...p.bg, ...patch } }))
  function moveNav(i, d) {
    setPrefs(p => {
      const nav = [...p.nav]
      const j = i + d
      if (j < 0 || j >= nav.length) return p
      ;[nav[i], nav[j]] = [nav[j], nav[i]]
      return { ...p, nav }
    })
  }
  const toggleNav = (path) => setPrefs(p => ({ ...p, nav: p.nav.map(n => (n.path === path ? { ...n, hidden: !n.hidden } : n)) }))
  async function chooseImage() {
    const r = await window.kozo?.api?.dialog?.pickWallpaper?.()
    if (r?.ok && r.data) setBg({ mode: 'image', image: r.data })
  }

  return (
    <>
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconLayoutSidebar size={15} stroke={1.6} />
          <span>Sidebar and start page</span>
        </div>
        <Segmented label="Style" value={prefs.sidebar || 'full'} onChange={v => setPrefs({ sidebar: v })}
          options={[{ value: 'full', label: 'Full' }, { value: 'rail', label: 'Slim (icons only)' }]} />
        <p className={s.sectionDesc}>Reorder the sidebar tabs or hide the ones you don't use. Library always stays.</p>
        <div className={s.navList}>
          {prefs.nav.map((n, i) => {
            const item = NAV_ITEMS.find(x => x.path === n.path)
            if (!item) return null
            return (
              <div key={n.path} className={`${s.navRow} ${n.hidden ? s.navRowHidden : ''}`}>
                <item.Icon size={16} stroke={1.6} />
                <span className={s.navRowLabel}>{item.label}</span>
                <button type="button" className={s.navRowBtn} onClick={() => moveNav(i, -1)} disabled={i === 0}
                  aria-label={`Move ${item.label} up`}><IconArrowUp size={14} /></button>
                <button type="button" className={s.navRowBtn} onClick={() => moveNav(i, 1)} disabled={i === prefs.nav.length - 1}
                  aria-label={`Move ${item.label} down`}><IconArrowDown size={14} /></button>
                <button type="button" className={s.navRowBtn} onClick={() => toggleNav(n.path)} disabled={n.path === '/'}
                  aria-label={n.hidden ? `Show ${item.label}` : `Hide ${item.label}`} title={n.hidden ? 'Show' : 'Hide'}>
                  {n.hidden ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                </button>
              </div>
            )
          })}
        </div>
        <Segmented label="Start page" value={prefs.startPage || '/'} onChange={v => setPrefs({ startPage: v })}
          options={START_PAGES} wrap />
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconTextSize size={15} stroke={1.6} />
          <span>Size and density</span>
        </div>
        <div className={s.segList}>
          <Segmented label={`UI scale ${Math.round((prefs.scale || 1) * 100)}%`} value={prefs.scale} onChange={v => setPrefs({ scale: v })}
            options={[{ value: 0.9, label: '90%' }, { value: 1, label: '100%' }, { value: 1.1, label: '110%' }, { value: 1.25, label: '125%' }]} />
          <Segmented label="Spacing" value={prefs.density} onChange={v => setPrefs({ density: v })}
            options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
          <Segmented label="Corners" value={prefs.corners} onChange={v => setPrefs({ corners: v })}
            options={[{ value: 'sharp', label: 'Sharp' }, { value: 'default', label: 'Default' }, { value: 'round', label: 'Round' }]} />
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconSparkles size={15} stroke={1.6} />
          <span>Animations</span>
        </div>
        <p className={s.sectionDesc}>
          {prefs.motion === 'heavy' ? 'Pages rise in, cards spring in one after another and lift with a glow, dialogs pop. Big Picture zooms, slides and drifts.'
            : prefs.motion === 'off' ? 'Nothing moves. Pages and cards show at once.'
            : 'Pages fade in, cards rise in and lift when you point at them, buttons press in. Big Picture eases between games.'}
        </p>
        <div className={s.segList}>
          <Segmented label="Motion" value={prefs.motion || 'soft'} onChange={v => setPrefs({ motion: v })}
            options={[{ value: 'heavy', label: 'Heavy' }, { value: 'soft', label: 'Soft' }, { value: 'off', label: 'Off' }]} />
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconPhoto size={15} stroke={1.6} />
          <span>Background</span>
        </div>
        <p className={s.sectionDesc}>Put a picture behind every page. Cards and panels stay solid so text is easy to read.</p>
        <div className={s.segList}>
          <Segmented label="Picture" value={prefs.bg.mode} onChange={v => {
            // "A game's art" with nothing picked yet: start from your most
            // played game that has art, so the change shows at once.
            if (v === 'game' && !prefs.bg.gameArt && games.length) {
              const g = [...games].sort((a, b) => (b.total_playtime_seconds || 0) - (a.total_playtime_seconds || 0))[0]
              setBg({ mode: v, gameId: g.id, gameArt: g.hero_local_path || g.banner_local_path })
            } else setBg({ mode: v })
          }}
            options={[{ value: 'off', label: 'Off' }, { value: 'image', label: 'My image' }, { value: 'game', label: "A game's art" }]} />
          {prefs.bg.mode === 'image' && (
            <div className={s.segRow}>
              <span className={s.segLabel}>Image</span>
              <button type="button" className={s.testBtn} onClick={chooseImage}>
                <IconPhoto size={14} stroke={1.7} /> {prefs.bg.image ? 'Change picture' : 'Choose picture'}
              </button>
            </div>
          )}
          {prefs.bg.mode === 'game' && (
            <GameArtPicker games={games} value={prefs.bg.gameId}
              onPick={g => setBg({ gameId: g.id, gameArt: g.hero_local_path || g.banner_local_path })} />
          )}
          {prefs.bg.mode !== 'off' && (
            <>
              <SliderRow label="Blur" value={prefs.bg.blur} min={0} max={30} unit="px" onChange={v => setBg({ blur: v })} />
              <SliderRow label="Darkness" value={prefs.bg.dim} min={40} max={95} unit="%" onChange={v => setBg({ dim: v })} />
            </>
          )}
        </div>
      </section>
      <div>
        <button type="button" className={s.testBtn} onClick={() => setPrefs(DEFAULT_APPEARANCE)}>
          <IconRefresh size={14} stroke={1.7} /> Reset appearance
        </button>
      </div>
    </>
  )
}

// ── Tab: Appearance ──────────────────────────────────────────────────────────
function AppearanceTab() {
  return (
    <div className={s.tabContent}>
      <LookCustomize />
      <AppearanceCustomize />
    </div>
  )
}

// ── Tab: Features ─────────────────────────────────────────────────────────────
const FEATURE_GROUPS = [
  {
    title: 'Tracking',
    items: [
      { Icon: IconClock,    name: 'Automatic playtime', go: '/activity?tab=sessions', desc: 'Detects running games and records sessions, no manual timers.' },
      { Icon: IconHistory,  name: 'Sessions timeline', go: '/activity?tab=sessions',  desc: 'Every play session grouped by day with durations and unlocks.' },
      { Icon: IconBolt,     name: 'Idle / AFK pause', go: 'tab:tracking',   desc: 'Stops counting when you step away so overnight idling doesn’t inflate stats.' },
    ],
  },
  {
    title: 'Achievements',
    items: [
      { Icon: IconBrandSteam, name: 'Steam sync', go: '/activity?tab=achievements',        desc: 'Imports your unlocks via the Steam Web API, automatically while you play and after each session. No interval to set.' },
      { Icon: IconTrophy,     name: 'Cracked-game sync', go: '/activity?tab=achievements', desc: 'Reads Goldberg, CODEX, RUNE, EMPRESS, SKIDROW and more, watched live, so unlocks appear instantly.' },
      { Icon: IconBell,       name: 'Live game overlay', go: 'overlay:test', desc: 'A toast pops over your game the moment you unlock something, Steam-style, in your accent color.' },
      { Icon: IconDownload,   name: 'Achievement lists for any launcher', go: '/activity?tab=achievements', desc: "Xbox/Epic/other games auto-match a Steam achievement list on add, then tick off the ones you've earned." },
    ],
  },
  {
    title: 'Library',
    items: [
      { Icon: IconSearch,         name: 'Scan PC', go: '/?scan=1',          desc: 'Finds installed games (Steam, Epic, GOG, Xbox, cracked) on your drives, with the right launcher badge, right from the Library toolbar.' },
      { Icon: IconDeviceGamepad2, name: 'Add manually', go: '/?add=1',     desc: 'Point KoZo at any .exe, perfect for offline games.' },
      { Icon: IconDownload,       name: 'Import from launchers', go: '/?launchers=1', desc: 'Finds the games installed through Epic, GOG and Xbox and adds the ones you pick, with Play going through their launcher.' },
      { Icon: IconStar,           name: 'Favorites', go: '/',        desc: 'Star a game to pin it to the top of your Library and Game List.' },
      { Icon: IconList,           name: 'Game List', go: '/game-list',        desc: 'A backlog / wishlist with statuses, genres, search, and Spotify-style custom lists.' },
      { Icon: IconStar,           name: 'Discounts', go: '/deals',         desc: 'Steam sales ranked for you: your Game List games on sale first (with a badge when one goes on sale), a deal score from the discount, reviews and your taste, and whether it is the lowest price ever.' },
      { Icon: IconStar,           name: 'Games like', go: '/like',          desc: 'Search any game and see the games that play most like it, ranked by shared Steam tags, Steam\'s own picks and reviews, with the reasons.' },
      { Icon: IconEyeOff,         name: 'Status filter & hidden games', go: '/', desc: 'Filter the Library by Playing/Finished/Dropped/On hold; hidden games tuck into a collapsed section at the bottom (their stats still count).' },
      { Icon: IconLayoutGrid,     name: 'Drag & drop ordering', go: '/', desc: 'Pick "Custom order" and drag cards into any arrangement you like, in the Library and the Game List.' },
    ],
  },
  {
    title: 'Saves & Backups',
    items: [
      { Icon: IconDeviceFloppy, name: 'Saves found for you', go: 'tab:data', desc: 'KoZo finds where each game saves by itself: known locations, cracked-game folders, Steam Cloud, and the folders a game writes while you play.' },
      { Icon: IconArchive,      name: 'Automatic save backups', go: 'tab:data', desc: 'Before and after every session, with restore points by day. Only changed files take space. Restore any game, or all of them at once.' },
      { Icon: IconCloud,        name: 'Google Drive copy', go: 'tab:data', desc: 'Your saves and library copied to your Google Drive, so even a full format cannot take them. Get everything back on a new PC in one click.' },
    ],
  },
  {
    title: 'Personalize',
    items: [
      { Icon: IconUser,      name: 'Your profile', go: '/profile',  desc: 'A profile page with a cropped avatar & banner, banner themes, a title, and a showcase of your favorite games.' },
      { Icon: IconBolt,      name: 'XP & levels', go: '/profile',   desc: 'Earn XP from playtime, rare achievements, play streaks and finished games, level up through tiers from Rookie to Mythic, shown on your profile.' },
      { Icon: IconPalette,   name: 'Custom accent', go: 'tab:appearance', desc: 'Pick any accent (presets or custom hex), it themes the whole app, badges, and the live overlay.' },
    ],
  },
  {
    title: 'Insights & App',
    items: [
      { Icon: IconChartBar,  name: 'Statistics', go: '/activity?tab=overview',    desc: 'Playtime trends with an hourly 24h view, daily/monthly charts, and click-a-day (or hour) to focus it.' },
      { Icon: IconBell,      name: 'In-game status (Alt+K)', go: 'tab:shortcuts', desc: 'Press Alt+K while playing to flash your live session time and achievement progress over the game.' },
      { Icon: IconTrophy,    name: 'Achievement list (Alt+J)', go: 'tab:shortcuts', desc: 'Press Alt+J while playing to flash your progress and the rarest achievements you still have left, right over the game.' },
      { Icon: IconRocket,    name: 'Tray & startup', go: 'tab:general',desc: 'Runs quietly in the system tray and can launch with Windows.' },
      { Icon: IconRocket,    name: 'Open KoZo from anywhere', go: 'tab:shortcuts', desc: 'Press Ctrl+Shift+K, or hold the Xbox button on a controller for a second (pick another combo in Shortcuts), to bring KoZo up (in Big Picture) even when it is closed to the tray.' },
      { Icon: IconDeviceTv,  name: 'Big Picture', go: '/big', desc: 'Full screen for the TV: big posters, your recent games and Up next, made for the controller.' },
      { Icon: IconBrandDiscord, name: 'Discord status', go: 'tab:accounts', desc: 'Discord shows the game you are playing, your KoZo level and your hours in it.' },
      { Icon: IconDeviceGamepad2, name: 'Controller control', go: 'tab:shortcuts', desc: 'Drive the whole app with a controller: D-pad to move, A to select, B to go back, X for options, Y to search, LB and RB to switch tabs.' },
    ],
  },
]

// Every feature row opens where that feature lives: a page, a Settings tab,
// or the action itself (Scan PC, the overlay test).
function FeaturesTab({ setTab }) {
  const navigate = useNavigate()
  function open(go) {
    if (!go) return
    if (go.startsWith('tab:')) setTab(go.slice(4))
    else if (go === 'overlay:test') window.kozo?.api?.overlay?.test?.()
    else navigate(go)
  }
  return (
    <div className={s.tabContent}>
      <p className={s.sectionDesc}>
        Everything KoZo can do, grouped by area. Click a feature to go straight to it.
      </p>
      {FEATURE_GROUPS.map(group => (
        <section key={group.title} className={s.featureGroup}>
          <div className={s.featureGroupTitle}>{group.title}</div>
          <div className={s.featureList}>
            {group.items.map(f => (
              <button key={f.name} type="button" data-gpnav="" className={`${s.featureRow} ${s.featureRowLink}`} onClick={() => open(f.go)}>
                <div className={s.featureIcon}><f.Icon size={18} stroke={1.6} /></div>
                <div className={s.featureRowBody}>
                  <div className={s.featureName}>{f.name}</div>
                  <div className={s.featureDesc}>{f.desc}</div>
                </div>
                <IconChevronRight size={16} stroke={1.6} className={s.featureGo} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

// ── Tab: About ───────────────────────────────────────────────────────────────
function AboutTab() {
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)   // null | { ok, steps }
  const [version, setVersion] = useState('')
  const [updState, setUpdState] = useState('idle')     // idle | checking | done
  const [updResult, setUpdResult] = useState(null)

  useEffect(() => {
    window.kozo?.api?.app?.getVersion?.().then(res => {
      if (res?.ok) setVersion(res.data)
    })
  }, [])

  async function runTrackingTest() {
    setTesting(true)
    setTestResult(null)
    const res = await window.kozo?.api?.diagnostics?.trackingSelfTest?.()
    setTesting(false)
    setTestResult(res?.ok ? res.data : (res || { ok: false, steps: [] }))
  }

  async function checkUpdates() {
    setUpdState('checking')
    setUpdResult(null)
    const res = await window.kozo?.api?.app?.checkForUpdates?.()
    setUpdResult(res?.ok ? res.data : res)
    setUpdState('done')
  }

  // One place decides how an update check reads, instead of a five-deep ternary
  // inline in the markup.
  function updateLine(r) {
    if (r.error) {
      return ['error', r.error === 'timed_out'
        ? "Couldn't reach the update server. Check your connection."
        : r.error]
    }
    if (r.notConfigured) return ['info', 'Update source not configured yet (set build.publish in package.json).']
    if (r.noReleases) return ['info', `No releases published on ${r.repo} yet. Build the app and publish a GitHub release to enable updates.`]
    if (r.updateAvailable) {
      return ['success', `Update ${r.latest} available (you have ${r.current})${r.dev || r.manualOnly ? '' : '. Downloading in the background.'}`]
    }
    return ['success', `You're up to date${r.latest ? `. ${r.latest} is the latest release` : ''}${r.dev ? ' (dev build, checked against GitHub)' : ''}.`]
  }

  return (
    <div className={s.tabContent}>
      <section className={s.section}>
        <div className={s.aboutCard}>
          <div className={s.aboutLogo}><HoneycombLogo size={44} /></div>
          <div className={s.aboutInfo}>
            <div className={s.aboutName}>KoZo</div>
            <div className={s.aboutVersion}>Version {version || '…'}</div>
            <div className={s.aboutDesc}>
              A local-first game tracker for Windows. Track playtime, sessions, and
              achievements, even for cracked and offline games.
            </div>
          </div>
        </div>
        <div className={s.keyRow}>
          <button type="button" className={s.testBtn} onClick={checkUpdates} disabled={updState === 'checking'}>
            {updState === 'checking'
              ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Checking…</>
              : <><IconRefresh size={13} stroke={1.8} /> Check for updates</>}
          </button>
        </div>
        {updState === 'done' && updResult && (() => {
          const [type, text] = updateLine(updResult)
          const showLink = updResult.updateAvailable && (updResult.dev || updResult.manualOnly) && updResult.releaseUrl
          return (
            <StatusLine type={type}>
              {text}
              {showLink && (
                <>
                  {' '}
                  <button type="button" className={s.linkBtn}
                    onClick={() => window.kozo?.api?.shell?.openExternal(updResult.releaseUrl)}>
                    Open release page
                  </button>
                </>
              )}
            </StatusLine>
          )
        })()}
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconInfoCircle size={15} stroke={1.6} /><span>Details</span></div>
        <div className={s.aboutDetails}>
          {[
            ['Platform',            'Windows (Electron 41)'],
            ['Runtime',             'React 19 + SQLite'],
            ['Data storage',        'Local, nothing leaves your PC'],
            ['Steam integration',   'Steam Web API (optional). Public profiles sync without a key'],
            ['Crack support',       'Goldberg, CODEX, EMPRESS, ALI213, SSE, CreamAPI, SKIDROW, Reloaded, online-fix'],
          ].map(([k, v]) => (
            <div key={k} className={s.aboutDetailRow}>
              <span className={s.aboutDetailKey}>{k}</span>
              <span className={s.aboutDetailVal}>{v}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Diagnostics — push-button proof the critical pipeline works */}
      <section className={s.section}>
        <div className={s.sectionHeader}><IconStethoscope size={15} stroke={1.6} /><span>Diagnostics</span></div>
        <p className={s.sectionDesc}>
          Verify the achievement pipeline end to end: KoZo plants a synthetic crack file,
          runs the real scanner on it, records the unlock in the database, and fires the
          real in-game overlay toast, then cleans everything up.
        </p>
        <div className={s.keyRow}>
          <button type="button" className={s.testBtn} onClick={runTrackingTest} disabled={testing}>
            {testing
              ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Testing…</>
              : <><IconTrophy size={13} stroke={1.8} /> Test achievement tracking</>}
          </button>
          <button type="button" className={s.testBtn} onClick={() => window.kozo?.api?.overlay?.test?.()}>
            <IconBell size={13} stroke={1.8} /> Test notifications
          </button>
        </div>
        {testResult && (
          <div className={s.statusStack}>
            {(testResult.steps || []).map((st, i) => (
              <StatusLine key={i} type={st.ok ? 'success' : 'error'}>
                {st.name}{st.detail ? <span className={s.statusDetail}>: {st.detail}</span> : null}
              </StatusLine>
            ))}
            <StatusLine type={testResult.ok ? 'success' : 'error'} className={s.statusSummary}>
              {testResult.ok
                ? 'Achievement tracking is working on this PC.'
                : 'Something failed. See the steps above.'}
            </StatusLine>
          </div>
        )}
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}><IconRocket size={15} stroke={1.6} /><span>Getting Started</span></div>
        <p className={s.sectionDesc}>New here, or want a refresher on setup and features?</p>
        <div className={s.keyRow}>
          <button
            type="button"
            className={s.testBtn}
            onClick={() => window.dispatchEvent(new Event('kozo:show-onboarding'))}
          >
            <IconRocket size={13} stroke={1.8} /> Show the walkthrough
          </button>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconCode size={15} stroke={1.6} />
          <span>Dev</span>
        </div>
        <p className={s.sectionDesc}>
          Developer options for testing KoZo, locked with a password.
        </p>
        <RestrictedContent />
      </section>
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────
// Grouped like the sidebar: the app itself, your games, your data, help.
const TABS = [
  { key: 'general',    label: 'General',    group: 'App',   Icon: IconSettings,   desc: 'Starting with Windows and graphics.' },
  { key: 'appearance', label: 'Appearance', group: 'App',   Icon: IconPalette,    desc: 'Colors, the sidebar, sizes, animations, a background picture and what cards show.' },
  { key: 'shortcuts',  label: 'Shortcuts',  group: 'App',   Icon: IconKeyboard,   desc: 'Every keyboard shortcut and controller button.' },
  { key: 'tracking',   label: 'Tracking',   group: 'Games', Icon: IconClock,      desc: 'How playtime is counted, and where KoZo looks for your games.' },
  { key: 'accounts',   label: 'Connections', group: 'Games', Icon: IconPlugConnected, desc: 'Steam, Discord, covers and Google Drive.' },
  { key: 'data',       label: 'Backups',    group: 'Data',  Icon: IconArchive,    desc: 'Your game saves and your library, backed up on their own.' },
  { key: 'features',   label: 'Features',   group: 'Help',  Icon: IconLayoutGrid, desc: 'Everything KoZo can do, with a link to each.' },
  { key: 'about',      label: 'About',      group: 'Help',  Icon: IconInfoCircle, desc: 'Version, updates, diagnostics and the walkthrough.' },
]
// Old tab names (links from other pages) land on their new home.
const TAB_ALIASES = { steam: 'accounts', scan: 'tracking' }

export default function Settings() {
  // `?tab=<key>` (or an old alias) opens that tab; links and the URL stay in step.
  const [params, setParams] = useSearchParams()
  const want = TAB_ALIASES[params.get('tab')] || params.get('tab')
  const tab = TABS.some(t => t.key === want) ? want : 'general'
  const setTab = (t) => setParams({ tab: TAB_ALIASES[t] || t }, { replace: true })
  const current = TABS.find(t => t.key === tab) || TABS[0]
  const [saveGame, setSaveGame] = useState(null)   // game whose saves are being managed
  return (
    <div className={s.page}>
      <div className={s.toolbar}><h1 className={s.pageTitle}>Settings</h1></div>
      <div className={s.layout}>
        <nav className={s.nav} aria-label="Settings sections">
          {TABS.map((t, i) => (
            <React.Fragment key={t.key}>
              {(i === 0 || TABS[i - 1].group !== t.group) && <div className={s.navGroup}>{t.group}</div>}
              <button
                type="button"
                aria-current={tab === t.key ? 'page' : undefined}
                className={`${s.navItem} ${tab === t.key ? s.navActive : ''}`}
                onClick={() => setTab(t.key)}>
                <t.Icon size={15} stroke={1.7} className={s.navItemIcon} />
                {t.label}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className={s.panel}>
          <div className={s.tabIntro}>
            <h2 className={s.tabTitle}>{current.label}</h2>
            <p className={s.tabDesc}>{current.desc}</p>
          </div>
          {tab === 'features'   && <FeaturesTab setTab={setTab} />}
          {tab === 'general'    && <GeneralTab />}
          {tab === 'shortcuts'  && <ShortcutsTab />}
          {tab === 'accounts'   && <SteamTab />}
          {tab === 'tracking'   && <TrackingTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'data'       && <BackupsTab onManageSaves={setSaveGame} />}
          {tab === 'about'      && <AboutTab />}
        </div>
      </div>

      {saveGame && (
        <SaveManagerModal game={saveGame} onClose={() => setSaveGame(null)} />
      )}
    </div>
  )
}
