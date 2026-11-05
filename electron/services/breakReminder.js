'use strict'
// Settings > Tracking > Break reminder. Pure, so the rules can be tested: called
// from processWatcher.heartbeatSession on its existing tick, with no timer or
// process of its own, so it costs a game nothing between toasts.

// activeSec: time actually played this session (paused time doesn't count).
// state: what the last call returned (null for a session not seen yet).
// Returns { due, state }.
function breakDue({ activeSec, everySec, paused = false, state = null }) {
  if (!(everySec > 0)) return { due: false, state: null }
  const stage = Math.floor(Math.max(0, activeSec) / everySec)
  // First look at this session (it just began, or KoZo restarted during it), or
  // the interval was just changed: note where things stand, without a toast.
  if (!state || state.everySec !== everySec) return { due: false, state: { everySec, stage } }
  // Paused: wait, so it doesn't speak to someone who has already walked away.
  if (paused || stage <= state.stage) return { due: false, state }
  return { due: true, state: { everySec, stage } }
}

module.exports = { breakDue }
