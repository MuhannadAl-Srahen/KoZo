// What an opened session shows (components/SessionDetail). No imports, so the logic
// tests can load it.

// Time a session ran but didn't count: away, AFK, or closed between two legs of a
// merged session. Worked out from the clock, not idle_seconds: that column is saved
// on a throttle, so it can lag behind what was really taken off.
export function pausedSeconds(session) {
  const span = (new Date(session?.ended_at) - new Date(session?.started_at)) / 1000
  if (!Number.isFinite(span)) return 0
  return Math.max(0, Math.round(span - (session.duration_seconds || 0)))
}

export function clockTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function byUnlockTime(a, b) {
  if (!a.unlocked_at || !b.unlocked_at) return a.unlocked_at ? -1 : b.unlocked_at ? 1 : 0
  return new Date(a.unlocked_at) - new Date(b.unlocked_at)
}

// One group per session, earliest first, each with what was earned in it, in the
// order it came. Links by session_id, the same rows the session's own count is kept from.
export function sessionGroups(sessions, achievements) {
  const groups = [...sessions]
    .sort((a, b) => new Date(a.started_at) - new Date(b.started_at))
    .map(session => ({
      session,
      paused: pausedSeconds(session),
      unlocks: achievements
        .filter(a => a.session_id === session.id && (a.unlock_id != null || a.unlocked_at != null))
        .sort(byUnlockTime),
    }))
  return {
    groups,
    played: groups.reduce((sum, g) => sum + (g.session.duration_seconds || 0), 0),
    paused: groups.reduce((sum, g) => sum + g.paused, 0),
    unlocks: groups.reduce((sum, g) => sum + g.unlocks.length, 0),
  }
}
