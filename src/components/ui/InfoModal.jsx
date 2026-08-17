import React from 'react'
import {
  IconCheck, IconAlertTriangle, IconInfoCircle, IconAlertCircle, IconExternalLink,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './Modal'
import s from './InfoModal.module.css'

/**
 * Drop-in replacement for `alert()` that matches the app's design system.
 *
 * Props:
 *   variant: 'success' | 'error' | 'info' | 'warning'   (default 'info')
 *   title:   string                                     (modal header)
 *   message: string                                     (one-line lead)
 *   lines:   string[]                                   (bullet detail)
 *   actions: Array<{ label, onClick, variant?: 'primary'|'secondary'|'danger' }>
 *   onClose: () => void
 */
export default function InfoModal({
  variant = 'info',
  title,
  message,
  lines = [],
  actions,
  onClose,
  children,
}) {
  const iconBy = {
    success: <IconCheck size={16} stroke={2.2} />,
    error:   <IconAlertCircle size={16} stroke={1.8} />,
    warning: <IconAlertTriangle size={16} stroke={1.8} />,
    info:    <IconInfoCircle size={16} stroke={1.8} />,
  }
  const klassBy = {
    success: s.success,
    error:   s.error,
    warning: s.warning,
    info:    s.info,
  }

  const buttons = actions && actions.length > 0
    ? actions
    : [{ label: 'OK', onClick: onClose, variant: 'primary' }]

  return (
    <Modal
      title={title}
      icon={<span className={`${s.headerBadge} ${klassBy[variant]}`}>{iconBy[variant]}</span>}
      onClose={onClose}
      width={460}
      footer={
        <>
          {buttons.map((b, i) => {
            const cls =
              b.variant === 'danger'    ? ms.btnDanger :
              b.variant === 'secondary' ? ms.btnCancel :
                                          ms.btnPrimary
            return (
              <button key={i} type="button" className={cls} onClick={b.onClick}>
                {b.icon} {b.label}
              </button>
            )
          })}
        </>
      }
    >
      <div className={s.body}>
        {message && <p className={s.message}>{message}</p>}
        {lines.length > 0 && (
          <ul className={s.list}>
            {lines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        )}
        {children}
      </div>
    </Modal>
  )
}

// Helper: show a Steam-privacy guidance block (with a link button) inside an
// InfoModal — used by the Diagnose / Sync flows.
export function PrivacyHelp({ openSteamPrivacy }) {
  return (
    <div className={s.helpBox}>
      <div className={s.helpTitle}>
        <IconAlertTriangle size={13} stroke={2} />
        Steam privacy is blocking achievement access
      </div>
      <p className={s.helpText}>
        Steam's API refuses to share achievement data when your profile is private.
        Fix it in 3 steps:
      </p>
      <ol className={s.helpSteps}>
        <li>Open Steam → click your name (top-right) → <strong>Profile</strong></li>
        <li>Click <strong>Edit Profile</strong> → <strong>Privacy Settings</strong></li>
        <li>Set <strong>Game details</strong> to <strong>Public</strong> and save</li>
      </ol>
      <p className={s.helpTextSpaced}>
        After changing, wait ~1 minute then click <strong>Refresh achievements</strong> again.
      </p>
      {openSteamPrivacy && (
        <button type="button" className={s.helpBtn} onClick={openSteamPrivacy}>
          <IconExternalLink size={13} stroke={1.7} />
          Open Steam privacy settings
        </button>
      )}
    </div>
  )
}
