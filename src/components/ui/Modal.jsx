import React, { useEffect } from 'react'
import { IconX } from '@tabler/icons-react'
import s from './Modal.module.css'

export default function Modal({ title, icon, onClose, children, footer, width = 480 }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={s.modal} style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className={s.header}>
          <div className={s.headerLeft}>
            {icon && <span className={s.headerIcon}>{icon}</span>}
            <h2 className={s.title}>{title}</h2>
          </div>
          <button className={s.closeBtn} onClick={onClose}><IconX size={15} /></button>
        </div>

        <div className={s.body}>{children}</div>

        {footer && <div className={s.footer}>{footer}</div>}
      </div>
    </div>
  )
}

export { s as modalStyles }
