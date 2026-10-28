import React, { useState } from 'react'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { monthKey } from '../../lib/utils'
import s from './MonthPicker.module.css'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// In-app month picker (the native <input type="month"> popup ignores the theme).
// `value` / onChange use 'YYYY-MM' keys; null means no month.
export default function MonthPicker({ value, onChange }) {
  const now = new Date()
  const thisKey = monthKey(now)
  const nextKey = monthKey(new Date(now.getFullYear(), now.getMonth() + 1, 1))
  const [year, setYear] = useState(() => Number((value || thisKey).slice(0, 4)))

  function pick(key) {
    setYear(Number(key.slice(0, 4)))
    onChange(key)
  }

  return (
    <div className={s.picker}>
      <div className={s.quick}>
        <button type="button" className={`${s.quickBtn} ${value === thisKey ? s.quickActive : ''}`} onClick={() => pick(thisKey)}>This month</button>
        <button type="button" className={`${s.quickBtn} ${value === nextKey ? s.quickActive : ''}`} onClick={() => pick(nextKey)}>Next month</button>
      </div>
      <div className={s.head}>
        <button type="button" className={s.arrow} onClick={() => setYear(y => y - 1)} aria-label="Previous year"><IconChevronLeft size={15} /></button>
        <span className={s.year}>{year}</span>
        <button type="button" className={s.arrow} onClick={() => setYear(y => y + 1)} aria-label="Next year"><IconChevronRight size={15} /></button>
      </div>
      <div className={s.grid}>
        {MONTHS.map((label, i) => {
          const key = `${year}-${String(i + 1).padStart(2, '0')}`
          return (
            <button
              type="button"
              key={key}
              className={`${s.month} ${key === value ? s.monthActive : ''} ${key === thisKey ? s.monthNow : ''} ${key < thisKey ? s.monthPast : ''}`}
              onClick={() => pick(key)}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
