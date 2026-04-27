import React, { useState, useEffect } from 'react'
import {
  IconArrowRight, IconArrowLeft, IconCheck, IconX, IconLoader2,
  IconBrandSteam, IconExternalLink, IconDeviceGamepad2, IconTrophy,
  IconDeviceFloppy, IconChartBar, IconSearch, IconBell, IconClock,
  IconBolt, IconPlayerPlayFilled,
} from '@tabler/icons-react'
import HoneycombLogo from './HoneycombLogo'
import s from './OnboardingModal.module.css'

const API_KEY_URL = 'https://steamcommunity.com/dev/apikey'

// ── Little visual mockups of the real app, so the tour SHOWS how KoZo works ──

// The Library toolbar with the Scan PC button highlighted.
function MockToolbar() {
  return (
    <div className={s.mock}>
      <div className={s.mockToolbar}>
        <span className={s.mockTbItem}>My Library</span>
        <span className={s.mockTbItem}>Search…</span>
        <span className={s.mockTbScan}><IconSearch size={12} stroke={2} /> Scan PC</span>
        <span className={s.mockTbItem}>＋ Add Game</span>
      </div>
      <div className={s.mockHint}>↑ One click finds every installed game on your drives.</div>
    </div>
  )
}

// A live game card with a running session timer (what the sidebar shows while you play).
function MockPlay() {
  return (
    <div className={s.mock}>
      <div className={s.mockGameRow}>
        <div className={s.mockCover}><IconPlayerPlayFilled size={16} style={{ color: 'rgba(255,255,255,0.25)' }} /></div>
        <div className={s.mockGameInfo}>
          <div className={s.mockGameName}>Hollow Knight</div>
          <div className={s.mockLive}><span className={s.mockLiveDot} /> LIVE — NOW PLAYING</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={s.mockTimer}>01:24:07</div>
          <div className={s.mockMeta}>auto-paused when you're away</div>
        </div>
      </div>
    </div>
  )
}

// The achievement toast that slides over your game.
function MockToast() {
  return (
    <div className={s.mock} style={{ background: 'transparent', border: 'none', padding: 0 }}>
      <div className={s.mockToast}>
        <div className={s.mockToastIcon}><IconTrophy size={18} stroke={1.6} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={s.mockToastLabel}>Achievement Unlocked</div>
          <div className={s.mockToastName}>Knight in Shining Armor</div>
          <div className={s.mockToastGame}>Hollow Knight · 4.2% of players</div>
        </div>
        <IconCheck size={16} stroke={2.5} style={{ color: 'var(--a)' }} />
      </div>
    </div>
  )
}

// The XP level ring + tier from your profile.
function MockXp() {
  return (
    <div className={s.mock}>
      <div className={s.mockXp}>
        <div className={s.mockRing} style={{ '--p': 68 }}>
          <div className={s.mockRingInner}>
            <span className={s.mockRingLvl}>12</span>
            <span className={s.mockRingWord}>LEVEL</span>
          </div>
        </div>
        <div className={s.mockXpInfo}>
          <div className={s.mockXpTier}>Seasoned</div>
          <div className={s.mockXpBarTrack}><div className={s.mockXpBarFill} style={{ width: '68%' }} /></div>
          <div className={s.mockXpSub}>+340 XP to Level 13 · earned from playtime, rare unlocks, streaks & finished games</div>
        </div>
      </div>
    </div>
  )
}

export default function OnboardingModal({ onDone }) {
  const [step, setStep]       = useState(0)
  const [apiKey, setApiKey]   = useState('')
  const [steamId, setSteamId] = useState('')
  const [testState, setTestState] = useState('idle')   // idle | testing | valid | invalid
  const [testMsg, setTestMsg] = useState('')
  const [saving, setSaving]   = useState(false)
  const [resolving, setResolving] = useState(false)
  const [idMsg, setIdMsg] = useState(null)   // { type: 'ok'|'err', text }

  useEffect(() => {
    window.kozo?.api?.settings?.getAll?.().then(res => {
      if (res?.ok) {
        setApiKey(res.data?.steam_api_key || '')
        setSteamId(res.data?.steam_user_id || '')
      }
    })
  }, [])

  async function finish() {
    await window.kozo?.api?.settings?.set('onboarding_done', '1')
    onDone()
  }

  async function testKey() {
    if (!apiKey.trim()) return
    setTestState('testing'); setTestMsg('')
    const res = await window.kozo?.api?.steam?.testKey(apiKey.trim())
    if (res?.ok) { setTestState(res.data?.valid ? 'valid' : 'invalid'); setTestMsg(res.data?.message || '') }
    else { setTestState('invalid'); setTestMsg('Test failed') }
  }

  // Resolve whatever's in the Steam field (URL / name / ID) to a SteamID64.
  async function resolveId() {
    if (!steamId.trim()) return null
    setResolving(true); setIdMsg(null)
    const r = await window.kozo?.api?.steam?.resolveId(steamId.trim(), apiKey.trim())
    setResolving(false)
    if (r?.ok && r.data?.steamId) {
      setSteamId(r.data.steamId)
      setIdMsg({ type: 'ok', text: `Found your account: ${r.data.steamId}` })
      return r.data.steamId
    }
    const reason = r?.data?.error
    setIdMsg({ type: 'err', text:
      reason === 'no_api_key' ? 'Add your API key above first, then check again.' :
      reason === 'not_found'  ? "Couldn't find that profile. Make sure the name/URL is right." :
      reason === 'unrecognized' ? "That doesn't look like a Steam profile URL, name, or ID." :
      'Could not look that up. Check your API key and try again.' })
    return null
  }

  async function saveSteamAndNext() {
    setSaving(true)
    const key = apiKey.trim()
    if (key) await window.kozo?.api?.settings?.set('steam_api_key', key)
    const idInput = steamId.trim()
    if (idInput) {
      // Resolve a URL/name to a SteamID64 before saving (a raw 17-digit ID passes through).
      const r = await window.kozo?.api?.steam?.resolveId(idInput, key)
      const finalId = (r?.ok && r.data?.steamId) ? r.data.steamId : idInput
      await window.kozo?.api?.settings?.set('steam_user_id', finalId)
    }
    setSaving(false)
    setStep(2)
  }

  const STEPS = [
    // 0 — Welcome
    <div key="w" className={s.stepBody}>
      <div className={s.heroLogo}><HoneycombLogo size={56} /></div>
      <h2 className={s.heroTitle}>Welcome to KoZo</h2>
      <p className={s.heroText}>
        Your local-first game tracker. It spots the games you launch, records your playtime and
        sessions, and syncs achievements — even for cracked/offline games — all on your PC. Here's
        a 60-second tour of how it actually works.
      </p>
      <div className={s.tipGrid}>
        <Tip Icon={IconChartBar} title="Tracks itself" text="Detects running games and records every session — no manual timers." />
        <Tip Icon={IconTrophy} title="Live achievements" text="Unlocks pop up over your game, for Steam and cracked games alike." />
        <Tip Icon={IconDeviceFloppy} title="Yours, locally" text="Find & back up your saves; your whole library stays on your machine." />
      </div>
    </div>,

    // 1 — Connect Steam
    <div key="s" className={s.stepBody}>
      <div className={s.stepIcon}><IconBrandSteam size={30} stroke={1.5} /></div>
      <h2 className={s.stepTitle}>Connect Steam <span className={s.optional}>recommended</span></h2>
      <p className={s.stepText}>
        This is the part most people forget. KoZo needs a free <strong>Steam Web API key</strong> and
        your <strong>Steam ID</strong> to sync achievements and cover art. You can always add these
        later in Settings → Steam.
      </p>

      <label className={s.fieldLabel}>
        Steam Web API key
        <a className={s.help} href="#" onClick={e => { e.preventDefault(); window.kozo?.api?.shell?.openExternal(API_KEY_URL) }}>
          Get a key <IconExternalLink size={11} stroke={1.8} />
        </a>
      </label>
      <input className={s.input} value={apiKey} onChange={e => { setApiKey(e.target.value); setTestState('idle') }}
        placeholder="Paste your API key" spellCheck={false} />

      <label className={s.fieldLabel} style={{ marginTop: 12 }}>Your Steam profile</label>
      <input className={s.input} value={steamId} onChange={e => { setSteamId(e.target.value); setIdMsg(null) }}
        placeholder="Profile link, custom name, or SteamID64" spellCheck={false} />
      <p className={s.note} style={{ marginTop: 6 }}>
        In Steam, click your name (top-right) → <strong>View my profile</strong>, then copy the page
        URL and paste it above. KoZo turns it into your ID for you — no other websites needed.
      </p>

      <div className={s.testRow}>
        <button className={s.ghostBtn} onClick={testKey} disabled={!apiKey.trim() || testState === 'testing'}>
          {testState === 'testing' ? <IconLoader2 size={13} className="spin" /> : <IconCheck size={13} stroke={2} />}
          Test key
        </button>
        <button className={s.ghostBtn} onClick={resolveId} disabled={!steamId.trim() || resolving}>
          {resolving ? <IconLoader2 size={13} className="spin" /> : <IconSearch size={13} stroke={2} />}
          Find my ID
        </button>
      </div>
      <div className={s.testRow} style={{ marginTop: 8 }}>
        {testState === 'valid'   && <span className={s.ok}><IconCheck size={13} stroke={2.5} /> Key is valid</span>}
        {testState === 'invalid' && <span className={s.err}><IconX size={13} stroke={2.5} /> {testMsg || 'Invalid key'}</span>}
        {idMsg?.type === 'ok'  && <span className={s.ok}><IconCheck size={13} stroke={2.5} /> {idMsg.text}</span>}
        {idMsg?.type === 'err' && <span className={s.err}><IconX size={13} stroke={2.5} /> {idMsg.text}</span>}
      </div>

      <p className={s.note}>
        For achievement sync to work, your Steam profile + game details must be set to <strong>Public</strong>.
      </p>
    </div>,

    // 2 — Add games
    <div key="g" className={s.stepBody}>
      <div className={s.stepIcon}><IconDeviceGamepad2 size={30} stroke={1.5} /></div>
      <h2 className={s.stepTitle}>Fill your library</h2>
      <p className={s.stepText}>Two easy ways — do either any time, right from the Library:</p>
      <MockToolbar />
      <div className={s.wayList}>
        <Way Icon={IconSearch} title="Scan PC" text="The Scan PC button on the Library toolbar finds installed games (Steam, Epic, GOG, Xbox, cracked) across your drives — pick which to add. Achievements start syncing the moment a game is added." />
        <Way Icon={IconDeviceGamepad2} title="Add manually" text='The "Add Game" button — point KoZo at any .exe. Perfect for offline games.' />
      </div>
    </div>,

    // 3 — Auto tracking
    <div key="t" className={s.stepBody}>
      <div className={s.stepIcon}><IconClock size={30} stroke={1.5} /></div>
      <h2 className={s.stepTitle}>It tracks while you play</h2>
      <p className={s.stepText}>
        Just launch a game. KoZo notices it start, lights up a <strong>LIVE</strong> badge, and counts
        the session — no buttons to press.
      </p>
      <MockPlay />
      <div className={s.tipGrid}>
        <Tip Icon={IconBolt} title="Away? It pauses" text="Step away and KoZo stops counting (and watches your controller too) — overnight idling won't inflate your stats. Turn it on in Settings → General." />
        <Tip Icon={IconChartBar} title="Sessions & stats" text="Every session lands on your timeline and feeds the Statistics page — playtime by day, by hour, by game." />
      </div>
    </div>,

    // 4 — Achievements
    <div key="a" className={s.stepBody}>
      <div className={s.stepIcon}><IconTrophy size={30} stroke={1.5} /></div>
      <h2 className={s.stepTitle}>Achievements pop up live</h2>
      <p className={s.stepText}>
        The moment you unlock one, a toast slides in over your game — Steam-style, in your accent color.
        Works for Steam <em>and</em> cracked games, no setup.
      </p>
      <MockToast />
      <p className={s.note}>
        Steam unlocks sync automatically while you play and after each session; cracked games update
        instantly from their local files. Every unlock also shows on each game's page.
      </p>
    </div>,

    // 5 — Progress + done
    <div key="f" className={s.stepBody}>
      <div className={s.stepIcon}><IconBolt size={30} stroke={1.5} /></div>
      <h2 className={s.stepTitle}>Level up — you're all set</h2>
      <p className={s.stepText}>
        Everything you do earns XP — playtime, rare unlocks, day streaks and finished games — leveling
        up your profile through tiers from Rookie to Mythic.
      </p>
      <MockXp />
      <p className={s.note}>
        Press <strong>Alt+K</strong> in-game to flash your session time + achievements over the game.
        KoZo lives in the tray and keeps tracking in the background — and can keep an always-synced
        backup of your data (Settings → Backups).
      </p>
    </div>,
  ]

  const isLast  = step === STEPS.length - 1
  const isSteam = step === 1

  return (
    <div className={s.overlay}>
      <div className={s.card}>
        <button className={s.skip} onClick={finish} title="Skip">Skip <IconX size={13} stroke={2} /></button>

        <div className={s.content}>{STEPS[step]}</div>

        <div className={s.footer}>
          <div className={s.dots}>
            {STEPS.map((_, i) => (
              <span key={i} className={`${s.dot} ${i === step ? s.dotActive : ''}`} />
            ))}
          </div>
          <div className={s.footerBtns}>
            {step > 0 && (
              <button className={s.ghostBtn} onClick={() => setStep(step - 1)}>
                <IconArrowLeft size={14} stroke={2} /> Back
              </button>
            )}
            {isSteam ? (
              <button className={s.primaryBtn} onClick={saveSteamAndNext} disabled={saving}>
                {saving ? <IconLoader2 size={14} className="spin" /> : null}
                {apiKey.trim() || steamId.trim() ? 'Save & continue' : 'Skip for now'}
                <IconArrowRight size={14} stroke={2} />
              </button>
            ) : isLast ? (
              <button className={s.primaryBtn} onClick={finish}>
                <IconCheck size={14} stroke={2.5} /> Get started
              </button>
            ) : (
              <button className={s.primaryBtn} onClick={() => setStep(step + 1)}>
                Next <IconArrowRight size={14} stroke={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Tip({ Icon, title, text }) {
  return (
    <div className={s.tip}>
      <div className={s.tipIcon}><Icon size={18} stroke={1.6} /></div>
      <div>
        <div className={s.tipTitle}>{title}</div>
        <div className={s.tipText}>{text}</div>
      </div>
    </div>
  )
}

function Way({ Icon, title, text }) {
  return (
    <div className={s.way}>
      <div className={s.wayIcon}><Icon size={17} stroke={1.6} /></div>
      <div>
        <div className={s.wayTitle}>{title}</div>
        <div className={s.wayText}>{text}</div>
      </div>
    </div>
  )
}
