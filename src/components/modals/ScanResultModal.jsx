import React, { useState } from 'react'
import {
  IconSearch, IconPlus, IconCheck, IconDeviceGamepad2, IconX, IconAlertTriangle,
  IconChevronDown, IconFolderOpen, IconFile, IconTool, IconRefresh,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import ContextMenu from '../ui/ContextMenu'
import { LAUNCHERS, fileUrl, exeLooksLikeTool } from '../../lib/utils'
import { LIBRARY_STATUSES } from '../../lib/cardModel'
import { bytesText } from '../StorageTab'
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

// Badge colors come from LAUNCHERS (§14c single source of truth) so a game looks
// identical here and on its Library card — every detected_type lowercases to its
// LAUNCHERS key. Alpha suffixes match GameCard's sourceBadge.
function typeStyle(type) {
  const l = LAUNCHERS[String(type).toLowerCase()] || LAUNCHERS.manual
  return { color: l.color, bg: l.color + '18', border: l.color + '44' }
}

// Badge click cycles detected → Cracked → Steam → detected, so the genuinely
// detected launcher is always reachable again (returning to it deletes the
// override entirely rather than pinning the same value).
function nextType(current, detected) {
  const cycle = [detected, ...['Cracked', 'Steam'].filter(t => t !== detected)]
  return cycle[(cycle.indexOf(current) + 1) % cycle.length]
}

// What a scan type is called on screen. The value stays 'Cracked' (it sets is_cracked).
const typeLabel = (t) => (t === 'Cracked' ? 'No launcher' : t)
const low = (x) => String(x || '').toLowerCase()
const lastTwo = (p) => String(p || '').split(/[\\/]/).filter(Boolean).slice(-2).join('\\')
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// One card as it stands now: the scan's answer plus a game file picked by hand.
// A game already in KoZo (r.library) has `changes`: what ticking it would update there
// (electron/services/scanPlan.js). A hand pick that differs from the stored file is a change too.
function viewOf(r, type, edit) {
  const lib = r.library || null
  const fromFiles = type === 'Cracked'
  const exe = edit?.exe_name ?? r.exe_name ?? null
  const dir = edit ? edit.dir : null
  let changes = lib ? { ...(r.changes || {}) } : null
  if (lib && edit) {
    const differs = low(edit.exe_name) !== low(lib.exe_name)
    if (differs) changes.exe = { from: lib.exe_name, to: edit.exe_name, dir: edit.dir }
    else delete changes.exe
    if (fromFiles && low(edit.dir) !== low(lib.install_path)) changes.folder = { from: lib.install_path, to: edit.dir }
    else if (changes.folder && changes.exe) changes.folder = { ...changes.folder, to: fromFiles ? edit.dir : changes.folder.to }
  }
  const hasChanges = !!changes && Object.keys(changes).length > 0
  const state = lib ? (hasChanges ? 'update' : 'in-library')
    : !exe ? 'no-file'
    : (r.exe_unsure && !edit) ? 'unsure' : 'new'
  return {
    lib, exe, changes, state,
    install_path: lib ? null : (edit ? (fromFiles ? dir : (r.game_root || r.install_path)) : r.install_path),
    canTick: state === 'new' || state === 'unsure' || state === 'update',
    tool: !!edit && exeLooksLikeTool(edit.exe_name),
  }
}

export default function ScanResultModal({ results, onClose, onAdd, title }) {
  const [selected, setSelected]       = useState(() => new Set())
  const [nameEdits, setNameEdits]     = useState({})
  const [typeOverrides, setTypeOverrides] = useState({})
  const [exeEdits, setExeEdits]       = useState({})     // key -> { exe_name, dir, launch_file } picked by hand
  const [menu, setMenu]               = useState(null)   // { key, x, y }: the Change game file menu
  const [search, setSearch]           = useState('')
  const [typeFilter, setTypeFilter]   = useState('all')
  const [adding, setAdding]           = useState(false)
  const [addMsg, setAddMsg]           = useState(null)    // { type: 'ok'|'err', text }
  const [done, setDone]               = useState(() => new Set())   // keys already added or updated
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

  const typeOf = (r) => typeOverrides[keyOf(r)] ?? r.detected_type
  const view = (r) => {
    const k = keyOf(r)
    if (done.has(k)) return { lib: r.library || { name: r.name }, exe: exeEdits[k]?.exe_name ?? r.exe_name, changes: {}, state: 'in-library', canTick: false, tool: false }
    return viewOf(r, typeOf(r), exeEdits[k])
  }

  const views = results.map(r => ({ r, v: view(r) }))
  const newKeys = views.filter(x => x.v.state === 'new').map(x => keyOf(x.r))
  const updateKeys = views.filter(x => x.v.state === 'update').map(x => keyOf(x.r))
  const picked = views.filter(x => selected.has(keyOf(x.r)) && x.v.canTick)
  const nAdd = picked.filter(x => !x.v.lib).length
  const nUpd = picked.filter(x => x.v.lib).length

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // A file picked by hand: that card is ticked, since picking is saying "this one".
  function pickExe(key, pick) {
    setExeEdits(p => ({ ...p, [key]: pick }))
    setSelected(prev => new Set(prev).add(key))
  }

  async function browse(r) {
    const key = keyOf(r)
    const res = await window.kozo?.api?.dialog?.pickExe?.(r.game_root || r.install_path || undefined)
    const d = res?.ok ? res.data : null
    if (!d || !d.exe_name) return
    pickExe(key, { exe_name: d.exe_name, dir: d.install_path, launch_file: d.launch_file || null })
  }

  async function handleApply() {
    const toAdd = picked.filter(x => !x.v.lib).map(({ r, v }) => {
      const k = keyOf(r)
      const type = typeOf(r)
      const edit = exeEdits[k]
      return {
        ...r,
        name: nameEdits[k] ?? r.name,
        name_edited: nameEdits[k] !== undefined,
        detected_type: type,
        is_cracked: typeOverrides[k] !== undefined ? (type === 'Cracked' ? 1 : 0) : r.is_cracked,
        ...(edit ? { exe_name: edit.exe_name, install_path: v.install_path, exe_dir: edit.dir, launch_file: edit.launch_file || null, exe_picked: true, exe_unsure: false, no_game_file: false } : {}),
      }
    })
    const toUpdate = picked.filter(x => x.v.lib).map(({ r, v }) => {
      const edit = exeEdits[keyOf(r)]
      const c = v.changes || {}
      return {
        id: v.lib.id,
        restore: !!c.restore,
        installed: !!c.installed,
        install_path: c.folder?.to || undefined,
        exe_name: c.exe?.to || undefined,
        exe_dir: c.exe?.dir || undefined,
        ...(edit ? { launch_file: edit.launch_file || null, picked: true } : {}),
      }
    })
    if (!toAdd.length && !toUpdate.length) return
    setAdding(true)
    setAddMsg(null)
    const api = window.kozo?.api?.scanner
    const addRes = toAdd.length ? await api?.addGames?.(toAdd) : null
    const updRes = toUpdate.length ? await api?.updateGames?.(toUpdate) : null
    setAdding(false)
    const failed = (toAdd.length && !addRes?.ok) || (toUpdate.length && !updRes?.ok)
    if (failed) { setAddMsg({ type: 'err', text: addRes?.error || updRes?.error || 'That did not work.' }); return }
    const added = addRes?.data?.added || 0
    const updated = updRes?.data?.updated || 0
    const skipped = updRes?.data?.skipped || []
    const parts = []
    if (added) parts.push(`Added ${added}`)
    if (updated) parts.push(`${added ? 'updated' : 'Updated'} ${updated}`)
    let text = parts.length ? parts.join(', ') + '.' : 'Nothing changed.'
    for (const sk of skipped) {
      text += sk.reason === 'running' ? ` ${sk.name} is running, so it wasn't changed.` : ` ${sk.name} wasn't changed (${sk.reason}).`
    }
    setAddMsg({ type: skipped.length && !added && !updated ? 'err' : 'ok', text })
    const skippedIds = new Set(skipped.map(x => x.id))
    setDone(prev => {
      const next = new Set(prev)
      for (const { r, v } of picked) if (!v.lib || !skippedIds.has(v.lib.id)) next.add(keyOf(r))
      return next
    })
    setSelected(new Set())
    if (added || updated) onAdd?.(added + updated)
  }

  const types = ['all', ...new Set(results.map(typeOf))]

  const filtered = views.filter(({ r }) => {
    const k = keyOf(r)
    if (typeFilter !== 'all' && typeOf(r) !== typeFilter) return false
    const name = nameEdits[k] ?? r.name
    if (search && !name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const menuFor = menu && results.find(r => keyOf(r) === menu.key)
  const menuItems = menuFor ? (() => {
    const cur = view(menuFor)
    const items = (menuFor.exe_choices || []).map(c => ({
      label: c.exe_name,
      Icon: c.tool ? IconTool : IconFile,
      hint: [bytesText(c.size), c.rel || 'Game folder', c.tool ? 'Tool' : !c.sure ? 'Not sure' : null].filter(Boolean).join(', '),
      active: low(c.exe_name) === low(cur.exe),
      onClick: () => pickExe(menu.key, { exe_name: c.exe_name, dir: c.dir, launch_file: null }),
    }))
    if (items.length) items.push({ divider: true })
    items.push({ label: 'Browse for the file', Icon: IconFolderOpen, onClick: () => browse(menuFor) })
    return items
  })() : null

  const applyLabel = nAdd && nUpd ? `Add ${nAdd}, update ${nUpd}`
    : nUpd ? `Update ${plural(nUpd, 'game')}`
    : `Add ${plural(nAdd, 'game')} to Library`

  return (
    <Modal
      title={`${title || 'Scan Results'}: ${plural(results.length, 'game')}, ${newKeys.length} new${updateKeys.length ? `, ${updateKeys.length} to update` : ''}`}
      icon={<IconDeviceGamepad2 size={17} stroke={1.6} />}
      onClose={onClose}
      // Escape with the file menu open closes the menu, not the whole window and its picks.
      onRequestClose={() => { if (menu) setMenu(null); else onClose() }}
      width={780}
      footer={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
          {addMsg && (
            <span data-scan-msg style={{
              display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 12,
              color: addMsg.type === 'err' ? 'var(--status-dropped)' : 'var(--status-playing)',
              flex: 1,
            }}>
              {addMsg.type === 'err'
                ? <IconAlertTriangle size={13} stroke={2} />
                : <IconCheck size={13} stroke={2.5} />}
              {addMsg.text}
            </span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className={ms.btnCancel} onClick={onClose}>Close</button>
            <button
              className={ms.btnPrimary}
              data-scan-apply
              onClick={handleApply}
              disabled={picked.length === 0 || adding}
            >
              {adding
                ? <><span className="spin" style={{ display: 'inline-block', marginRight: 6 }}>↻</span>Working…</>
                : <>{nUpd && !nAdd ? <IconRefresh size={14} stroke={2} style={{ marginRight: 4 }} /> : <IconPlus size={14} stroke={2} style={{ marginRight: 4 }} />}{applyLabel}</>
              }
            </button>
          </div>
        </div>
      }
    >
      {/* Toolbar */}
      <div className={s.toolbar}>
        <div className={`${s.searchBox} hasRing`}>
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
              {t === 'all' ? `All (${results.length})` : typeLabel(t)}
            </button>
          ))}
        </div>

        <button className={s.actionBtn} onClick={() => setSelected(new Set(newKeys))} disabled={newKeys.length === 0}>
          <IconCheck size={12} stroke={2} /> Select {newKeys.length} new
        </button>
        {updateKeys.length > 0 && (
          <button className={s.actionBtn} onClick={() => setSelected(prev => new Set([...prev, ...updateKeys]))} data-scan-select-updates>
            <IconRefresh size={12} stroke={2} /> Select {updateKeys.length} to update
          </button>
        )}
        <button className={s.actionBtn} onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
          <IconX size={12} stroke={2} /> Clear
        </button>
      </div>

      {/* Card grid */}
      <div className={s.grid}>
        {filtered.map(({ r, v }) => {
          const key = keyOf(r)
          const type = typeOf(r)
          const ts = typeStyle(type)
          const isNew = !v.lib
          const editable = isNew && v.canTick
          const isChecked = selected.has(key) && v.canTick
          const name = nameEdits[key] ?? r.name
          const c = v.changes || {}
          // resolvedUrls[appId]: undefined=not tried, null=fetching, ''=failed, string=url
          const resolved = r.steam_app_id ? resolvedUrls[r.steam_app_id] : undefined
          const libraryCover = v.lib && (fileUrl(r.library_cover_path) || r.library_cover_url)
          const bannerUrl = libraryCover || ((resolved != null && resolved !== '')
            ? resolved
            : (r.steam_app_id
              ? `https://cdn.akamai.steamstatic.com/steam/apps/${r.steam_app_id}/library_600x900_2x.jpg`
              : null))
          const hasFolder = !!(r.game_root || r.install_path) && !r.launch_uri
          const statusLabel = v.lib?.status ? LIBRARY_STATUSES[v.lib.status]?.label || null : null

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
              className={`${s.card} ${!v.canTick ? s.cardDim : ''} ${isChecked ? s.cardSelected : ''}`}
              onClick={() => v.canTick && toggle(key)}
              data-scan-card={v.state}
              data-scan-name={r.name}
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
                {v.canTick ? (
                  <div className={`${s.checkOverlay} ${isChecked ? s.checkOverlayOn : ''}`}>
                    {isChecked && <IconCheck size={14} stroke={2.5} style={{ color: '#fff' }} />}
                  </div>
                ) : null}

                {/* Type badge */}
                <div className={s.typeBadge}
                  style={{ color: ts.color, background: ts.bg, borderColor: ts.border }}
                  onClick={e => {
                    e.stopPropagation()
                    if (!editable) return
                    const next = nextType(type, r.detected_type)
                    setTypeOverrides(p => {
                      const n = { ...p }
                      if (next === r.detected_type) delete n[key]
                      else n[key] = next
                      return n
                    })
                  }}
                  title={!editable ? undefined : 'Click to change type'}
                >
                  {typeLabel(type)}
                </div>

                {r.isInstalled && editable && (
                  <div className={s.installedTag}>Installed</div>
                )}

                {/* A game KoZo already has: say so in a corner, the cover stays readable */}
                {v.lib && (
                  <div className={s.libChip}>
                    {v.lib.is_archived && c.restore ? 'Removed' : 'In your Library'}{statusLabel ? `, ${statusLabel}` : ''}
                  </div>
                )}
                {v.state === 'no-file' && (
                  <div className={s.inLibraryOverlay}>No game file</div>
                )}
              </div>

              {/* Info */}
              <div className={s.info}>
                <input
                  className={s.nameInput}
                  value={v.lib?.name && !isNew ? v.lib.name : name}
                  onChange={e => { e.stopPropagation(); setNameEdits(p => ({ ...p, [key]: e.target.value })) }}
                  onClick={e => e.stopPropagation()}
                  disabled={!editable}
                  placeholder="Game name"
                />

                {/* What ticking this card changes for a game already in KoZo */}
                {v.state === 'update' && (
                  <ul className={s.changes} data-scan-changes>
                    {c.restore && <li>Back in your Library</li>}
                    {c.installed && <li>Installed again</li>}
                    {c.folder && <li title={`${c.folder.from || 'No folder'} to ${c.folder.to}`}>Folder: {lastTwo(c.folder.to)}</li>}
                    {c.exe && <li title={c.exe.dir}>Game file: {c.exe.to}{c.exe.from ? ` (was ${c.exe.from})` : ''}</li>}
                  </ul>
                )}
                {r.fixed && !done.has(key) && (
                  <div className={s.fixedLine} data-scan-fixed>
                    <IconCheck size={11} stroke={2.4} />
                    <span>{r.fixed.folder ? `Found again at ${lastTwo(r.fixed.folder)}` : 'Installed again'}</span>
                  </div>
                )}
                {done.has(key) && <div className={s.fixedLine}><IconCheck size={11} stroke={2.4} /><span>Done</span></div>}

                {/* The game file, and a way to choose another one */}
                {hasFolder && !done.has(key) && (
                  <button type="button" data-scan-exe data-gpnav=""
                    className={`${s.exeBtn} ${(v.state === 'no-file' || v.state === 'unsure' || v.tool) ? s.exeLineWarn : ''}`}
                    title="Change game file"
                    onClick={e => {
                      e.stopPropagation()
                      const b = e.currentTarget.getBoundingClientRect()
                      setMenu({ key, x: b.left, y: b.bottom + 4 })
                    }}>
                    {(v.state === 'no-file' || v.state === 'unsure' || v.tool) && <IconAlertTriangle size={11} stroke={2} />}
                    <span>
                      {v.state === 'no-file' ? 'Choose the game file'
                        : v.state === 'unsure' ? `Not sure: ${v.exe}`
                        : v.exe || 'Choose the game file'}
                    </span>
                    <IconChevronDown size={11} stroke={2} />
                  </button>
                )}
                {v.tool && <div className={`${s.exeLine} ${s.exeLineWarn}`}><span>Looks like a tool, not the game</span></div>}
                {exeEdits[key]?.launch_file && (
                  <div className={s.exeLine}><span>Starts with {String(exeEdits[key].launch_file).split(/[\\/]/).pop()}</span></div>
                )}
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

      {menu && menuFor && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          header={{ name: nameEdits[menu.key] ?? menuFor.name, sub: 'Which file is the game?' }}
          items={menuItems}
        />
      )}
    </Modal>
  )
}
