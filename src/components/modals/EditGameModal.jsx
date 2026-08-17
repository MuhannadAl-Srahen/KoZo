import React, { useState } from 'react'
import {
  IconEdit, IconAlertTriangle, IconCrosshair, IconCheck, IconFolderOpen,
  IconChevronDown, IconChevronRight,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import RunningProcessPicker from '../ui/RunningProcessPicker'
import { FOREIGN_LAUNCHERS } from '../../lib/utils'
import cs from '../../styles/controls.module.css'
import s from './AddGameModal.module.css'

const KNOWN_SYSTEM_EXES = new Set([
  'explorer.exe', 'svchost.exe', 'winlogon.exe', 'csrss.exe',
  'lsass.exe', 'services.exe', 'system', 'taskmgr.exe',
])

export default function EditGameModal({ game, onClose, onSaved }) {
  const [name, setName]               = useState(game.name || '')
  const [exeName, setExeName]         = useState(game.exe_name || '')
  const [installPath, setInstallPath] = useState(game.install_path || '')
  const [isInstalled, setIsInstalled] = useState(game.is_installed ? 1 : 0)
  const [isCracked, setIsCracked]     = useState(game.is_cracked ? 1 : 0)
  const [source, setSource]           = useState(game.source || 'manual')
  const [steamAppId, setSteamAppId]   = useState(game.steam_app_id ? String(game.steam_app_id) : '')
  const [runAsAdmin, setRunAsAdmin]   = useState(game.run_as_admin ? 1 : 0)
  const [errors, setErrors]           = useState({})
  const [exeWarn, setExeWarn]         = useState(false)
  const [saving, setSaving]           = useState(false)
  const [saved, setSaved]             = useState(false)
  const [showPicker, setShowPicker]   = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  function onExeChange(val) {
    setExeName(val)
    setExeWarn(KNOWN_SYSTEM_EXES.has(val.toLowerCase().trim()))
  }

  // One predicate drives BOTH the field's visibility and whether save keeps the
  // value, so an App ID can never be held while hidden nor destroyed while
  // invisible. Kept for anything that is or was a cracked Steam copy (the
  // scanner stores those as source='cracked'); force-nulled for foreign
  // launchers and plain manual entries.
  const appIdRelevant = source === 'steam' || source === 'cracked' || isCracked === 1

  async function handleSave() {
    const newErrors = {}
    if (!name.trim())    newErrors.name = 'Game name is required'
    if (!exeName.trim()) newErrors.exeName = 'Executable name is required'
    if (exeName.trim() && !exeName.toLowerCase().trim().endsWith('.exe')) {
      newErrors.exeName = 'Must end in .exe'
    }
    const sid = appIdRelevant ? steamAppId.trim() : ''
    if (sid && !/^\d+$/.test(sid)) newErrors.steamAppId = 'Steam App ID must be numeric'
    if (Object.keys(newErrors).length) { setErrors(newErrors); return }

    setSaving(true)
    try {
      const res = await window.kozo?.api?.games?.update(game.id, {
        name: name.trim(),
        exe_name: exeName.trim(),
        install_path: installPath.trim() || null,
        is_installed: isInstalled,
        is_cracked: isCracked,
        source,
        steam_app_id: sid ? Number(sid) : null,
        run_as_admin: runAsAdmin,
      })
      setSaving(false)
      if (res?.ok) {
        setSaved(true)
        onSaved?.(res.data)
        setTimeout(() => onClose(), 600)
      } else {
        setErrors({ save: res?.error || 'Failed to save changes' })
      }
    } catch (e) {
      setSaving(false)
      setErrors({ save: e?.message || 'Something went wrong' })
    }
  }

  return (
    <Modal
      title={`Edit "${game.name}"`}
      icon={<IconEdit size={16} stroke={1.6} />}
      onClose={onClose}
      width={540}
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
      {/* Game name */}
      <div className={s.field}>
        <label className={`${s.label} ${s.labelRequired}`}>Game name</label>
        <input
          className={`${s.input} ${errors.name ? s.inputError : ''}`}
          value={name}
          onChange={e => { setName(e.target.value); setErrors(p => ({ ...p, name: '' })) }}
        />
        {errors.name && <div className={s.errorText}>{errors.name}</div>}
      </div>

      {/* Exe name with picker */}
      <div className={s.field}>
        <label className={`${s.label} ${s.labelRequired}`}>Executable name</label>
        <div className={s.exeRow}>
          <input
            className={`${s.input} ${errors.exeName ? s.inputError : ''}`}
            value={exeName}
            onChange={e => { onExeChange(e.target.value); setErrors(p => ({ ...p, exeName: '' })) }}
            placeholder="e.g. LOP-Win64-Shipping.exe"
          />
          <button
            type="button"
            className={s.pickBtn}
            onClick={async () => {
              const res = await window.kozo?.api?.dialog?.pickExe(installPath || undefined)
              if (res?.ok && res.data) {
                setExeName(res.data.exe_name)
                setInstallPath(res.data.install_path)
                setExeWarn(KNOWN_SYSTEM_EXES.has(res.data.exe_name.toLowerCase()))
                setErrors(p => ({ ...p, exeName: '' }))
              }
            }}
            title="Browse for the game .exe file"
          >
            <IconFolderOpen size={14} stroke={1.7} />
            Browse
          </button>
          <button
            type="button"
            className={s.pickBtn}
            onClick={() => setShowPicker(v => !v)}
            title="Pick from running processes"
          >
            <IconCrosshair size={14} stroke={1.7} />
            Pick running
          </button>
        </div>

        {showPicker && (
          <div className={s.pickerWrap}>
            <RunningProcessPicker
              onClose={() => setShowPicker(false)}
              onPick={(proc) => {
                setExeName(proc.exe_name)
                if (proc.install_path) setInstallPath(proc.install_path)
                setExeWarn(KNOWN_SYSTEM_EXES.has(proc.exe_name.toLowerCase()))
                setErrors(p => ({ ...p, exeName: '' }))
                setShowPicker(false)
              }}
            />
          </div>
        )}

        {errors.exeName
          ? <div className={s.errorText}>{errors.exeName}</div>
          : <div className={s.inputHint}>Click "Browse" to locate the game's .exe on disk — most reliable. Or "Pick running" if it's already open.</div>
        }
        {exeWarn && (
          <div className={s.warning}>
            <IconAlertTriangle size={14} stroke={1.8} className={s.warningIcon} />
            This looks like a Windows system process. Are you sure?
          </div>
        )}
      </div>

      {/* Install path */}
      <div className={s.field}>
        <label className={s.label}>
          Install path <span className={s.labelNote}>(optional)</span>
        </label>
        <input
          className={s.input}
          value={installPath}
          onChange={e => setInstallPath(e.target.value)}
          placeholder="e.g. C:\Games\Lies of P"
        />
        <div className={s.inputHint}>Used to detect crack emulator achievement files (Goldberg, Codex, etc.)</div>
      </div>

      {/* Everything below is rarely touched (auto-detected or set once at add
          time) — collapsed so the modal stays a quick name/exe/path editor. */}
      <button
        type="button"
        className={s.advancedToggle}
        onClick={() => setShowAdvanced(v => !v)}
        aria-expanded={showAdvanced}
      >
        {showAdvanced ? <IconChevronDown size={13} stroke={1.8} /> : <IconChevronRight size={13} stroke={1.8} />}
        Advanced — status, launcher, copy type
      </button>

      {showAdvanced && <>
      {/* Installed status — manual override for when detection is wrong */}
      <div className={s.field}>
        <label className={s.label}>Installation status</label>
        <div className={s.pills}>
          <button
            type="button"
            className={`${s.pill} ${isInstalled ? s.pillActive : ''}`}
            onClick={() => setIsInstalled(1)}
          >
            Installed
          </button>
          <button
            type="button"
            className={`${s.pill} ${!isInstalled ? s.pillActive : ''}`}
            onClick={() => setIsInstalled(0)}
          >
            Not installed
          </button>
        </div>
        <div className={s.inputHint}>
          Rescan in Settings auto-detects this for Steam games; use this only to override.
        </div>
      </div>

      {/* Launcher / source — drives the library badge */}
      <div className={s.field}>
        <label className={s.label}>Launcher</label>
        <div className={s.pills} style={{ flexWrap: 'wrap' }}>
          {[
            // A scanner/discovery-added cracked copy is stored as source='cracked',
            // which isn't a launcher — but without a pill for it no option would
            // render active and a stray click would silently drop it.
            ...(game.source === 'cracked' ? [['cracked', 'Cracked']] : []),
            ['steam', 'Steam'], ['epic', 'Epic'], ['gog', 'GOG'],
            ['xbox', 'Xbox'], ['ea', 'EA'], ['ubisoft', 'Ubisoft'], ['manual', 'Other'],
          ].map(([val, lbl]) => (
            <button
              key={val}
              type="button"
              className={`${s.pill} ${source === val ? s.pillActive : ''}`}
              onClick={() => {
                setSource(val)
                // A stray Steam App ID on a foreign launcher would (wrongly) trigger
                // Steam sync UI — drop it when switching to one.
                if (FOREIGN_LAUNCHERS.has(val)) setSteamAppId('')
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className={s.inputHint}>
          Which store/launcher this game is from — shown as a badge on the cover. A cracked
          copy keeps its own "Cracked" badge regardless of this. KoZo can only sync
          achievements for Steam and cracked games.
        </div>
      </div>

      {/* Steam App ID — only relevant for Steam (and cracked games that use the
          Steam schema for achievement names/icons). Hidden for foreign launchers. */}
      {appIdRelevant && (
        <div className={s.field}>
          <label className={s.label}>
            Steam App ID <span className={s.labelNote}>(optional)</span>
          </label>
          <input
            className={`${s.input} ${errors.steamAppId ? s.inputError : ''}`}
            value={steamAppId}
            onChange={e => { setSteamAppId(e.target.value); setErrors(p => ({ ...p, steamAppId: '' })) }}
            placeholder="e.g. 1627720"
          />
          {errors.steamAppId
            ? <div className={s.errorText}>{errors.steamAppId}</div>
            : <div className={s.inputHint}>Steam's numeric game ID — used to pull achievements + cover art. Found in the store page URL (store.steampowered.com/app/<b>1627720</b>/).</div>}
        </div>
      )}

      {/* Cracked flag — controls launch + how achievements are sourced */}
      <div className={s.field}>
        <label className={s.label}>Copy type</label>
        <div className={s.pills}>
          <button
            type="button"
            className={`${s.pill} ${!isCracked ? s.pillActive : ''}`}
            onClick={() => setIsCracked(0)}
          >
            Official
          </button>
          <button
            type="button"
            className={`${s.pill} ${isCracked ? s.pillActive : ''}`}
            onClick={() => setIsCracked(1)}
          >
            Cracked / offline
          </button>
        </div>
        <div className={s.inputHint}>
          Cracked games launch the local .exe (never Steam) and pull achievements from crack
          emulator files (Goldberg, CODEX, online-fix, etc) instead of the Steam API.
        </div>
      </div>

      {/* Run as administrator — some repacks/copies need elevation to launch at
          all; KoZo also sets this automatically the first time Play needs it. */}
      <div className={s.field}>
        <label className={s.label}>Launch</label>
        <div className={s.pills}>
          <button
            type="button"
            className={`${s.pill} ${!runAsAdmin ? s.pillActive : ''}`}
            onClick={() => setRunAsAdmin(0)}
          >
            Normal
          </button>
          <button
            type="button"
            className={`${s.pill} ${runAsAdmin ? s.pillActive : ''}`}
            onClick={() => setRunAsAdmin(1)}
          >
            Run as administrator
          </button>
        </div>
        <div className={s.inputHint}>
          Turn this on if Play doesn't seem to do anything — some copies (especially
          repacks installed under Program Files) need admin rights to launch at all.
        </div>
      </div>
      </>}

      {errors.save && <div className={s.errorText} role="alert">{errors.save}</div>}
    </Modal>
  )
}
