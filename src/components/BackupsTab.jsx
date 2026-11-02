import React, { useEffect, useState } from 'react'
import {
  IconShieldCheck, IconAlertTriangle, IconDeviceDesktop, IconBrandGoogleDrive, IconRefresh, IconLoader2,
  IconExternalLink, IconChevronRight, IconChevronDown, IconHistory, IconDownload, IconUpload, IconFolder,
  IconArchive, IconCheck, IconCloudOff, IconFileZip, IconBrandGoogle,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import { fileUrl, timeAgo } from '../lib/utils'
import b from './BackupsTab.module.css'

// Settings → Backups. KoZo finds every game's saves and backs them up before
// and after each session (electron/services/saveDetect.js, saveVault.js), plus
// the library itself (autoBackup). All of it lives in one "KoZo Backup" folder
// KoZo picks (backupHome.js, never Temp), and is copied to Google Drive
// (googleDrive.js) when KoZo has a Google client (defaults.js, or the maker's
// own in Connections > Advanced); without one the Drive row stays hidden. One
// file with everything (kozoPack.js) works for everyone. This page only shows
// that it's working and how to get things back.

export function fmtSize(n) {
  if (!n) return '0 MB'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

const api = () => window.kozo?.api

function Switch({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label}
      className={`${b.switch} ${on ? b.switchOn : ''}`} onClick={() => onChange(!on)}>
      <span className={b.thumb} />
    </button>
  )
}

export default function BackupsTab({ onManageSaves }) {
  const [overview, setOverview] = useState(null)
  const [storage, setStorage] = useState(null)
  const [drive, setDrive] = useState(null)
  const [auto, setAuto] = useState(true)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)
  const [found, setFound] = useState([])
  const [restoreAll, setRestoreAll] = useState(false)
  const [showQuiet, setShowQuiet] = useState(false)
  const [packProgress, setPackProgress] = useState(null)

  const loadOverview = () => api()?.saves?.overview?.().then(r => { if (r?.ok) setOverview(r.data) })
  const loadStorage = () => api()?.saves?.storage?.().then(r => { if (r?.ok) setStorage(r.data) })
  const loadDrive = () => api()?.drive?.status?.().then(r => { if (r?.ok) setDrive(r.data) })

  useEffect(() => {
    loadOverview(); loadStorage(); loadDrive()
    api()?.saves?.getAutoBackup?.().then(r => { if (r?.ok) setAuto(!!r.data) })
    api()?.backup?.findExisting?.().then(r => { if (r?.ok) setFound(r.data.filter(f => !f.current && f.games)) })
    // Look for saves again (new games, games played since), then refresh.
    api()?.saves?.detect?.().then(() => loadOverview())
    const off = window.kozo?.events?.onDriveStatus?.((st) => setDrive(st))
    const offPack = window.kozo?.events?.onPackProgress?.((p) => setPackProgress(p))
    return () => { try { off?.(); offPack?.() } catch {} }
  }, [])

  async function run(key, fn, done) {
    setBusy(key); setMsg(null)
    try {
      const r = await fn()
      if (r && r.ok === false) setMsg({ type: 'error', text: r.error || 'That did not work' })
      else if (done) setMsg({ type: 'ok', text: typeof done === 'function' ? done(r?.data) : done })
    } finally { setBusy(''); loadOverview(); loadStorage(); loadDrive() }
  }

  async function toggleAuto(v) {
    setAuto(v)
    await api()?.saves?.setAutoBackup?.(v)
  }

  async function connectDrive() {
    setBusy('drive'); setMsg(null)
    const r = await api()?.drive?.connect?.()
    setBusy('')
    const d = r?.data
    if (d?.error && d.error !== 'superseded') setMsg({ type: 'error', text: 'Google did not finish signing in. Try again.' })
    loadDrive()
  }

  // One file with everything: save it anywhere, open it on any PC.
  async function exportPack() {
    setBusy('packOut'); setMsg(null); setPackProgress(null)
    const r = await api()?.pack?.exportAll?.()
    setBusy(''); setPackProgress(null)
    if (r?.ok === false) setMsg({ type: 'error', text: r.error || 'The file could not be saved.' })
    else if (r?.data) setMsg({ type: 'ok', text: `Saved ${r.data.games} games and every save backup (${fmtSize(r.data.bytes)}). Keep the file anywhere: a USB stick, a cloud folder, an email to yourself.` })
  }
  async function importPack() {
    setBusy('packIn'); setMsg(null); setPackProgress(null)
    const r = await api()?.pack?.importAll?.()
    setBusy(''); setPackProgress(null)
    if (r?.ok === false) { setMsg({ type: 'error', text: r.error || 'That file could not be opened.' }); return }
    if (!r?.data) return
    setMsg({ type: 'ok', text: `Brought back ${r.data.data?.games ?? 0} games and their save backups.` })
    loadOverview(); loadStorage()
    if (r.data.files > 0) setRestoreAll(true)
  }

  const list = overview || []
  const withSaves = list.filter(g => g.confirmed || g.count > 0)
  const quiet = list.filter(g => !g.confirmed && !g.count)
  const backedUp = withSaves.filter(g => g.count > 0)
  const waiting = withSaves.filter(g => !g.count)
  const lastAt = list.map(g => g.latestAt).filter(Boolean).sort().pop()
  const lowSpace = storage?.free != null && storage.free < 2 * 1024 ** 3
  const driveProblem = drive?.connected && (drive.error || drive.last?.over)

  let title, sub, warn = false
  if (!auto) { title = 'Automatic backups are off'; sub = 'Turn them on so KoZo keeps your saves safe.'; warn = true }
  else if (lowSpace) { title = 'The backup drive is almost full'; sub = 'New backups wait until there is 2 GB free. Free some space or move the backups.'; warn = true }
  else if (!withSaves.length) { title = 'Ready'; sub = 'KoZo backs up a game\'s saves the first time you play it.' }
  else { title = `${withSaves.length} game${withSaves.length === 1 ? '' : 's'} protected`; sub = `Backed up before and after every session${lastAt ? `, last ${timeAgo(lastAt)}` : ''}.` }

  return (
    <div className={b.page}>
      {/* 1. Is everything safe? */}
      <section className={`${b.card} ${b.status} ${warn ? b.statusWarn : ''}`}>
        <div className={b.statusTop}>
          <span className={b.shield}>{warn ? <IconAlertTriangle size={26} /> : <IconShieldCheck size={26} />}</span>
          <div className={b.statusText}>
            <h3>{title}</h3>
            <p>{sub}</p>
          </div>
          <Switch on={auto} onChange={toggleAuto} label="Back up automatically" />
        </div>

        <div className={b.places}>
          <div className={b.place}>
            <span className={b.placeIcon}><IconDeviceDesktop size={17} /></span>
            <div className={b.placeText}>
              <strong>This PC</strong>
              <span title={storage?.base || ''}>{storage ? <>{storage.base} · {fmtSize(storage.bytes)}{storage.free != null ? ` · ${fmtSize(storage.free)} free` : ''}</> : '…'}</span>
            </div>
            <button type="button" className={b.btn} onClick={() => storage?.base && api()?.shell?.openPath?.(storage.base)} disabled={!storage}>
              <IconExternalLink size={14} /> Open
            </button>
          </div>

          {drive?.configured && <div className={`${b.place} ${driveProblem ? b.placeWarn : ''}`}>
            <span className={`${b.placeIcon} ${b.driveIcon}`}><IconBrandGoogleDrive size={17} /></span>
            <div className={b.placeText}>
              <strong>Google Drive {drive?.email ? <em>{drive.email}</em> : null}</strong>
              <span>
                {!drive ? '…'
                  : !drive.connected ? 'Keeps a copy off this PC, so even a full format can\'t take your saves.'
                  : drive.error === 'signed_out' ? 'Google signed KoZo out. Connect again.'
                  : drive.error ? `Last copy failed: ${drive.error}`
                  : drive.syncing ? 'Copying…'
                  : drive.lastSync ? <>Copied {timeAgo(drive.lastSync)}{drive.last ? ` · ${fmtSize(drive.last.bytes)} of ${drive.budgetGb ? (drive.budgetGb < 1 ? `${drive.budgetGb * 1000} MB` : `${drive.budgetGb} GB`) : 'your Drive'}` : ''}</>
                  : 'Connected. The first copy starts in a moment.'}
              </span>
            </div>
            {(!drive.connected || drive.error === 'signed_out'
              ? <button type="button" className={`${b.btn} ${b.btnPrimary}`} onClick={connectDrive} disabled={busy === 'drive'}>
                  {busy === 'drive' ? <><IconLoader2 size={14} className="spin" /> Waiting for Google…</> : <><IconBrandGoogle size={14} /> Sign in with Google</>}
                </button>
              : <button type="button" className={b.btn} onClick={() => run('sync', () => api().drive.sync(), (d) => d?.error ? `Copy failed: ${d.error}` : 'Google Drive is up to date.')} disabled={busy === 'sync' || drive.syncing}>
                  {busy === 'sync' || drive.syncing ? <IconLoader2 size={14} className="spin" /> : <IconRefresh size={14} />} Copy now
                </button>)}
          </div>}

          <div className={b.place}>
            <span className={b.placeIcon}><IconFileZip size={17} /></span>
            <div className={b.placeText}>
              <strong>One file</strong>
              <span>{busy === 'packOut' && packProgress ? `Saving… ${Math.round((packProgress.done / Math.max(1, packProgress.total)) * 100)}%` : 'Your library, playtime and every save backup in one .kozo file. Take it to a new PC and open it there.'}</span>
            </div>
            <button type="button" className={b.btn} onClick={exportPack} disabled={!!busy}>
              {busy === 'packOut' ? <IconLoader2 size={14} className="spin" /> : <IconDownload size={14} />} Save to a file
            </button>
          </div>
        </div>

        {drive?.last?.over && <p className={b.note}><IconAlertTriangle size={13} /> Not every restore point fits in the Google Drive space you gave KoZo. The newest one of every game is there; older ones stay on this PC only.</p>}
        {drive?.last?.big?.length > 0 && <p className={b.note}><IconCloudOff size={13} /> Kept on this PC only (over 2 GB): {drive.last.big.join(', ')}.</p>}
        {msg && <p className={`${b.msg} ${msg.type === 'error' ? b.msgErr : ''}`}>{msg.type === 'error' ? <IconAlertTriangle size={13} /> : <IconCheck size={13} />} {msg.text}</p>}
      </section>

      {/* 2. Games */}
      <section className={b.card}>
        <div className={b.cardHead}>
          <h4>Games</h4>
          <span>{overview ? `${backedUp.length} backed up${waiting.length ? `, ${waiting.length} waiting for their first backup` : ''}` : 'Looking for saves…'}</span>
        </div>
        {overview && withSaves.length === 0 && <p className={b.empty}>No saves found on this PC yet. Play a game and KoZo finds where it saves.</p>}
        <div className={b.games}>
          {withSaves.map(g => <GameRow key={g.id} g={g} onOpen={() => onManageSaves?.({ id: g.id, name: g.name })} />)}
        </div>
        {quiet.length > 0 && (
          <>
            <button type="button" className={b.fold} onClick={() => setShowQuiet(v => !v)} aria-expanded={showQuiet}>
              <IconChevronDown size={14} className={showQuiet ? b.foldOpen : ''} /> Not played on this PC yet ({quiet.length})
            </button>
            {showQuiet && (
              <>
                <p className={b.foldNote}>No save of these on this PC. KoZo finds it by itself the first time you play one. You can also point to it by hand.</p>
                <div className={b.games}>
                  {quiet.map(g => <GameRow key={g.id} g={g} quiet onOpen={() => onManageSaves?.({ id: g.id, name: g.name })} />)}
                </div>
              </>
            )}
          </>
        )}
      </section>

      {/* 3. Getting things back */}
      <section className={b.card}>
        <div className={b.cardHead}>
          <h4>Get everything back</h4>
          <span>After a new Windows, or on another PC</span>
        </div>
        <div className={b.actions}>
          {drive?.connected && (
            <button type="button" className={b.action} disabled={!!busy}
              onClick={() => run('restoreDrive', () => api().drive.restore(), (d) => `Brought back ${d?.data?.games ?? 0} games and their save backups from Google Drive.`)}>
              <IconBrandGoogleDrive size={18} />
              <span><strong>{busy === 'restoreDrive' ? 'Downloading…' : 'From Google Drive'}</strong><small>Your library, playtime and every save backup</small></span>
            </button>
          )}
          {found.map(f => (
            <button key={f.path} type="button" className={b.action} disabled={!!busy}
              onClick={() => run('folder', () => api().backup.restoreFolder(f.path), 'Restored. Your saves from that folder are listed above.')}>
              <IconFolder size={18} />
              <span><strong>From {f.path}</strong><small>{f.games} games{f.at ? `, saved ${timeAgo(f.at)}` : ''}</small></span>
            </button>
          ))}
          <button type="button" className={b.action} disabled={!!busy || !backedUp.length} onClick={() => setRestoreAll(true)}>
            <IconHistory size={18} />
            <span><strong>Put saves back</strong><small>Every game's newest backup, the ones you pick</small></span>
          </button>
          <button type="button" className={b.action} disabled={!!busy} onClick={importPack}>
            <IconFileZip size={18} />
            <span><strong>{busy === 'packIn' ? (packProgress ? `Opening… ${Math.round((packProgress.done / Math.max(1, packProgress.total)) * 100)}%` : 'Opening…') : 'From a KoZo file'}</strong><small>A .kozo file you saved: library, playtime and saves</small></span>
          </button>
        </div>
      </section>

      {/* 4. Everything else */}
      <details className={b.more}>
        <summary><IconChevronRight size={14} className={b.moreChevron} /> More options</summary>
        <div className={b.moreBody}>
          <Row label="Keep at most on this PC" hint="Every backup is kept a week, then one a day up to a month, then one a week up to 3 months. Ones you make yourself always stay. The oldest automatic ones go first when it's full.">
            <Seg value={String(storage?.capGb ?? 2)} onChange={async v => { await api()?.saves?.setCap?.(Number(v)); loadStorage() }}
              options={[['1', '1 GB'], ['2', '2 GB'], ['5', '5 GB'], ['0', 'No limit']]} />
          </Row>
          {drive?.configured && (
            <Row label="Google Drive space for KoZo" hint="Saves are small and only changed files are sent. If KoZo runs out of this space, older restore points stay on this PC only.">
              <Seg value={String(drive?.budgetGb ?? 1)} onChange={async v => { await api()?.drive?.setBudget?.(Number(v)); loadDrive() }}
                options={[['0.5', '500 MB'], ['1', '1 GB'], ['2', '2 GB'], ['5', '5 GB']]} />
            </Row>
          )}
          <div className={b.moreBtns}>
            <button type="button" className={b.btn} disabled={!!busy}
              onClick={() => run('all', () => api().saves.backupAll(), (d) => `${d?.backedUp ?? 0} games backed up.`)}>
              {busy === 'all' ? <IconLoader2 size={14} className="spin" /> : <IconArchive size={14} />} Back up every game now
            </button>
            <button type="button" className={b.btn} disabled={!!busy}
              onClick={() => run('move', () => api().saves.moveBase(), (d) => d ? `Backups moved to ${d}.` : null)}>
              <IconFolder size={14} /> Keep backups somewhere else
            </button>
            <button type="button" className={b.btn} disabled={!!busy}
              onClick={() => run('manifest', () => api().saves.refreshManifest(), 'Save locations updated.')}>
              {busy === 'manifest' ? <IconLoader2 size={14} className="spin" /> : <IconRefresh size={14} />} Update known save locations
            </button>
            <button type="button" className={b.btn} disabled={!!busy}
              onClick={() => run('file', () => api().backup.import(), (d) => d ? `Restored ${d.games} games and ${d.sessions} sessions.` : null)}>
              <IconUpload size={14} /> Open an older library file (.json)
            </button>
            {drive?.connected && (
              <button type="button" className={b.btn} onClick={() => run('disc', () => api().drive.disconnect(), 'Google Drive disconnected. The copy there stays.')}>
                <IconCloudOff size={14} /> Disconnect Google Drive
              </button>
            )}
          </div>
          <p className={b.foldNote}>
            {storage?.manifest?.games ? `${storage.manifest.games.toLocaleString()} games' save locations known (PCGamingWiki). ` : ''}
            {storage?.dataAt ? `Library backup written ${timeAgo(storage.dataAt)}.` : ''}
          </p>
        </div>
      </details>

      {restoreAll && <RestoreAllModal onClose={() => { setRestoreAll(false); loadOverview() }} />}
    </div>
  )
}

function GameRow({ g, quiet, onOpen }) {
  const [broken, setBroken] = useState(false)
  const art = !broken && (g.art ? fileUrl(g.art) : g.artUrl)
  return (
    <button type="button" className={`${b.game} ${quiet ? b.gameQuiet : ''}`} onClick={onOpen} data-gpnav="">
      <span className={b.art}>{art ? <img src={art} alt="" loading="lazy" onError={() => setBroken(true)} /> : null}</span>
      <span className={b.gameText}>
        <strong>{g.name}</strong>
        <small>
          {quiet ? 'No save on this PC yet'
            : g.count ? `Backed up ${timeAgo(g.latestAt)} · ${fmtSize(g.latestBytes)} · ${g.count} restore point${g.count === 1 ? '' : 's'}`
            : 'Saves found, backs up when you play'}
        </small>
      </span>
      {!quiet && <span className={`${b.dot} ${g.count ? b.dotOk : ''}`} />}
      <IconChevronRight size={16} className={b.chev} />
    </button>
  )
}

function Row({ label, hint, children }) {
  return (
    <div className={b.row}>
      <div className={b.rowText}><strong>{label}</strong>{hint && <small>{hint}</small>}</div>
      {children}
    </div>
  )
}
function Seg({ value, onChange, options }) {
  return (
    <div className={b.seg} role="radiogroup">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? b.segOn : ''} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  )
}

function RestoreAllModal({ onClose }) {
  const [rows, setRows] = useState(null)
  const [pick, setPick] = useState(new Set())
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)
  useEffect(() => {
    api()?.saves?.restorePlan?.().then(r => {
      if (!r?.ok) { setRows([]); return }
      setRows(r.data)
      // Missing here = surely wanted back; the rest the user ticks.
      setPick(new Set(r.data.filter(x => !x.hasSaveHere).map(x => x.id)))
    })
  }, [])
  const toggle = (id) => setPick(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  async function go() {
    setState('working')
    const items = rows.filter(r => pick.has(r.id)).map(r => ({ id: r.id, snapshot: r.snapshot }))
    const r = await api()?.saves?.restoreMany?.(items)
    setResult(r?.ok ? r.data : [])
    setState('done')
  }
  const failed = (result || []).filter(r => !r.ok)
  return (
    <Modal title="Put saves back" icon={<IconHistory size={16} />} onClose={onClose} width={560}
      footer={state === 'done'
        ? <button type="button" className={ms.btnPrimary} onClick={onClose}>Done</button>
        : <>
            <button type="button" className={ms.btnCancel} onClick={onClose}>Cancel</button>
            <button type="button" className={ms.btnPrimary} onClick={go} disabled={!pick.size || state === 'working'}>
              {state === 'working' ? <><IconLoader2 size={14} className="spin" /> Restoring…</> : <><IconDownload size={14} /> Restore {pick.size || ''}</>}
            </button>
          </>}>
      {state === 'done' ? (
        <p className={b.foldNote}>
          {result.length - failed.length} restored.{failed.length ? ` ${failed.length} could not be restored (is the game running?).` : ''} Each game's save from before is kept as a restore point.
        </p>
      ) : (
        <>
          <p className={b.foldNote}>Each game gets its newest backup back. The save there now is kept as a restore point first, so nothing is lost.</p>
          {!rows ? <p className={b.foldNote}>Loading…</p> : (
            <div className={b.pickList}>
              {rows.map(r => (
                <label key={r.id} className={b.pickRow}>
                  <input type="checkbox" checked={pick.has(r.id)} onChange={() => toggle(r.id)} />
                  <span className={b.gameText}><strong>{r.name}</strong><small>Backup from {new Date(r.createdAt).toLocaleString()}{r.hasSaveHere ? ' · this PC has a save too' : ' · no save on this PC'}</small></span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
