import React, { useState } from 'react'
import { IconHistory, IconFolder, IconBrandGoogleDrive, IconLoader2, IconCheck, IconFileZip } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import { timeAgo } from '../lib/utils'
import b from './BackupsTab.module.css'

// First run with an empty library: "Welcome back". Offers the KoZo Backup
// folder found on this PC's drives (backupHome.findExisting) and Google Drive,
// so a new Windows gets the library and every save back in one click.
export default function RestoreOffer({ found, drive, onOffer, onClose }) {
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState(null)
  const [error, setError] = useState(null)

  // `copy`: a cloud folder or USB stick, which stays where it is.
  async function fromFolder(path, copy) {
    setBusy(path); setError(null)
    const r = await window.kozo?.api?.backup?.restoreFolder?.(path, { copy })
    setBusy('')
    if (r?.ok) setDone(r.data?.data?.games ?? 0)
    else setError(r?.error || 'Restore failed')
  }
  async function pickFolder() {
    const p = await window.kozo?.api?.dialog?.pickFolder?.()
    if (p?.ok && p.data) fromFolder(p.data, true)
  }
  async function fromFile() {
    setBusy('file'); setError(null)
    const r = await window.kozo?.api?.pack?.importAll?.()
    setBusy('')
    if (r?.ok && r.data) setDone(r.data.data?.games ?? 0)
    else if (r?.ok === false) setError(r.error || 'That file could not be opened')
  }
  // What to bring in is asked in the next window (DriveOffer), the same as after any sign-in.
  async function fromDrive() {
    setBusy('drive'); setError(null)
    const api = window.kozo?.api?.drive
    const r = drive?.connected ? await api?.offer?.() : await api?.connect?.()
    setBusy('')
    if (!r?.ok || r.data?.error) { setError('Google Drive was not connected.'); return }
    const offer = drive?.connected ? r.data : r.data?.offer
    if (offer?.anything) onOffer(offer)
    else setError('This Google account has no KoZo backup to bring in.')
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
              <button key={f.path} type="button" className={b.action} disabled={!!busy} onClick={() => fromFolder(f.path, f.kind === 'copy')}>
                {busy === f.path ? <IconLoader2 size={18} className="spin" /> : <IconFolder size={18} />}
                <span><strong>{f.path}</strong><small>{f.games} games{f.at ? `, saved ${timeAgo(f.at)}` : ''}</small></span>
              </button>
            ))}
            {drive?.configured && (
              <button type="button" className={b.action} disabled={!!busy} onClick={fromDrive}>
                {busy === 'drive' ? <IconLoader2 size={18} className="spin" /> : <IconBrandGoogleDrive size={18} />}
                <span><strong>From Google Drive</strong><small>Sign in, then choose what to add</small></span>
              </button>
            )}
            <button type="button" className={b.action} disabled={!!busy} onClick={pickFolder}>
              <IconFolder size={18} />
              <span><strong>From a folder</strong><small>A KoZo Backup folder in your cloud folder or on a USB stick</small></span>
            </button>
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
