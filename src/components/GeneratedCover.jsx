import React from 'react'
import s from './GeneratedCover.module.css'

// The base layer of every cover: a styled poster made from the game's name, so
// a game with no art (or art that fails to load) still gets a real-looking
// cover instead of an empty tile. The real image, when there is one, sits on top.

function hueOf(name) {
  let h = 0
  for (const ch of String(name || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return h % 360
}

function initials(name) {
  const words = String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export default function GeneratedCover({ name, Icon, compact = false }) {
  const hue = hueOf(name)
  return (
    <div className={`${s.cover} ${compact ? s.compact : ''}`} style={{ '--h': hue }} aria-hidden="true">
      <span className={s.glow} />
      {Icon && <Icon className={s.icon} size={compact ? 14 : 18} stroke={1.6} />}
      <span className={s.mono}>{initials(name)}</span>
      <span className={s.lines} />
    </div>
  )
}
