import React, { useState } from 'react'
import {
  IconEdit, IconAlertTriangle, IconCrosshair, IconCheck, IconFolderOpen,
  IconChevronDown, IconChevronRight, IconPhotoSearch, IconUpload, IconX, IconDeviceGamepad2,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import LauncherNote from '../ui/LauncherNote'
import RunningProcessPicker from '../ui/RunningProcessPicker'
import SearchableSelect from '../ui/SearchableSelect'
import Switch from '../ui/Switch'
import ImageCropModal from './ImageCropModal'
import CoverPickerModal from './CoverPickerModal'
import { FOREIGN_LAUNCHERS, KNOWN_SYSTEM_EXES, exeLooksLikeTool, fileUrl } from '../../lib/utils'
import cs from '../../styles/controls.module.css'
import s from './AddGameModal.module.css'
import e from './EditGameModal.module.css'

const STORES = [
  { value: 'steam', label: 'Steam' }, { value: 'epic', label: 'Epic' }, { value: 'gog', label: 'GOG' },
  { value: 'xbox', label: 'Xbox' }, { value: 'ea', label: 'EA' }, { value: 'ubisoft', label: 'Ubisoft' },
  { value: 'manual', label: 'Other' },
]

function OptionRow({ label, hint, children }) {
  return (
    <div className={e.row}>
      <div className={e.rowText}>
        <div className={e.rowLabel}>{label}</div>
        {hint && <div className={e.rowHint}>{hint}</div>}
      </div>
      {children}
    </div>
  )
}

// The cover and the three things people come here for are in view; everything that's set once
// sits under More options, with what it's set to on the closed row.
export default function EditGameModal({ game, onClose, onSaved }) {
  const [name, setName]               = useState(game.name || '')
  const [exeName, setExeName]         = useState(game.exe_name || '')
  const [installPath, setInstallPath] = useState(game.install_path || '')
  const [launchFile, setLaunchFile]   = useState(game.launch_file || '')   // .bat / shortcut Play runs
  const [candidates, setCandidates]   = useState([])
  const [isInstalled, setIsInstalled] = useState(game.is_installed ? 1 : 0)
  const [isCracked, setIsCracked]     = useState(game.is_cracked ? 1 : 0)
  const [source, setSource]           = useState(game.source || 'manual')
  const [steamAppId, setSteamAppId]   = useState(game.steam_app_id ? String(game.steam_app_id) : '')
  const [runAsAdmin, setRunAsAdmin]   = useState(game.run_as_admin ? 1 : 0)
  const [errors, setErrors]           = useState({})
  const [saving, setSaving]           = useState(false)
  const [saved, setSaved]             = useState(false)
  const [showPicker, setShowPicker]   = useState(false)
  const [coverPath, setCoverPath]     = useState(game.banner_local_path || '')
  const [cropSrc, setCropSrc]         = useState(null)
  const [findCover, setFindCover]     = useState(false)
  const [showMore, setShowMore]       = useState(false)

  const exe = exeName.trim()
  const systemExe = KNOWN_SYSTEM_EXES.has(exe.toLowerCase())
  const toolExe = !systemExe && exeLooksLikeTool(exe)

  // One predicate drives BOTH the field's visibility and whether save keeps the
  // value, so an App ID can never be held while hidden nor destroyed while
  // invisible. Kept for anything that is or was a cracked Steam copy (the
  // scanner stores those as source='cracked'); force-nulled for foreign
  // launchers and plain manual entries.
  const appIdRelevant = source === 'steam' || source === 'cracked' || isCracked === 1

  // A scanner/discovery-added cracked copy is stored as source='cracked', which isn't a store,
  // but without an option for it a stray pick would silently drop it.
  const stores = game.source === 'cracked' ? [{ value: 'cracked', label: 'Cracked' }, ...STORES] : STORES
  const summary = [
    isCracked ? 'Cracked' : 'Official',
    stores.find(o => o.value === source)?.label,
    isInstalled ? 'Installed' : 'Not installed',
    runAsAdmin ? 'Runs as administrator' : null,
  ].filter(Boolean).filter((v, i, all) => all.indexOf(v) === i).join(', ')

  async function handleSave() {
    const newErrors = {}
    if (!name.trim()) newErrors.name = 'Game name is required'
    // No file is allowed: a game whose file is gone can still have its name and cover edited.
    if (exe && !exe.toLowerCase().endsWith('.exe')) newErrors.exeName = 'Must end in .exe'
    const sid = appIdRelevant ? steamAppId.trim() : ''
    if (sid && !/^\d+$/.test(sid)) { newErrors.steamAppId = 'Must be a number'; setShowMore(true) }
    if (Object.keys(newErrors).length) { setErrors(newErrors); return }

    setSaving(true)
    try {
      const res = await window.kozo?.api?.games?.update(game.id, {
        name: name.trim(),
        exe_name: exe,
        install_path: installPath.trim() || null,
        launch_file: launchFile || null,
        is_installed: isInstalled,
        is_cracked: isCracked,
        source,
        steam_app_id: sid ? Number(sid) : null,
        run_as_admin: runAsAdmin,
        banner_local_path: coverPath.trim() || null,
        // A hand-picked cover must outrank the remote Steam URL, or the card
        // would keep falling back to whatever art the app id resolves to.
        ...(coverPath.trim() && coverPath !== game.banner_local_path ? { banner_url: null } : {}),
      })
      setSaving(false)
      if (res?.ok) {
        setSaved(true)
        onSaved?.(res.data)
        setTimeout(() => onClose(), 600)
      } else {
        setErrors({ save: res?.error || 'Failed to save changes' })
      }
    } catch (err) {
      setSaving(false)
      setErrors({ save: err?.message || 'Something went wrong' })
    }
  }

  async function browseExe() {
    const res = await window.kozo?.api?.dialog?.pickExe(installPath || undefined)
    if (res?.ok && res.data) {
      setExeName(res.data.exe_name || '')
      setInstallPath(res.data.install_path)
      setLaunchFile(res.data.launch_file || '')
      setCandidates(res.data.candidates || [])
      setErrors(p => ({ ...p, exeName: '' }))
    }
  }

  async function uploadCover() {
    const res = await window.kozo?.api?.dialog?.pickImageData?.()
    if (res?.ok && res.data?.dataUrl) setCropSrc(res.data.dataUrl)
  }

  return (
   <>
    <Modal
      title={`Edit "${game.name}"`}
      icon={<IconEdit size={16} stroke={1.6} />}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button type="button" className={ms.btnCancel} onClick={onClose}>Cancel</button>
          {/* Busy is `btnLoading`, not `disabled`: a disabled button drops out of
              the focus order and stops announcing itself mid-save. `saved` is a
              real terminal state, so that one still disables. */}
          <button
            type="button"
            className={`${ms.btnPrimary} ${saving ? cs.btnLoading : ''}`}
            onClick={handleSave}
            disabled={saved}
            aria-busy={saving || undefined}
          >
            {saved
              ? <><IconCheck size={14} stroke={2.5} /> Saved</>
              : (saving ? 'Saving…' : 'Save changes')}
          </button>
        </>
      }
    >
      <div className={e.top} data-edit-game>
        <div className={e.coverCol}>
          <div className={e.cover} data-edit-cover>
            {coverPath
              ? <img src={fileUrl(coverPath, game.banner_rev || undefined)} alt="" />
              : <IconDeviceGamepad2 size={30} stroke={1.2} className={e.coverEmpty} />}
            {coverPath && (
              <button type="button" className={e.coverRemove} onClick={() => setCoverPath('')} title="Remove the cover" aria-label="Remove the cover">
                <IconX size={12} stroke={2.2} />
              </button>
            )}
          </div>
          <div className={e.coverBtns}>
            <button type="button" className={e.coverBtn} onClick={() => setFindCover(true)} title="Find a cover on SteamGridDB" data-edit-find>
              <IconPhotoSearch size={13} stroke={1.7} /> Find
            </button>
            <button type="button" className={e.coverBtn} onClick={uploadCover} title="Use your own image" data-edit-upload>
              <IconUpload size={13} stroke={1.7} /> Upload
            </button>
          </div>
        </div>

        <div className={e.fields}>
          <div className={s.field}>
            <label className={`${s.label} ${s.labelRequired}`}>Name</label>
            <input
              className={`${s.input} ${errors.name ? s.inputError : ''}`}
              value={name}
              onChange={ev => { setName(ev.target.value); setErrors(p => ({ ...p, name: '' })) }}
            />
            {errors.name && <div className={s.errorText}>{errors.name}</div>}
          </div>

          <div className={s.field}>
            <label className={s.label}>Game file</label>
            <div className={s.exeRow}>
              <input
                className={`${s.input} ${errors.exeName ? s.inputError : ''}`}
                value={exeName}
                onChange={ev => { setExeName(ev.target.value); setErrors(p => ({ ...p, exeName: '' })) }}
                placeholder="e.g. Game.exe"
              />
              <button type="button" className={s.pickBtn} onClick={browseExe} title="Choose the game's .exe, or the .bat or shortcut it starts from">
                <IconFolderOpen size={14} stroke={1.7} /> Browse
              </button>
              <button type="button" className={s.pickBtn} onClick={() => setShowPicker(v => !v)} title="Choose from what's running now">
                <IconCrosshair size={14} stroke={1.7} /> Running
              </button>
            </div>
            {errors.exeName && <div className={s.errorText}>{errors.exeName}</div>}
            {!exe && !errors.exeName && <div className={s.inputHint}>No game file yet, so KoZo can't start or track this game.</div>}
            {systemExe && (
              <div className={s.warning}>
                <IconAlertTriangle size={14} stroke={1.8} className={s.warningIcon} />
                This is a Windows program, not a game.
              </div>
            )}
            {toolExe && (
              <div className={s.warning}>
                <IconAlertTriangle size={14} stroke={1.8} className={s.warningIcon} />
                This looks like a tool or an installer, not the game.
              </div>
            )}
          </div>

          <div className={s.field}>
            <label className={s.label}>Folder</label>
            <input
              className={s.input}
              value={installPath}
              onChange={ev => setInstallPath(ev.target.value)}
              placeholder="e.g. C:\Games\Lies of P"
            />
          </div>
        </div>
      </div>

      <LauncherNote launchFile={launchFile} candidates={candidates} exeName={exeName}
        onPickExe={(c) => { setExeName(c.exe_name); setInstallPath(c.install_path) }}
        onClear={() => { setLaunchFile(''); setCandidates([]) }} />

      {showPicker && (
        <div className={s.pickerWrap}>
          <RunningProcessPicker
            onClose={() => setShowPicker(false)}
            onPick={(proc) => {
              setExeName(proc.exe_name)
              if (proc.install_path) setInstallPath(proc.install_path)
              setErrors(p => ({ ...p, exeName: '' }))
              setShowPicker(false)
            }}
          />
        </div>
      )}

      <button type="button" className={e.more} onClick={() => setShowMore(v => !v)} aria-expanded={showMore} data-edit-more>
        {showMore ? <IconChevronDown size={14} stroke={1.8} /> : <IconChevronRight size={14} stroke={1.8} />}
        <span className={e.moreLabel}>More options</span>
        {!showMore && <span className={e.moreSummary} data-edit-summary>{summary}</span>}
      </button>

      {showMore && (
        <div className={e.options} data-edit-options>
          <OptionRow label="Installed on this PC">
            <Switch label="Installed on this PC" checked={!!isInstalled} onChange={v => setIsInstalled(v ? 1 : 0)} />
          </OptionRow>
          <OptionRow label="Cracked copy" hint="Starts the file directly. Achievements come from its own files, not Steam.">
            <Switch label="Cracked copy" checked={!!isCracked} onChange={v => setIsCracked(v ? 1 : 0)} />
          </OptionRow>
          <OptionRow label="Run as administrator" hint="Turn this on if Play does nothing.">
            <Switch label="Run as administrator" checked={!!runAsAdmin} onChange={v => setRunAsAdmin(v ? 1 : 0)} />
          </OptionRow>
          <OptionRow label="Store" hint="The badge on its cover.">
            <SearchableSelect
              value={source}
              options={stores}
              width={140}
              searchable={false}
              clearable={false}
              onChange={(v) => {
                setSource(v)
                // A stray Steam App ID on a foreign launcher would (wrongly) trigger
                // Steam sync UI: drop it when switching to one.
                if (FOREIGN_LAUNCHERS.has(v)) setSteamAppId('')
              }}
            />
          </OptionRow>
          {appIdRelevant && (
            <OptionRow label="Steam App ID" hint={errors.steamAppId || 'The number in its Steam store address.'}>
              <input
                className={`${s.input} ${e.appId} ${errors.steamAppId ? s.inputError : ''}`}
                value={steamAppId}
                onChange={ev => { setSteamAppId(ev.target.value); setErrors(p => ({ ...p, steamAppId: '' })) }}
                placeholder="None"
              />
            </OptionRow>
          )}
        </div>
      )}

      {errors.save && <div className={s.errorText} role="alert">{errors.save}</div>}
    </Modal>

    {/* Sibling, not a child: same as AddGameModal. Modal portals to body, so
        a crop modal declared inside another modal's subtree still escapes it,
        but keeping them siblings matches the pattern used everywhere else. */}
    {findCover && (
      <CoverPickerModal
        game={{ ...game, name: name.trim() || game.name }}
        onClose={() => setFindCover(false)}
        onApplied={(g) => { if (g?.banner_local_path) setCoverPath(g.banner_local_path); setFindCover(false) }}
      />
    )}

    {cropSrc && (
      <ImageCropModal
        src={cropSrc}
        kind="cover"
        title="Adjust cover"
        onCancel={() => setCropSrc(null)}
        onDone={(path) => { setCoverPath(path); setCropSrc(null) }}
      />
    )}
   </>
  )
}
