import React from 'react'
import s from './Skeleton.module.css'

// Loading placeholders shaped like what's coming, so the page never reads as empty and nothing
// jumps when the data lands. Pages draw their own skeletons with their real layout classes
// (Upcoming's day boxes, Play Plan's months, the game page's header) out of these blocks; the
// shared ones below cover the common shapes. A wrapper says it's loading (aria-busy), which
// scripts/site-shots.js also waits on.

// Widths that vary from one line to the next, the same every time.
const NAME_W = ['72%', '58%', '80%', '64%', '50%', '68%']
const SUB_W = ['44%', '36%', '52%', '30%', '40%']
export const widthAt = (list, i) => list[i % list.length]

export function Skeleton({ w, h = 14, r, className = '', style, children }) {
  return (
    <div
      className={`${s.sk} ${className}`}
      style={{ width: w, height: h, borderRadius: r, ...style }}
      aria-hidden="true"
    >{children}</div>
  )
}

// Ghost cards for the Library, Game List, Finished and Games like this. Takes the SAME grid class
// the real grid uses, so the ghost and the loaded layout line up. A cover card has its name on the
// art and a stats strip under it, like GameCard; `portrait={false}` is a wide store card with its
// lines under the art; `list` is the list view's rows.
export function CardSkeletonGrid({ gridClassName, count = 12, portrait = true, list = false, foot = true, style }) {
  if (list) {
    return (
      <div className={gridClassName} style={style} aria-busy="true" aria-label="Loading">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className={s.row} style={{ height: 94 }}>
            <Skeleton className={s.rowThumb} h={null} />
            <div className={s.rowBody}>
              <Skeleton w={widthAt(['46%', '34%', '52%', '40%'], i)} h={14} />
              <Skeleton w={widthAt(['24%', '18%', '28%'], i)} h={11} />
            </div>
            <div className={s.rowEnd}>
              <Skeleton w={44} h={12} />
              <Skeleton w={56} h={12} />
            </div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className={gridClassName} style={style} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={s.card}>
          {portrait ? (
            <div className={`${s.sk} ${s.cardArt}`}>
              <Skeleton w={widthAt(NAME_W, i)} h={14} />
              <Skeleton w={widthAt(SUB_W, i)} h={10} />
            </div>
          ) : <div className={`${s.sk} ${s.cardArtWide}`} />}
          {portrait ? (foot && (
            <div className={s.cardFoot}>
              <Skeleton w={34} h={10} />
              <Skeleton w={42} h={10} />
              <Skeleton w={30} h={10} />
            </div>
          )) : (
            <div className={s.cardBody}>
              <Skeleton w={widthAt(NAME_W, i)} h={14} />
              <Skeleton w={widthAt(SUB_W, i)} h={11} />
              <div className={s.chips}><Skeleton w={54} h={18} r={9} /><Skeleton w={70} h={18} r={9} /></div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// Rows with a cover, a name and a line, and a value at the end (lists of games).
export function RowSkeleton({ count = 6, height = 84 }) {
  return (
    <div className={s.rows} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={s.row} style={{ height }}>
          <Skeleton className={s.rowThumb} h={null} />
          <div className={s.rowBody}>
            <Skeleton w={widthAt(['38%', '30%', '44%', '34%'], i)} h={13} />
            <Skeleton w={widthAt(['22%', '16%', '26%'], i)} h={11} />
          </div>
          <Skeleton w={64} h={12} />
        </div>
      ))}
    </div>
  )
}

// Lines with a value at the end (a ranked list inside a panel).
export function PanelSkeleton({ lines = 5 }) {
  return (
    <div className={s.panel} aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={s.panelLine}>
          <Skeleton w={widthAt(['62%', '48%', '56%', '40%', '52%', '34%'], i)} h={12} />
          <Skeleton w={44} h={12} />
        </div>
      ))}
    </div>
  )
}

// A bar chart's shape: bars of different heights on a base line.
const BAR_H = [38, 62, 45, 80, 55, 30, 70, 92, 48, 66, 40, 58, 84, 36, 60, 74, 42, 52, 88, 34, 64, 46, 72, 56]
export function ChartSkeleton({ bars = 24, height = 140, gap }) {
  return (
    <div className={s.chart} style={{ height, gap }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: bars }, (_, i) => (
        <Skeleton key={i} className={s.chartBar} h={`${widthAt(BAR_H, i)}%`} />
      ))}
    </div>
  )
}
