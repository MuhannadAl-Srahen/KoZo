import React from 'react'
import { IconLayoutGrid } from '@tabler/icons-react'
import { useCardSize } from '../../lib/useCardZoom'
import s from './CardSizeSlider.module.css'

// The visible way to resize a page's cards: Ctrl + mouse wheel works too, but nothing
// on screen said so. Same arguments as the page's useCardZoom, and they stay in step.
// Nothing shows in a view without a card grid.
export default function CardSizeSlider({ pageKey, view, defaults, opts }) {
  const { base, min, max, step, size, setSize } = useCardSize(pageKey, view, defaults, opts)
  if (!base) return null
  return (
    <label className={s.wrap} title="Card size (Ctrl + mouse wheel works too)" data-zoom-ignore="">
      <IconLayoutGrid size={14} stroke={1.7} aria-hidden="true" />
      <input type="range" className={s.range} min={min} max={max} step={step} value={size ?? base}
        onChange={(e) => setSize(Number(e.target.value))} aria-label="Card size" data-card-size="" />
    </label>
  )
}
