import React, { useState } from 'react'
import { IconFolderOpen, IconCrosshair, IconPlayerPlayFilled, IconAlertTriangle, IconCheck, IconFileCode } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import RunningProcessPicker from '../ui/RunningProcessPicker'
import GeneratedCover from '../GeneratedCover'
import { fileUrl, detectLauncherFromPath, KNOWN_SYSTEM_EXES } from '../../lib/utils'
import s from './MakePlayableModal.module.css'

// After Move to Library: KoZo needs each game's .exe to launch it and track
// playtime. One game at a time ("2 of 3"): Browse for the file (an .exe, or the
// .bat / shortcut a cracked copy starts from, then which .exe is the game), pick it from
// the running processes, or Skip and set it later from Edit.
// `games`: [{ gameId, name, cover, coverPath }] from gameList:moveToLibrary.
export default function MakePlayableModal({ games, onClose }) {
  const [i, setI] = useState(0)
  const [picked, setPicked] = useState(null)      // { exe_name, install_path, launch_file?, candidates? }
  const [showRunning, setShowRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [doneNames, setDoneNames] = useState([])
  const [failed, setFailed] = useState(false)
  const g = games[i]
  const last = i >= games.length - 1
  const cover = g?.coverPath ? fileUrl(g.coverPath) : g?.cover
  const systemExe = picked?.exe_name && KNOWN_SYSTEM_EXES.has(picked.exe_name.toLowerCase())

  function next() {
    setPicked(null); setShowRunning(false); setFailed(false)
    if (last) onClose(); else setI(n => n + 1)
  }

  async function browse() {
    const res = await window.kozo?.api?.dialog?.pickExe?.()
    if (res?.ok && res.data) setPicked(res.data)
  }

  async function save() {
    if (!picked?.exe_name) return
    setSaving(true)
    const source = detectLauncherFromPath(picked.install_path)
    await window.kozo?.api?.games?.update?.(g.gameId, {
      exe_name: picked.exe_name,
      install_path: picked.install_path || null,
      launch_file: picked.launch_file || null,
      is_installed: 1,
      ...(source ? { source } : {}),
    })
    setSaving(false)
    setDoneNames(d => [...d, g.name])
    next()
  }

  if (!g) return null
  return (
    <Modal
      title="Make it playable"
      icon={<IconPlayerPlayFilled size={16} />}
      onClose={onClose}
      width={520}
      footer={
        <div className={s.footer}>
          {games.length > 1 && <button className={ms.btnGhost} onClick={onClose}>Skip all</button>}
          <div className={s.spacer} />
          <button className={ms.btnCancel} onClick={next}>Skip</button>
          <button className={ms.btnPrimary} onClick={save} disabled={!picked?.exe_name || saving}>
            {saving ? 'Saving…' : last ? 'Done' : 'Save and next'}
          </button>
        </div>
      }
    >
      <div className={s.head}>
        <div className={s.cover}>
          {cover && !failed ? <img src={cover} alt="" onError={() => setFailed(true)} /> : <GeneratedCover name={g.name} compact />}
        </div>
        <div className={s.headText}>
          <div className={s.added}><IconCheck size={13} stroke={2.4} /> Added to your Library</div>
          <div className={s.name}>{g.name}</div>
          {games.length > 1 && <div className={s.step}>{i + 1} of {games.length}</div>}
        </div>
      </div>

      <p className={s.lead}>Show KoZo the game's .exe so it can launch it and track your playtime.</p>

      <div className={s.choices}>
        <button type="button" className={s.choice} onClick={browse} data-gpnav="">
          <IconFolderOpen size={20} stroke={1.6} />
          <span className={s.choiceTitle}>Browse for the game</span>
          <span className={s.choiceDesc}>Its .exe, or the .bat or shortcut that starts it</span>
        </button>
        <button type="button" className={`${s.choice} ${showRunning ? s.choiceOn : ''}`} onClick={() => setShowRunning(v => !v)} data-gpnav="">
          <IconCrosshair size={20} stroke={1.6} />
          <span className={s.choiceTitle}>Pick a running game</span>
          <span className={s.choiceDesc}>If the game is open right now</span>
        </button>
      </div>

      {showRunning && (
        <div className={s.running}>
          <RunningProcessPicker
            onClose={() => setShowRunning(false)}
            onPick={(proc) => { setPicked(p => ({ ...(p?.launch_file ? p : {}), exe_name: proc.exe_name, install_path: proc.install_path || null })); setShowRunning(false) }}
          />
        </div>
      )}

      {picked?.launch_file && (
        <div className={s.launcher}>
          <div className={s.launcherHead}>
            <IconFileCode size={15} /> Starts with <strong>{picked.launch_file.split(/[\\/]/).pop()}</strong>
          </div>
          <div className={s.launcherAsk}>Which program is the game? KoZo watches it to track your playtime.</div>
          <div className={s.cands}>
            {(picked.candidates || []).map(c => (
              <button key={c.install_path + c.exe_name} type="button" data-gpnav=""
                className={`${s.cand} ${c.exe_name === picked.exe_name && c.install_path === picked.install_path ? s.candOn : ''}`}
                onClick={() => setPicked(p => ({ ...p, exe_name: c.exe_name, install_path: c.install_path }))}>
                {c.exe_name}
              </button>
            ))}
            {!(picked.candidates || []).length && <span className={s.candNone}>No .exe found next to it. Start the game and use Pick a running game.</span>}
          </div>
        </div>
      )}
      {picked?.exe_name && (
        <div className={s.picked}>
          <IconCheck size={15} stroke={2.2} />
          <span className={s.pickedName}>{picked.exe_name}</span>
          {picked.install_path && <span className={s.pickedPath} title={picked.install_path}>{picked.install_path}</span>}
        </div>
      )}
      {systemExe && (
        <div className={s.warn}><IconAlertTriangle size={14} /> This looks like a Windows system process. Are you sure?</div>
      )}
      {doneNames.length > 0 && <div className={s.ready}>Ready to play: {doneNames.join(', ')}</div>}
    </Modal>
  )
}
