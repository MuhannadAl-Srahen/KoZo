import {
  IconPlayerPlayFilled, IconCircleCheckFilled, IconX,
  IconPlayerPauseFilled, IconClock, IconCalendar,
} from '@tabler/icons-react'
import { LAUNCHERS } from './utils'

// One description of "what a card should show", shared by the Library and the
// Game List so the two grids stop drifting apart (they had diverged on ~20 axes:
// title over the art vs under it, four badges vs one, 32px vs 28px star…).
//
// The card renders exactly ONE status channel plus one identity chip. Everything
// else that used to be its own pill is folded into a channel below, because five
// stacked pills covered a third of the cover art they were sitting on.

// Statuses the LIBRARY can set on a game (games.completion_status).
export const LIBRARY_STATUSES = {
  playing:  { label: 'Playing',  color: 'var(--status-playing)',  Icon: IconPlayerPlayFilled },
  finished: { label: 'Finished', color: 'var(--status-finished)', Icon: IconCircleCheckFilled },
  on_hold:  { label: 'On hold',  color: 'var(--status-onhold)',   Icon: IconPlayerPauseFilled },
  dropped:  { label: 'Dropped',  color: 'var(--status-dropped)',  Icon: IconX },
}

// The Game List adds two of its own; a library game can never be either.
export const LIST_STATUSES = {
  ...LIBRARY_STATUSES,
  want_to_play: { label: 'Want to play', color: 'var(--a)',                Icon: IconClock },
  upcoming:     { label: 'Upcoming',     color: 'var(--status-upcoming)',  Icon: IconCalendar },
}

// Backwards-compatible alias — GameCard used to export STATUS_META.
export const STATUS_META = LIBRARY_STATUSES

// A cracked copy of a Steam game is "Cracked", not "Steam": is_cracked wins.
// Unknown sources fall back to the neutral Manual chip rather than rendering
// nothing, so every card carries exactly one identity.
export function sourceOf(game) {
  if (game?.is_cracked === 1) return LAUNCHERS.cracked
  return LAUNCHERS[game?.source] || LAUNCHERS.manual
}

// The single accent channel down the card's left edge. Priority order matters:
// a game that is running right now is more interesting than the label you gave
// it last month, and an uninstalled game is worth flagging over a stale status.
//
// Returns { tone, color, label } or null. `tone` drives the CSS class so the
// treatment (solid vs dim) can differ from the colour.
export function accentOf(game, statuses = LIBRARY_STATUSES) {
  if (game?._isLive) {
    return { tone: 'live', color: 'var(--status-playing)', label: 'Playing now' }
  }
  if (game?.is_installed === 0) {
    return { tone: 'unavailable', color: 'var(--neutral)', label: 'Not installed' }
  }
  const st = statuses[game?.completion_status] || statuses[game?.status]
  if (st) return { tone: 'status', color: st.color, label: st.label }
  return null
}

// Everything the card needs to render, derived once.
export function cardModel(game, { statuses = LIBRARY_STATUSES, showInstallState = true } = {}) {
  const source = sourceOf(game)
  const accent = accentOf(showInstallState ? game : { ...game, is_installed: 1 }, statuses)
  return {
    source,
    accent,
    // Dimming says "you cannot play this right now". Hidden games are dimmed for
    // a different reason, so they carry their own quieter treatment.
    unavailable: showInstallState && game?.is_installed === 0,
    hidden: game?.is_hidden === 1,
    favorite: game?.is_favorite === 1,
  }
}
