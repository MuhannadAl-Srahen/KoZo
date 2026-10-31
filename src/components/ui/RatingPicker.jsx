import React, { useRef, useState } from 'react'
import { IconStarFilled } from '@tabler/icons-react'
import s from './RatingPicker.module.css'

// The 1 to 10 score picker (RateGameModal, FinishedGameModal). Hover is worked
// out from the pointer's x over the whole bar, not per button, so the gaps
// between segments never flip it back and forth; every line has a fixed
// height, so nothing moves while you hover (a centred dialog that changed
// height would slide the bar out from under the mouse and flicker).

export const RATING_WORDS = ['', 'Awful', 'Bad', 'Poor', 'Meh', 'Okay', 'Decent', 'Good', 'Great', 'Amazing', 'Masterpiece']

// Red (1) through amber to green (10).
export function ratingColor(n) {
  return `hsl(${Math.round(((n - 1) / 9) * 130)} 75% 52%)`
}

export default function RatingPicker({ value, onChange }) {
  const [hover, setHover] = useState(null)
  const bar = useRef(null)
  const shown = hover ?? value

  function pointAt(clientX) {
    const r = bar.current.getBoundingClientRect()
    return Math.min(10, Math.max(1, Math.ceil(((clientX - r.left) / r.width) * 10)))
  }

  return (
    <div className={s.wrap}>
      <div className={s.readout} style={shown ? { '--rc': ratingColor(shown) } : undefined}>
        <IconStarFilled size={22} className={s.star} />
        <span className={s.big}>{shown || '?'}</span>
        <span className={s.of}>/10</span>
        <span className={s.word}>{shown ? RATING_WORDS[shown] : 'Pick a score'}</span>
      </div>
      <div
        ref={bar}
        className={s.bar}
        role="radiogroup"
        aria-label="Rating from 1 to 10"
        onMouseMove={(e) => { const n = pointAt(e.clientX); if (n !== hover) setHover(n) }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onChange(pointAt(e.clientX))}
      >
        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n}, ${RATING_WORDS[n]}`}
            className={`${s.seg} ${shown && n <= shown ? s.segOn : ''} ${value === n && hover == null ? s.segPicked : ''}`}
            style={shown && n <= shown ? { '--sc': ratingColor(shown) } : undefined}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(n) } }}
          >
            {n}
          </button>
        ))}
      </div>
      <div className={s.scaleEnds}><span>Awful</span><span>Masterpiece</span></div>
    </div>
  )
}
