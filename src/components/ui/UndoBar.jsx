import React, { useEffect, useState } from 'react'
import { IconArrowBackUp, IconX } from '@tabler/icons-react'
import s from './UndoBar.module.css'

// "Changed 5 games. Undo": a bar at the bottom for 20 seconds after an edit to many
// games (Library select mode). `undo` = { text, run } or null; a new one replaces it.
export default function UndoBar({ undo, onDone }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => onDone?.(), 20000)
    return () => clearTimeout(t)
  }, [undo])
  if (!undo) return null
  async function run() {
    setBusy(true)
    try { await undo.run() } finally { setBusy(false); onDone?.() }
  }
  return (
    <div className={s.bar} role="status" data-undo-bar>
      <span className={s.text}>{undo.text}</span>
      <button type="button" className={s.undo} onClick={run} disabled={busy}>
        <IconArrowBackUp size={15} stroke={1.8} /> {busy ? 'Undoing…' : 'Undo'}
      </button>
      <button type="button" className={s.close} onClick={() => onDone?.()} aria-label="Close"><IconX size={14} /></button>
    </div>
  )
}
