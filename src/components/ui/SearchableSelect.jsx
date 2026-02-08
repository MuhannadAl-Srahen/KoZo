import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronDown, IconSearch, IconX } from '@tabler/icons-react'
import s from './SearchableSelect.module.css'

export default function SearchableSelect({
  value, onChange, options, placeholder = 'All', width = 180, searchable = true,
}) {
  const [open, setOpen]       = useState(false)
  const [query, setQuery]     = useState('')
  const [pos, setPos]         = useState(null)
  const wrapRef               = useRef(null)
  const triggerRef            = useRef(null)
  const dropdownRef           = useRef(null)
  const inp                   = useRef(null)

  const selected = options.find(o => String(o.value) === String(value))
  const filtered = (searchable && query.trim())
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options

  useEffect(() => {
    if (open && searchable) setTimeout(() => inp.current?.focus(), 10)
  }, [open, searchable])

  // Close on outside click — checks both trigger wrapper AND portal dropdown
  useEffect(() => {
    function onDown(e) {
      const inWrap = wrapRef.current?.contains(e.target)
      const inDrop = dropdownRef.current?.contains(e.target)
      if (!inWrap && !inDrop) { setOpen(false); setQuery('') }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  function handleTrigger() {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect()
      // Open upward if there's more space above than below
      const below = window.innerHeight - r.bottom
      const above = r.top
      const openUp = below < 220 && above > below
      setPos({
        left: r.left,
        width: r.width,
        top: openUp ? undefined : r.bottom + 4,
        bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
      })
    }
    setOpen(v => !v)
    if (open) setQuery('')
  }

  function select(val) {
    onChange(val)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={wrapRef} style={{ width, position: 'relative', flexShrink: 0 }}>
      <button
        ref={triggerRef}
        className={`${s.trigger} ${open ? s.triggerOpen : ''}`}
        onClick={handleTrigger}
        type="button"
      >
        <span className={s.triggerLabel}>
          {selected ? selected.label : <span className={s.triggerPlaceholder}>{placeholder}</span>}
        </span>
        {value && value !== '' ? (
          <span
            className={s.clear}
            onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
            onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(''); onChange('') }}
            title="Clear"
          >
            <IconX size={11} stroke={2} />
          </span>
        ) : (
          <IconChevronDown size={12} stroke={1.8} className={`${s.chevron} ${open ? s.chevronOpen : ''}`} />
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={dropdownRef}
          className={s.dropdown}
          style={{
            position: 'fixed',
            left: pos.left,
            width: pos.width,
            top: pos.top,
            bottom: pos.bottom,
            zIndex: 99999,
          }}
        >
          {searchable && (
            <div className={s.searchRow}>
              <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
              <input
                ref={inp}
                className={s.searchInput}
                placeholder="Search…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
          )}
          <div className={s.list}>
            <div className={`${s.option} ${!value || value === '' ? s.optionActive : ''}`} onClick={() => select('')}>
              {placeholder}
            </div>
            {filtered.length === 0 && <div className={s.noResults}>No results</div>}
            {filtered.map(o => (
              <div
                key={o.value}
                className={`${s.option} ${String(o.value) === String(value) ? s.optionActive : ''}`}
                onClick={() => select(o.value)}
              >
                {o.label}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
