import React, { useEffect, useState } from 'react'
import { IconFolder, IconLoader2, IconRefresh, IconDeviceDesktop } from '@tabler/icons-react'
import s from './StorageTab.module.css'

// Settings > Data > Storage: each disk (used and free), and the games on it by size
// (services/gameSizes.js). Sizes are counted in the background, never during a game,
// and kept, so this opens at once; anything a week old is counted again on a visit.

export function bytesText(b) {
  if (b == null) return ''
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)} TB`
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`
  return b > 0 ? 'Under 1 MB' : '0 MB'
}

let cache = null

export default function StorageTab() {
  const [data, setData] = useState(cache)
  const [progress, setProgress] = useState(null)   // { done, total } while counting
  const load = () => window.kozo?.api?.storage?.overview?.().then(r => { if (r?.ok) { cache = r.data; setData(r.data) } })
  useEffect(() => {
    load()
    window.kozo?.api?.storage?.measure?.()
    // At most one reload a second while counting: reloading after every game redrew the
    // whole list 500 times for 500 games (scripts/perf-check.js). The end always reloads.
    let timer = null
    const soon = () => { if (!timer) timer = setTimeout(() => { timer = null; load() }, 1000) }
    const off = window.kozo?.events?.onStorageProgress?.((p) => {
      if (p?.finished) { clearTimeout(timer); timer = null; setProgress(null); load() }
      else { setProgress(p); if (p?.gameId) soon() }
    })
    return () => { off?.(); clearTimeout(timer) }
  }, [])

  const drives = data?.drives || []
  return (
    <div className={s.wrap} data-storage>
      <div className={s.top}>
        {progress ? (
          <span className={s.counting}><IconLoader2 size={14} className="spin" /> Counting sizes, {progress.done} of {progress.total}</span>
        ) : (
          <button type="button" className={s.recount} onClick={() => window.kozo?.api?.storage?.measure?.(true)}>
            <IconRefresh size={14} /> Count again
          </button>
        )}
      </div>
      {!data && <div className={s.muted}>Loading…</div>}
      {data && !drives.length && <div className={s.muted}>No games with a folder on this PC yet.</div>}
      {drives.map(d => {
        const used = Math.max(0, d.size - d.free)
        const games = Math.min(d.gamesBytes, used)
        const pct = (n) => (d.size > 0 ? `${Math.max(0, Math.min(100, (n / d.size) * 100))}%` : '0%')
        return (
          <section key={d.drive} className={s.drive} data-drive={d.drive}>
            <div className={s.driveHead}>
              <IconDeviceDesktop size={16} stroke={1.6} />
              <strong>{d.drive}</strong>
              {d.size > 0 && <span className={s.driveFree}>{bytesText(d.free)} free of {bytesText(d.size)}</span>}
            </div>
            {d.size > 0 && (
              <>
                <div className={s.bar} role="img" aria-label={`Games ${bytesText(games)}, other files ${bytesText(used - games)}, free ${bytesText(d.free)}`}>
                  <span className={s.barGames} style={{ width: pct(games) }} />
                  <span className={s.barOther} style={{ width: pct(used - games) }} />
                </div>
                <div className={s.legend}>
                  <span><i className={s.dotGames} /> Games {bytesText(games)}</span>
                  <span><i className={s.dotOther} /> Other files {bytesText(used - games)}</span>
                  <span><i className={s.dotFree} /> Free {bytesText(d.free)}</span>
                </div>
              </>
            )}
            {d.games.length > 0 && (
              <ul className={s.list}>
                {d.games.map(g => (
                  <li key={g.id} className={s.row}>
                    <span className={s.name} title={g.install_path}>{g.name}</span>
                    {g.size != null && d.gamesBytes > 0 && (
                      <span className={s.share}><span style={{ width: `${Math.max(2, (g.size / Math.max(...d.games.map(x => x.size || 0), 1)) * 100)}%` }} /></span>
                    )}
                    <span className={s.size}>{g.size != null ? bytesText(g.size) : 'Counting…'}</span>
                    <button type="button" className={s.open} onClick={() => window.kozo?.api?.shell?.openPath?.(g.install_path)} title="Open the game's folder">
                      <IconFolder size={14} /> Open folder
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
