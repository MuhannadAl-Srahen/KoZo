import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconDeviceGamepad2, IconX, IconPlus } from '@tabler/icons-react'
import s from './UnknownGamePrompt.module.css'

// Persists across reloads so the user isn't pestered for the same exe again
const DISMISSED_KEY = 'kozo:dismissed-exes'

function loadDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')) }
  catch { return new Set() }
}

function saveDismissed(set) {
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]))
}

export default function UnknownGamePrompt() {
  const [queue, setQueue]         = useState([])     // pending unknown exes
  const [current, setCurrent]     = useState(null)   // exe currently shown in toast
  const [dismissed, setDismissed] = useState(loadDismissed)
  const navigate                  = useNavigate()

  useEffect(() => {
    if (!window.kozo?.events) return
    window.kozo.events.onUnknownProcess(({ exe_name, install_path }) => {
      if (!exe_name) return
      const key = exe_name.toLowerCase()
      setDismissed(prevD => {
        if (prevD.has(key)) return prevD
        setQueue(prevQ => prevQ.some(x => x.exe_name.toLowerCase() === key)
          ? prevQ
          : [...prevQ, { exe_name, install_path }])
        return prevD
      })
    })
    return () => window.kozo.events.removeAll('unknown-process')
  }, [])

  // Promote the next queued exe into the visible toast when slot is empty
  useEffect(() => {
    if (!current && queue.length > 0) {
      setCurrent(queue[0])
      setQueue(q => q.slice(1))
    }
  }, [current, queue])

  function dismiss(forever) {
    if (forever && current) {
      const next = new Set(dismissed)
      next.add(current.exe_name.toLowerCase())
      setDismissed(next)
      saveDismissed(next)
    }
    setCurrent(null)
  }

  function addToLibrary() {
    if (!current) return
    sessionStorage.setItem('kozo:prefill-exe', current.exe_name)
    if (current.install_path) {
      sessionStorage.setItem('kozo:prefill-install-path', current.install_path)
    }
    setCurrent(null)
    navigate('/?add=1')
  }

  if (!current) return null

  // Show only the trailing folder name to keep the path short
  const folderHint = current.install_path
    ? current.install_path.split(/[\\/]/).slice(-2).join('\\')
    : null

  return (
    <div className={s.toast} role="alert">
      <div className={s.iconWrap}>
        <IconDeviceGamepad2 size={20} stroke={1.5} />
      </div>

      <div className={s.body}>
        <div className={s.title}>New game detected</div>
        <div className={s.desc}>
          <code className={s.exe}>{current.exe_name}</code> is running. Want to track it?
        </div>
        {folderHint && (
          <div className={s.folderHint}>from <code className={s.folder}>{folderHint}</code></div>
        )}

        <div className={s.actions}>
          <button className={s.btnPrimary} onClick={addToLibrary}>
            <IconPlus size={13} stroke={2} />
            Add to library
          </button>
          <button className={s.btnSecondary} onClick={() => dismiss(false)}>
            Not now
          </button>
          <button className={s.btnGhost} onClick={() => dismiss(true)}>
            Never ask again
          </button>
        </div>
      </div>

      <button className={s.closeBtn} onClick={() => dismiss(false)} title="Dismiss">
        <IconX size={14} stroke={2} />
      </button>
    </div>
  )
}
