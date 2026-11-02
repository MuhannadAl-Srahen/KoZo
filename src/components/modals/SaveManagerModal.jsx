import React, { useState, useEffect } from 'react'
import {
  IconDeviceFloppy, IconFolderOpen, IconArchive, IconRestore, IconTrash, IconLoader2,
  IconAlertTriangle, IconCheck, IconPlus, IconX, IconShieldCheck, IconFolderPlus, IconEye,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import { timeAgo } from '../../lib/utils'
import s from './SaveManagerModal.module.css'

// One game's save backups (services/saveVault.js):
// 1. Where the saves are: the confirmed location(s). Only these are backed up
//    automatically. Candidates come from the known-locations list (Ludusavi)
//    first, then a folder-name search, each with its newest change so the
//    right one is easy to tell.
// 2. Restore points: every backup, newest first, grouped by day. Restore
//    shows what will change, then replaces the save exactly (the current one
//    is backed up first).

export function fmtBytes(b) {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0, n = b
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

const REASONS = {
  'before-play':    { label: 'Before playing', cls: 'tagBlue' },
  'after-play':     { label: 'After playing',  cls: 'tagGreen' },
  'manual':         { label: 'Manual',         cls: 'tagAccent' },
  'before-restore': { label: 'Before a restore', cls: 'tagAmber' },
  'auto':           { label: 'Automatic',      cls: 'tagGreen' },
}

function dayLabel(iso) {
  const d = new Date(iso), today = new Date()
  const y = new Date(today); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined })
}

export default function SaveManagerModal({ game, onClose }) {
  const [found, setFound]       = useState(null)   // { locations, confirmed }
  const [snaps, setSnaps]       = useState(null)
  const [bytes, setBytes]       = useState(0)
  const [editing, setEditing]   = useState(false)
  const [picked, setPicked]     = useState(new Set())
  const [busy, setBusy]         = useState('')
  const [msg, setMsg]           = useState(null)    // { type: 'ok'|'err', text }
  const [restoreOf, setRestoreOf] = useState(null)  // { id, diff }
  const [confirmDelete, setConfirmDelete] = useState(null)

  async function loadAll() {
    const [loc, bk] = await Promise.all([
      window.kozo?.api?.saves?.find(game.id),
      window.kozo?.api?.saves?.listBackups(game.id),
    ])
    const f = loc?.ok ? loc.data : { locations: [], confirmed: [] }
    setFound(f)
    setSnaps(bk?.ok ? bk.data.snapshots : [])
    setBytes(bk?.ok ? bk.data.bytes : 0)
    if (!f.confirmed.length) {
      setEditing(true)
      // Pre-tick the known location(s), else the best candidate.
      const known = f.locations.filter(l => l.known).map(l => l.path)
      setPicked(new Set(known.length ? known : f.locations.slice(0, 1).map(l => l.path)))
    }
  }
  useEffect(() => {
    loadAll()
    window.addEventListener('focus', loadAll)
    return () => window.removeEventListener('focus', loadAll)
  }, [])

  async function savePaths(paths) {
    const res = await window.kozo?.api?.saves?.setPaths(game.id, paths)
    if (res?.ok) { setEditing(false); setMsg({ type: 'ok', text: 'Save location confirmed. Backups now use it.' }); loadAll() }
    else setMsg({ type: 'err', text: res?.error || 'Could not save that' })
  }
  async function addFolder() {
    const res = await window.kozo?.api?.dialog?.pickFolder?.()
    const dir = res?.ok ? res.data : null
    if (!dir) return
    setPicked(p => new Set([...p, dir]))
    setFound(f => ({ ...f, locations: [{ path: dir, source: 'Chosen by you', files: null }, ...f.locations.filter(l => l.path !== dir)] }))
  }

  async function doBackup() {
    setBusy('backup'); setMsg(null)
    const res = await window.kozo?.api?.saves?.backup(game.id)
    setBusy('')
    if (res?.ok) { setMsg({ type: 'ok', text: `Backed up ${res.data.files} file${res.data.files === 1 ? '' : 's'}.` }); loadAll() }
    else setMsg({ type: 'err', text: res?.error || 'Backup failed' })
  }

  async function askRestore(id) {
    setRestoreOf({ id, diff: null }); setConfirmDelete(null)
    const res = await window.kozo?.api?.saves?.compare(game.id, id)
    setRestoreOf(r => (r?.id === id ? { id, diff: res?.ok ? res.data : { error: res?.error } } : r))
  }
  async function doRestore(id) {
    setBusy('rs:' + id); setMsg(null)
    const res = await window.kozo?.api?.saves?.restore(game.id, id)
    setBusy(''); setRestoreOf(null)
    if (res?.ok) { setMsg({ type: 'ok', text: 'Save restored. Your save from before the restore was backed up too.' }); loadAll() }
    else setMsg({ type: 'err', text: res?.error || 'Restore failed' })
  }
  async function doDelete(id) {
    setBusy('del:' + id)
    await window.kozo?.api?.saves?.deleteBackup(game.id, id)
    setBusy(''); setConfirmDelete(null)
    loadAll()
  }

  const confirmed = found?.confirmed || []
  const groups = []
  for (const b of snaps || []) {
    const k = dayLabel(b.createdAt)
    if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, items: [] })
    groups[groups.length - 1].items.push(b)
  }

  return (
    <Modal
      title={`Saves: ${game.name}`}
      icon={<IconDeviceFloppy size={17} stroke={1.6} />}
      onClose={onClose}
      width={720}
      footer={
        <div className={s.footer}>
          <span className={s.footNote}>{snaps?.length ? `${snaps.length} restore point${snaps.length === 1 ? '' : 's'} · ${fmtBytes(bytes)} on disk` : ''}</span>
          <button className={ms.btnCancel} onClick={onClose}>Close</button>
          <button className={ms.btnPrimary} onClick={doBackup} disabled={!confirmed.length || busy === 'backup'}>
            {busy === 'backup' ? <IconLoader2 size={14} className="spin" /> : <IconArchive size={14} />} Back up now
          </button>
        </div>
      }
    >
      {msg && (
        <div className={`${s.banner} ${msg.type === 'ok' ? s.bannerOk : s.bannerErr}`}>
          {msg.type === 'ok' ? <IconCheck size={14} stroke={2.5} /> : <IconAlertTriangle size={14} stroke={2} />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* 1. Where the saves are */}
      <div className={s.sectionTitle}>
        <IconShieldCheck size={15} /> Where this game keeps its saves
        {!editing && confirmed.length > 0 && <button className={s.linkBtn} onClick={() => { setEditing(true); setPicked(new Set(confirmed)) }}>Change</button>}
      </div>
      {found === null ? (
        <div className={s.loading}><IconLoader2 size={16} className="spin" /> Looking for the save folder…</div>
      ) : !editing ? (
        <div className={s.list}>
          {confirmed.map(p => (
            <div key={p} className={`${s.row} ${s.rowConfirmed}`}>
              <IconCheck size={15} className={s.okIcon} />
              <div className={s.rowInfo}><div className={s.path}>{p}</div></div>
              <button className={s.iconBtn} title="Open in Explorer" onClick={() => window.kozo?.api?.shell?.openPath?.(p)}><IconFolderOpen size={14} /></button>
            </div>
          ))}
        </div>
      ) : (
        <>
          <p className={s.hint}>
            {found.locations.some(l => l.known)
              ? 'KoZo knows where this game saves (from PCGamingWiki). Check it, then confirm.'
              : 'Tick the folder the game really saves into. The newest change helps: play, save, and it moves to the top.'}
            {' '}Automatic backups only use what you confirm here.
          </p>
          <div className={s.list}>
            {found.locations.length === 0 && <div className={s.empty}>No save folder found. Add it yourself below.</div>}
            {found.locations.map(loc => (
              <label key={loc.path} className={`${s.row} ${s.rowPick} ${picked.has(loc.path) ? s.rowPicked : ''}`}>
                <input type="checkbox" checked={picked.has(loc.path)}
                  onChange={() => setPicked(p => { const n = new Set(p); n.has(loc.path) ? n.delete(loc.path) : n.add(loc.path); return n })} />
                <div className={s.rowInfo}>
                  <div className={s.path}>{loc.path}</div>
                  <div className={s.meta}>
                    {loc.known ? <span className={s.tagGreen}>Known save location</span> : <span>{loc.source}</span>}
                    {loc.files != null && <span>{loc.files} file{loc.files === 1 ? '' : 's'}</span>}
                    {loc.modifiedAt && <span>changed {timeAgo(loc.modifiedAt)}</span>}
                  </div>
                </div>
                <button type="button" className={s.iconBtn} title="Open in Explorer" onClick={(e) => { e.preventDefault(); window.kozo?.api?.shell?.openPath?.(loc.path) }}><IconFolderOpen size={14} /></button>
              </label>
            ))}
          </div>
          <div className={s.editBar}>
            <button className={s.ghostBtn} onClick={addFolder}><IconFolderPlus size={14} /> Add a folder</button>
            <span className={s.spacer} />
            {confirmed.length > 0 && <button className={s.ghostBtn} onClick={() => setEditing(false)}><IconX size={14} /> Cancel</button>}
            <button className={s.primaryBtn} disabled={!picked.size} onClick={() => savePaths([...picked])}>
              <IconCheck size={14} /> Confirm {picked.size > 1 ? `${picked.size} locations` : 'location'}
            </button>
          </div>
        </>
      )}

      {/* 2. Restore points */}
      <div className={s.sectionTitle} style={{ marginTop: 20 }}>
        <IconRestore size={15} /> Restore points {snaps?.length > 0 && <span className={s.count}>{snaps.length}</span>}
      </div>
      {snaps === null ? null : snaps.length === 0 ? (
        <div className={s.empty}>No backups yet. {confirmed.length ? 'Press Back up now, or just play: KoZo backs up before and after every session when automatic backups are on.' : 'Confirm the save location first.'}</div>
      ) : groups.map(g => (
        <div key={g.k} className={s.day}>
          <div className={s.dayTitle}>{g.k}</div>
          <div className={s.list}>
            {g.items.map(b => {
              const r = REASONS[b.reason] || REASONS.manual
              return (
                <div key={b.id} className={s.snapWrap}>
                  <div className={s.row}>
                    <span className={s.time}>{new Date(b.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    <span className={s[r.cls]}>{r.label}</span>
                    {b.label && <span className={s.metaInline}>{b.label}</span>}
                    <span className={s.metaInline}>{b.files} file{b.files === 1 ? '' : 's'} · {fmtBytes(b.bytes)}</span>
                    <span className={s.spacer} />
                    {confirmDelete === b.id ? (
                      <>
                        <button className={s.dangerBtn} disabled={busy === 'del:' + b.id} onClick={() => doDelete(b.id)}><IconTrash size={13} /> Delete</button>
                        <button className={s.iconBtn} onClick={() => setConfirmDelete(null)}><IconX size={14} /></button>
                      </>
                    ) : (
                      <>
                        <button className={s.iconBtn} title="Open a copy in Explorer" onClick={() => window.kozo?.api?.saves?.exportSnapshot(game.id, b.id)}><IconEye size={14} /></button>
                        <button className={s.primaryBtn} onClick={() => askRestore(b.id)}><IconRestore size={13} /> Restore</button>
                        <button className={s.iconBtn} title="Delete this restore point" onClick={() => { setConfirmDelete(b.id); setRestoreOf(null) }}><IconTrash size={14} /></button>
                      </>
                    )}
                  </div>
                  {restoreOf?.id === b.id && (
                    <div className={s.restoreBox}>
                      {restoreOf.diff === null ? <span><IconLoader2 size={13} className="spin" /> Comparing with your current save…</span>
                        : restoreOf.diff.error ? <span>{restoreOf.diff.error}</span>
                        : (
                          <span>
                            {restoreOf.diff.changed + restoreOf.diff.missing + restoreOf.diff.extra === 0
                              ? 'Your current save is the same as this one.'
                              : <>Restoring puts back {restoreOf.diff.files} file{restoreOf.diff.files === 1 ? '' : 's'}: {restoreOf.diff.changed} changed, {restoreOf.diff.missing} missing now{restoreOf.diff.extra ? `, and ${restoreOf.diff.extra} newer file${restoreOf.diff.extra === 1 ? '' : 's'} will be removed` : ''}.</>}
                            {' '}Your current save is backed up first. Close the game before restoring.
                          </span>
                        )}
                      <span className={s.spacer} />
                      <button className={s.ghostBtn} onClick={() => setRestoreOf(null)}>Cancel</button>
                      <button className={s.confirmBtn} disabled={!restoreOf.diff || restoreOf.diff.error || busy === 'rs:' + b.id} onClick={() => doRestore(b.id)}>
                        {busy === 'rs:' + b.id ? <IconLoader2 size={13} className="spin" /> : <IconRestore size={13} />} Restore this save
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </Modal>
  )
}
