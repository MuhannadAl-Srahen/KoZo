import React, { useEffect, useState } from 'react'
import { IconDownload, IconRefresh, IconX, IconSparkles } from '@tabler/icons-react'
import InfoModal from './ui/InfoModal'
import s from './UpdateBanner.module.css'

// Tells the user about app updates as soon as KoZo opens:
//   • a slim bar while a newer release downloads, then "Restart to update";
//   • a one-time "What's new" card the first launch after an update installed.
// State comes from electron/services/appUpdater.js (app:update / app:updateState).
// Must match `rev` in electron/preload.js.
const PRELOAD_REV = 9

export default function UpdateBanner() {
  // The UI reloaded with new code but the main process is still the old one.
  const stale = window.kozo && window.kozo.rev !== PRELOAD_REV
  const [staleHidden, setStaleHidden] = useState(false)
  const [update, setUpdate]       = useState(null)
  const [dismissed, setDismissed] = useState(false)
  const [whatsNew, setWhatsNew]   = useState(null)

  useEffect(() => {
    const api = window.kozo?.api?.app
    if (!api) return
    let alive = true
    api.updateState?.().then(res => { if (alive && res?.ok) setUpdate(res.data) })
    api.whatsNew?.().then(res => { if (alive && res?.ok && res.data) setWhatsNew(res.data) })
    const off = window.kozo.events.onAppUpdate?.((st) => { setUpdate(st); setDismissed(false) })
    return () => { alive = false; off?.() }
  }, [])

  const visible = !dismissed && (update?.state === 'downloading' || update?.state === 'ready')

  return (
    <>
      {stale && !staleHidden && (
        <div className={s.bar} role="status">
          <IconRefresh size={15} stroke={2} />
          <span className={s.text}>KoZo was updated. Quit it from the tray icon and open it again to finish.</span>
          <button className={s.close} onClick={() => setStaleHidden(true)} aria-label="Hide">
            <IconX size={14} />
          </button>
        </div>
      )}
      {visible && (
        <div className={s.bar} role="status">
          {update.state === 'ready'
            ? <IconRefresh size={15} stroke={2} />
            : <IconDownload size={15} stroke={2} />}
          <span className={s.text}>
            {update.state === 'ready'
              ? <>KoZo {update.version} is ready to install.</>
              : <>Downloading KoZo {update.version}{update.percent ? ` (${update.percent}%)` : '…'}</>}
          </span>
          {update.notes && (
            <button className={s.link} onClick={() => setWhatsNew({ version: update.version, notes: update.notes, upcoming: true })}>
              What's new
            </button>
          )}
          {update.state === 'ready' && (
            <button className={s.primary} onClick={() => window.kozo.api.app.installUpdate()}>
              Restart now
            </button>
          )}
          <button className={s.close} onClick={() => setDismissed(true)} aria-label="Hide">
            <IconX size={14} />
          </button>
        </div>
      )}

      {whatsNew && (
        <InfoModal
          variant="info"
          title={whatsNew.upcoming ? `What's new in KoZo ${whatsNew.version}` : `KoZo updated to ${whatsNew.version}`}
          message={whatsNew.upcoming ? 'This update is downloading in the background.' : 'Here is what changed in this version.'}
          onClose={() => setWhatsNew(null)}
        >
          <div className={s.notes}>
            {(whatsNew.notes || 'Bug fixes and improvements.').trim()}
          </div>
          {whatsNew.url && (
            <button className={s.link} onClick={() => window.kozo.api.shell?.openExternal?.(whatsNew.url)}>
              <IconSparkles size={13} /> Full release notes on GitHub
            </button>
          )}
        </InfoModal>
      )}
    </>
  )
}
