import React, { useEffect, useState } from 'react'
import {
  IconPlayerPlayFilled, IconPlayerPause, IconPlayerPlay, IconTrophy, IconClock,
  IconLayoutDashboard, IconChartBar, IconPower, IconDeviceGamepad2, IconMoonStars,
} from '@tabler/icons-react'
import HoneycombLogo from './components/HoneycombLogo'
import { applyAccent } from './context/AccentColorContext'
import { fileUrl, formatPlaytime } from './lib/utils'
import s from './TrayApp.module.css'

// The tray popup (electron/trayWindow.js): opened by right-clicking KoZo's tray
// icon. Data comes from tray:data; buttons go through tray:action.

function clock(sec) {
  sec = Math.max(0, Math.floor(sec))
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

function coverSrc(g) {
  return g.cover ? fileUrl(g.cover, g.coverRev) : (g.coverUrl || null)
}

function Cover({ g, className }) {
  const [failed, setFailed] = useState(false)
  const src = coverSrc(g)
  if (!src || failed) return <div className={`${className} ${s.coverEmpty}`}><IconDeviceGamepad2 size={18} stroke={1.4} /></div>
  return <img className={className} src={src} alt="" onError={() => setFailed(true)} />
}

export default function TrayApp() {
  const [data, setData] = useState(null)
  const [, setTick] = useState(0)

  async function load() {
    const res = await window.kozo?.api?.tray?.data?.()
    if (res?.ok) {
      setData(res.data)
      if (res.data.accent) applyAccent(res.data.accent)
    }
  }

  useEffect(() => {
    // The popup window is transparent — only the panel itself is painted.
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    load()
    const off = window.kozo?.events?.onTrayRefresh?.(load)
    const t = setInterval(() => setTick(n => n + 1), 1000)
    const onKey = (e) => { if (e.key === 'Escape') act('hide') }
    window.addEventListener('keydown', onKey)
    return () => { off?.(); clearInterval(t); window.removeEventListener('keydown', onKey) }
  }, [])

  function act(name, arg) {
    return window.kozo?.api?.tray?.action?.(name, arg).then(() => {
      if (name === 'pause' || name === 'resume') load()
    })
  }

  if (!data) return <div className={s.panel} />

  const { profile, live, recent, todaySec, paused } = data
  const now = Date.now()
  const liveSec = (g) => (now - new Date(g.startedAt).getTime()) / 1000 - (g.idleSeconds || 0)
  const today = todaySec + live.reduce((n, g) => n + Math.max(0, liveSec(g)), 0)

  return (
    <div className={s.panel}>
      <header className={s.head}>
        {profile.avatar
          ? <img className={s.avatar} src={fileUrl(profile.avatar)} alt="" />
          : <div className={s.avatarEmpty}><HoneycombLogo size={22} /></div>}
        <div className={s.who}>
          <div className={s.name}>{profile.name}</div>
          {profile.level != null && (
            <>
              <div className={s.level}>Lv {profile.level}{profile.tier ? ` · ${profile.tier}` : ''}</div>
              <div className={s.xpBar}><span style={{ width: `${profile.progress}%` }} /></div>
            </>
          )}
        </div>
      </header>

      <section className={s.section}>
        <div className={s.label}>{live.length ? 'Now playing' : 'Status'}</div>
        {live.length === 0 ? (
          <div className={s.idle}>
            {paused ? <IconPlayerPause size={18} /> : <IconMoonStars size={18} />}
            <span>{paused ? 'Tracking is paused' : 'No game running'}</span>
          </div>
        ) : live.map(g => (
          <button key={g.id} className={s.now} onClick={() => act('openAt', `/game/${g.id}`)}>
            <Cover g={g} className={s.nowCover} />
            <div className={s.nowInfo}>
              <div className={s.nowName}>{g.name}</div>
              <div className={s.nowTime}>
                <span className={s.liveDot} /> {clock(liveSec(g))}
                {g.idle && <span className={s.away}>away</span>}
              </div>
              {g.achTotal > 0 && (
                <div className={s.nowAch}>
                  <IconTrophy size={12} /> {g.achUnlocked}/{g.achTotal}
                  <div className={s.achBar}><span style={{ width: `${(g.achUnlocked / g.achTotal) * 100}%` }} /></div>
                </div>
              )}
            </div>
          </button>
        ))}
        <div className={s.today}>
          <IconClock size={14} />
          <span>Today</span>
          <strong>{today >= 60 ? formatPlaytime(today) : 'Nothing yet'}</strong>
        </div>
      </section>

      {recent.length > 0 && (
        <section className={s.section}>
          <div className={s.label}>Jump back in</div>
          <div className={s.recent}>
            {recent.map(g => (
              <button key={g.id} className={s.recentItem} onClick={() => act('launch', g.id)} title={`Play ${g.name}`}>
                <Cover g={g} className={s.recentCover} />
                <span className={s.recentPlay}><IconPlayerPlayFilled size={14} /></span>
                <span className={s.recentName}>{g.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <footer className={s.foot}>
        <button className={s.primary} onClick={() => act('open')}>
          <IconLayoutDashboard size={15} /> Open KoZo
        </button>
        <button className={s.iconBtn} title="Statistics" onClick={() => act('openAt', '/statistics')}>
          <IconChartBar size={16} />
        </button>
        <button className={s.iconBtn} title={paused ? 'Resume tracking' : 'Pause tracking'} onClick={() => act(paused ? 'resume' : 'pause')}>
          {paused ? <IconPlayerPlay size={16} /> : <IconPlayerPause size={16} />}
        </button>
        <button className={`${s.iconBtn} ${s.quit}`} title="Quit KoZo" onClick={() => act('quit')}>
          <IconPower size={16} />
        </button>
      </footer>
    </div>
  )
}
