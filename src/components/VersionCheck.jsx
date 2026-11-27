import React, { useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconRefresh, IconNews, IconExternalLink, IconAlertTriangle, IconCircleCheck, IconHelpCircle, IconLoader2 } from '@tabler/icons-react'
import { timeAgo } from '../lib/utils'
import c from './VersionCheck.module.css'

// The version tag beside a game's name (services/gameVersion.js), and a small window under it
// that says how KoZo knows: your copy's version and where it was read, Steam's newest build and
// patch notes, and the verdict. The maker saw "v1.0130.1 · May be outdated" with no way to check
// it; the window has Check again (past the caches), the game's patch notes and SteamDB's list of
// every update. No entry = nothing can be said about it.
const LOOK = {
  behind: { label: 'Update out', cls: c.behind, Icon: IconAlertTriangle },
  maybe: { label: 'May be outdated', cls: c.maybe, Icon: IconHelpCircle },
  current: { label: 'Up to date', cls: c.current, Icon: IconCircleCheck },
}
const fullDate = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null)

function verdict(v) {
  const n = v.details?.inNews
  if (v.state === 'behind') {
    return n?.newer > 0
      ? `Steam has ${n.newer} update${n.newer === 1 ? '' : 's'} after your version.`
      : 'Steam has a newer version than this copy.'
  }
  if (v.state === 'current') return n ? "Your version is the newest one in Steam's patch notes." : "This copy matches Steam's newest version."
  if (v.state === 'maybe') return 'Steam was updated after this copy was made, so it may be out of date.'
  return "KoZo couldn't compare this copy with Steam."
}

function why(v) {
  const d = v.details
  if (!d) return null
  if (v.state === 'maybe') {
    return d.local.version
      ? `Steam's news doesn't name version ${d.local.version}, so only dates could be compared. An update doesn't always change the game file, and a copy from another store has its own dates: check the patch notes to be sure.`
      : "This copy has no version number KoZo can read, so only dates could be compared. Check the patch notes to be sure."
  }
  if (d.local.build && d.latest?.build) return "Compared by Steam's build number, which is exact."
  if (d.inNews) return `Steam's news names your version${d.inNews.since ? ` on ${fullDate(d.inNews.since)}` : ''}${d.inNews.newer ? ', and counts the updates after it' : ''}.`
  if (d.local.version && d.latest?.version) return 'Compared by version number with the newest patch notes.'
  return null
}

export default function VersionCheck({ v, onCheck, onNews }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const down = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true) }
  }, [open])

  const look = LOOK[v.state]
  const d = v.details
  async function check() {
    setBusy(true)
    try { await onCheck?.() } finally { setBusy(false) }
  }
  const mine = d?.local
  const theirs = d?.latest
  return (
    <span className={c.wrap} ref={ref}>
      <button type="button" className={`${c.chip} ${look?.cls || ''}`} onClick={() => setOpen(o => !o)} aria-expanded={open}
        title={v.hint} data-game-version={v.state}>
        {v.text}
        {look && <span className={c.state}> · {look.label}</span>}
        {d && <IconChevronDown size={12} stroke={2} className={c.caret} />}
      </button>
      {open && d && (
        <div className={c.panel} role="dialog" aria-label="Is this copy up to date?" data-version-panel>
          <div className={`${c.head} ${look?.cls || ''}`}>
            {look ? <look.Icon size={16} stroke={1.8} /> : <IconHelpCircle size={16} stroke={1.8} />}
            <span>{verdict(v)}</span>
          </div>
          <dl className={c.rows}>
            <dt>Your copy</dt>
            <dd>
              <b>{mine.version ? `Version ${mine.version}` : mine.build ? `Build ${mine.build}` : 'No version number'}</b>
              {(mine.versionFrom || mine.buildFrom) && <small>read from {mine.version ? mine.versionFrom : mine.buildFrom}</small>}
              {mine.version && mine.build && <small>build {mine.build}</small>}
              {mine.date && <small>files from {fullDate(mine.date)}</small>}
            </dd>
            <dt>On Steam</dt>
            <dd>
              {theirs && (theirs.version || theirs.build || theirs.at) ? <>
                <b>{theirs.version ? `Version ${theirs.version}` : theirs.build ? `Build ${theirs.build}` : 'Updated'}</b>
                {theirs.version && theirs.build && <small>build {theirs.build}</small>}
                {theirs.at && <small>updated {fullDate(theirs.at)}</small>}
              </> : <b className={c.none}>Steam didn't answer</b>}
            </dd>
            {theirs?.newest && <>
              <dt>Newest patch notes</dt>
              <dd><b className={c.title}>{theirs.newest.title}</b>{theirs.newest.date && <small>{fullDate(theirs.newest.date)}</small>}</dd>
            </>}
          </dl>
          {why(v) && <p className={c.why}>{why(v)}</p>}
          <div className={c.actions}>
            <button type="button" className={c.btn} onClick={check} disabled={busy} data-version-recheck>
              {busy ? <IconLoader2 size={14} className="spin" /> : <IconRefresh size={14} />} {busy ? 'Checking…' : 'Check again'}
            </button>
            {onNews && (
              <button type="button" className={c.btn} onClick={() => { setOpen(false); onNews() }}>
                <IconNews size={14} /> Patch notes
              </button>
            )}
            {d.appid && (
              <button type="button" className={c.btn} title="Every update of this game, with dates and build numbers"
                onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://steamdb.info/app/${d.appid}/patchnotes/`)}>
                <IconExternalLink size={14} /> SteamDB
              </button>
            )}
          </div>
          <small className={c.checked}>Checked {timeAgo(new Date(d.checkedAt).toISOString())}</small>
        </div>
      )}
    </span>
  )
}
