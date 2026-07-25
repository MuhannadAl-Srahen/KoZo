import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
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

  // Portal to <body> — a modal opened from inside a card (e.g. a launch-error
  // toast from GameCard) would otherwise render as a DESCENDANT of that card.
  // Cards use `transform` on hover/active for their press effect, and any
  // ancestor with a transform becomes the containing block for its
  // `position: fixed` descendants — so the overlay stops covering the
  // viewport and instead gets clipped to the card's own box. Because the
  // modal's buttons are then also descendants of `.card`, hovering them
  // re-triggers `.card:hover`'s transform, which reflows the "viewport" the
  // fixed overlay is measured against on every mouse move — the modal visibly
  // jumps/flashes and buttons become unreachable. Escaping to body sidesteps
  // this for every consumer, everywhere in the app.
  return createPortal(
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
    </div>,
    document.body
  )
}

export { s as modalStyles }
