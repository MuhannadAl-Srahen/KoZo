import React, { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from '@tabler/icons-react'
import s from './Modal.module.css'

// Stacked modals (e.g. ImageCropModal on top of AddGameModal) each register a
// document-level Escape listener — without a stack, one press would fire ALL
// of them and close the parent form too, discarding its state. Only the
// top-most (last-mounted) modal may react to Escape.
const modalStack = []

// `onRequestClose` (optional) intercepts dismissals — backdrop click, Escape,
// and the X button — so a consumer can show an "unsaved changes" confirmation
// instead of closing outright. Defaults to onClose, so existing modals are
// unaffected. Explicit footer buttons keep calling onClose directly.
export default function Modal({ title, icon, onClose, onRequestClose, children, footer, width = 480 }) {
  const requestClose = onRequestClose || onClose
  const titleId = useId()
  // Latest-close via ref so the stack effect registers exactly once per mount —
  // re-registering on every inline-onClose identity change would pop/re-push
  // the entry and could reorder a parent above its child.
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose
  useEffect(() => {
    const entry = {}
    modalStack.push(entry)
    const onKey = (e) => {
      if (e.key === 'Escape' && modalStack[modalStack.length - 1] === entry) requestCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      const i = modalStack.indexOf(entry)
      if (i !== -1) modalStack.splice(i, 1)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

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
      <div
        className={s.modal}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={s.header}>
          <div className={s.headerLeft}>
            {icon && <span className={s.headerIcon}>{icon}</span>}
            {/* Titles interpolate game names ("Edit \"Lies of P\"") and truncate,
                so they carry their own tooltip. */}
            <h2 className={s.title} id={titleId} title={typeof title === 'string' ? title : undefined}>{title}</h2>
          </div>
          <button type="button" className={s.closeBtn} onClick={requestClose} aria-label="Close dialog">
            <IconX size={15} stroke={1.8} />
          </button>
        </div>

        <div className={s.body}>{children}</div>

        {footer && <div className={s.footer}>{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export { s as modalStyles }
