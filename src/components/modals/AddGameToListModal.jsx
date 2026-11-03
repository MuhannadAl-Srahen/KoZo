import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  IconSearch, IconPlus, IconCheck, IconDeviceGamepad2, IconStar, IconX, IconListDetails, IconLoader2, IconAlertTriangle,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import { getBannerBg } from '../../lib/utils'
import { LIST_STATUSES, LIST_STATUS_ORDER } from '../../lib/cardModel'
import { rankResults } from '../../lib/searchRank'
import SearchableSelect from '../ui/SearchableSelect'
import s from './AddGameModal.module.css'
import a from './AddGameToListModal.module.css'

const STATUS_OPTIONS = LIST_STATUS_ORDER.map(value => ({ value, label: LIST_STATUSES[value].label }))

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

// A picked game, from a Steam hit, a SteamGridDB hit or a typed name.
const fromSteam = (g) => ({ key: `s${g.steam_app_id}`, name: g.name, steam_app_id: g.steam_app_id, thumb: g.header_image, capsule: g.capsule, meta: 'Steam' })
const fromSgdb  = (h) => ({ key: `g${h.sgdb_id}`, name: h.name, cover: h.cover || null, thumb: h.thumb, portrait: true, meta: 'Not on Steam' })
const fromName  = (n) => ({ key: `m${n.toLowerCase()}`, name: n, meta: 'Added by name' })

async function searchBoth(q) {
  const [res, sg] = await Promise.all([
    window.kozo?.api?.steam?.search(q),
    window.kozo?.api?.sgdb?.searchGames?.(q).catch(() => null),
  ])
  return { steam: res?.ok ? (res.data || []) : [], sgdb: sg?.ok ? (sg.data || []) : [] }
}

// Add to Game List: pick one game or many (search and tick, or paste a list
// of names), choose one status for all, add them in one go.
export default function AddGameToListModal({ onClose, onSaved }) {
  const [mode, setMode]           = useState('search')   // search | paste
  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState([])
  const [sgdbResults, setSgdbResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [basket, setBasket]       = useState([])          // picked games, in order
  const [status, setStatus]       = useState('want_to_play')
  const [rating, setRating]       = useState('')
  const [saving, setSaving]       = useState(null)        // { done, total } while adding
  const [error, setError]         = useState(null)
  const [confirmingClose, setConfirmingClose] = useState(false)

  // Paste a list
  const [pasted, setPasted]       = useState('')
  const [matching, setMatching]   = useState(null)        // { done, total }
  const [matches, setMatches]     = useState([])          // [{ line, options: [item], pick: index | -1 }]

  const inBasket = (key) => basket.some(b => b.key === key)
  const toggle = (item) => setBasket(bs => bs.some(b => b.key === item.key) ? bs.filter(b => b.key !== item.key) : [...bs, item])

  const searchSeq = useRef(0)
  const doSearch = useCallback(
    debounce(async (q) => {
      const seq = ++searchSeq.current
      if (!q.trim() || q.length < 2) { setResults([]); setSgdbResults([]); setSearching(false); return }
      setSearching(true)
      const r = await searchBoth(q)
      if (seq !== searchSeq.current) return
      setSearching(false)
      setResults(r.steam)
      setSgdbResults(r.sgdb)
    }, 400),
    []
  )
  useEffect(() => { doSearch(query) }, [query])

  async function findPasted() {
    const lines = [...new Set(pasted.split(/\r?\n/).map(l => l.replace(/^[\s\-*•\d.)]+/, '').trim()).filter(l => l.length >= 2))].slice(0, 60)
    if (!lines.length) return
    setMatching({ done: 0, total: lines.length })
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const r = await searchBoth(lines[i])
      const ranked = rankResults(lines[i], r.steam, r.sgdb).slice(0, 4)
        .map(x => (x.kind === 'steam' ? fromSteam(x.game) : fromSgdb(x.hit)))
      out.push({ line: lines[i], options: [...ranked, fromName(lines[i])], pick: 0 })
      setMatching({ done: i + 1, total: lines.length })
      setMatches([...out])
    }
    setMatching(null)
  }
  function addMatches() {
    const picked = matches.filter(m => m.pick >= 0).map(m => m.options[m.pick])
    setBasket(bs => [...bs, ...picked.filter(p => !bs.some(b => b.key === p.key))])
    setMatches([]); setPasted(''); setMode('search')
  }

  async function addAll() {
    if (!basket.length) return
    setError(null)
    const total = basket.length
    const failed = []
    setSaving({ done: 0, total })
    for (let i = 0; i < basket.length; i++) {
      const g = basket[i]
      const payload = {
        steam_app_id: g.steam_app_id ?? null,
        name: g.name.trim(),
        banner_url: g.steam_app_id
          ? `https://cdn.akamai.steamstatic.com/steam/apps/${g.steam_app_id}/library_600x900_2x.jpg`
          : (g.cover || null),
        status,
        rating: total === 1 && status === 'finished' && rating !== '' ? Math.min(10, Math.max(0, Number(rating))) : null,
        game_id: null,
      }
      const res = await window.kozo?.api?.gameList?.add(payload)
      if (!res?.ok) failed.push(g.name)
      setSaving({ done: i + 1, total })
    }
    setSaving(null)
    if (failed.length) {
      setError(`Could not add: ${failed.join(', ')}`)
      setBasket(bs => bs.filter(b => failed.includes(b.name)))
      if (failed.length < total) onSaved?.({ keepOpen: true })
      return
    }
    onSaved?.()
  }

  function requestClose() {
    if (basket.length && !saving) setConfirmingClose(true)
    else onClose()
  }

  const row = (item, key = item.key) => {
    const on = inBasket(item.key)
    return (
      <button type="button" key={key} className={`${s.resultItem} ${a.pickRow} ${on ? a.pickRowOn : ''}`} onClick={() => toggle(item)} aria-pressed={on}>
        <div className={`${s.resultIcon} ${item.portrait ? s.resultIconPortrait : ''}`} style={{ background: getBannerBg(item.steam_app_id || item.key) }}>
          {item.thumb
            ? <img src={item.thumb} alt="" onError={e => artError(e, item)} />
            : <IconDeviceGamepad2 size={18} stroke={1.3} style={{ color: 'rgba(255,255,255,0.15)' }} />}
        </div>
        <div className={s.resultInfo}>
          <div className={s.resultName}>{item.name}</div>
          <div className={s.resultMeta}>{item.meta}{item.steam_app_id ? ` · #${item.steam_app_id}` : ''}</div>
        </div>
        <span className={a.tick}>{on ? <IconCheck size={14} stroke={3} /> : <IconPlus size={14} stroke={2.4} />}</span>
      </button>
    )
  }

  return (
    <Modal
      title="Add to Game List"
      icon={<IconPlus size={17} stroke={1.6} />}
      onClose={onClose}
      onRequestClose={requestClose}
      width={620}
      footer={
        <>
          <button className={ms.btnCancel} onClick={onClose} disabled={!!saving}>Cancel</button>
          <button className={ms.btnPrimary} onClick={addAll} disabled={!basket.length || !!saving}>
            {saving
              ? <><IconLoader2 size={14} className="spin" /> Adding {saving.done} of {saving.total}…</>
              : <><IconPlus size={14} stroke={2} /> {basket.length > 1 ? `Add ${basket.length} games` : 'Add to list'}</>}
          </button>
        </>
      }
    >
      <div className={a.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'search'} className={mode === 'search' ? a.tabOn : ''} onClick={() => setMode('search')}>
          <IconSearch size={14} /> Search
        </button>
        <button type="button" role="tab" aria-selected={mode === 'paste'} className={mode === 'paste' ? a.tabOn : ''} onClick={() => setMode('paste')}>
          <IconListDetails size={14} /> Paste a list
        </button>
      </div>

      {mode === 'search' ? (
        <>
          <div className={`${s.searchRow} hasRing`}>
            <IconSearch size={15} stroke={1.6} className={s.searchIcon} />
            <input className={s.searchInput} placeholder="Search Steam or type a game name…" value={query}
              onChange={e => setQuery(e.target.value)} autoFocus />
          </div>
          {searching && <div className={s.searching}>Searching…</div>}
          {!searching && query.length >= 2 && (
            <div className={`${s.resultsList} ${a.results}`}>
              {rankResults(query, results, sgdbResults).map(r => row(r.kind === 'steam' ? fromSteam(r.game) : fromSgdb(r.hit)))}
              {results.length === 0 && sgdbResults.length === 0 && <div className={s.searchHint}>No results. Add it by name below.</div>}
              {row(fromName(query.trim()), 'manual')}
            </div>
          )}
          {!searching && query.length < 2 && !basket.length && (
            <div className={s.searchHint}>Search a game and tick it. Tick as many as you like, then add them all at once.</div>
          )}
        </>
      ) : (
        <div className={a.paste}>
          {!matches.length ? (
            <>
              <textarea className={a.textarea} value={pasted} onChange={e => setPasted(e.target.value)} autoFocus
                placeholder={'One game per line, for example:\nHollow Knight\nElden Ring\nHades II'} spellCheck={false} />
              <button type="button" className={ms.btnPrimary} onClick={findPasted} disabled={!pasted.trim() || !!matching}>
                {matching ? <><IconLoader2 size={14} className="spin" /> Finding {matching.done} of {matching.total}…</> : <><IconSearch size={14} /> Find these games</>}
              </button>
            </>
          ) : (
            <>
              <div className={a.matchHead}>
                <span>{matching ? `Finding ${matching.done} of ${matching.total}…` : `Check the matches, then add them to your picks.`}</span>
              </div>
              <div className={a.matchList}>
                {matches.map((m, i) => {
                  const cur = m.pick >= 0 ? m.options[m.pick] : null
                  return (
                    <div key={m.line} className={`${a.match} ${m.pick < 0 ? a.matchOff : ''}`}>
                      <div className={a.matchArt} style={{ background: getBannerBg(cur?.steam_app_id || m.line) }}>
                        {cur?.thumb && <img src={cur.thumb} alt="" onError={e => artError(e, cur)} />}
                      </div>
                      <div className={a.matchText}>
                        <small>{m.line}</small>
                        <SearchableSelect value={String(m.pick)} searchable={false} clearable={false} width={360}
                          onChange={v => setMatches(ms2 => ms2.map((x, j) => j === i ? { ...x, pick: Number(v) } : x))}
                          options={[...m.options.map((o, k) => ({ value: String(k), label: `${o.name} (${o.meta})` })), { value: '-1', label: 'Skip this one' }]} />
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className={a.matchBtns}>
                <button type="button" className={ms.btnCancel} onClick={() => setMatches([])} disabled={!!matching}>Back</button>
                <button type="button" className={ms.btnPrimary} onClick={addMatches} disabled={!!matching || !matches.some(m => m.pick >= 0)}>
                  <IconCheck size={14} /> Use {matches.filter(m => m.pick >= 0).length} matches
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Picked games, and one status for all of them */}
      {basket.length > 0 && (
        <div className={a.basket}>
          <div className={a.basketHead}>
            <strong>{basket.length} picked</strong>
            <button type="button" className={a.clearBtn} onClick={() => setBasket([])}>Clear</button>
          </div>
          <div className={a.chips}>
            {basket.map(b => (
              <span key={b.key} className={a.chip}>
                {b.name}
                <button type="button" onClick={() => toggle(b)} aria-label={`Remove ${b.name}`}><IconX size={12} stroke={2.4} /></button>
              </span>
            ))}
          </div>
          <div className={s.field}>
            <label className={s.label}>Status {basket.length > 1 ? 'for all of them' : ''}</label>
            <div className={s.pills}>
              {STATUS_OPTIONS.map(o => (
                <button key={o.value} className={`${s.pill} ${status === o.value ? s.pillActive : ''}`} onClick={() => setStatus(o.value)}>{o.label}</button>
              ))}
            </div>
          </div>
          {status === 'finished' && basket.length === 1 && (
            <div className={s.field}>
              <label className={s.label}>
                <IconStar size={12} stroke={1.6} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                Rating <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(0 to 10, optional)</span>
              </label>
              <input type="number" className={s.input} min={0} max={10} step={0.1} value={rating}
                onChange={e => setRating(e.target.value)} placeholder="e.g. 8.5" />
            </div>
          )}
        </div>
      )}

      {error && <div className={s.errorText} style={{ marginTop: 8 }}><IconAlertTriangle size={13} style={{ verticalAlign: 'middle' }} /> {error}</div>}

      {confirmingClose && (
        <div className={s.confirmOverlay} onMouseDown={e => e.stopPropagation()}>
          <div className={s.confirmBox}>
            <div className={s.confirmTitle}>Close without adding the {basket.length} game{basket.length === 1 ? '' : 's'} you picked?</div>
            <div className={s.confirmBtns}>
              <button className={ms.btnPrimary} onClick={() => setConfirmingClose(false)}>Keep picking</button>
              <button className={ms.btnDanger} onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
