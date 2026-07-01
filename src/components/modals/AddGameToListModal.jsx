import React, { useState, useEffect, useCallback } from 'react'
import {
  IconSearch, IconPlus, IconCheck, IconDeviceGamepad2, IconStar, IconX,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './AddGameModal.module.css'

const STATUS_OPTIONS = [
  { value: 'want_to_play', label: 'Want to play' },
  { value: 'playing',      label: 'Playing' },
  { value: 'finished',     label: 'Finished' },
  { value: 'on_hold',      label: 'On hold' },
  { value: 'dropped',      label: 'Dropped' },
  { value: 'upcoming',     label: 'Upcoming' },
]

const BANNER_BG = ['#1a0f2e','#0f1e3a','#0f2a1e','#2a1a0a','#2a0f0f','#1e1a0a']
function bannerBg(id) { return BANNER_BG[(id || 0) % BANNER_BG.length] }

// header.jpg → hashed capsule → hide (same approach as Add Game).
function artError(e, game) {
  const img = e.target
  if (!img.dataset.fb && game.capsule) { img.dataset.fb = '1'; img.src = game.capsule }
  else img.style.display = 'none'
}

function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

export default function AddGameToListModal({ onClose, onSaved }) {
  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected]   = useState(null)
  const [isManual, setIsManual]   = useState(false)

  const [name, setName]           = useState('')
  const [status, setStatus]       = useState('want_to_play')
  const [rating, setRating]       = useState('')
  const [saving, setSaving]       = useState(false)
  const [errors, setErrors]       = useState({})
  // IDs of game-list rows created during THIS modal session, so Cancel can roll them back.
  const [addedIds, setAddedIds]   = useState([])
  // Set when a dismissal (backdrop / Escape / X) would silently discard adds.
  const [confirmingClose, setConfirmingClose] = useState(false)
  const savedCount = addedIds.length

  // Cancel → discard everything added this session.
  async function handleCancel() {
    if (addedIds.length) {
      for (const id of addedIds) {
        await window.kozo?.api?.gameList?.delete(id)
      }
    }
    onClose()
  }

  // Backdrop / Escape / X — with pending adds, confirm before discarding them.
  function requestClose() {
    if (addedIds.length) setConfirmingClose(true)
    else onClose()
  }

  // Done → keep the added games and refresh the parent list.
  function handleDone() {
    if (addedIds.length) onSaved?.()
    else onClose()
  }

  const doSearch = useCallback(
    debounce(async (q) => {
      if (!q.trim() || q.length < 2) { setResults([]); setSearching(false); return }
      setSearching(true)
      const res = await window.kozo?.api?.steam?.search(q)
      setSearching(false)
      setResults(res?.ok ? res.data : [])
    }, 400),
    []
  )

  useEffect(() => { doSearch(query) }, [query])

  function pickGame(game) {
    setSelected(game)
    setIsManual(false)
    setName(game.name)
  }

  function pickManual() {
    setSelected(null)
    setIsManual(true)
    setName(query.trim())
  }

  function clearSelection() {
    setSelected(null)
    setIsManual(false)
    setName('')
    setErrors({})
  }

  async function handleSave() {
    const newErrors = {}
    if (!name.trim()) newErrors.name = 'Game name is required'
    if (status === 'finished' && rating !== '' && (isNaN(rating) || Number(rating) < 0 || Number(rating) > 10)) {
      newErrors.rating = 'Rating must be 0–10'
    }
    if (Object.keys(newErrors).length) { setErrors(newErrors); return }

    setSaving(true)
    const payload = {
      steam_app_id: selected?.steam_app_id ?? null,
      name: name.trim(),
      // Steam-linked entries pull the CDN cover automatically; manual entries get none.
      // The local-banner-picker has been removed at the user's request.
      banner_url: selected?.steam_app_id
        ? `https://cdn.akamai.steamstatic.com/steam/apps/${selected.steam_app_id}/library_600x900_2x.jpg`
        : null,
      status,
      rating: status === 'finished' && rating !== '' ? Number(rating) : null,
      game_id: null,
    }

    const res = await window.kozo?.api?.gameList?.add(payload)
    setSaving(false)
    if (res?.ok) {
      if (res.data?.id) setAddedIds(ids => [...ids, res.data.id])
      // Reset to search so the user can add another game without closing
      setSelected(null)
      setIsManual(false)
      setQuery('')
      setName('')
      setStatus('want_to_play')
      setRating('')
      setErrors({})
    } else {
      setErrors({ save: res?.error || 'Failed to add game' })
    }
  }

  const showForm = selected || isManual

  return (
    <Modal
      title="Add to Game List"
      icon={<IconPlus size={17} stroke={1.6} />}
      onClose={handleCancel}
      onRequestClose={requestClose}
      width={580}
      footer={
        <>
          <button className={ms.btnCancel} onClick={handleCancel}>
            {savedCount > 0 ? `Cancel (discard ${savedCount})` : 'Cancel'}
          </button>
          {showForm ? (
            <button
              className={ms.btnPrimary}
              onClick={handleSave}
              disabled={!name.trim() || saving}
            >
              <IconPlus size={14} stroke={2} style={{ marginRight: 4 }} />
              {saving ? 'Adding…' : 'Add to List'}
            </button>
          ) : savedCount > 0 ? (
            <button className={ms.btnPrimary} onClick={handleDone}>
              <IconCheck size={14} stroke={2.5} style={{ marginRight: 4 }} />
              Done ({savedCount} added)
            </button>
          ) : null}
        </>
      }
    >
      {/* Search or selected chip */}
      {!showForm ? (
        <div className={s.searchRow}>
          <IconSearch size={15} stroke={1.6} className={s.searchIcon} />
          <input
            className={s.searchInput}
            placeholder="Search Steam or type a game name…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
        </div>
      ) : (
        <div className={s.selectedChip}>
          {selected && (
            <div className={s.selectedThumb} style={{ background: bannerBg(selected.steam_app_id) }}>
              <img src={selected.header_image} alt="" onError={e => artError(e, selected)} />
            </div>
          )}
          <span className={s.selectedChipName}>{name || query}</span>
          {selected && <span className={s.selectedChipMeta}>Steam · {selected.steam_app_id}</span>}
          {isManual && <span className={s.selectedChipMeta}>Manual</span>}
          <button className={s.selectedChipClear} onClick={clearSelection} title="Search again">
            <IconX size={13} stroke={2} />
          </button>
        </div>
      )}

      {searching && <div className={s.searching}>Searching…</div>}

      {!showForm && !searching && query.length >= 2 && (
        <div className={s.resultsList}>
          {results.map(game => (
            <div key={game.steam_app_id} className={s.resultItem} onClick={() => pickGame(game)}>
              <div className={s.resultIcon} style={{ background: bannerBg(game.steam_app_id) }}>
                <img src={game.header_image} alt="" onError={e => artError(e, game)} />
              </div>
              <div className={s.resultInfo}>
                <div className={s.resultName}>{game.name}</div>
                <div className={s.resultMeta}>Steam · #{game.steam_app_id}</div>
              </div>
            </div>
          ))}

          {results.length === 0 && (
            <div className={s.searchHint}>No Steam results found. Add manually below.</div>
          )}

          <div className={s.manualOption} onClick={pickManual}>
            <IconPlus size={14} stroke={2} />
            Add "{query}" manually (not on Steam)
          </div>
        </div>
      )}

      {!showForm && !searching && query.length < 2 && (
        <div className={s.searchHint}>
          Search any game to add it to your list — backlog, wishlist, playing, or finished.
        </div>
      )}

      {/* Form */}
      {showForm && (
        <>
          <hr className={s.divider} />

          <div className={s.field}>
            <label className={`${s.label} ${s.labelRequired}`}>Game name</label>
            <input
              className={`${s.input} ${errors.name ? s.inputError : ''}`}
              value={name}
              onChange={e => { setName(e.target.value); setErrors(p => ({ ...p, name: '' })) }}
              placeholder="e.g. Elden Ring"
            />
            {errors.name && <div className={s.errorText}>{errors.name}</div>}
          </div>

          <div className={s.field}>
            <label className={s.label}>Status</label>
            <div className={s.pills}>
              {STATUS_OPTIONS.map(o => (
                <button
                  key={o.value}
                  className={`${s.pill} ${status === o.value ? s.pillActive : ''}`}
                  onClick={() => setStatus(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {status === 'finished' && (
            <div className={s.field}>
              <label className={s.label}>
                <IconStar size={12} stroke={1.6} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                Rating <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(0–10, optional)</span>
              </label>
              <input
                type="number"
                className={`${s.input} ${errors.rating ? s.inputError : ''}`}
                min={0}
                max={10}
                step={0.1}
                value={rating}
                onChange={e => { setRating(e.target.value); setErrors(p => ({ ...p, rating: '' })) }}
                onBlur={e => {
                  if (e.target.value === '') return
                  const n = parseFloat(e.target.value)
                  if (!isNaN(n)) setRating(String(Math.min(10, Math.max(0, Math.round(n * 10) / 10))))
                }}
                placeholder="e.g. 8.5"
              />
              {errors.rating && <div className={s.errorText}>{errors.rating}</div>}
            </div>
          )}

          {errors.save && <div className={s.errorText} style={{ marginTop: 6 }}>{errors.save}</div>}
        </>
      )}

      {/* Confirm-discard layer: shown when a backdrop/Escape/X dismissal would
          silently delete the games added in this session. */}
      {confirmingClose && (
        <div className={s.confirmOverlay} onMouseDown={e => e.stopPropagation()}>
          <div className={s.confirmBox}>
            <div className={s.confirmTitle}>
              Discard the {savedCount} game{savedCount === 1 ? '' : 's'} you just added?
            </div>
            <div className={s.confirmBtns}>
              <button className={ms.btnPrimary} onClick={() => setConfirmingClose(false)}>
                Keep editing
              </button>
              <button className={ms.btnDanger} onClick={handleCancel}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
