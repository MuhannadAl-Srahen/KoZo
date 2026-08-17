import React, { useState, useEffect, useId } from 'react'
import {
  IconKey, IconCheck, IconX, IconLoader2, IconClock, IconEye, IconEyeOff, IconLayoutGrid,
  IconUser, IconRefresh, IconExternalLink, IconAlertTriangle,
  IconPalette, IconInfoCircle, IconRocket, IconDeviceGamepad2,
  IconBrandSteam,
  IconSearch, IconPlus, IconMinus, IconFolder, IconTrophy,
  IconDownload, IconUpload, IconDeviceFloppy, IconArchive, IconCloud,
  IconHistory, IconList, IconChartBar, IconBell, IconBolt,
  IconStar, IconStethoscope,
} from '@tabler/icons-react'
import { useAccentColor } from '../context/AccentColorContext'
import HoneycombLogo from '../components/HoneycombLogo'
import ScanResultModal from '../components/modals/ScanResultModal'
import SaveManagerModal from '../components/modals/SaveManagerModal'
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
function ToggleRow({ label, desc, checked, onChange, busy = false }) {
  const labelId = useId()
  const toggle = () => { if (!busy) onChange(!checked) }
  return (
    <div className={s.toggleRow} onClick={toggle}>
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
  const [idlePause, setIdlePause]     = useState(generalTabCache?.idlePause ?? '5')      // minutes, 0 = off
  const [saved, setSaved]             = useState(false)
  const [openAtLogin, setOpenAtLogin]     = useState(generalTabCache?.openAtLogin ?? false)
  const [startMinimized, setStartMinimized] = useState(generalTabCache?.startMinimized ?? false)
  const [startupLoaded, setStartupLoaded] = useState(!!generalTabCache)   // avoids off→on flicker on open
  const [startupMsg, setStartupMsg]   = useState(null)   // { type, text }

  useEffect(() => {
    async function load() {
      if (!window.kozo?.api) return
      const res = await window.kozo.api.settings.getAll()
      const c = generalTabCache || {}
      if (res?.ok) {
        c.idlePause   = res.data?.idle_pause_min || '5'
        setIdlePause(c.idlePause)
      }
      const startup = await window.kozo.api.app?.getStartup?.()
      if (startup?.ok) { c.openAtLogin = startup.data?.openAtLogin ?? false; setOpenAtLogin(c.openAtLogin) }
      const minRes = await window.kozo.api.app?.getStartMinimized?.()
      if (minRes?.ok) { c.startMinimized = !!minRes.data; setStartMinimized(c.startMinimized) }
      generalTabCache = c
      setStartupLoaded(true)
    }
    load()
  }, [])

  async function save() {
    if (!window.kozo?.api) return
    await window.kozo.api.settings.set('idle_pause_min', String(parseInt(idlePause) || 0))
    generalTabCache = { ...(generalTabCache || {}), idlePause }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

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
      setStartupMsg({ type: 'success', text: 'Registered via Task Scheduler — works even when KoZo runs as administrator.' })
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
            desc="Hide the window on startup, only show tray icon"
            checked={startMinimized}
            busy={!startupLoaded}
            onChange={toggleStartMinimized}
          />
        </div>
        <Message msg={startupMsg} />
      </section>

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
              onClick={() => setIdlePause(v)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <div className={s.saveRow}>
        <button type="button" className={`${s.saveBtn} ${saved ? s.saveBtnSaved : ''}`} onClick={save}>
          {saved ? <><IconCheck size={14} stroke={2.5} /> Saved</> : 'Save Settings'}
        </button>
      </div>
    </div>
  )
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

  async function save() {
    if (!window.kozo?.api) return
    // The Steam ID is managed by detect / sign-in — Save only stores the key.
    await window.kozo.api.settings.set('steam_api_key', apiKey.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    if (apiKey.trim() && steamUserId) loadProfile(apiKey.trim(), steamUserId)
  }

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
        text: d?.error === 'timeout' ? 'Sign-in timed out — try again.' : 'Steam sign-in failed — try again.',
      })
    }
  }

  return (
    <div className={s.tabContent}>
      {/* API Key */}
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconKey size={15} stroke={1.6} />
          <span>Steam Web API Key</span>
        </div>
        <p className={s.sectionDesc}>
          <strong className={s.strong}>Optional</strong> — KoZo syncs achievements
          without a key as long as your Steam profile's Game details are public. A key adds support for
          private profiles and owned-games data. Get yours at{' '}
          <button
            type="button"
            className={s.linkBtn}
            onClick={() => window.kozo?.api?.shell?.openExternal('https://steamcommunity.com/dev/apikey')}
          >
            steamcommunity.com/dev/apikey
          </button>
        </p>
        <div className={s.keyRow}>
          {/* hasRing: the bordered wrapper is the control, so the focus ring is
              drawn once around the whole row rather than around the bare input. */}
          <div className={`${s.keyInputWrap} hasRing`}>
            <input type={showKey ? 'text' : 'password'} className={s.keyInput}
              placeholder="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" value={apiKey}
              aria-label="Steam Web API key"
              onChange={e => { setApiKey(e.target.value); setTestState('idle') }}
              spellCheck={false} autoComplete="off" />
            <button type="button" className={s.keyToggle} onClick={() => setShowKey(v => !v)}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}>
              {showKey ? <IconEyeOff size={14} stroke={1.6} /> : <IconEye size={14} stroke={1.6} />}
            </button>
          </div>
          <button type="button" className={s.testBtn} onClick={testKey} disabled={!apiKey.trim() || testState === 'testing'}>
            {testState === 'testing' ? <IconLoader2 size={13} stroke={1.8} className="spin" /> : 'Test'}
          </button>
        </div>
        {testState !== 'idle' && testState !== 'testing' && (
          <StatusLine type={testState === 'valid' ? 'success' : 'error'}>{testMsg}</StatusLine>
        )}
      </section>

      {/* User ID + Profile */}
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconUser size={15} stroke={1.6} />
          <span>Your Steam Profile</span>
        </div>
        <p className={s.sectionDesc}>
          Connects <strong className={s.strong}>automatically</strong> — KoZo reads
          your logged-in account from the Steam app on this PC. Use "Sign in with Steam" for a
          different account or when Steam isn't installed here. Nothing to type.
        </p>
        {steamUserId && (
          <StatusLine type="success">
            Connected{steamPersona ? <> as <strong>{steamPersona}</strong></> : <> — {steamUserId}</>}
          </StatusLine>
        )}
        {privacyError && (
          <div className={s.privacyBanner}>
            <IconAlertTriangle size={15} stroke={1.8} className={s.privacyIcon} />
            <div>
              {privacyError === 'profile_not_found'
                ? <>KoZo couldn't read your Steam profile. Check the Steam ID above.</>
                : <>
                    Steam wouldn't return unlocks for any game KoZo tried, which usually means your
                    profile's <strong>Game details</strong> are private. KoZo still reads unlocks
                    straight from the Steam app on this PC, so achievements keep working — this only
                    costs you Steam's real unlock dates. If you've already set Game details to Public,
                    hit Re-check.
                  </>}
              <div className={s.keyRow}>
                <button type="button" className={s.testBtn}
                  onClick={() => window.kozo?.api?.shell?.openExternal?.('https://steamcommunity.com/my/edit/settings')}>
                  Open Steam privacy settings
                </button>
                {/* Steam caches privacy changes for a moment, and KoZo only
                    re-tests on launch — so give it a way to confirm now. */}
                <button type="button" className={s.testBtn} disabled={privacyChecking}
                  onClick={async () => {
                    setPrivacyChecking(true)
                    const res = await window.kozo?.api?.steam?.recheckPrivacy?.()
                    setPrivacyChecking(false)
                    const d = res?.ok ? res.data : null
                    if (d?.checked && !d.private) setPrivacyError('')
                  }}>
                  {privacyChecking
                    ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Checking…</>
                    : <><IconRefresh size={13} stroke={1.8} /> Re-check now</>}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className={s.keyRow}>
          <button type="button" className={s.testBtn}
            title="Read your logged-in account from the local Steam install — no typing needed"
            onClick={detectFromPc}>
            Detect from this PC
          </button>
          <button type="button" className={s.testBtn}
            title="Sign in with Steam in your browser — for a different account or when Steam isn't installed here"
            disabled={signingIn}
            onClick={signInWithSteam}>
            <IconBrandSteam size={13} stroke={1.8} />
            {signingIn ? 'Waiting…' : 'Sign in with Steam'}
          </button>
        </div>
        <Message msg={detectMsg} />
        {profile && profileState === 'found' && (
          <div className={s.profileCard}>
            {profile.avatar && <img src={profile.avatar} alt="" className={s.profileAvatar} loading="lazy" decoding="async" />}
            <div className={s.profileBody}>
              <div className={s.profileName} title={profile.persona_name}>{profile.persona_name}</div>
              <div className={s.profileId} title={profile.steam_id}>SteamID: {profile.steam_id}</div>
            </div>
            {profile.profile_url && (
              <button type="button" className={s.profileLinkBtn} aria-label="Open Steam profile"
                onClick={() => window.kozo?.api?.shell?.openExternal(profile.profile_url)}>
                <IconExternalLink size={13} stroke={1.6} />
              </button>
            )}
          </div>
        )}
        {profileState === 'error' && profileMsg && (
          <StatusLine type="error">{profileMsg}</StatusLine>
        )}
      </section>

      {/* Save */}
      <div className={s.saveRowBare}>
        <button type="button" className={`${s.saveBtn} ${saved ? s.saveBtnSaved : ''}`} onClick={save}>
          {saved ? <><IconCheck size={14} stroke={2.5} /> Saved</> : 'Save'}
        </button>
      </div>

      {/* Refresh cover images (moved here from the Library toolbar) */}
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconRefresh size={15} stroke={1.6} />
          <span>Refresh Cover Images</span>
        </div>
        <p className={s.sectionDesc}>
          Re-downloads every cover at 2× quality (Library + Game List). Use it if covers look blurry or failed to load.
        </p>
        <div className={s.keyRow}>
          <button type="button" className={s.testBtn} disabled={bannerRefreshing} onClick={doRefreshBanners}>
            {bannerRefreshing
              ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Refreshing…</>
              : <><IconRefresh size={13} stroke={1.8} /> Refresh images</>}
          </button>
        </div>
        <Message msg={bannerMsg} />
      </section>
    </div>
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
    <div className={s.tabContent}>
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
    </div>
  )
}

// ── Tab: Appearance ──────────────────────────────────────────────────────────
function AppearanceTab() {
  const { accent, setAccent, presets, bgTint, setBgTint } = useAccentColor()
  const [customHex, setCustomHex] = useState(accent)
  useEffect(() => { setCustomHex(accent) }, [accent])
  const validHex = /^#[0-9A-Fa-f]{6}$/.test(customHex.trim())
  function applyCustom() {
    if (validHex) setAccent(customHex.trim())
  }

  return (
    <div className={s.tabContent}>
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconPalette size={15} stroke={1.6} />
          <span>Accent Color</span>
        </div>
        <p className={s.sectionDesc}>
          Controls the highlight color used across the entire app — buttons, active states, and badges.
        </p>
        <div className={s.swatchGrid}>
          {presets.map(p => (
            <button key={p.value}
              type="button"
              aria-pressed={accent === p.value}
              className={`${s.swatch} ${accent === p.value ? s.swatchActive : ''}`}
              style={{ '--sw': p.value }} onClick={() => setAccent(p.value)} title={p.label}>
              <span className={s.swatchDot} />
              {accent === p.value && <IconCheck size={12} stroke={2.5} className={s.swatchCheck} />}
              <span className={s.swatchLabel}>{p.label}</span>
            </button>
          ))}
        </div>
        <div className={s.customColorRow}>
          <div className={s.customColorPreview}
            style={{ background: validHex ? customHex.trim() : 'var(--surface-3)' }} />
          <input className={s.customColorInput} value={customHex} maxLength={7}
            aria-label="Custom accent hex"
            onChange={e => setCustomHex(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyCustom()}
            placeholder="#a78bfa" spellCheck={false} />
          <button type="button" className={s.testBtn} onClick={applyCustom} disabled={!validHex}>Apply</button>
        </div>
        <p className={s.sectionDescQuiet}>
          Enter any hex color. Very dark colors are automatically brightened for readability.
        </p>

        {/* Accent-matched dark background */}
        <div className={s.toggleList}>
          <ToggleRow
            label="Match background to accent"
            desc="Tints the app's dark background and cards with your accent color's hue — a themed dark look instead of the stock blue-violet."
            checked={bgTint}
            onChange={setBgTint}
          />
        </div>
      </section>
    </div>
  )
}

// ── Tab: Data ────────────────────────────────────────────────────────────────
// Module cache so re-opening Data doesn't flash the auto-backup toggles off→on
// while their async state loads.
let dataTabCache = null

function DataTab({ onManageSaves }) {
  const [importState, setImportState] = useState('idle')   // idle | working | done | error
  const [importResult, setImportResult] = useState(null)

  // Sync folder ("sign in" without an account)
  const [sync, setSync]               = useState(dataTabCache?.sync ?? null)

  // Game saves — per-game overview (count + latest) so backups are trackable.
  const [overview, setOverview]       = useState(dataTabCache?.overview ?? [])
  const [backupsDir, setBackupsDir]   = useState(dataTabCache?.backupsDir ?? null)
  const [allState, setAllState]       = useState('idle')   // idle | working | done | error
  const [allResult, setAllResult]     = useState(null)
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(dataTabCache?.autoSaveEnabled ?? false)

  async function loadOverview() {
    const res = await window.kozo?.api?.saves?.overview?.()
    if (res?.ok) { setOverview(res.data ?? []); if (dataTabCache) dataTabCache.overview = res.data ?? [] }
  }

  async function doBackupAll() {
    setAllState('working'); setAllResult(null)
    const res = await window.kozo?.api?.saves?.backupAll?.()
    if (res?.ok) { setAllResult(res.data); setAllState('done') }
    else { setAllResult({ error: res?.error || 'Backup failed' }); setAllState('error') }
    loadOverview()
  }

  useEffect(() => {
    dataTabCache = dataTabCache || {}
    loadOverview()
    window.kozo?.api?.saves?.backupsDir?.().then(res => { if (res?.ok) { setBackupsDir(res.data); dataTabCache.backupsDir = res.data } })
    window.kozo?.api?.saves?.getAutoBackup?.().then(res => { if (res?.ok) { setAutoSaveEnabled(!!res.data); dataTabCache.autoSaveEnabled = !!res.data } })
    window.kozo?.api?.backup?.syncStatus?.().then(res => { if (res?.ok) { setSync(res.data); dataTabCache.sync = res.data } })
  }, [])

  async function doSyncSetup() {
    const res = await window.kozo?.api?.backup?.syncSetup?.()
    if (!res?.ok || !res.data) return   // cancelled
    setSync(res.data)
    if (dataTabCache) dataTabCache.sync = res.data
    // The sync setup rewires the backup dirs + toggles — refresh dependent state.
    const dir = await window.kozo?.api?.saves?.backupsDir?.()
    if (dir?.ok) { setBackupsDir(dir.data); if (dataTabCache) dataTabCache.backupsDir = dir.data }
    setAutoSaveEnabled(true)
    loadOverview()
  }

  async function doSyncRestore() {
    setImportState('working')
    setImportResult(null)
    try {
      const res = await window.kozo?.api?.backup?.syncRestore?.()
      const data = res?.ok ? res.data : res
      if (data?.error) {
        setImportResult({ error: data.error === 'no_backup_found' ? 'No backup file found in the sync folder yet.' : 'Sync folder is not set up.' })
        setImportState('error')
        return
      }
      setImportResult(data)
      setImportState('done')
    } catch (e) {
      setImportResult({ error: e.message })
      setImportState('error')
    }
  }

  async function toggleAutoSave(val) {
    setAutoSaveEnabled(val)
    if (dataTabCache) dataTabCache.autoSaveEnabled = val
    await window.kozo?.api?.saves?.setAutoBackup?.(val)
  }

  async function doImport() {
    setImportState('working')
    setImportResult(null)
    try {
      // Every IPC reply is an { ok, data } envelope, so the envelope itself is
      // always truthy — cancel (data === null) and failures have to be read out
      // of it, or a cancelled picker reports a restore of "undefined" games.
      const env = await window.kozo?.api?.backup?.import()
      if (!env?.ok) {
        setImportResult({ error: env?.error || 'Restore failed' })
        setImportState('error')
        return
      }
      if (!env.data) { setImportState('idle'); return }   // user cancelled
      setImportResult(env.data)
      setImportState('done')
    } catch (e) {
      setImportResult({ error: e.message })
      setImportState('error')
    }
  }

  return (
    <div className={s.tabContent}>
      {/* Sync & Backup — folder based, fully offline. No accounts needed. */}
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconCloud size={15} stroke={1.6} />
          <span>Sync &amp; Backup — your data on any PC</span>
        </div>
        <p className={s.sectionDesc}>
          No account needed — sync KoZo to <strong className={s.strong}>any folder</strong>:
          a cloud-synced folder (OneDrive/Drive/Dropbox), a network drive, or a USB stick. It keeps your
          library, playtime, achievements, lists AND game-save backups mirrored there. On a new PC:
          install KoZo, choose the same folder, hit Restore.
        </p>
        <div className={s.keyRow}>
          <button type="button" className={s.testBtn} onClick={doSyncSetup}>
            <IconFolder size={13} stroke={1.8} /> {sync?.configured ? 'Change sync folder' : 'Choose sync folder'}
          </button>
          {sync?.configured && (
            <>
              <button type="button" className={s.testBtn} onClick={() => window.kozo?.api?.shell?.openPath?.(sync.folder)}>
                <IconExternalLink size={13} stroke={1.8} /> Open folder
              </button>
              <button type="button" className={s.testBtn} onClick={doSyncRestore} disabled={importState === 'working'}>
                {importState === 'working'
                  ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Restoring…</>
                  : <><IconDownload size={13} stroke={1.8} /> Restore from sync folder</>}
              </button>
            </>
          )}
          <button type="button" className={s.testBtn} onClick={doImport} disabled={importState === 'working'}>
            <IconUpload size={13} stroke={1.8} /> Restore from file…
          </button>
        </div>
        {sync?.configured && (
          <p className={s.sectionDescQuiet}>
            Syncing to <strong className={s.savePath} title={sync.folder}>{sync.folder}</strong>
            {sync.lastBackupAt ? <> — last backup {new Date(sync.lastBackupAt).toLocaleString()}</> : ' — first backup will be written shortly'}
          </p>
        )}

        {importState === 'done' && importResult && (
          <StatusLine type="success">
            Restored — {importResult.games} games, {importResult.sessions} sessions,
            {' '}{importResult.gameList} list items
          </StatusLine>
        )}
        {importState === 'error' && (
          <StatusLine type="error">{importResult?.error || 'Restore failed'}</StatusLine>
        )}

        {/* ── Game save files — same folder, same section ── */}
        <div className={s.subSection}>
          <div className={s.sectionHeader}>
            <IconDeviceFloppy size={14} stroke={1.6} />
            <span>Game save files</span>
          </div>
          <p className={s.sectionDesc}>
            Each game's save files back up into the same folder
            {backupsDir && <> (<code className={s.savePath} title={backupsDir}>{backupsDir}</code>)</>} — great for
            cracked/offline games with no cloud saves.
          </p>

          <div className={s.toggleList}>
            <ToggleRow
              label="Auto-back up saves after each session"
              desc="After you finish playing, snapshots that game's saves automatically — keeps the last two sessions (older ones are overwritten so backups never balloon in size)."
              checked={autoSaveEnabled}
              onChange={toggleAutoSave}
            />
          </div>

          {/* Back up every game's saves at once — for moving PCs / formatting */}
          {overview.length > 0 && (
            <div className={s.keyRow}>
              <button type="button" className={s.testBtn} onClick={doBackupAll} disabled={allState === 'working'}>
                {allState === 'working'
                  ? <><IconLoader2 size={13} stroke={1.8} className="spin" /> Backing up all…</>
                  : <><IconArchive size={13} stroke={1.8} /> Back up all game saves</>}
              </button>
              {allState === 'done' && allResult && (
                <StatusLine type={(allResult.noSaves || allResult.failed) ? 'warning' : 'success'}>
                  {allResult.backedUp} backed up
                  {allResult.noSaves ? ` — ${allResult.noSaves} had no detectable save folder (open that game's Save Files to back up manually)` : ''}
                  {allResult.failed ? `, ${allResult.failed} failed` : ''}
                </StatusLine>
              )}
              {allState === 'error' && (
                <StatusLine type="error">{allResult?.error || 'Backup failed'}</StatusLine>
              )}
            </div>
          )}

          {/* Per-game overview — count + newest snapshot at a glance */}
          {overview.length === 0 ? (
            <p className={s.sectionDescItalic}>No games in your library yet.</p>
          ) : (
            <div className={s.saveGameList}>
              {overview.map(g => (
                <div key={g.id} className={s.saveGameRow}>
                  <span className={s.saveGameName} title={g.name}>{g.name}</span>
                  {g.count > 0 ? (
                    <span className={s.saveBackupInfo}>
                      <IconCheck size={11} stroke={2.5} className={s.saveBackupTick} />
                      {g.count} backup{g.count === 1 ? '' : 's'}
                      {g.latestAt && <span className={s.saveBackupDate}> · {new Date(g.latestAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                    </span>
                  ) : (
                    <span className={`${s.saveBackupInfo} ${s.saveBackupNone}`}>No backups</span>
                  )}
                  <button type="button" className={s.saveManageBtn} onClick={() => onManageSaves?.({ id: g.id, name: g.name })}>
                    <IconDeviceFloppy size={12} stroke={1.7} /> Manage
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className={s.sectionDescQuiet}>
          Restoring merges data in (matching entries are updated) — it never deletes anything or touches game saves.
        </p>
      </section>
    </div>
  )
}

// ── Tab: Features ─────────────────────────────────────────────────────────────
const FEATURE_GROUPS = [
  {
    title: 'Tracking',
    items: [
      { Icon: IconClock,    name: 'Automatic playtime', desc: 'Detects running games and records sessions — no manual timers.' },
      { Icon: IconHistory,  name: 'Sessions timeline',  desc: 'Every play session grouped by day with durations and unlocks.' },
      { Icon: IconBolt,     name: 'Idle / AFK pause',   desc: 'Stops counting when you step away so overnight idling doesn’t inflate stats.' },
    ],
  },
  {
    title: 'Achievements',
    items: [
      { Icon: IconBrandSteam, name: 'Steam sync',        desc: 'Imports your unlocks via the Steam Web API — automatically while you play and after each session. No interval to set.' },
      { Icon: IconTrophy,     name: 'Cracked-game sync', desc: 'Reads Goldberg, CODEX, RUNE, EMPRESS, SKIDROW and more — watched live, so unlocks appear instantly.' },
      { Icon: IconBell,       name: 'Live game overlay', desc: 'A toast pops over your game the moment you unlock something — Steam-style, in your accent color.' },
      { Icon: IconDownload,   name: 'Achievement lists for any launcher', desc: "Xbox/Epic/other games auto-match a Steam achievement list on add — then tick off the ones you've earned." },
    ],
  },
  {
    title: 'Library',
    items: [
      { Icon: IconSearch,         name: 'Scan PC',          desc: 'Finds installed games (Steam, Epic, GOG, Xbox, cracked) on your drives, with the right launcher badge — right from the Library toolbar.' },
      { Icon: IconDeviceGamepad2, name: 'Add manually',     desc: 'Point KoZo at any .exe — perfect for offline games.' },
      { Icon: IconStar,           name: 'Favorites',        desc: 'Star a game to pin it to the top of your Library and Game List.' },
      { Icon: IconList,           name: 'Game List',        desc: 'A backlog / wishlist with statuses, genres, search, and Spotify-style custom lists.' },
      { Icon: IconEyeOff,         name: 'Status filter & hidden games', desc: 'Filter the Library by Playing/Finished/Dropped/On hold; hidden games tuck into a collapsed section at the bottom (their stats still count).' },
      { Icon: IconLayoutGrid,     name: 'Drag & drop ordering', desc: 'Pick "Custom order" and drag cards into any arrangement you like — in the Library and the Game List.' },
    ],
  },
  {
    title: 'Saves & Backups',
    items: [
      { Icon: IconDeviceFloppy, name: 'Save file finder',     desc: 'Locates each game’s real save folder (even tricky publisher paths).' },
      { Icon: IconArchive,      name: 'Save backup & restore',desc: 'Snapshot and roll back any game’s saves — manually, all at once before a format, or automatically after each session (keeps the last two).' },
      { Icon: IconCloud,        name: 'Folder sync', desc: 'Sync everything (game saves included) to any folder — cloud-synced, network drive, or USB — and restore on any PC. Fully offline, no account.' },
    ],
  },
  {
    title: 'Personalize',
    items: [
      { Icon: IconUser,      name: 'Your profile',  desc: 'A profile page with a cropped avatar & banner, banner themes, a title, and a showcase of your favorite games.' },
      { Icon: IconBolt,      name: 'XP & levels',   desc: 'Earn XP from playtime, rare achievements, play streaks and finished games — level up through tiers from Rookie to Mythic, shown on your profile.' },
      { Icon: IconPalette,   name: 'Custom accent', desc: 'Pick any accent (presets or custom hex) — it themes the whole app, badges, and the live overlay.' },
    ],
  },
  {
    title: 'Insights & App',
    items: [
      { Icon: IconChartBar,  name: 'Statistics',    desc: 'Playtime trends with an hourly 24h view, daily/monthly charts, and click-a-day (or hour) to focus it.' },
      { Icon: IconBell,      name: 'In-game status (Alt+K)', desc: 'Press Alt+K while playing to flash your live session time and achievement progress over the game.' },
      { Icon: IconTrophy,    name: 'Achievement list (Alt+J)', desc: 'Press Alt+J while playing to flash your progress and the rarest achievements you still have left, right over the game.' },
      { Icon: IconRocket,    name: 'Tray & startup',desc: 'Runs quietly in the system tray and can launch with Windows.' },
    ],
  },
]

function FeaturesTab() {
  return (
    <div className={s.tabContent}>
      <p className={s.sectionDesc}>
        Everything KoZo can do, grouped by area. Most of it runs automatically once you've added
        games and connected Steam.
      </p>
      {FEATURE_GROUPS.map(group => (
        <section key={group.title} className={s.featureGroup}>
          <div className={s.featureGroupTitle}>{group.title}</div>
          <div className={s.featureList}>
            {group.items.map(f => (
              <div key={f.name} className={s.featureRow}>
                <div className={s.featureIcon}><f.Icon size={18} stroke={1.6} /></div>
                <div className={s.featureRowBody}>
                  <div className={s.featureName}>{f.name}</div>
                  <div className={s.featureDesc}>{f.desc}</div>
                </div>
              </div>
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
        ? "Couldn't reach the update server — check your connection."
        : r.error]
    }
    if (r.notConfigured) return ['info', 'Update source not configured yet (set build.publish in package.json).']
    if (r.noReleases) return ['info', `No releases published on ${r.repo} yet — build the app and publish a GitHub release to enable updates.`]
    if (r.updateAvailable) {
      return ['success', `Update ${r.latest} available (you have ${r.current})${r.dev || r.manualOnly ? '' : ' — downloading in the background.'}`]
    }
    return ['success', `You're up to date${r.latest ? ` — ${r.latest} is the latest release` : ''}${r.dev ? ' (dev build, checked against GitHub)' : ''}.`]
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
              achievements — even for cracked and offline games.
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
            ['Data storage',        'Local — nothing leaves your PC'],
            ['Steam integration',   'Steam Web API — optional; public profiles sync keyless'],
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
          real in-game overlay toast — then cleans everything up.
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
                {st.name}{st.detail ? <span className={s.statusDetail}> — {st.detail}</span> : null}
              </StatusLine>
            ))}
            <StatusLine type={testResult.ok ? 'success' : 'error'} className={s.statusSummary}>
              {testResult.ok
                ? 'Achievement tracking is working on this PC.'
                : 'Something failed — see the steps above.'}
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
    </div>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'features',   label: 'Features' },
  { key: 'general',    label: 'General' },
  { key: 'steam',      label: 'Steam' },
  { key: 'scan',       label: 'Scan PC' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'data',       label: 'Backups' },
  { key: 'about',      label: 'About' },
]

export default function Settings() {
  const [tab, setTab] = useState('general')
  const [saveGame, setSaveGame] = useState(null)   // game whose saves are being managed
  return (
    <div className={s.page}>
      <div className={s.toolbar}><h1 className={s.pageTitle}>Settings</h1></div>
      <div className={s.layout}>
        <nav className={s.nav} aria-label="Settings sections">
          {TABS.map(t => (
            <button key={t.key}
              type="button"
              aria-current={tab === t.key ? 'page' : undefined}
              className={`${s.navItem} ${tab === t.key ? s.navActive : ''}`}
              onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className={s.panel}>
          {tab === 'features'   && <FeaturesTab />}
          {tab === 'general'    && <GeneralTab />}
          {tab === 'steam'      && <SteamTab />}
          {tab === 'scan'       && <ScanPCTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'data'       && <DataTab onManageSaves={setSaveGame} />}
          {tab === 'about'      && <AboutTab />}
        </div>
      </div>

      {saveGame && (
        <SaveManagerModal game={saveGame} onClose={() => setSaveGame(null)} />
      )}
    </div>
  )
}
