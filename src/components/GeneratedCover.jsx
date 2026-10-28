import React from 'react'
import { IconDeviceGamepad2 } from '@tabler/icons-react'
import s from './GeneratedCover.module.css'

// Shown only when a game has no cover image at all (or it failed to load): a
// soft gradient tinted from the game's name with a faint launcher icon, so the
// tile still looks intentional. Never drawn underneath real art.

function hueOf(name) {
  let h = 0
  for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return h % 360
}

export default function GeneratedCover({ name, Icon, compact = false }) {
  const Glyph = Icon || IconDeviceGamepad2
  return (
    <div className={`${s.cover} ${compact ? s.compact : ''}`} style={{ '--h': hueOf(name) }} aria-hidden="true">
      <span className={s.glow} />
      <Glyph className={s.icon} stroke={1.3} />
      <span className={s.lines} />
    </div>
  )
}
