import React from 'react'
import s from './EmptyState.module.css'

// One empty state for the whole app — five near-identical copies used to live in
// Library, GameList, Sessions, GameDetail and Statistics.
//
// `action` is optional and doubles as the "nothing matched your filters" escape
// hatch: a filtered-empty grid without a way back out reads as a broken page.
export default function EmptyState({ Icon, title, desc, action, size = 'md' }) {
  return (
    <div className={`${s.empty} ${size === 'sm' ? s.emptySm : ''}`}>
      {Icon && (
        <div className={s.emptyIcon}>
          <Icon size={size === 'sm' ? 22 : 26} stroke={1.4} />
        </div>
      )}
      {title && <div className={s.emptyTitle}>{title}</div>}
      {desc && <div className={s.emptyDesc}>{desc}</div>}
      {action && (
        <button type="button" className={s.emptyAction} onClick={action.onClick}>
          {action.Icon && <action.Icon size={14} stroke={1.8} />}
          {action.label}
        </button>
      )}
    </div>
  )
}
