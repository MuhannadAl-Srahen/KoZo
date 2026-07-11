import React, { useState, useEffect } from 'react'
import {
  IconDeviceFloppy, IconFolderOpen, IconArchive, IconRestore,
  IconTrash, IconLoader2, IconAlertTriangle, IconCheck, IconClock,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './SaveManagerModal.module.css'

function fmtBytes(b) {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0, n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function SaveManagerModal({ game, onClose }) {
  const [locations, setLocations] = useState(null)   // null = loading
  const [backups, setBackups]     = useState([])
  const [busy, setBusy]           = useState('')      // key of the in-flight action
  const [msg, setMsg]             = useState(null)    // { type: 'ok'|'err', text }
  const [confirmRestore, setConfirmRestore] = useState(null)
  const [confirmDelete, setConfirmDelete]   = useState(null)

  async function loadAll() {
    const [loc, bk] = await Promise.all([
      window.kozo?.api?.saves?.find(game.id),
      window.kozo?.api?.saves?.listBackups(game.id),
    ])
    setLocations(loc?.ok ? (loc.data?.locations || []) : [])
    setBackups(bk?.ok ? (bk.data || []) : [])
  }
  useEffect(() => {
    loadAll()
    // Backups can be created elsewhere while this is open (Settings "Back up
    // all", the post-session auto-backup) — refresh when the window refocuses.
    window.addEventListener('focus', loadAll)
    return () => window.removeEventListener('focus', loadAll)
  }, [])

  async function doBackup(p) {
    setBusy('bk:' + p); setMsg(null)
    const res = await window.kozo?.api?.saves?.backup(game.id, p)
    setBusy('')
    if (res?.ok) { setMsg({ type: 'ok', text: `Backed up ${res.data.files} file${res.data.files === 1 ? '' : 's'}.` }); loadAll() }
    else setMsg({ type: 'err', text: res?.error || 'Backup failed' })
  }

  async function doRestore(id) {
    setBusy('rs:' + id); setMsg(null)
    const res = await window.kozo?.api?.saves?.restore(game.id, id)
    setBusy(''); setConfirmRestore(null)
    if (res?.ok) { setMsg({ type: 'ok', text: `Restored to ${res.data.restoredTo}` }); loadAll() }
    else setMsg({ type: 'err', text: res?.error || 'Restore failed' })
  }

  async function doDelete(id) {
    setBusy('del:' + id)
    await window.kozo?.api?.saves?.deleteBackup(game.id, id)
    setBusy(''); setConfirmDelete(null)
    loadAll()
  }

  return (
    <Modal
      title={`Save Files — ${game.name}`}
      icon={<IconDeviceFloppy size={17} stroke={1.6} />}
      onClose={onClose}
      width={640}
      footer={<button className={ms.btnCancel} onClick={onClose}>Close</button>}
    >
      {msg && (
        <div className={`${s.banner} ${msg.type === 'ok' ? s.bannerOk : s.bannerErr}`}>
          {msg.type === 'ok' ? <IconCheck size={14} stroke={2.5} /> : <IconAlertTriangle size={14} stroke={2} />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* Save locations */}
      <div className={s.sectionTitle}>Detected save locations</div>
      {locations === null ? (
        <div className={s.loading}><IconLoader2 size={16} className="spin" /> Searching…</div>
      ) : locations.length === 0 ? (
        <div className={s.empty}>
          No save folders found automatically. The game may store saves under a different
          name or only in the cloud.
        </div>
      ) : (
        <div className={s.list}>
          {locations.map((loc, i) => (
            <div key={i} className={s.row}>
              <div className={s.rowInfo}>
                <div className={s.path}>{loc.path}</div>
                <div className={s.meta}>
                  {loc.source} · {loc.files} file{loc.files === 1 ? '' : 's'}
                  {loc.saveLike && <span className={s.tag}>save data</span>}
                </div>
              </div>
              <div className={s.rowBtns}>
                <button className={s.iconBtn} title="Open in Explorer"
                  onClick={() => window.kozo?.api?.shell?.openPath?.(loc.path)}>
                  <IconFolderOpen size={14} stroke={1.7} />
                </button>
                <button className={s.primaryBtn} disabled={busy === 'bk:' + loc.path}
                  onClick={() => doBackup(loc.path)}>
                  {busy === 'bk:' + loc.path
                    ? <IconLoader2 size={13} className="spin" />
                    : <IconArchive size={13} stroke={1.7} />}
                  Back up
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Backups */}
      <div className={s.sectionTitle} style={{ marginTop: 18 }}>
        Backups {backups.length > 0 && <span className={s.count}>{backups.length}</span>}
        <button
          className={s.iconBtn}
          title="Refresh the backup list"
          style={{ marginLeft: 'auto' }}
          onClick={loadAll}
        >
          <IconRestore size={13} stroke={1.7} />
        </button>
      </div>
      {backups.length === 0 ? (
        <div className={s.empty}>No backups yet. Click “Back up” on a location above to save a copy you can restore later.</div>
      ) : (
        <div className={s.list}>
          {backups.map(b => (
            <div key={b.id} className={s.row}>
              <div className={s.rowInfo}>
                <div className={s.bkTitle}>
                  <IconClock size={12} stroke={1.6} /> {fmtDate(b.createdAt)}
                  {b.label === 'auto' && <span className={s.tagAmber}>latest session</span>}
                  {b.label === 'auto (previous)' && <span className={s.tagAmber}>previous session</span>}
                  {b.label === 'before-restore' && <span className={s.tagAmber}>auto (pre-restore)</span>}
                </div>
                <div className={s.meta}>{b.files} file{b.files === 1 ? '' : 's'} · {fmtBytes(b.bytes)}</div>
                {b.source && <div className={s.bkSource}>{b.source}</div>}
              </div>
              <div className={s.rowBtns}>
                {confirmRestore === b.id ? (
                  <>
                    <button className={s.confirmBtn} disabled={busy === 'rs:' + b.id} onClick={() => doRestore(b.id)}>
                      {busy === 'rs:' + b.id ? <IconLoader2 size={13} className="spin" /> : <IconRestore size={13} stroke={1.7} />}
                      Confirm restore
                    </button>
                    <button className={s.iconBtn} onClick={() => setConfirmRestore(null)}>Cancel</button>
                  </>
                ) : confirmDelete === b.id ? (
                  <>
                    <button className={s.dangerBtn} disabled={busy === 'del:' + b.id} onClick={() => doDelete(b.id)}>
                      {busy === 'del:' + b.id ? <IconLoader2 size={13} className="spin" /> : <IconTrash size={13} stroke={1.7} />}
                      Delete
                    </button>
                    <button className={s.iconBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button className={s.iconBtn} title="Open backup folder"
                      onClick={() => window.kozo?.api?.shell?.openPath?.(b.path)}>
                      <IconFolderOpen size={14} stroke={1.7} />
                    </button>
                    <button className={s.primaryBtn} onClick={() => { setConfirmRestore(b.id); setConfirmDelete(null) }}>
                      <IconRestore size={13} stroke={1.7} /> Restore
                    </button>
                    <button className={s.iconBtn} title="Delete backup"
                      onClick={() => { setConfirmDelete(b.id); setConfirmRestore(null) }}>
                      <IconTrash size={14} stroke={1.6} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {confirmRestore && (
        <div className={s.restoreNote}>
          <IconAlertTriangle size={13} stroke={1.8} />
          Restoring overwrites the current save. KoZo automatically snapshots the current
          state first, so you can undo it.
        </div>
      )}
      {confirmDelete && (
        <div className={s.deleteNote}>
          <IconAlertTriangle size={13} stroke={1.8} />
          This permanently deletes this backup copy from your PC. It does not affect the game's
          current save.
        </div>
      )}
    </Modal>
  )
}
