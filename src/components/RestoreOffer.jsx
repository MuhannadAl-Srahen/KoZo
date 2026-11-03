import React, { useState } from 'react'
import { IconHistory, IconFolder, IconBrandGoogleDrive, IconLoader2, IconCheck, IconFileZip } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import { timeAgo } from '../lib/utils'
import b from './BackupsTab.module.css'

// First run with an empty library: "Welcome back". Offers the KoZo Backup
// folder found on this PC's drives (backupHome.findExisting) and Google Drive,
// so a new Windows gets the library and every save back in one click.
export default function RestoreOffer({ found, drive, onClose }) {
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState(null)
  const [error, setError] = useState(null)

  async function fromFolder(path) {
    setBusy(path); setError(null)
    const r = await window.kozo?.api?.backup?.restoreFolder?.(path)
    setBusy('')
    if (r?.ok) setDone(r.data?.data?.games ?? 0)
    else setError(r?.error || 'Restore failed')
  }
  async function fromFile() {
    setBusy('file'); setError(null)
    const r = await window.kozo?.api?.pack?.importAll?.()
    setBusy('')
    if (r?.ok && r.data) setDone(r.data.data?.games ?? 0)
    else if (r?.ok === false) setError(r.error || 'That file could not be opened')
  }
  async function fromDrive() {
    setBusy('drive'); setError(null)
    if (!drive?.connected) {
      const c = await window.kozo?.api?.drive?.connect?.()
      if (!c?.ok || c.data?.error) { setBusy(''); setError('Google Drive was not connected.'); return }
    }
    const r = await window.kozo?.api?.drive?.restore?.()
    setBusy('')
    if (r?.ok) setDone(r.data?.data?.games ?? 0)
    else setError(r?.error || 'Restore failed')
  }

  return (
    <Modal title="Welcome back" icon={<IconHistory size={16} />} onClose={onClose} width={520}
      footer={done != null
        ? <button type="button" className={ms.btnPrimary} onClick={() => { onClose(); window.location.reload() }}><IconCheck size={14} /> Open my library</button>
        : <button type="button" className={ms.btnCancel} onClick={onClose} disabled={!!busy}>Start fresh</button>}>
      {done != null ? (
        <p className={b.foldNote}>Restored {done} games with their playtime and lists. Your save backups are back too: Settings, Backups, Put saves back.</p>
      ) : (
        <>
          <p className={b.foldNote}>KoZo found a backup of your library and game saves. Bring everything back?</p>
          <div className={b.actions} style={{ marginTop: 12 }}>
            {found.map(f => (
              <button key={f.path} type="button" className={b.action} disabled={!!busy} onClick={() => fromFolder(f.path)}>
                {busy === f.path ? <IconLoader2 size={18} className="spin" /> : <IconFolder size={18} />}
                <span><strong>{f.path}</strong><small>{f.games} games{f.at ? `, saved ${timeAgo(f.at)}` : ''}</small></span>
              </button>
            ))}
            {drive?.configured && (
              <button type="button" className={b.action} disabled={!!busy} onClick={fromDrive}>
                {busy === 'drive' ? <IconLoader2 size={18} className="spin" /> : <IconBrandGoogleDrive size={18} />}
                <span><strong>From Google Drive</strong><small>Sign in and download your backup</small></span>
              </button>
            )}
            <button type="button" className={b.action} disabled={!!busy} onClick={fromFile}>
              {busy === 'file' ? <IconLoader2 size={18} className="spin" /> : <IconFileZip size={18} />}
              <span><strong>From a KoZo file</strong><small>A .kozo file you saved on your old PC</small></span>
            </button>
          </div>
          {error && <p className={`${b.msg} ${b.msgErr}`} style={{ marginTop: 10 }}>{error}</p>}
        </>
      )}
    </Modal>
  )
}
