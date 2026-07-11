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
  const [steamId, setSteamId] = useState('')
  const [persona, setPersona] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [steamMsg, setSteamMsg] = useState(null)   // { type: 'ok'|'err', text }

  useEffect(() => {
    ;(async () => {
      const res = await window.kozo?.api?.settings?.getAll?.()
      if (res?.ok) {
        setSteamId(res.data?.steam_user_id || '')
        setPersona(res.data?.steam_persona || '')
      }
      // Not connected yet? Try the silent local detect right here so the step
      // usually opens already done.
      if (!res?.data?.steam_user_id) {
        const d = await window.kozo?.api?.steam?.detectUser?.()
        const det = d?.ok ? d.data : d
        if (det?.steamId) {
          await window.kozo?.api?.settings?.set('steam_user_id', det.steamId)
          setSteamId(det.steamId)
          setPersona(det.personaName || '')
        }
      }
    })()
  }, [])

  async function finish() {
    await window.kozo?.api?.settings?.set('onboarding_done', '1')
    onDone()
  }

  async function signInWithSteam() {
    setSigningIn(true)
    setSteamMsg({ type: 'ok', text: 'Waiting for the browser sign-in…' })
    const r = await window.kozo?.api?.steam?.signIn?.()
    setSigningIn(false)
    const d = r?.ok ? r.data : r
    if (d?.steamId) {
      setSteamId(d.steamId)
      setPersona(d.personaName || '')
      setSteamMsg(null)
    } else {
      setSteamMsg({ type: 'err', text: d?.error === 'timeout' ? 'Sign-in timed out — try again.' : 'Sign-in failed — try again.' })
    }
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

    // 1 — Connect Steam (automatic — nothing to type)
    <div key="s" className={s.stepBody}>
      <div className={s.stepIcon}><IconBrandSteam size={30} stroke={1.5} /></div>
      <h2 className={s.stepTitle}>Steam connects itself</h2>
      <p className={s.stepText}>
        Nothing to type: KoZo reads your logged-in account straight from the Steam app on
        this PC and syncs achievements + cover art from there. No API key needed.
      </p>

      {steamId ? (
        <div className={s.testRow} style={{ marginTop: 4 }}>
          <span className={s.ok}>
            <IconCheck size={13} stroke={2.5} />
            Connected{persona ? <> as <strong>&nbsp;{persona}</strong></> : ` — ${steamId}`}
          </span>
        </div>
      ) : (
        <>
          <p className={s.note}>
            Steam isn't installed on this PC (or nobody is logged in) — sign in with your
            browser instead:
          </p>
          <div className={s.testRow}>
            <button className={s.ghostBtn} onClick={signInWithSteam} disabled={signingIn}>
              {signingIn ? <IconLoader2 size={13} className="spin" /> : <IconBrandSteam size={13} stroke={2} />}
              {signingIn ? 'Waiting…' : 'Sign in with Steam'}
            </button>
          </div>
        </>
      )}
      {steamMsg && (
        <div className={s.testRow} style={{ marginTop: 8 }}>
          <span className={steamMsg.type === 'ok' ? s.ok : s.err}>
            {steamMsg.type === 'ok' ? <IconLoader2 size={13} className="spin" /> : <IconX size={13} stroke={2.5} />}
            {steamMsg.text}
          </span>
        </div>
      )}

      <p className={s.note}>
        Your Steam profile's <strong>Game details</strong> must be Public for achievement sync.
        Private profile? Add an optional{' '}
        <a className={s.help} href="#" onClick={e => { e.preventDefault(); window.kozo?.api?.shell?.openExternal(API_KEY_URL) }}>
          API key <IconExternalLink size={11} stroke={1.8} />
        </a>{' '}
        later in Settings → Steam.
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

  const isLast = step === STEPS.length - 1

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
            {isLast ? (
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
