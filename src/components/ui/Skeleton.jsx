import React from 'react'
import s from './Skeleton.module.css'

// Loading placeholders that match the real layout, so content swapping in causes
// no reflow. The app previously showed bare spinners, which give no sense of
// what is coming and shift everything when the data lands.

export function Skeleton({ w, h = 14, r, className = '', style }) {
  return (
    <div
      className={`${s.sk} ${className}`}
      style={{ width: w, height: h, borderRadius: r, ...style }}
    />
  )
}

// Ghost grid for the library / game list. Takes the SAME grid class the real
// grid uses, so the ghost and the loaded layout are pixel-identical.
export function CardSkeletonGrid({ gridClassName, count = 12, portrait = true }) {
  return (
    <div className={gridClassName}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={s.card}>
          <div className={`${s.sk} ${portrait ? s.cardArt : s.cardArtWide}`} />
          <div className={s.cardBody}>
            <Skeleton w="72%" h={13} />
            <Skeleton w="45%" h={11} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function RowSkeleton({ count = 6, height = 84 }) {
  return (
    <div className={s.rows}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={s.row} style={{ height }}>
          <div className={`${s.sk} ${s.rowThumb}`} />
          <div className={s.rowBody}>
            <Skeleton w="38%" h={13} />
            <Skeleton w="22%" h={11} />
          </div>
          <Skeleton w={64} h={12} />
        </div>
      ))}
    </div>
  )
}

export function PanelSkeleton({ lines = 5 }) {
  return (
    <div className={s.panel}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={s.panelLine}>
          <Skeleton w={`${68 - i * 7}%`} h={12} />
          <Skeleton w={44} h={12} />
        </div>
      ))}
    </div>
  )
}

export function HeroSkeleton({ height = 240 }) {
  return (
    <div className={s.hero} style={{ height }}>
      <div className={s.heroBottom}>
        <Skeleton w={260} h={22} />
        <Skeleton w={180} h={12} />
      </div>
    </div>
  )
}
