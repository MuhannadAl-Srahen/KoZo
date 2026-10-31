import React from 'react'
import { IconFileCode, IconX } from '@tabler/icons-react'
import s from './LauncherNote.module.css'

// Shown under the executable field when the game starts from a launcher file
// (.bat / .cmd / shortcut, common for cracked copies): Play runs that file,
// and the chips pick which .exe in its folder is the game KoZo watches.
export default function LauncherNote({ launchFile, candidates = [], exeName, onPickExe, onClear }) {
  if (!launchFile) return null
  return (
    <div className={s.box}>
      <div className={s.head}>
        <IconFileCode size={14} />
        <span>Starts with <strong>{launchFile.split(/[\\/]/).pop()}</strong></span>
        {onClear && (
          <button type="button" className={s.clear} onClick={onClear} title="Launch the .exe directly instead" aria-label="Stop using the launcher file">
            <IconX size={12} />
          </button>
        )}
      </div>
      {candidates.length > 0 && (
        <>
          <div className={s.ask}>Which program is the game? KoZo watches it to track playtime.</div>
          <div className={s.chips}>
            {candidates.map(c => (
              <button key={c.install_path + c.exe_name} type="button"
                className={`${s.chip} ${c.exe_name === exeName ? s.chipOn : ''}`}
                onClick={() => onPickExe(c)}>
                {c.exe_name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
