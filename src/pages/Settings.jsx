import React, { useState, useEffect } from 'react'
import {
  IconKey, IconCheck, IconX, IconLoader2, IconClock, IconEye, IconEyeOff,
  IconUser, IconRefresh, IconExternalLink, IconAlertTriangle,
  IconPalette, IconInfoCircle, IconRocket, IconDeviceGamepad2,
  IconBrandSteam,
  IconSearch, IconPlus, IconMinus, IconFolder, IconTrophy,
  IconDownload, IconUpload, IconDatabase, IconDeviceFloppy, IconArchive,
  IconHistory, IconList, IconChartBar, IconBell, IconBolt,
  IconStar,
} from '@tabler/icons-react'
import { useAccentColor } from '../context/AccentColorContext'
import HoneycombLogo from '../components/HoneycombLogo'
import ScanResultModal from '../components/modals/ScanResultModal'
import SaveManagerModal from '../components/modals/SaveManagerModal'
import s from './Settings.module.css'

// ── Tab: General ─────────────────────────────────────────────────────────────

// Module cache so re-opening General doesn't flash toggles (e.g. controller mode)
// from their default before the async settings load resolves.
let generalTabCache = null

function GeneralTab() {
  const [idlePause, setIdlePause]     = useState(generalTabCache?.idlePause ?? '5')      // minutes, 0 = off
  const [saved, setSaved]             = useState(false)
  const [openAtLogin, setOpenAtLogin]     = useState(generalTabCache?.openAtLogin ?? false)
  const [startMinimized, setStartMinimized] = useState(generalTabCache?.startMinimized ?? false)
  const [startupLoaded, setStartupLoaded] = useState(!!generalTabCache)   // avoids off→on flicker on open
  const [startupMsg, setStartupMsg]   = useState('')
  const [startupErr, setStartupErr]   = useState('')

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
    setStartupMsg('')
    setStartupErr('')
    const res = await window.kozo?.api?.app?.setStartup?.(val)
    if (!val) return
    if (res?.ok === false) {
      setOpenAtLogin(false)
      if (generalTabCache) generalTabCache.openAtLogin = false
      setStartupErr('Could not register startup: ' + (res?.error || 'unknown error'))
    } else if (res?.method === 'task_scheduler') {
      setStartupMsg('Registered via Task Scheduler — works even when KoZo runs as administrator.')
    } else if (res?.method === 'registry') {
      setStartupMsg('Registered in Windows startup registry.')
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
          <label className={s.toggleRow}>
            <div className={s.toggleInfo}>
              <div className={s.toggleLabel}>Launch on startup</div>
              <div className={s.toggleDesc}>Start KoZo automatically when Windows boots</div>
            </div>
            {startupLoaded ? (
              <button className={`${s.toggle} ${openAtLogin ? s.toggleOn : ''}`}
                onClick={() => toggleStartup(!openAtLogin)} type="button">
                <span className={s.toggleThumb} />
              </button>
            ) : (
              <IconLoader2 size={16} className={s.spin} style={{ color: 'var(--text-muted)' }} />
            )}
          </label>
          <label className={s.toggleRow}>
            <div className={s.toggleInfo}>
              <div className={s.toggleLabel}>Start minimized to tray</div>
              <div className={s.toggleDesc}>Hide the window on startup, only show tray icon</div>
            </div>
            {startupLoaded ? (
              <button className={`${s.toggle} ${startMinimized ? s.toggleOn : ''}`}
                onClick={() => toggleStartMinimized(!startMinimized)} type="button">
                <span className={s.toggleThumb} />
              </button>
            ) : (
              <IconLoader2 size={16} className={s.spin} style={{ color: 'var(--text-muted)' }} />
            )}
          </label>
        </div>
        {startupMsg && <div className={s.startupMsg}>{startupMsg}</div>}
        {startupErr && <div className={s.startupErr}>{startupErr}</div>}
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
        <div className={s.sensitivityRow}>
          {[['0', 'Off'], ['1', '1m'], ['2', '2m'], ['5', '5m'], ['10', '10m'], ['15', '15m'], ['30', '30m']].map(([v, label]) => (
            <button key={v}
              className={`${s.sensitivityBtn} ${idlePause === v ? s.sensitivityActive : ''}`}
              onClick={() => setIdlePause(v)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <div className={s.saveRow}>
        <button className={`${s.saveBtn} ${saved ? s.saveBtnSaved : ''}`} onClick={save}>
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
  const [bannerMsg, setBannerMsg]   = useState('')
  const [profile, setProfile]       = useState(steamTabCache?.profile ?? null)
  const [profileState, setProfileState] = useState(steamTabCache?.profile ? 'found' : 'idle')
  const [profileMsg, setProfileMsg] = useState('')

  useEffect(() => {
    async function load() {
      if (!window.kozo?.api) return
      const res = await window.kozo.api.settings.getAll()
      if (res?.ok) {
        const key = res.data?.steam_api_key || ''
        const sid = res.data?.steam_user_id || ''
        setApiKey(key)
        setSteamUserId(sid)
        steamTabCache = { ...(steamTabCache || {}), apiKey: key, steamUserId: sid }
        // Only re-fetch the profile card if we don't already have it cached.
        if (key && sid && !steamTabCache.profile) loadProfile(key, sid)
      }
    }
    load()
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
    await window.kozo.api.settings.set('steam_api_key', apiKey.trim())
    // Accept a profile URL / custom name / raw ID and resolve to a SteamID64.
    let finalId = steamUserId.trim()
    if (finalId) {
      const r = await window.kozo.api.steam.resolveId(finalId, apiKey.trim())
      if (r?.ok && r.data?.steamId) { finalId = r.data.steamId; setSteamUserId(finalId) }
    }
    await window.kozo.api.settings.set('steam_user_id', finalId)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    if (apiKey.trim() && finalId) loadProfile(apiKey.trim(), finalId)
  }

  async function doRefreshBanners() {
    setBannerRefreshing(true)
    setBannerMsg('')
    // Refresh BOTH cover systems: Library local banners + Game List remote covers.
    const res = await window.kozo?.api?.steam?.refreshAllBanners?.()
    await window.kozo?.api?.gameList?.refreshBanners?.()
    setBannerRefreshing(false)
    setBannerMsg(res?.ok === false
      ? '❌ ' + (res?.error || 'Could not refresh images.')
      : 'Cover images refreshed at 2× quality.')
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
          Required for syncing achievements and game metadata. Get yours at{' '}
          <span className={s.link}>steamcommunity.com/dev/apikey</span>
        </p>
        <div className={s.keyRow}>
          <div className={s.keyInputWrap}>
            <input type={showKey ? 'text' : 'password'} className={s.keyInput}
              placeholder="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" value={apiKey}
              onChange={e => { setApiKey(e.target.value); setTestState('idle') }}
              spellCheck={false} autoComplete="off" />
            <button className={s.keyToggle} onClick={() => setShowKey(v => !v)}>
              {showKey ? <IconEyeOff size={14} stroke={1.6} /> : <IconEye size={14} stroke={1.6} />}
            </button>
          </div>
          <button className={s.testBtn} onClick={testKey} disabled={!apiKey.trim() || testState === 'testing'}>
            {testState === 'testing' ? <IconLoader2 size={13} stroke={1.8} className={s.spin} /> : 'Test'}
          </button>
        </div>
        {testState !== 'idle' && testState !== 'testing' && (
          <div className={`${s.testResult} ${testState === 'valid' ? s.testValid : s.testInvalid}`}>
            {testState === 'valid' ? <IconCheck size={13} stroke={2.5} /> : <IconX size={13} stroke={2.5} />}
            {testMsg}
          </div>
        )}
      </section>

      {/* User ID + Profile */}
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconUser size={15} stroke={1.6} />
          <span>Your Steam Profile</span>
        </div>
        <p className={s.sectionDesc}>
          Paste your <strong style={{ color: 'var(--text-primary)' }}>profile URL</strong> (in Steam:
          your name → View my profile, then copy the page URL), your custom name, or a 17-digit
          SteamID64 — KoZo resolves it to your ID for you. No third-party sites.
        </p>
        <div className={s.keyRow}>
          <div className={s.keyInputWrap}>
            <input type="text" className={s.keyInput} placeholder="Profile URL, custom name, or SteamID64"
              value={steamUserId} spellCheck={false} autoComplete="off"
              onChange={e => { setSteamUserId(e.target.value); setProfileState('idle'); setProfile(null) }} />
          </div>
          <button className={s.testBtn}
            onClick={async () => {
              const r = await window.kozo?.api?.steam?.resolveId(steamUserId.trim(), apiKey.trim())
              const id = (r?.ok && r.data?.steamId) ? r.data.steamId : steamUserId.trim()
              if (r?.ok && r.data?.steamId) setSteamUserId(id)
              loadProfile(apiKey.trim(), id)
            }}
            disabled={!apiKey.trim() || !steamUserId.trim() || profileState === 'loading'}>
            {profileState === 'loading' ? <IconLoader2 size={13} stroke={1.8} className={s.spin} /> : 'Verify'}
          </button>
        </div>
        {profile && profileState === 'found' && (
          <div className={s.profileCard}>
            {profile.avatar && <img src={profile.avatar} alt="" className={s.profileAvatar} />}
            <div className={s.profileBody}>
              <div className={s.profileName}>{profile.persona_name}</div>
              <div className={s.profileId}>SteamID: {profile.steam_id}</div>
            </div>
            {profile.profile_url && (
              <button className={s.profileLinkBtn}
                onClick={() => window.kozo?.api?.shell?.openExternal(profile.profile_url)}>
                <IconExternalLink size={13} stroke={1.6} />
              </button>
            )}
          </div>
        )}
        {profileState === 'error' && profileMsg && (
          <div className={`${s.testResult} ${s.testInvalid}`}>
            <IconAlertTriangle size={13} stroke={2} /> {profileMsg}
          </div>
        )}
      </section>

      {/* Save */}
      <div className={s.saveRow} style={{ borderTop: 'none', paddingTop: 0 }}>
        <button className={`${s.saveBtn} ${saved ? s.saveBtnSaved : ''}`} onClick={save}>
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
          <button className={s.testBtn} disabled={bannerRefreshing} onClick={doRefreshBanners}>
            {bannerRefreshing
              ? <><IconLoader2 size={13} stroke={1.8} className={s.spin} /> Refreshing…</>
              : <><IconRefresh size={13} stroke={1.8} /> Refresh images</>}
          </button>
        </div>
        {bannerMsg && (
          <div className={`${s.testResult} ${bannerMsg.startsWith('❌') ? s.testInvalid : s.testValid}`}>
            {bannerMsg.startsWith('❌')
              ? <><IconAlertTriangle size={13} stroke={2} /> {bannerMsg.slice(2)}</>
              : <><IconCheck size={12} stroke={2.5} /> {bannerMsg}</>}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Tab: Scan PC ─────────────────────────────────────────────────────────────
function ScanPCTab() {
  const [paths, setPaths]           = useState([])
  const [scanning, setScanning]     = useState(false)
  const [scanModal, setScanModal]   = useState(null)  // null | results[]
  const [scanMsg, setScanMsg]       = useState('')
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
    setScanMsg('')
    const res = await window.kozo?.api?.scanner?.scan?.(paths)
    setScanning(false)
    if (!res?.ok) { setScanMsg('❌ Scan failed: ' + (res?.error || 'unknown')); return }
    const results = res.data || []
    if (results.length === 0) {
      setScanMsg('No games found in the selected folders. Try adding a custom folder.')
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
              <span className={s.pathText}>{p}</span>
              <button className={s.pathRemoveBtn} onClick={() => persistPaths(paths.filter((_, j) => j !== i))}>
                <IconMinus size={12} stroke={2} />
              </button>
            </div>
          ))}
          <button className={s.pathAddBtn} onClick={addFolder}>
            <IconPlus size={13} stroke={2} /> Add folder
          </button>
        </div>

        <div className={s.keyRow}>
          <button className={s.testBtn} onClick={runScan} disabled={scanning || paths.length === 0}>
            {scanning
              ? <><IconLoader2 size={13} stroke={1.8} className={s.spin} /> Scanning…</>
              : <><IconSearch size={13} stroke={1.8} /> Scan now</>
            }
          </button>
          {addedCount > 0 && (
            <div className={`${s.testResult} ${s.testValid}`} style={{ padding: '5px 10px', fontSize: 12 }}>
              <IconCheck size={12} stroke={2.5} /> {addedCount} game{addedCount === 1 ? '' : 's'} added to library
            </div>
          )}
        </div>

        {scanMsg && !scanMsg.startsWith('❌') && (
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>{scanMsg}</p>
        )}
        {scanMsg?.startsWith('❌') && (
          <div className={`${s.testResult} ${s.testInvalid}`}>
            <IconAlertTriangle size={13} stroke={2} /> {scanMsg.slice(2)}
          </div>
        )}
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
  const { accent, setAccent, presets } = useAccentColor()
  const [customHex, setCustomHex] = useState(accent)
  useEffect(() => { setCustomHex(accent) }, [accent])
  function applyCustom() {
    if (/^#[0-9A-Fa-f]{6}$/.test(customHex.trim())) setAccent(customHex.trim())
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
            style={{ background: /^#[0-9A-Fa-f]{6}$/.test(customHex) ? customHex : 'var(--surface-3)' }} />
          <input className={s.customColorInput} value={customHex} maxLength={7}
            onChange={e => setCustomHex(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyCustom()}
            placeholder="#a78bfa" spellCheck={false} />
          <button className={s.testBtn} onClick={applyCustom}>Apply</button>
        </div>
        <p className={s.sectionDesc} style={{ marginTop: 4 }}>
          Enter any hex color. Very dark colors are automatically brightened for readability.
        </p>
      </section>
    </div>
  )
}

// ── Tab: Crack Games ─────────────────────────────────────────────────────────
function CrackTab() {
  const [scanning, setScanning] = useState(false)
  const [result, setResult]     = useState(null)
  const [diagGame, setDiagGame] = useState(null)
  const [diagResult, setDiagResult] = useState(null)
  const [games, setGames]       = useState([])

  useEffect(() => {
    window.kozo?.api?.games?.list().then(res => {
      if (res?.ok) setGames((res.data || []).filter(g => !!g.is_cracked))
    })
  }, [])

  async function scanAll() {
    setScanning(true); setResult(null)
    const res = await window.kozo?.api?.crack?.scanAll?.()
    setScanning(false)
    if (res?.ok) setResult(res.data)
    else setResult({ error: res?.error || 'Scan failed' })
  }

  async function diagnose(gameId) {
    setDiagGame(gameId); setDiagResult(null)
    const res = await window.kozo?.api?.crack?.diagnose?.(gameId)
    setDiagGame(null)
    if (res?.ok) setDiagResult({ gameId, ...res.data })
    else setDiagResult({ error: res?.error || 'Failed' })
  }

  return (
    <div className={s.tabContent}>
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconDeviceGamepad2 size={15} stroke={1.6} />
          <span>Crack Achievement Scanner</span>
        </div>
        <p className={s.sectionDesc}>
          Scans 40+ known emulator file locations (Goldberg, CODEX, EMPRESS, ALI213,
          SmartSteamEmu, CreamAPI, SKIDROW, Reloaded, online-fix…) for each cracked game
          and imports newly unlocked achievements. While a cracked game is running KoZo
          watches these files live, so unlocks pop up the instant they're written (with a
          30s safety re-scan as a backup).
        </p>
        <div className={s.keyRow}>
          <button className={s.testBtn} onClick={scanAll} disabled={scanning}>
            {scanning
              ? <><IconLoader2 size={13} stroke={1.8} className={s.spin} /> Scanning…</>
              : <><IconRefresh size={13} stroke={1.8} /> Scan all cracked games now</>
            }
          </button>
        </div>
        {result && !result.error && (
          <div className={`${s.testResult} ${result.totalAdded > 0 ? s.testValid : ''}`}
            style={result.totalAdded === 0 ? { background: 'var(--surface-2)', borderColor: 'var(--border)', color: 'var(--text-secondary)' } : undefined}>
            {result.totalAdded > 0 && <IconCheck size={13} stroke={2.5} />}
            {result.totalAdded > 0
              ? `${result.totalAdded} new achievement${result.totalAdded === 1 ? '' : 's'} imported across ${result.gamesScanned} game${result.gamesScanned === 1 ? '' : 's'}`
              : `Scanned ${result.gamesScanned} game${result.gamesScanned === 1 ? '' : 's'} — already up to date`
            }
          </div>
        )}
        {result?.error && (
          <div className={`${s.testResult} ${s.testInvalid}`}>
            <IconAlertTriangle size={13} stroke={2} /> {result.error}
          </div>
        )}
      </section>

      {games.length > 0 && (
        <section className={s.section}>
          <div className={s.sectionHeader}>
            <span>Cracked games in library ({games.length})</span>
          </div>
          <div className={s.crackGameList}>
            {games.map(g => (
              <div key={g.id} className={s.crackGameRow}>
                <div className={s.crackGameName}>{g.name}</div>
                {g.steam_app_id
                  ? <button className={s.testBtn} onClick={() => diagnose(g.id)} disabled={diagGame === g.id}
                      style={{ padding: '5px 12px', fontSize: 12 }}>
                      {diagGame === g.id ? <IconLoader2 size={11} stroke={1.8} className={s.spin} /> : 'Find files'}
                    </button>
                  : <span className={s.crackGameNoId}>No Steam ID — can't scan</span>
                }
              </div>
            ))}
          </div>
        </section>
      )}

      {diagResult && !diagResult.error && (
        <section className={s.section}>
          <div className={s.sectionHeader}><span>Diagnostic — {diagResult.gameName}</span></div>
          {diagResult.appidMismatch && (
            <div className={`${s.testResult} ${s.testInvalid}`}>
              <IconAlertTriangle size={13} stroke={2} />
              AppID mismatch — KoZo: <strong>{diagResult.appid}</strong> · Game folder: <strong>{diagResult.detectedAppid}</strong>. Edit the game and set the correct Steam App ID.
            </div>
          )}
          {diagResult.keyPaths?.length > 0 && (
            <div className={s.crackFileList}>
              {diagResult.keyPaths.map((kp, i) => (
                <div key={i} className={s.crackFileRow}>
                  <span className={s.crackFileSource}
                    style={kp.exists ? undefined : { background: 'rgba(248,113,113,0.12)', borderColor: 'rgba(248,113,113,0.3)', color: '#f87171' }}>
                    {kp.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className={s.crackFilePath}>{kp.path}</div>
                    {kp.note && <div style={{ fontSize: 10, color: kp.exists ? 'var(--text-secondary)' : '#f87171', marginTop: 2 }}>{kp.note}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {diagResult.found.length === 0 ? (
            <div className={`${s.testResult} ${s.testInvalid}`} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <IconAlertTriangle size={13} stroke={2} />
                No achievement files found across {diagResult.totalChecked} locations.
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                For ZIP-extracted games using Goldberg: the file is created at
                <strong style={{ color: 'var(--text-primary)' }}> %APPDATA%\Goldberg SteamEmu Saves\{'{appid}'}\achievements.json</strong> only
                after your first in-game achievement unlock.
              </div>
            </div>
          ) : (
            <>
              <div className={`${s.testResult} ${s.testValid}`}>
                <IconCheck size={13} stroke={2.5} /> Found {diagResult.found.length} achievement file{diagResult.found.length === 1 ? '' : 's'}
              </div>
              <div className={s.crackFileList}>
                {diagResult.found.map((f, i) => (
                  <div key={i} className={s.crackFileRow}>
                    <span className={s.crackFileSource}>{f.source}</span>
                    <span className={s.crackFilePath}>{f.path}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {games.length === 0 && (
        <p className={s.sectionDesc} style={{ fontStyle: 'italic' }}>
          No cracked games in library yet. Add a game and mark it as "Cracked / offline" in the Copy type field.
        </p>
      )}
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

  // Auto-backup
  const [autoEnabled, setAutoEnabled] = useState(dataTabCache?.autoEnabled ?? false)
  const [autoDir, setAutoDir]         = useState(dataTabCache?.autoDir ?? null)

  // Game saves
  const [games, setGames]             = useState(dataTabCache?.games ?? [])
  const [backupsDir, setBackupsDir]   = useState(dataTabCache?.backupsDir ?? null)
  const [allState, setAllState]       = useState('idle')   // idle | working | done | error
  const [allResult, setAllResult]     = useState(null)
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(dataTabCache?.autoSaveEnabled ?? false)

  async function doBackupAll() {
    setAllState('working'); setAllResult(null)
    const res = await window.kozo?.api?.saves?.backupAll?.()
    if (res?.ok) { setAllResult(res.data); setAllState('done') }
    else { setAllResult({ error: res?.error || 'Backup failed' }); setAllState('error') }
  }

  useEffect(() => {
    dataTabCache = dataTabCache || {}
    window.kozo?.api?.backup?.getAutoConfig?.().then(res => {
      if (res?.ok) {
        const en = !!res.data?.enabled, dir = res.data?.dir || null
        setAutoEnabled(en); setAutoDir(dir)
        dataTabCache.autoEnabled = en; dataTabCache.autoDir = dir
      }
    })
    window.kozo?.api?.games?.list?.().then(res => {
      if (res?.ok) {
        const g = (res.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
        setGames(g); dataTabCache.games = g
      }
    })
    window.kozo?.api?.saves?.backupsDir?.().then(res => { if (res?.ok) { setBackupsDir(res.data); dataTabCache.backupsDir = res.data } })
    window.kozo?.api?.saves?.getAutoBackup?.().then(res => { if (res?.ok) { setAutoSaveEnabled(!!res.data); dataTabCache.autoSaveEnabled = !!res.data } })
  }, [])

  async function toggleAutoSave(val) {
    setAutoSaveEnabled(val)
    if (dataTabCache) dataTabCache.autoSaveEnabled = val
    await window.kozo?.api?.saves?.setAutoBackup?.(val)
  }

  async function toggleAuto(val) {
    // Enabling without a folder → ask for one first.
    if (val && !autoDir) {
      const res = await window.kozo?.api?.backup?.chooseAutoFolder?.()
      if (!res?.ok || !res.data) return
      setAutoDir(res.data)
      if (dataTabCache) dataTabCache.autoDir = res.data
    }
    setAutoEnabled(val)
    if (dataTabCache) dataTabCache.autoEnabled = val
    await window.kozo?.api?.backup?.setAutoEnabled?.(val)
  }

  async function chooseAutoDir() {
    const res = await window.kozo?.api?.backup?.chooseAutoFolder?.()
    if (res?.ok && res.data) setAutoDir(res.data)
  }

  async function doImport() {
    setImportState('working')
    setImportResult(null)
    try {
      const res = await window.kozo?.api?.backup?.import()
      if (!res) { setImportState('idle'); return }   // user cancelled
      setImportResult(res)
      setImportState('done')
    } catch (e) {
      setImportResult({ error: e.message })
      setImportState('error')
    }
  }

  return (
    <div className={s.tabContent}>
      {/* App-data backup — one continuously-synced file + restore */}
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconDatabase size={15} stroke={1.6} />
          <span>App-Data Backup</span>
        </div>
        <p className={s.sectionDesc}>
          Auto-saves <strong style={{ color: 'var(--text-primary)' }}>KoZo's own data</strong> (library,
          playtime, achievements, settings — not game saves) to a folder you pick, always kept current.
          Restore it any time.
        </p>
        <div className={s.toggleList}>
          <label className={s.toggleRow}>
            <div className={s.toggleInfo}>
              <div className={s.toggleLabel}>Always keep a synced backup</div>
              <div className={s.toggleDesc}>
                {autoEnabled && autoDir
                  ? <>On — saving to <strong style={{ color: 'var(--text-secondary)' }}>{autoDir}</strong></>
                  : autoDir ? `Folder: ${autoDir}` : 'Pick a folder to store the backup file'}
              </div>
            </div>
            <button className={`${s.toggle} ${autoEnabled ? s.toggleOn : ''}`}
              onClick={() => toggleAuto(!autoEnabled)} type="button">
              <span className={s.toggleThumb} />
            </button>
          </label>
        </div>
        <div className={s.keyRow} style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button className={s.testBtn} onClick={chooseAutoDir}>
            <IconFolder size={13} stroke={1.8} /> {autoDir ? 'Change folder' : 'Choose folder'}
          </button>
          {autoDir && (
            <button className={s.testBtn} onClick={() => window.kozo?.api?.shell?.openPath?.(autoDir)}>
              <IconExternalLink size={13} stroke={1.8} /> Open folder
            </button>
          )}
          <button className={s.testBtn} onClick={doImport} disabled={importState === 'working'}>
            {importState === 'working'
              ? <><IconLoader2 size={13} stroke={1.8} className={s.spin} /> Restoring…</>
              : <><IconUpload size={13} stroke={1.8} /> Restore from backup…</>}
          </button>
        </div>
        {importState === 'done' && importResult && (
          <div className={`${s.testResult} ${s.testValid}`} style={{ marginTop: 8 }}>
            <IconCheck size={13} stroke={2.5} />
            Restored — {importResult.games} games, {importResult.sessions} sessions,
            {' '}{importResult.gameList} list items
          </div>
        )}
        {importState === 'error' && (
          <div className={`${s.testResult} ${s.testInvalid}`} style={{ marginTop: 8 }}>
            <IconAlertTriangle size={13} stroke={2} /> {importResult?.error || 'Restore failed'}
          </div>
        )}
        <div className={s.sectionDesc} style={{ fontSize: 11.5, marginTop: 8, opacity: 0.8 }}>
          Restoring merges the file in (matching entries are updated) — it never deletes anything or touches game saves.
        </div>
      </section>

      {/* Game save files */}
      <section className={s.section}>
        <div className={s.sectionHeader}>
          <IconDeviceFloppy size={15} stroke={1.6} />
          <span>Game Save Files</span>
        </div>
        <p className={s.sectionDesc}>
          Back up each <strong style={{ color: 'var(--text-primary)' }}>game's own save files</strong> —
          great for cracked/offline games with no cloud saves. Saved here (change it if you like):
        </p>

        {/* Automatic save backup — the save-file equivalent of app-data auto-backup */}
        <div className={s.toggleList}>
          <label className={s.toggleRow}>
            <div className={s.toggleInfo}>
              <div className={s.toggleLabel}>Auto-back up saves after each session</div>
              <div className={s.toggleDesc}>
                After you finish playing, snapshots that game's saves automatically (one rolling copy, skipped if unchanged).
              </div>
            </div>
            <button className={`${s.toggle} ${autoSaveEnabled ? s.toggleOn : ''}`}
              onClick={() => toggleAutoSave(!autoSaveEnabled)} type="button">
              <span className={s.toggleThumb} />
            </button>
          </label>
        </div>

        {backupsDir && (
          <div className={s.savePathRow}>
            <code className={s.savePathCode}>{backupsDir}</code>
            <button className={s.testBtn} onClick={async () => {
              const res = await window.kozo?.api?.saves?.chooseBackupsDir?.()
              if (res?.ok && res.data) { setBackupsDir(res.data); if (dataTabCache) dataTabCache.backupsDir = res.data }
            }}>
              <IconFolder size={13} stroke={1.8} /> Change folder
            </button>
            <button className={s.testBtn} onClick={() => window.kozo?.api?.shell?.openPath?.(backupsDir)}>
              <IconExternalLink size={13} stroke={1.8} /> Open folder
            </button>
          </div>
        )}

        {/* Back up every game's saves at once — for moving PCs / formatting */}
        {games.length > 0 && (
          <div className={s.keyRow}>
            <button className={s.testBtn} onClick={doBackupAll} disabled={allState === 'working'}>
              {allState === 'working'
                ? <><IconLoader2 size={13} stroke={1.8} className={s.spin} /> Backing up all…</>
                : <><IconArchive size={13} stroke={1.8} /> Back up all game saves</>}
            </button>
            {allState === 'done' && allResult && (
              <div className={`${s.testResult} ${s.testValid}`}>
                <IconCheck size={13} stroke={2.5} />
                {allResult.backedUp} backed up
                {allResult.noSaves ? `, ${allResult.noSaves} had no saves` : ''}
                {allResult.failed ? `, ${allResult.failed} failed` : ''}
              </div>
            )}
            {allState === 'error' && (
              <div className={`${s.testResult} ${s.testInvalid}`}>
                <IconAlertTriangle size={13} stroke={2} /> {allResult?.error || 'Backup failed'}
              </div>
            )}
          </div>
        )}

        {games.length === 0 ? (
          <p className={s.sectionDesc} style={{ fontStyle: 'italic' }}>No games in your library yet.</p>
        ) : (
          <div className={s.saveGameList}>
            {games.map(g => (
              <div key={g.id} className={s.saveGameRow}>
                <span className={s.saveGameName}>{g.name}</span>
                <button className={s.saveManageBtn} onClick={() => onManageSaves?.(g)}>
                  <IconDeviceFloppy size={12} stroke={1.7} /> Manage saves
                </button>
              </div>
            ))}
          </div>
        )}
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
      { Icon: IconList,           name: 'Game List',        desc: 'A backlog / wishlist with statuses and custom categories.' },
    ],
  },
  {
    title: 'Saves & Backups',
    items: [
      { Icon: IconDeviceFloppy, name: 'Save file finder',     desc: 'Locates each game’s real save folder (even tricky publisher paths).' },
      { Icon: IconArchive,      name: 'Save backup & restore',desc: 'Snapshot and roll back any game’s saves — manually, all at once before a format, or automatically after each session.' },
      { Icon: IconDatabase,     name: 'App-data backup',      desc: 'A live, always-synced backup of your whole KoZo library and settings, with one-click restore.' },
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
      { Icon: IconRocket,    name: 'Tray & startup',desc: 'Runs quietly in the system tray and can launch with Windows.' },
    ],
  },
]

function FeaturesTab() {
  return (
    <div className={`${s.tabContent} ${s.featuresTab}`}>
      <p className={s.sectionDesc} style={{ marginBottom: 4 }}>
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
  return (
    <div className={s.tabContent}>
      <section className={s.section}>
        <div className={s.aboutCard}>
          <div className={s.aboutLogo}><HoneycombLogo size={44} /></div>
          <div className={s.aboutInfo}>
            <div className={s.aboutName}>KoZo</div>
            <div className={s.aboutVersion}>Version 1.0.0</div>
            <div className={s.aboutDesc}>
              A local-first game tracker for Windows. Track playtime, sessions, and
              achievements — even for cracked and offline games.
            </div>
          </div>
        </div>
      </section>
      <section className={s.section}>
        <div className={s.sectionHeader}><IconInfoCircle size={15} stroke={1.6} /><span>Details</span></div>
        <div className={s.aboutDetails}>
          {[
            ['Platform',            'Windows (Electron 41)'],
            ['Runtime',             'React 19 + SQLite'],
            ['Data storage',        'Local — nothing leaves your PC'],
            ['Steam integration',   'Steam Web API (requires API key)'],
            ['Crack support',       'Goldberg, CODEX, EMPRESS, ALI213, SSE, CreamAPI, SKIDROW, Reloaded, online-fix'],
          ].map(([k, v]) => (
            <div key={k} className={s.aboutDetailRow}>
              <span className={s.aboutDetailKey}>{k}</span>
              <span className={s.aboutDetailVal}>{v}</span>
            </div>
          ))}
        </div>
      </section>
      <section className={s.section}>
        <div className={s.sectionHeader}><IconRocket size={15} stroke={1.6} /><span>Getting Started</span></div>
        <p className={s.sectionDesc}>New here, or want a refresher on setup and features?</p>
        <div className={s.keyRow}>
          <button
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
      <div className={s.header}><h1 className={s.title}>Settings</h1></div>
      <div className={s.layout}>
        <nav className={s.nav}>
          {TABS.map(t => (
            <button key={t.key}
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
