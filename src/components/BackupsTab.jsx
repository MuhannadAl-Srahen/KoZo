import React, { useEffect, useRef, useState } from 'react'
import {
  IconShield, IconShieldCheck, IconAlertTriangle, IconDeviceDesktop, IconBrandGoogleDrive, IconRefresh, IconLoader2,
  IconExternalLink, IconChevronRight, IconChevronDown, IconHistory, IconDownload, IconFolder,
  IconArchive, IconCheck, IconCloudOff, IconFileZip, IconBrandGoogle, IconBrandDropbox, IconBrandApple, IconCloud, IconCloudUp,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import { DriveBlockedHint } from './DriveSetupModal'
import DriveOffer from './DriveOffer'
import { fileUrl, timeAgo } from '../lib/utils'
import b from './BackupsTab.module.css'

// Settings → Backups. KoZo finds every game's saves and backs them up before
// and after each session (electron/services/saveDetect.js, saveVault.js), plus
// the library itself (autoBackup). All of it lives in one "KoZo Backup" folder
// KoZo picks (backupHome.js, never Temp), and is copied to Google Drive
// (googleDrive.js) when KoZo has a Google client (defaults.js, or the maker's
// own in Connections > Advanced); without one the Drive row stays hidden. One
// file with everything (kozoPack.js) works for everyone, and so does a copy in a
// folder the user picks (backupCopy.js): their own cloud sync folder or a USB
// stick. This page only shows that it's working and how to get things back.

const CLOUD_ICONS = { google: IconBrandGoogleDrive, dropbox: IconBrandDropbox, icloud: IconBrandApple, mega: IconCloud }

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
  const [copy, setCopy] = useState(null)       // the copy folder's status
  const [clouds, setClouds] = useState([])     // cloud folders found on this PC
  const [offPcOpen, setOffPcOpen] = useState(false)
  const [getBackOpen, setGetBackOpen] = useState(false)

  const loadCopy = () => api()?.backup?.copyStatus?.().then(r => { if (r?.ok) setCopy(r.data) })
  const loadOverview = () => api()?.saves?.overview?.().then(r => { if (r?.ok) setOverview(r.data) })
  const loadStorage = () => api()?.saves?.storage?.().then(r => { if (r?.ok) setStorage(r.data) })
  const loadDrive = () => api()?.drive?.status?.().then(r => { if (r?.ok) setDrive(r.data) })

  useEffect(() => {
    loadOverview(); loadStorage(); loadDrive(); loadCopy()
    api()?.backup?.copyDetect?.().then(r => { if (r?.ok) setClouds(r.data || []) })
    api()?.saves?.getAutoBackup?.().then(r => { if (r?.ok) setAuto(!!r.data) })
    api()?.backup?.findExisting?.().then(r => { if (r?.ok) setFound(r.data.filter(f => !f.current && f.games)) })
    // Look for saves again (new games, games played since), then refresh.
    api()?.saves?.detect?.().then(() => loadOverview())
    const off = window.kozo?.events?.onDriveStatus?.((st) => setDrive(st))
    const offPack = window.kozo?.events?.onPackProgress?.((p) => setPackProgress(p))
    const offCopy = window.kozo?.events?.onBackupCopyStatus?.((st) => setCopy(st))
    return () => { try { off?.(); offPack?.(); offCopy?.() } catch {} }
  }, [])

  async function run(key, fn, done) {
    setBusy(key); setMsg(null)
    try {
      const r = await fn()
      if (r && r.ok === false) setMsg({ type: 'error', text: r.error || 'That did not work' })
      else if (done) {
        // A function may return nothing (a cancelled folder picker): no message.
        const text = typeof done === 'function' ? done(r?.data) : done
        if (text) setMsg({ type: 'ok', text })
      }
    } finally { setBusy(''); loadOverview(); loadStorage(); loadDrive(); loadCopy() }
  }

  // From the Off this PC window: it closes once the folder is set. A refusal
  // stays there with its reason; cancelling the folder picker changes nothing.
  async function chooseCopy(folder) {
    setBusy('copy'); setMsg(null)
    const r = await api()?.backup?.copySet?.(folder).catch(e => ({ ok: false, error: e?.message }))
    setBusy('')
    if (r?.ok === false) { setMsg({ type: 'error', text: r.error || 'That folder cannot be used' }); return }
    if (r?.data) { setMsg({ type: 'ok', text: `KoZo now keeps a copy of your backups in ${r.data}.` }); setOffPcOpen(false) }
    loadCopy()
  }
  // Google Drive asks what to add, one question at a time (DriveOffer).
  const [driveOffer, setDriveOffer] = useState(null)
  async function offerFromDrive() {
    setBusy('restoreDrive'); setMsg(null)
    const r = await api()?.drive?.offer?.()
    setBusy('')
    setGetBackOpen(false)
    if (r?.ok === false) setMsg({ type: 'error', text: r.error || 'Google Drive did not answer.' })
    else if (r?.data?.anything) setDriveOffer(r.data)
    else setMsg({ type: 'ok', text: 'Nothing new on Google Drive. Everything there is already on this PC.' })
  }
  // From the Get everything back window: it closes when the restore has finished.
  async function getBack(fn) {
    await fn()
    setGetBackOpen(false)
  }

  // Any folder holding a backup: it stays where it is, and saves come down to this PC.
  async function restoreFromFolder() {
    const p = await api()?.dialog?.pickFolder?.()
    const dir = p?.ok ? p.data : null
    if (dir) run('folder', () => api().backup.restoreFolder(dir, { copy: true }), 'Restored. Your saves from that folder are listed above.')
  }

  async function toggleAuto(v) {
    setAuto(v)
    await api()?.saves?.setAutoBackup?.(v)
  }

  // A second click restarts the sign-in (Google's "Access blocked" page never
  // comes back), so only the newest attempt may change the UI.
  const driveTry = useRef(0)
  async function connectDrive() {
    const mine = ++driveTry.current
    setBusy('drive'); setMsg(null)
    const r = await api()?.drive?.connect?.()
    if (mine !== driveTry.current) return
    setBusy('')
    const d = r?.data
    if (d?.error && d.error !== 'superseded') setMsg({ type: 'error', text: 'Google did not finish signing in. Try again.' })
    else if (d?.email != null) setOffPcOpen(false)
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
  const copyProblem = copy?.configured && (!copy.reachable || copy.error)

  let title, sub, warn = false
  if (!auto) { title = 'Automatic backups are off'; sub = 'Turn them on so KoZo keeps your saves safe.'; warn = true }
  else if (lowSpace) { title = 'The backup drive is almost full'; sub = 'New backups wait until there is 2 GB free. Free some space or move the backups.'; warn = true }
  else if (!withSaves.length) { title = 'Ready'; sub = 'KoZo backs up a game\'s saves the first time you play it.' }
  else if (!backedUp.length) { title = `${waiting.length} game${waiting.length === 1 ? '' : 's'} waiting for a first backup`; sub = 'KoZo knows where the saves are, and backs them up the next time you play.' }
  else { title = `${backedUp.length} game${backedUp.length === 1 ? '' : 's'} protected`; sub = `Backed up before and after every session${lastAt ? `, last ${timeAgo(lastAt)}` : ''}.${waiting.length ? ` ${waiting.length} more waiting for a first backup.` : ''}` }

  return (
    <div className={b.page}>
      {/* Is everything safe, and where is it? */}
      <section className={`${b.card} ${b.status} ${warn ? b.statusWarn : ''}`}>
        <div className={b.statusTop}>
          <span className={b.shield}>{warn ? <IconAlertTriangle size={26} /> : backedUp.length ? <IconShieldCheck size={26} /> : <IconShield size={26} />}</span>
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
              <span title={storage?.base || ''}>{storage ? `${fmtSize(storage.bytes)} used${storage.free != null ? `, ${fmtSize(storage.free)} free` : ''}` : '…'}</span>
            </div>
            <button type="button" className={b.btn} onClick={() => storage?.base && api()?.shell?.openPath?.(storage.base)} disabled={!storage}>
              <IconExternalLink size={14} /> Open
            </button>
          </div>

          {!copy?.configured && !drive?.connected && (
            <div className={`${b.place} ${drive?.error === 'signed_out' ? b.placeWarn : ''}`}>
              <span className={b.placeIcon}><IconCloudUp size={17} /></span>
              <div className={b.placeText}>
                <strong>Off this PC</strong>
                <span>{drive?.error === 'signed_out' ? 'Google signed KoZo out. Set it up again.' : 'Not set up. If this PC dies, your backups go with it.'}</span>
              </div>
              <button type="button" className={`${b.btn} ${b.btnPrimary}`} onClick={() => setOffPcOpen(true)}>Set up</button>
            </div>
          )}

          {copy?.configured && (
            <div className={`${b.place} ${copyProblem ? b.placeWarn : ''}`}>
              <span className={b.placeIcon}><IconCloudUp size={17} /></span>
              <div className={b.placeText}>
                <strong>Cloud folder</strong>
                <span title={copy.dir}>
                  {!copy.reachable ? `Can't reach ${copy.dir}. Plug it in or start its sync app.`
                    : copy.syncing ? `Copying to ${copy.dir}…`
                    : copy.error ? `Some files could not be copied to ${copy.dir}.`
                    : copy.lastAt ? `Copied ${timeAgo(copy.lastAt)} to ${copy.dir}`
                    : copy.dir}
                </span>
              </div>
              <button type="button" className={b.btn} disabled={!!busy || copy.syncing}
                onClick={() => run('copyNow', () => api().backup.copyNow(), (d) => d?.error ? null : 'Your backup copy is up to date.')}>
                {busy === 'copyNow' || copy.syncing ? <IconLoader2 size={14} className="spin" /> : <IconRefresh size={14} />} Copy now
              </button>
            </div>
          )}

          {drive?.connected && (
            <div className={`${b.place} ${driveProblem ? b.placeWarn : ''}`}>
              <span className={`${b.placeIcon} ${b.driveIcon}`}><IconBrandGoogleDrive size={17} /></span>
              <div className={b.placeText}>
                <strong>Google Drive {drive.email ? <em>{drive.email}</em> : null}</strong>
                <span>
                  {drive.error ? `Last copy failed: ${drive.error}`
                    : drive.syncing ? 'Copying…'
                    : drive.lastSync ? `Copied ${timeAgo(drive.lastSync)}`
                    : 'Connected. The first copy starts in a moment.'}
                </span>
              </div>
              <button type="button" className={b.btn} onClick={() => run('sync', () => api().drive.sync(), (d) => d?.error ? `Copy failed: ${d.error}` : 'Google Drive is up to date.')} disabled={busy === 'sync' || drive.syncing}>
                {busy === 'sync' || drive.syncing ? <IconLoader2 size={14} className="spin" /> : <IconRefresh size={14} />} Copy now
              </button>
            </div>
          )}
        </div>

        {drive?.last?.over && <p className={b.note}><IconAlertTriangle size={13} /> Not every restore point fits in your Google Drive space for KoZo. The newest one of every game is there.</p>}
        {drive?.last?.big?.length > 0 && <p className={b.note}><IconCloudOff size={13} /> Kept on this PC only (over 2 GB): {drive.last.big.join(', ')}.</p>}
        {msg && <p className={`${b.msg} ${msg.type === 'error' ? b.msgErr : ''}`}>{msg.type === 'error' ? <IconAlertTriangle size={13} /> : <IconCheck size={13} />} {msg.text}</p>}

        <div className={b.quick}>
          <button type="button" className={b.btn} disabled={!!busy} onClick={() => setGetBackOpen(true)}>
            <IconHistory size={14} /> Get everything back
          </button>
          <button type="button" className={b.btn} disabled={!!busy} onClick={exportPack} title="Your library, playtime and every save backup in one .kozo file. Open it on any PC.">
            {busy === 'packOut' ? <IconLoader2 size={14} className="spin" /> : <IconDownload size={14} />}
            {busy === 'packOut' && packProgress ? `Saving… ${Math.round((packProgress.done / Math.max(1, packProgress.total)) * 100)}%` : 'Save everything to one file'}
          </button>
        </div>
      </section>

      {/* Closed until wanted */}
      <details className={b.more}>
        <summary>
          <IconChevronRight size={14} className={b.moreChevron} /> Games
          <small>{overview ? `${backedUp.length} backed up${waiting.length ? `, ${waiting.length} waiting` : ''}` : 'Looking for saves…'}</small>
        </summary>
        <div className={b.moreBody}>
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
                <div className={b.games}>
                  {quiet.map(g => <GameRow key={g.id} g={g} quiet onOpen={() => onManageSaves?.({ id: g.id, name: g.name })} />)}
                </div>
              )}
            </>
          )}
        </div>
      </details>

      <details className={b.more}>
        <summary><IconChevronRight size={14} className={b.moreChevron} /> More options</summary>
        <div className={b.moreBody}>
          <Row label="Keep at most on this PC" hint="The oldest automatic backups go first when it's full.">
            <Seg value={String(storage?.capGb ?? 2)} onChange={async v => { await api()?.saves?.setCap?.(Number(v)); loadStorage() }}
              options={[['1', '1 GB'], ['2', '2 GB'], ['5', '5 GB'], ['0', 'No limit']]} />
          </Row>
          {drive?.connected && (
            <Row label="Google Drive space for KoZo" hint="Older restore points stay on this PC when it's full.">
              <Seg value={String(drive?.budgetGb ?? 1)} onChange={async v => { await api()?.drive?.setBudget?.(Number(v)); loadDrive() }}
                options={[['0.5', '500 MB'], ['1', '1 GB'], ['2', '2 GB'], ['5', '5 GB']]} />
            </Row>
          )}
          <div className={b.moreBtns}>
            <button type="button" className={b.btn} disabled={!!busy}
              onClick={() => run('all', () => api().saves.backupAll(), (d) => `${d?.backedUp ?? 0} games backed up.`)}>
              {busy === 'all' ? <IconLoader2 size={14} className="spin" /> : <IconArchive size={14} />} Back up every game now
            </button>
            {(copy?.configured || drive?.connected) && (
              <button type="button" className={b.btn} disabled={!!busy} onClick={() => setOffPcOpen(true)}>
                <IconCloudUp size={14} /> Change where copies go
              </button>
            )}
            <button type="button" className={b.btn} disabled={!!busy}
              onClick={() => run('move', () => api().saves.moveBase(), (d) => d ? `Backups moved to ${d}.` : null)}>
              <IconFolder size={14} /> Move backups on this PC
            </button>
            {copy?.configured && (
              <button type="button" className={b.btn} disabled={!!busy} onClick={() => run('copyOff', () => api().backup.copyOff(), 'Stopped copying. The files already in that folder stay.')}>
                <IconCloudOff size={14} /> Stop copying to my cloud folder
              </button>
            )}
            {drive?.connected && (
              <button type="button" className={b.btn} onClick={() => run('disc', () => api().drive.disconnect(), 'Google Drive disconnected. The copy there stays.')}>
                <IconCloudOff size={14} /> Disconnect Google Drive
              </button>
            )}
          </div>
        </div>
      </details>

      {offPcOpen && (
        <Modal title="Keep a copy off this PC" icon={<IconCloudUp size={16} />} onClose={() => setOffPcOpen(false)} width={500}
          footer={<button type="button" className={ms.btnCancel} onClick={() => setOffPcOpen(false)}>Close</button>}>
          <p className={b.foldNote}>In your own storage. Pick one, and KoZo keeps it up to date.</p>
          <div className={b.actionsCol}>
            {clouds.map(c => {
              const Icon = CLOUD_ICONS[c.id] || IconCloud
              return (
                <button key={c.id} type="button" className={b.action} disabled={!!busy} onClick={() => chooseCopy(c.path)}>
                  <Icon size={18} />
                  <span><strong>{c.name}</strong><small>{c.path}</small></span>
                </button>
              )
            })}
            {drive?.configured && !drive.connected && (
              <button type="button" className={b.action} onClick={connectDrive} title={busy === 'drive' ? 'Start the sign-in again' : undefined}>
                {busy === 'drive' ? <IconLoader2 size={18} className="spin" /> : <IconBrandGoogle size={18} />}
                <span><strong>{busy === 'drive' ? 'Waiting for Google…' : 'Sign in with Google'}</strong><small>Google Drive, without installing anything</small></span>
              </button>
            )}
            <button type="button" className={b.action} disabled={!!busy && busy !== 'drive'} onClick={() => chooseCopy(null)}>
              <IconFolder size={18} />
              <span><strong>Choose a folder</strong><small>Any cloud folder, USB stick or second drive</small></span>
            </button>
          </div>
          {busy === 'drive' && <DriveBlockedHint />}
          {!clouds.length && <p className={b.foldNote} style={{ marginTop: 10 }}>Install Google Drive for Desktop, Dropbox or MEGA and its folder shows up here.</p>}
          {msg?.type === 'error' && <p className={`${b.msg} ${b.msgErr}`} style={{ marginTop: 10 }}><IconAlertTriangle size={13} /> {msg.text}</p>}
        </Modal>
      )}

      {getBackOpen && (
        <Modal title="Get everything back" icon={<IconHistory size={16} />} onClose={() => setGetBackOpen(false)} width={500}
          footer={<button type="button" className={ms.btnCancel} onClick={() => setGetBackOpen(false)} disabled={!!busy}>Close</button>}>
          <p className={b.foldNote}>After a new Windows, or on another PC. Where is your backup?</p>
          <div className={b.actionsCol}>
            {found.map(f => (
              <button key={f.path} type="button" className={b.action} disabled={!!busy}
                onClick={() => getBack(() => run('folder', () => api().backup.restoreFolder(f.path, { copy: f.kind === 'copy' }), 'Restored. Your saves from that folder are back too.'))}>
                <IconFolder size={18} />
                <span><strong title={f.path}>{f.path}</strong><small>{f.games} games{f.at ? `, saved ${timeAgo(f.at)}` : ''}</small></span>
              </button>
            ))}
            {drive?.connected && (
              <button type="button" className={b.action} disabled={!!busy} onClick={offerFromDrive} data-offer-drive>
                <IconBrandGoogleDrive size={18} />
                <span><strong>{busy === 'restoreDrive' ? 'Looking…' : 'Google Drive'}</strong><small>Asks what to add: Game List, Library, game saves</small></span>
              </button>
            )}
            <button type="button" className={b.action} disabled={!!busy} onClick={() => getBack(restoreFromFolder)}>
              <IconFolder size={18} />
              <span><strong>{busy === 'folder' ? 'Bringing it back…' : 'A folder'}</strong><small>A KoZo Backup folder in a cloud folder or on a USB stick</small></span>
            </button>
            <button type="button" className={b.action} disabled={!!busy} onClick={() => getBack(importPack)}>
              <IconFileZip size={18} />
              <span><strong>{busy === 'packIn' ? (packProgress ? `Opening… ${Math.round((packProgress.done / Math.max(1, packProgress.total)) * 100)}%` : 'Opening…') : 'A .kozo file'}</strong><small>The one file you saved</small></span>
            </button>
          </div>
          <div className={b.modalLinks}>
            {backedUp.length > 0 && <button type="button" className={b.linkBtn} disabled={!!busy} onClick={() => { setGetBackOpen(false); setRestoreAll(true) }}>Put saves back from this PC's backups</button>}
            <button type="button" className={b.linkBtn} disabled={!!busy} onClick={() => getBack(() => run('file', () => api().backup.import(), (d) => d ? `Restored ${d.games} games and ${d.sessions} sessions.` : null))}>Open an older library file (.json)</button>
          </div>
        </Modal>
      )}

      {restoreAll && <RestoreAllModal onClose={() => { setRestoreAll(false); loadOverview() }} />}
      {driveOffer && <DriveOffer offer={driveOffer} onClose={() => { setDriveOffer(null); loadOverview(); loadStorage() }} />}
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
