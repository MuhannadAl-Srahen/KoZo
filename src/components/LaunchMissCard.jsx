import React, { useEffect, useState } from 'react'
import { IconDeviceGamepad2, IconLoader2 } from '@tabler/icons-react'
import RunningProcessPicker from './ui/RunningProcessPicker'
import s from './LaunchMissCard.module.css'

// Play was pressed, but the file KoZo watches never started, so the play isn't being
// counted. A card in the corner, not a window: the page stays usable, and it may be asked
// while the game is open. services/launchCheck.js decides when; picking a program here
// makes KoZo watch that one from now on.
export default function LaunchMissCard() {
  const [miss, setMiss] = useState(null)
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    window.kozo?.api?.games?.launchMiss?.().then(r => { if (alive && r?.ok) setMiss(r.data) })
    const off = window.kozo?.events?.onLaunchMiss?.((d) => { setMiss(d); setAll(false); setError(null) })
    return () => { alive = false; off?.() }
  }, [])

  if (!miss) return null

  async function pick(proc) {
    setBusy(true); setError(null)
    const r = await window.kozo?.api?.games?.setWatchedExe?.(miss.gameId, proc)
    setBusy(false)
    if (r?.ok) setMiss(null)
    else setError(r?.error || 'That could not be saved.')
  }
  function notNow() {
    window.kozo?.api?.games?.dismissLaunchMiss?.(miss.gameId)
    setMiss(null)
  }

  return (
    <div className={s.card} role="status" data-launch-miss={miss.gameId}>
      <div className={s.title}><IconDeviceGamepad2 size={16} stroke={1.7} /> Which program is {miss.name}?</div>
      <p className={s.text}>
        KoZo started it, but <b>{miss.exe_name}</b> never showed up, so your play isn't being counted.
        {miss.candidates?.length ? ' Is it this one?' : ' If the game is open, choose its program from All programs.'}
      </p>
      {all ? (
        <RunningProcessPicker onPick={pick} onClose={() => setAll(false)} />
      ) : miss.candidates?.length > 0 && (
        <div className={s.list}>
          {miss.candidates.map(c => (
            <button key={c.exe_name} type="button" className={s.option} disabled={busy} data-gpnav onClick={() => pick(c)} data-launch-pick={c.exe_name}>
              <span className={s.exe} title={c.exe_name}>{c.exe_name}</span>
              <small>In the game's folder</small>
            </button>
          ))}
        </div>
      )}
      {error && <p className={s.error}>{error}</p>}
      <div className={s.foot}>
        {busy && <IconLoader2 size={14} className="spin" />}
        {!all && <button type="button" className={s.btn} data-gpnav onClick={() => setAll(true)} data-launch-all>All programs</button>}
        <button type="button" className={s.btn} data-gpnav onClick={notNow} data-launch-later>Not now</button>
      </div>
    </div>
  )
}
