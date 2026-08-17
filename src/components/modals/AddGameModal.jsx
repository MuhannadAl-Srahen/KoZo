import React, { useState, useEffect, useCallback } from 'react'
import {
  IconSearch, IconPlus, IconCheck, IconAlertTriangle,
  IconDeviceGamepad2, IconCrosshair, IconFolderOpen, IconX,
} from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import RunningProcessPicker from '../ui/RunningProcessPicker'
import ImageCropModal from './ImageCropModal'
import { detectLauncherFromPath } from '../../lib/utils'
import s from './AddGameModal.module.css'

const KNOWN_SYSTEM_EXES = new Set([
  'explorer.exe', 'svchost.exe', 'winlogon.exe', 'csrss.exe',
  'lsass.exe', 'services.exe', 'system', 'taskmgr.exe',
])

// Detect official vs cracked from install path. Known store paths = official.
const OFFICIAL_PATH_HINTS = [
  'steamapps\\common\\', 'steamapps/common/',
  '\\epic games\\', '/epic games/',
  '\\gog games\\', '/gog games/', '\\gog galaxy\\', '/gog galaxy/',
  '\\windowsapps\\', '/windowsapps/',          // Xbox / Microsoft Store
  '\\ubisoft game launcher\\', '\\ubisoft connect\\',
  '\\origin games\\', '/origin games/',
  '\\ea games\\', '/ea games/',
  '\\battle.net\\', '\\battlenet\\',
  '\\riot games\\', '/riot games/',
  '\\rockstar games\\', '/rockstar games/',
]

function detectOfficialFromPath(filePath) {
  if (!filePath) return null
  const lower = filePath.toLowerCase()
  return OFFICIAL_PATH_HINTS.some(h => lower.includes(h)) ? 'official' : 'cracked'
}

function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

const BANNER_BG = ['#1a0f2e','#0f1e3a','#0f2a1e','#2a1a0a','#2a0f0f','#1e1a0a']
function bannerBg(id) { return BANNER_BG[(id || 0) % BANNER_BG.length] }

// Sharp appid header.jpg first; if it 404s (new/unreleased title) fall back to
// the hashed capsule from search, then to the icon.
function artChain(game) {
  return [game.header_image, game.capsule].filter(Boolean)
}
function bestArt(game) {
  return artChain(game)[0] || null
}
function bannerError(e, game) {
  const img = e.target
  const chain = artChain(game)
  const step = parseInt(img.dataset.step || '0', 10) + 1
  if (step < chain.length) {
    img.dataset.step = String(step)
    img.src = chain[step]
  } else {
    img.style.display = 'none'
  }
}

export default function AddGameModal({ onClose, onAdded, prefillExe, prefillInstallPath }) {
  const initialQuery = prefillInstallPath
    ? (prefillInstallPath.split(/[\\/]/).pop() || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
    : ''

  const [query, setQuery]         = useState(initialQuery)
  const [results, setResults]     = useState([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected]   = useState(null)
  const [isManual, setIsManual]   = useState(!!prefillExe && !initialQuery)

  const guessNameFromPath = (p) => {
    if (!p) return ''
    const folder = p.split(/[\\/]/).pop() || ''
    return folder.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const [name, setName]               = useState(prefillInstallPath ? guessNameFromPath(prefillInstallPath) : '')
  const [exeName, setExeName]         = useState(prefillExe || '')
  const [installPath, setInstallPath] = useState(prefillInstallPath || '')
  const [bannerPath, setBannerPath]   = useState('')
  const [cropSrc, setCropSrc]         = useState(null)   // data: URL pending crop
  const [isCracked, setIsCracked]     = useState(0)
  const [source, setSource]           = useState(() => detectLauncherFromPath(prefillInstallPath) || 'manual')
  const [saving, setSaving]           = useState(false)
  const [errors, setErrors]           = useState({})
  const [exeWarn, setExeWarn]         = useState(false)
  const [dupWarn, setDupWarn]         = useState(false)
  const [showPicker, setShowPicker]   = useState(false)

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

  function clearSelection() {
    setSelected(null)
    setIsManual(false)
    setName('')
    setBannerPath('')
    setIsCracked(0)
    setSource(detectLauncherFromPath(prefillInstallPath) || 'manual')
    setErrors({})
    setDupWarn(false)
    if (!prefillExe)         setExeName('')
    if (!prefillInstallPath) setInstallPath('')
  }

  function handleQueryChange(val) {
    if (selected || isManual) clearSelection()
    setQuery(val)
  }

  function pickGame(game) {
    setSelected(game)
    setIsManual(false)
    setName(game.name || '')
    setIsCracked(0)
    setSource('steam')
    setBannerPath('')
    setErrors({})
    setDupWarn(false)
    if (!prefillExe) {
      const guess = (game.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) + '.exe'
      setExeName(guess)
    }
    if (!prefillInstallPath) setInstallPath('')
  }

  function pickManual() {
    setSelected(null)
    setIsManual(true)
    setName(query.trim())
    setBannerPath('')
    setSource(detectLauncherFromPath(installPath) || 'manual')
    setErrors({})
    setDupWarn(false)
    if (!prefillExe) setExeName('')
    if (!prefillInstallPath) setInstallPath('')
  }

  function onExeChange(val) {
    setExeName(val)
    setExeWarn(KNOWN_SYSTEM_EXES.has(val.toLowerCase().trim()))
  }

  async function checkDuplicate(appId) {
    if (!appId) return false
    const res = await window.kozo?.api?.games?.list()
    if (!res?.ok) return false
    return res.data.some(g => g.steam_app_id === appId)
  }

  async function handleSave() {
    const newErrors = {}
    if (!name.trim())    newErrors.name = 'Game name is required'
    if (!exeName.trim()) newErrors.exeName = 'Executable name is required'
    if (exeName.trim() && !exeName.toLowerCase().trim().endsWith('.exe')) newErrors.exeName = 'Must end in .exe'
    if (Object.keys(newErrors).length) { setErrors(newErrors); return }

    setSaving(true)
    try {
      if (selected?.steam_app_id) {
        const isDup = await checkDuplicate(selected.steam_app_id)
        if (isDup) { setDupWarn(true); setSaving(false); return }
      }

      const safeTrim = (v) => (typeof v === 'string' ? v.trim() : '')
      const res = await window.kozo?.api?.games?.add({
        steam_app_id: selected?.steam_app_id ?? null,
        name: safeTrim(name),
        exe_name: safeTrim(exeName),
        install_path: safeTrim(installPath) || null,
        // Library cards are portrait (2:3) → store the portrait cover. games:add
        // downloads a hi-res local copy; `capsule_fallback` lets it grab the
        // hashed capsule for new titles that have no portrait yet.
        banner_url: selected?.steam_app_id
          ? `https://cdn.akamai.steamstatic.com/steam/apps/${selected.steam_app_id}/library_600x900_2x.jpg`
          : null,
        capsule_fallback: selected?.capsule || null,
        banner_local_path: safeTrim(bannerPath) || null,
        source: selected?.steam_app_id ? 'steam' : source,
        is_installed: 1,
        is_cracked: isCracked,
      })

      setSaving(false)
      if (res?.ok) {
        onAdded?.(res.data)
        onClose()
      } else {
        setErrors({ save: res?.error || 'Failed to add game' })
      }
    } catch (e) {
      setSaving(false)
      setErrors({ save: e?.message || 'Something went wrong' })
    }
  }

  const showForm = selected || isManual
  const canSave  = name.trim() && exeName.trim()
  // Only show results list when there's a query and no selection yet
  const showResults = !showForm && query.length >= 2

  return (
   <>
    <Modal
      title="Add Game to Library"
      icon={<IconDeviceGamepad2 size={17} stroke={1.6} />}
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className={ms.btnCancel} onClick={onClose}>Cancel</button>
          <button
            className={ms.btnPrimary}
            onClick={handleSave}
            disabled={!showForm || !canSave || saving}
          >
            <IconPlus size={14} stroke={2} style={{ marginRight: 4 }} />
            {saving ? 'Adding…' : 'Add to Library'}
          </button>
        </>
      }
    >
      {/* Search / selected chip */}
      {!showForm ? (
        <div className={`${s.searchRow} hasRing`}>
          <IconSearch size={15} stroke={1.6} className={s.searchIcon} />
          <input
            className={s.searchInput}
            placeholder="Search Steam or type a game name…"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            autoFocus
          />
        </div>
      ) : (
        <div className={s.selectedChip}>
          {selected && (
            <div className={s.selectedThumb} style={{ background: bannerBg(selected.steam_app_id) }}>
              {bestArt(selected)
                ? <img src={bestArt(selected)} alt="" onError={e => bannerError(e, selected)} />
                : <IconDeviceGamepad2 size={14} stroke={1.4} style={{ color: 'rgba(255,255,255,0.3)' }} />
              }
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

      {/* Results */}
      {searching && <div className={s.searching}>Searching…</div>}

      {showResults && !searching && (
        <div className={s.resultsList}>
          {results.map(game => (
            <div
              key={game.steam_app_id}
              className={s.resultItem}
              onClick={() => pickGame(game)}
            >
              <div className={s.resultIcon} style={{ background: bannerBg(game.steam_app_id) }}>
                {bestArt(game)
                  ? <img src={bestArt(game)} alt="" onError={e => bannerError(e, game)} />
                  : <IconDeviceGamepad2 size={18} stroke={1.3} style={{ color: 'rgba(255,255,255,0.15)' }} />
                }
              </div>
              <div className={s.resultInfo}>
                <div className={s.resultName}>{game.name}</div>
                <div className={s.resultMeta}>Steam · App {game.steam_app_id}</div>
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
          Type at least 2 characters to search Steam, or type a game name to add it manually.
        </div>
      )}

      {/* Form */}
      {showForm && (
        <>
          <hr className={s.divider} />

          {dupWarn && (
            <div className={s.warning}>
              <IconAlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              This game is already in your library.
            </div>
          )}

          <div className={s.field}>
            <label className={`${s.label} ${s.labelRequired}`}>Game name</label>
            <input
              className={`${s.input} ${errors.name ? s.inputError : ''}`}
              value={name}
              onChange={e => { setName(e.target.value); setErrors(p => ({ ...p, name: '' })) }}
              placeholder="e.g. Resident Evil 4"
            />
            {errors.name && <div className={s.errorText}>{errors.name}</div>}
          </div>

          <div className={s.field}>
            <label className={`${s.label} ${s.labelRequired}`}>Executable name</label>
            <div className={s.exeRow}>
              <input
                className={`${s.input} ${errors.exeName ? s.inputError : ''}`}
                value={exeName}
                onChange={e => { onExeChange(e.target.value); setErrors(p => ({ ...p, exeName: '' })) }}
                placeholder="e.g. re4.exe"
              />
              <button
                type="button"
                className={s.pickBtn}
                onClick={async () => {
                  const res = await window.kozo?.api?.dialog?.pickExe(installPath || undefined)
                  if (res?.ok && res.data) {
                    setExeName(res.data.exe_name)
                    setInstallPath(res.data.install_path)
                    setExeWarn(KNOWN_SYSTEM_EXES.has(res.data.exe_name.toLowerCase()))
                    setErrors(p => ({ ...p, exeName: '' }))
                    // Auto-detect official vs cracked + the launcher from the path
                    const detected = detectOfficialFromPath(res.data.install_path)
                    if (detected === 'official') setIsCracked(0)
                    if (detected === 'cracked')  setIsCracked(1)
                    setSource(detectLauncherFromPath(res.data.install_path) || 'manual')
                  }
                }}
              >
                <IconFolderOpen size={14} stroke={1.7} />
                Browse
              </button>
              <button type="button" className={s.pickBtn} onClick={() => setShowPicker(v => !v)}>
                <IconCrosshair size={14} stroke={1.7} />
                Pick running
              </button>
            </div>

            {showPicker && (
              <div className={s.pickerWrap}>
                <RunningProcessPicker
                  onClose={() => setShowPicker(false)}
                  onPick={(proc) => {
                    setExeName(proc.exe_name)
                    if (proc.install_path) {
                      setInstallPath(proc.install_path)
                      const lnch = detectLauncherFromPath(proc.install_path)
                      if (lnch) setSource(lnch)
                    }
                    setExeWarn(KNOWN_SYSTEM_EXES.has(proc.exe_name.toLowerCase()))
                    setErrors(p => ({ ...p, exeName: '' }))
                    setShowPicker(false)
                  }}
                />
              </div>
            )}

            {errors.exeName
              ? <div className={s.errorText}>{errors.exeName}</div>
              : <div className={s.inputHint}>Click "Browse" to find the .exe on disk, or "Pick running" if the game is already open.</div>
            }
            {exeWarn && (
              <div className={s.warning}>
                <IconAlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                This looks like a Windows system process. Are you sure?
              </div>
            )}
          </div>

          <div className={s.field}>
            <label className={s.label}>Install path <span style={{ color: 'var(--text-secondary)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
            <input
              className={s.input}
              value={installPath}
              onChange={e => setInstallPath(e.target.value)}
              placeholder="e.g. C:\Games\RE4"
            />
          </div>

          {/* Banner — manual games only */}
          {isManual && (
            <div className={s.field}>
              <label className={s.label}>Banner image <span style={{ color: 'var(--text-secondary)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
              <div className={s.fileRow}>
                <button
                  type="button"
                  className={s.fileBtn}
                  onClick={async () => {
                    const res = await window.kozo?.api?.dialog?.pickImageData?.()
                    if (res?.ok && res.data?.dataUrl) setCropSrc(res.data.dataUrl)
                  }}
                >
                  Choose image
                </button>
                {bannerPath
                  ? <span className={s.fileName}>{bannerPath.split(/[\\/]/).pop()}</span>
                  : <span className={s.fileHint}>No file chosen</span>
                }
              </div>
            </div>
          )}

          {/* Copy type — always shown. Steam games default to Official but can be overridden
              if the user has a cracked copy and only linked Steam for cover art / schema. */}
          <div className={s.field}>
            <label className={s.label}>Copy type</label>
            <div className={s.pills}>
              <button type="button" className={`${s.pill} ${!isCracked ? s.pillActive : ''}`} onClick={() => setIsCracked(0)}>Official</button>
              <button type="button" className={`${s.pill} ${isCracked ? s.pillActive : ''}`} onClick={() => setIsCracked(1)}>Cracked / offline</button>
            </div>
            <div className={s.inputHint}>
              {isCracked
                ? 'Launches the local .exe directly (never Steam). Reads achievements from crack emulator files (Goldberg, CODEX, etc).'
                : selected
                  ? 'Syncs achievements via Steam API after each session.'
                  : 'Mark as Cracked if this is not a legitimate copy from Steam, GOG, Epic, etc.'
              }
            </div>
          </div>

          {/* Launcher — manual games only (Steam picks are obviously Steam). Auto-set
              from the chosen install path; overridable so the badge is correct. */}
          {isManual && !isCracked && (
            <div className={s.field}>
              <label className={s.label}>Launcher</label>
              <div className={s.pills} style={{ flexWrap: 'wrap' }}>
                {[
                  ['steam', 'Steam'], ['epic', 'Epic'], ['gog', 'GOG'],
                  ['xbox', 'Xbox'], ['ea', 'EA'], ['ubisoft', 'Ubisoft'], ['manual', 'Other'],
                ].map(([val, lbl]) => (
                  <button
                    key={val}
                    type="button"
                    className={`${s.pill} ${source === val ? s.pillActive : ''}`}
                    onClick={() => setSource(val)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <div className={s.inputHint}>
                Shown as a badge on the cover. KoZo only syncs achievements for Steam and
                cracked games — other launchers track playtime &amp; sessions only.
              </div>
            </div>
          )}

          {errors.save && <div className={s.errorText} style={{ marginTop: 6 }}>{errors.save}</div>}
        </>
      )}
    </Modal>

    {cropSrc && (
      <ImageCropModal
        src={cropSrc}
        kind="cover"
        title="Adjust cover"
        onCancel={() => setCropSrc(null)}
        onDone={(path) => { setBannerPath(path); setCropSrc(null) }}
      />
    )}
   </>
  )
}
