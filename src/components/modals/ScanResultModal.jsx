import React, { useState } from 'react'
import {
  IconSearch, IconPlus, IconCheck, IconDeviceGamepad2, IconX,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './ScanResultModal.module.css'

const BANNER_BG = ['#1a0f2e','#0f1e3a','#0f2a1e','#2a1a0a','#2a0f0f','#1e1a0a','#1a2a0a','#0a1a2a']
function bannerBg(str) {
  let h = 0
  for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return BANNER_BG[h % BANNER_BG.length]
}

// Stable unique key — Steam games without an install path (not on disk) would
// otherwise all collide on `null`, so fall back to the appid.
function keyOf(r) {
  return r.install_path || (r.steam_app_id ? `steam:${r.steam_app_id}` : `name:${r.name}`)
}

const TYPE_STYLE = {
  Steam:   { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.3)' },
  Cracked: { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.3)' },
  Epic:    { color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', border: 'rgba(167,139,250,0.3)' },
  GOG:     { color: '#4ade80', bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.3)' },
  Ubisoft: { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.3)' },
  EA:      { color: '#f97316', bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.3)' },
  Xbox:    { color: '#4ade80', bg: 'rgba(74,222,128,0.12)', border: 'rgba(74,222,128,0.3)' },
}

export default function ScanResultModal({ results, onClose, onAdd, title }) {
  const [selected, setSelected]       = useState(() => new Set())
  const [nameEdits, setNameEdits]     = useState({})
  const [typeOverrides, setTypeOverrides] = useState({})
  const [search, setSearch]           = useState('')
  const [typeFilter, setTypeFilter]   = useState('all')
  const [adding, setAdding]           = useState(false)
  const [addMsg, setAddMsg]           = useState('')
  // Lazily resolved hashed art URLs for games where both CDN paths 404
  const [resolvedUrls, setResolvedUrls] = useState({})

  function resolveStoreArt(appId) {
    if (!appId || resolvedUrls[appId] !== undefined) return
    setResolvedUrls(p => ({ ...p, [appId]: null })) // mark as in-flight
    window.kozo?.api?.steam?.getStoreArt?.(appId).then(res => {
      const url = res?.ok && (res.data?.header_image || res.data?.capsule_image)
      setResolvedUrls(p => ({ ...p, [appId]: url || '' }))
    }).catch(() => setResolvedUrls(p => ({ ...p, [appId]: '' })))
  }

  const newCount = results.filter(r => !r.alreadyInLibrary).length

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function selectAllNew() {
    setSelected(new Set(results.filter(r => !r.alreadyInLibrary).map(keyOf)))
  }

  async function handleAdd() {
    const toAdd = results
      .filter(r => selected.has(keyOf(r)))
      .map(r => {
        const k = keyOf(r)
        return {
          ...r,
          name: nameEdits[k] ?? r.name,
          detected_type: typeOverrides[k] ?? r.detected_type,
          is_cracked: typeOverrides[k] !== undefined
            ? (typeOverrides[k] === 'Cracked' ? 1 : 0)
            : r.is_cracked,
        }
      })
    if (!toAdd.length) return
    setAdding(true)
    setAddMsg('')
    const res = await window.kozo?.api?.scanner?.addGames?.(toAdd)
    setAdding(false)
    if (res?.ok) {
      setAddMsg(`Added ${res.data?.added} game${res.data?.added === 1 ? '' : 's'}!`)
      onAdd?.(res.data?.added || 0)
      setSelected(new Set())
    } else {
      setAddMsg('❌ ' + (res?.error || 'Failed'))
    }
  }

  const types = ['all', ...new Set(results.map(r => typeOverrides[keyOf(r)] ?? r.detected_type))]

  const filtered = results.filter(r => {
    const k = keyOf(r)
    const t = typeOverrides[k] ?? r.detected_type
    if (typeFilter !== 'all' && t !== typeFilter) return false
    const name = nameEdits[k] ?? r.name
    if (search && !name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <Modal
      title={`${title || 'Scan Results'} — ${results.length} games, ${newCount} new`}
      icon={<IconDeviceGamepad2 size={17} stroke={1.6} />}
      onClose={onClose}
      width={780}
      footer={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
          {addMsg && (
            <span style={{
              fontSize: 12,
              color: addMsg.startsWith('❌') ? '#f87171' : '#4ade80',
              flex: 1,
            }}>{addMsg}</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className={ms.btnCancel} onClick={onClose}>Close</button>
            <button
              className={ms.btnPrimary}
              onClick={handleAdd}
              disabled={selected.size === 0 || adding}
            >
              {adding
                ? <><span style={{ animation: 'spin 0.7s linear infinite', display: 'inline-block', marginRight: 6 }}>↻</span>Adding…</>
                : <><IconPlus size={14} stroke={2} style={{ marginRight: 4 }} />Add {selected.size} game{selected.size === 1 ? '' : 's'} to Library</>
              }
            </button>
          </div>
        </div>
      }
    >
      {/* Toolbar */}
      <div className={s.toolbar}>
        <div className={s.searchBox}>
          <IconSearch size={13} stroke={1.6} className={s.searchIcon} />
          <input className={s.searchInput} placeholder="Filter games…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button className={s.searchClear} onClick={() => setSearch('')}>
              <IconX size={11} stroke={2} />
            </button>
          )}
        </div>

        <div className={s.typePills}>
          {types.map(t => (
            <button key={t}
              className={`${s.typePill} ${typeFilter === t ? s.typePillActive : ''}`}
              onClick={() => setTypeFilter(t)}>
              {t === 'all' ? `All (${results.length})` : t}
            </button>
          ))}
        </div>

        <button className={s.actionBtn} onClick={selectAllNew} disabled={newCount === 0}>
          <IconCheck size={12} stroke={2} /> Select {newCount} new
        </button>
        <button className={s.actionBtn} onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
          <IconX size={12} stroke={2} /> Clear
        </button>
      </div>

      {/* Card grid */}
      <div className={s.grid}>
        {filtered.map(r => {
          const key = keyOf(r)
          const type = typeOverrides[key] ?? r.detected_type
          const ts = TYPE_STYLE[type] || TYPE_STYLE.Cracked
          const isChecked = r.alreadyInLibrary || selected.has(key)
          const name = nameEdits[key] ?? r.name
          // resolvedUrls[appId]: undefined=not tried, null=fetching, ''=failed, string=url
          const resolved = r.steam_app_id ? resolvedUrls[r.steam_app_id] : undefined
          const bannerUrl = (resolved != null && resolved !== '')
            ? resolved
            : (r.steam_app_id
              ? `https://cdn.akamai.steamstatic.com/steam/apps/${r.steam_app_id}/library_600x900_2x.jpg`
              : null)

          function handleImgError(e) {
            const img = e.target
            const step = img.dataset.step || '0'
            if (step === '0') {
              img.dataset.step = '1'
              img.src = `https://cdn.akamai.steamstatic.com/steam/apps/${r.steam_app_id}/header.jpg`
            } else if (step === '1' && resolved == null) {
              // Both CDN paths failed — try getting real hashed URL via appdetails
              img.dataset.step = '2'
              img.style.display = 'none'
              resolveStoreArt(r.steam_app_id)
            } else {
              img.style.display = 'none'
            }
          }

          return (
            <div
              key={key}
              className={`${s.card} ${r.alreadyInLibrary ? s.cardDim : ''} ${selected.has(key) ? s.cardSelected : ''}`}
              onClick={() => !r.alreadyInLibrary && toggle(key)}
            >
              {/* Banner — blurred fill + contained cover so landscape art
                  (a header for a game with no portrait) still looks clean. */}
              <div className={s.banner} style={{ background: bannerBg(r.name) }}>
                {bannerUrl && (
                  <>
                    {/* key changes when bannerUrl resolves → forces fresh mount, clears hidden state */}
                    <img key={bannerUrl + 'b'} src={bannerUrl} alt="" aria-hidden="true" className={s.bannerBlur}
                      onError={handleImgError} />
                    <img key={bannerUrl + 'i'} src={bannerUrl} alt="" className={s.bannerImg}
                      onError={handleImgError} />
                  </>
                )}
                {!bannerUrl && (
                  <IconDeviceGamepad2 size={28} stroke={1.1} style={{ color: 'rgba(255,255,255,0.15)' }} />
                )}

                {/* Checkbox overlay */}
                <div className={`${s.checkOverlay} ${isChecked ? s.checkOverlayOn : ''}`}>
                  {isChecked && <IconCheck size={14} stroke={2.5} style={{ color: r.alreadyInLibrary ? 'var(--text-muted)' : '#fff' }} />}
                </div>

                {/* Type badge */}
                <div className={s.typeBadge}
                  style={{ color: ts.color, background: ts.bg, borderColor: ts.border }}
                  onClick={e => {
                    e.stopPropagation()
                    if (!r.alreadyInLibrary) {
                      setTypeOverrides(p => ({ ...p, [key]: type === 'Steam' ? 'Cracked' : 'Steam' }))
                    }
                  }}
                  title={r.alreadyInLibrary ? undefined : 'Click to toggle Steam/Cracked'}
                >
                  {type}
                </div>

                {r.isInstalled && !r.alreadyInLibrary && (
                  <div className={s.installedTag}>Installed</div>
                )}

                {r.alreadyInLibrary && (
                  <div className={s.inLibraryOverlay}>In Library</div>
                )}
              </div>

              {/* Info */}
              <div className={s.info}>
                <input
                  className={s.nameInput}
                  value={name}
                  onChange={e => { e.stopPropagation(); setNameEdits(p => ({ ...p, [key]: e.target.value })) }}
                  onClick={e => e.stopPropagation()}
                  disabled={r.alreadyInLibrary}
                  placeholder="Game name"
                />
                <div className={s.metaLine}>
                  {r.playtime > 0 && <span>{Math.round(r.playtime / 60)}h</span>}
                  {r.steam_app_id && <span>#{r.steam_app_id}</span>}
                  {!r.isInstalled && r.detected_type === 'Steam' && <span style={{ color: 'var(--text-muted)' }}>not installed</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-secondary)', fontSize: 13 }}>
          No games match the current filter.
        </div>
      )}
    </Modal>
  )
}
