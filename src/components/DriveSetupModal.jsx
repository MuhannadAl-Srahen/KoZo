import React, { useRef, useState } from 'react'
import { IconBrandGoogleDrive, IconExternalLink, IconLoader2, IconCheck } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import b from './BackupsTab.module.css'
import d from './DriveSetupModal.module.css'

// One-time Google Drive setup. Google lets an app use someone's Drive only
// through a "client" made in Google Cloud (free, a few clicks), the same idea
// as Discord's Application ID. The user makes it once, pastes it here, then
// signs in; KoZo keeps it on this PC only (gdrive_client_id / _secret).
const open = (url) => window.kozo?.api?.shell?.openExternal?.(url)
const AUDIENCE_URL = 'https://console.cloud.google.com/auth/audience'

// Google's "Access blocked" page never comes back to KoZo, so the sign-in would
// just sit there waiting. Say what fixes it while it waits.
export function DriveBlockedHint() {
  return (
    <p className={d.hint}>
      If Google says "Access blocked": open <button type="button" className={d.hintLink} onClick={() => open(AUDIENCE_URL)}>Audience in Google Cloud</button>,
      add your Gmail under Test users, then sign in again.
    </p>
  )
}

const STEPS = [
  { text: 'Open Google Cloud and make a new project (any name, for example KoZo).', link: 'https://console.cloud.google.com/projectcreate', label: 'New project' },
  { text: 'Turn on the Google Drive API for it.', link: 'https://console.cloud.google.com/apis/library/drive.googleapis.com', label: 'Drive API' },
  { text: 'Set up the consent screen: choose External and fill the app name and your email. Then, under Audience, add your own email under Test users.', link: AUDIENCE_URL, label: 'Audience' },
  { text: 'Create credentials: OAuth client ID, type Desktop app.', link: 'https://console.cloud.google.com/apis/credentials/oauthclient', label: 'Create client' },
  { text: 'Copy the Client ID and Client secret it shows, paste them below, then press Connect.' },
]

export default function DriveSetupModal({ onClose, onDone }) {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const tryRef = useRef(0)   // only the newest attempt may change the UI

  async function connect() {
    const mine = ++tryRef.current
    setBusy(true); setError(null)
    const r = await window.kozo?.api?.drive?.setClient?.({ id, secret })
    if (mine !== tryRef.current) return
    if (!r?.ok) { setBusy(false); setError(r?.error || 'Could not save that.'); return }
    const c = await window.kozo?.api?.drive?.connect?.()
    if (mine !== tryRef.current) return
    setBusy(false)
    if (c?.ok && c.data?.email != null && !c.data?.error) { onDone?.(); onClose() }
    else setError('Google did not finish the sign-in. Check the ID and secret, and that your email is a test user, then try again.')
  }

  return (
    <Modal title="Set up Google Drive" icon={<IconBrandGoogleDrive size={16} />} onClose={onClose} width={600}
      footer={<>
        <button type="button" className={ms.btnCancel} onClick={onClose}>Later</button>
        <button type="button" className={ms.btnPrimary} onClick={connect} disabled={!id.trim() || !secret.trim()} title={busy ? 'Start the sign-in again' : undefined}>
          {busy ? <><IconLoader2 size={14} className="spin" /> Waiting for Google…</> : <><IconCheck size={14} /> Connect</>}
        </button>
      </>}>
      <p className={b.foldNote}>
        Google only lets apps use your Drive through a free "client" you make once in Google Cloud. It takes about two minutes,
        and you never need to do it again on this PC.
      </p>
      <ol className={d.steps}>
        {STEPS.map((st, i) => (
          <li key={i} className={d.step}>
            <span className={d.num}>{i + 1}</span>
            <span className={d.text}>{st.text}</span>
            {st.link && <button type="button" className={d.link} onClick={() => open(st.link)}>{st.label} <IconExternalLink size={12} /></button>}
          </li>
        ))}
      </ol>
      <label className={d.label}>Client ID</label>
      <input className={d.input} value={id} onChange={e => setId(e.target.value)} placeholder="123456-abc.apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
      <label className={d.label}>Client secret</label>
      <input className={d.input} type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="GOCSPX-..." spellCheck={false} autoComplete="off" />
      {busy && <DriveBlockedHint />}
      {error && <p className={`${b.msg} ${b.msgErr}`} style={{ marginTop: 10 }}>{error}</p>}
    </Modal>
  )
}
