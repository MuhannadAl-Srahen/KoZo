import React, { useEffect } from 'react'
import { IconX } from '@tabler/icons-react'
import s from './Modal.module.css'

// `onRequestClose` (optional) intercepts dismissals — backdrop click, Escape,
// and the X button — so a consumer can show an "unsaved changes" confirmation
// instead of closing outright. Defaults to onClose, so existing modals are
// unaffected. Explicit footer buttons keep calling onClose directly.
export default function Modal({ title, icon, onClose, onRequestClose, children, footer, width = 480 }) {
  const requestClose = onRequestClose || onClose
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') requestClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [requestClose])

  return (
    <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose() }}>
      <div className={s.modal} style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <div className={s.headerLeft}>
            {icon && <span className={s.headerIcon}>{icon}</span>}
            <h2 className={s.title}>{title}</h2>
          </div>
          <button className={s.closeBtn} onClick={requestClose}><IconX size={15} /></button>
        </div>

        <div className={s.body}>{children}</div>

        {footer && <div className={s.footer}>{footer}</div>}
      </div>
    </div>
  )
}

export { s as modalStyles }
