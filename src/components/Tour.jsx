import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  IconBrandSteam, IconCheck, IconLoader2, IconX, IconPointer, IconChartBar,
  IconTrophy, IconDeviceFloppy, IconArrowRight, IconArrowLeft,
} from '@tabler/icons-react'
import HoneycombLogo from './HoneycombLogo'
import s from './Tour.module.css'

// Interactive first-run walkthrough. Each step spotlights a real control in the
// app (tagged with data-tour="…"), explains it, and either lets the user click
// it to move on ("Click Game List") or offers to run it for them ("Scan my PC
// now"). Centered steps (no target) cover the intro, Steam and the wrap-up.
// Finishing or skipping stores onboarding_done = 1; Settings → About replays it.

const STEPS = [
  { id: 'welcome' },
  {
    route: '/', target: 'library-stats',
    title: 'Your library at a glance',
    body: 'Games, total playtime, achievements and this week\'s play. Everything updates by itself while you play.',
  },
  {
    route: '/', target: 'scan-pc',
    title: 'Find your games in one click',
    body: 'Scan PC looks through your drives for Steam, Epic, GOG, Xbox and cracked games, then lets you pick which ones to add.',
    action: { label: 'Scan my PC now', click: true },
    waitText: 'Scanning your PC. This can take a minute, the results open by themselves.',
  },
  {
    route: '/', target: 'add-game',
    title: 'Or add any game yourself',
    body: 'Search Steam or point KoZo at any .exe. Offline and cracked games work too.',
    action: { label: 'Add a game', click: true },
  },
  {
    route: '/', target: 'nav-game-list', clickToContinue: true,
    title: 'Your Game List',
    body: 'Your backlog and wishlist live here, synced with your Library. Click Game List to open it.',
  },
  {
    route: '/game-list', target: 'month-filter',
    title: 'Plan your month',
    body: 'Select a few games, choose Plan for month, then filter by that month to see what you mean to play next.',
  },
  {
    route: '/game-list', target: 'nav-upcoming', clickToContinue: true,
    title: 'Upcoming releases',
    body: 'Click Upcoming to see what is coming out soon.',
  },
  {
    route: '/upcoming', target: 'upcoming-tabs',
    title: 'Steam release calendar',
    body: 'My upcoming counts down the games you track. Steam calendar shows every popular release by day. Track one and KoZo tells you the moment it is out.',
  },
  {
    route: '/upcoming', target: 'nav-profile',
    title: 'Level up as you play',
    body: 'Playtime, rare achievements, day streaks and finished games all earn XP. Your profile shows your level and favorite games.',
  },
  { id: 'steam' },
  { id: 'done' },
]

const TARGETED = STEPS.filter(st => st.target)
const CARD_W = 340
const GAP = 14
const PAD = 6

function findTarget(id) {
  return id ? document.querySelector(`[data-tour="${id}"]`) : null
}

// Card placement: right of the target, else below, else above, else left;
// always clamped inside the window.
// Card placement: below the target, else above, else right, else left. Any
// candidate whose card would overlap the target is rejected, so the card never
// hides the control it is talking about. Always clamped inside the window.
function placeCard(rect, cardH) {
  const vw = window.innerWidth, vh = window.innerHeight
  const clampX = (x) => Math.max(12, Math.min(x, vw - CARD_W - 12))
  const clampY = (y) => Math.max(12, Math.min(y, vh - cardH - 12))
  const centerX = clampX(rect.left + rect.width / 2 - CARD_W / 2)
  const centerY = clampY(rect.top + rect.height / 2 - cardH / 2)
  const candidates = [
    { left: centerX, top: rect.bottom + GAP },
    { left: centerX, top: rect.top - GAP - cardH },
    { left: rect.right + GAP, top: centerY },
    { left: rect.left - GAP - CARD_W, top: centerY },
  ]
  const fits = (c) => c.left >= 12 && c.top >= 12 && c.left + CARD_W <= vw - 12 && c.top + cardH <= vh - 12
  const overlaps = (c) => !(c.left + CARD_W <= rect.left || c.left >= rect.right || c.top + cardH <= rect.top || c.top >= rect.bottom)
  const pick = candidates.find(c => fits(c) && !overlaps(c)) || candidates.find(c => !overlaps({ left: clampX(c.left), top: clampY(c.top) }))
  const c = pick || candidates[0]
  return { left: clampX(c.left), top: clampY(c.top) }
}

export default function Tour({ onDone }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState(null)
  const [cardH, setCardH] = useState(220)
  const cardRef = useRef(null)
  const step = STEPS[index]
  const centered = !step.target
  // A real dialog (Scan results, Add Game…) is open: step aside until it closes.
  const [paused, setPaused] = useState(false)
  useEffect(() => {
    const t = setInterval(() => setPaused(!!document.querySelector('[role="dialog"]')), 200)
    return () => clearInterval(t)
  }, [])

  async function finish(then) {
    try { await window.kozo?.api?.settings?.set('onboarding_done', '1') } catch {}
    onDone()
    if (then) setTimeout(then, 50)
  }
  const next = () => (index < STEPS.length - 1 ? setIndex(index + 1) : finish())
  const back = () => setIndex(Math.max(0, index - 1))

  // Go to the step's page.
  useEffect(() => {
    if (step.route && location.pathname !== step.route) navigate(step.route)
  }, [index])

  // Track the target's position (it may mount late, move, or resize).
  useEffect(() => {
    setRect(null)
    if (!step.target) return
    let alive = true
    let scrolled = false
    const tick = () => {
      if (!alive) return
      const el = findTarget(step.target)
      if (el) {
        if (!scrolled) { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); scrolled = true }
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0) {
          setRect(prev => (prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height)
            ? prev
            : { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom })
        }
      }
    }
    tick()
    const t = setInterval(tick, 200)
    window.addEventListener('resize', tick)
    return () => { alive = false; clearInterval(t); window.removeEventListener('resize', tick) }
  }, [index, location.pathname])

  // "Click it to continue" steps advance when the real control is clicked.
  // Action steps (Scan PC, Add Game) instead wait for what the click started:
  // a scan can take a while and then opens its results, so the tour stays on
  // this step until that work and its dialog are both finished.
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setWaiting(false); setBusy(false) }, [index])
  useEffect(() => {
    if (!step.clickToContinue && !step.action) return
    const el = findTarget(step.target)
    if (!el) return
    const onClick = step.action
      ? () => setWaiting(true)
      : () => setTimeout(() => setIndex(i => i + 1), 120)
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [index, rect != null])

  useEffect(() => {
    if (!waiting) return
    const started = Date.now()
    let seen = false
    const t = setInterval(() => {
      const el = findTarget(step.target)
      const isBusy = !!el && (el.disabled || el.getAttribute('aria-busy') === 'true')
      const dialog = !!document.querySelector('[role="dialog"]')
      setBusy(isBusy)
      if (isBusy || dialog) { seen = true; return }
      if (seen || Date.now() - started > 3000) { clearInterval(t); setIndex(i => i + 1) }
    }, 200)
    return () => clearInterval(t)
  }, [waiting, index])

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight)
  }, [index, rect, waiting, busy])

  useEffect(() => {
    const onKey = (e) => {
      if (paused) return   // keys belong to the open dialog
      if (e.key === 'Escape') finish()
      if (e.key === 'ArrowRight' && !step.clickToContinue && !waiting) next()
      if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Run the real control (Scan PC, Add Game). Its click listener above puts the
  // step into waiting; the tour hides while a dialog is open and moves on after.
  function runAction() {
    findTarget(step.target)?.click()
  }

  // Dots for the spotlight steps only, so they match "Step x of y".
  const at = TARGETED.indexOf(step)
  const progress = at >= 0 && (
    <div className={s.dots}>
      {TARGETED.map((st, i) => <span key={i} className={`${s.dot} ${i === at ? s.dotActive : ''} ${i < at ? s.dotDone : ''}`} />)}
    </div>
  )

  // Kept 4px inside the window so the outline and glow are never cut off when
  // the target touches an edge (the stats bar sits right under the title bar).
  const spot = rect && (() => {
    const left = Math.max(4, rect.left - PAD), top = Math.max(4, rect.top - PAD)
    const right = Math.min(window.innerWidth - 4, rect.right + PAD), bottom = Math.min(window.innerHeight - 4, rect.bottom + PAD)
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
  })()
  const cardPos = rect ? placeCard({ ...rect, right: rect.right + PAD, bottom: rect.bottom + PAD, top: rect.top - PAD, left: rect.left - PAD }, cardH) : null

  if (paused) return null

  return createPortal(
    <div className={s.root}>
      {centered || !rect
        ? <div className={s.dim} />
        : <div className={s.spot} style={spot} />}

      {centered ? (
        <div className={s.centerWrap}>
          <div className={`${s.card} ${s.cardWide}`} ref={cardRef}>
            {step.id === 'welcome' && <Welcome />}
            {step.id === 'steam' && <SteamConnect />}
            {step.id === 'done' && <Done />}
            <div className={s.footer}>
              <div className={s.spacer} />
              {index === 0
                ? <button className={s.ghost} onClick={() => finish()}>Skip</button>
                : <button className={s.ghost} onClick={back}><IconArrowLeft size={14} /> Back</button>}
              <button className={s.primary} onClick={next}>
                {index === 0 ? 'Show me around' : step.id === 'done' ? 'Start playing' : 'Next'}
                {step.id !== 'done' && <IconArrowRight size={14} />}
              </button>
            </div>
          </div>
        </div>
      ) : rect && (
        <div className={s.card} ref={cardRef} style={{ left: cardPos.left, top: cardPos.top, width: CARD_W }}>
          <button className={s.close} onClick={() => finish()} aria-label="Close the tour"><IconX size={14} /></button>
          <div className={s.stepCount}>Step {TARGETED.indexOf(step) + 1} of {TARGETED.length}</div>
          <h3 className={s.title}>{step.title}</h3>
          <p className={s.body}>{step.body}</p>
          {step.clickToContinue && (
            <div className={s.hint}><IconPointer size={14} /> Click the highlighted button to continue</div>
          )}
          {waiting && busy && (
            <div className={s.hint}><IconLoader2 size={14} className="spin" /> {step.waitText || 'Working on it…'}</div>
          )}
          {progress}
          <div className={s.footer}>
            <button className={s.ghost} onClick={back} aria-label="Back"><IconArrowLeft size={14} /></button>
            <div className={s.spacer} />
            {waiting
              ? <button className={s.ghost} onClick={next}>Skip step</button>
              : step.action && <button className={s.ghost} onClick={runAction}>{step.action.label}</button>}
            {!step.clickToContinue && !waiting && <button className={s.primary} onClick={next}>Next <IconArrowRight size={14} /></button>}
            {step.clickToContinue && <button className={s.ghost} onClick={next}>Skip step</button>}
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}

function Welcome() {
  return (
    <div className={s.hero}>
      <HoneycombLogo size={54} />
      <h2 className={s.heroTitle}>Welcome to KoZo</h2>
      <p className={s.body}>
        KoZo spots the games you launch, records your playtime and syncs achievements, even for
        cracked and offline games. Everything stays on your PC. Let's take a quick tour of the real app.
      </p>
      <div className={s.features}>
        <div className={s.feature}><IconChartBar size={18} /><span>Tracks itself</span></div>
        <div className={s.feature}><IconTrophy size={18} /><span>Live achievements</span></div>
        <div className={s.feature}><IconDeviceFloppy size={18} /><span>Save backups</span></div>
      </div>
    </div>
  )
}

// Steam connects on its own from the local Steam app; browser sign-in is the fallback.
function SteamConnect() {
  const [steamId, setSteamId] = useState('')
  const [persona, setPersona] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    ;(async () => {
      const res = await window.kozo?.api?.settings?.getAll?.()
      if (res?.ok) { setSteamId(res.data?.steam_user_id || ''); setPersona(res.data?.steam_persona || '') }
      if (!res?.data?.steam_user_id) {
        const d = await window.kozo?.api?.steam?.detectUser?.()
        const det = d?.ok ? d.data : d
        if (det?.steamId) {
          await window.kozo?.api?.settings?.set('steam_user_id', det.steamId)
          setSteamId(det.steamId); setPersona(det.personaName || '')
        }
      }
    })()
  }, [])

  async function signIn() {
    setBusy(true); setMsg(null)
    const r = await window.kozo?.api?.steam?.signIn?.()
    setBusy(false)
    const d = r?.ok ? r.data : r
    if (d?.steamId) { setSteamId(d.steamId); setPersona(d.personaName || '') }
    else setMsg(d?.error === 'timeout' ? 'Sign-in timed out. Try again.' : 'Sign-in failed. Try again.')
  }

  return (
    <div className={s.hero}>
      <div className={s.steamIcon}><IconBrandSteam size={30} stroke={1.5} /></div>
      <h2 className={s.heroTitle}>Connect Steam</h2>
      <p className={s.body}>
        KoZo reads your account from the Steam app on this PC and syncs achievements and cover art.
        No API key needed.
      </p>
      {steamId ? (
        <div className={s.ok}><IconCheck size={15} stroke={2.5} /> Connected{persona ? ` as ${persona}` : ''}</div>
      ) : (
        <button className={s.primary} onClick={signIn} disabled={busy}>
          {busy ? <IconLoader2 size={14} className="spin" /> : <IconBrandSteam size={14} />}
          {busy ? 'Waiting for your browser…' : 'Sign in with Steam'}
        </button>
      )}
      {msg && <div className={s.err}>{msg}</div>}
      <p className={s.note}>Your Steam profile's Game details must be Public for achievement sync. You can change this later in Settings, Steam.</p>
    </div>
  )
}

function Done() {
  return (
    <div className={s.hero}>
      <HoneycombLogo size={46} />
      <h2 className={s.heroTitle}>You're all set</h2>
      <p className={s.body}>
        KoZo keeps running in the tray next to the clock. Right-click its icon for your current game,
        today's playtime and quick launch. Replay this tour any time from Settings, About.
      </p>
    </div>
  )
}
