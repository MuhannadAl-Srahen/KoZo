import React, { useState, useEffect } from 'react'
import { IconCalendar } from '@tabler/icons-react'
import SteamCalendar from '../components/SteamCalendar'
import ReleasedPanel from '../components/ReleasedPanel'
import s from './Upcoming.module.css'

// Upcoming = the Steam release calendar. Games you track are marked on it and
// listed under its "Tracked" shelf; tracking is a release watch on the Game
// List row (game_list.release_watch), so it survives status changes: a tracked
// game set to Want to play still gets its "Out now" alert.
export default function Upcoming() {
  // Game List rows with a Steam appid: appid → { id, status, watch }.
  const [byAppId, setByAppId] = useState(() => new Map())
  const [tracked, setTracked] = useState([])   // release-watched rows (any status)

  async function load() {
    const [all, watched] = await Promise.all([
      window.kozo?.api?.gameList?.list?.({ limit: 100000, offset: 0 }),
      window.kozo?.api?.gameList?.tracked?.(),
    ])
    if (watched?.ok) setTracked(watched.data || [])
    if (all?.ok) {
      const watchIds = new Set((watched?.ok ? watched.data : []).map(r => r.id))
      setByAppId(new Map((all.data?.items || [])
        .filter(i => i.steam_app_id)
        .map(i => [Number(i.steam_app_id), { id: i.id, status: i.status, watch: watchIds.has(i.id) }])))
    }
  }

  useEffect(() => {
    load()
    // Warm store details for tracked games and backfill their release dates.
    window.kozo?.api?.gameList?.refreshUpcomingInfo?.()
    const off = window.kozo?.events?.onGameUpdated?.(() => load())
    return () => off?.()
  }, [])

  // Track: a game already on your list just starts being watched; anything
  // else is added as Upcoming (which watches it).
  async function trackGame(g) {
    const info = byAppId.get(Number(g.appid))
    if (info) await window.kozo?.api?.gameList?.update?.(info.id, { release_watch: 1 })
    else {
      await window.kozo?.api?.gameList?.add?.({
        name: g.name,
        steam_app_id: g.appid,
        status: 'upcoming',
        release_date: g.release || null,
      })
    }
    await load()
  }

  async function untrackGame(g) {
    const info = byAppId.get(Number(g.appid))
    if (!info) return
    await window.kozo?.api?.gameList?.untrack?.(info.id)
    await load()
  }

  return (
    <div className={s.page}>
      <div className={s.toolbar} data-tour="upcoming-tabs">
        <h1 className={s.pageTitle}>
          <IconCalendar size={16} stroke={1.7} /> Upcoming
        </h1>
        {tracked.length > 0 && <span className={s.count} title="Releases you track">{tracked.length}</span>}
      </div>

      <div className={s.content}>
        <div className={s.inner}>
          <ReleasedPanel onChanged={load} />
          <SteamCalendar byAppId={byAppId} trackedRows={tracked} onTrack={trackGame} onUntrack={untrackGame} />
        </div>
      </div>
    </div>
  )
}
