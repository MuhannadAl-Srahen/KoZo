// The Library's tabs (pages/Library.jsx): Current, On hold, Finished, Dropped, Hidden, Removed.
// Pure, no imports: scripts/test-parsers.js loads this file as text.
//
// They replaced three folding rows under the grid ("Finished & dropped", "Hidden", "Archived"):
// with 23 of 30 games in those rows the page read as clutter, and a game removed with its
// history kept was still one click away on the same page ("it's still there"). On hold got
// its own tab (the maker's ask): Current is what you're playing and what you haven't started.

export const LIBRARY_TABS = ['current', 'on_hold', 'finished', 'dropped', 'hidden', 'removed']

// One home per game. Removed wins over Hidden, which wins over the status.
export function tabOf(g) {
  if (g?.is_archived) return 'removed'
  if (g?.is_hidden) return 'hidden'
  if (g?.completion_status === 'on_hold') return 'on_hold'
  if (g?.completion_status === 'finished') return 'finished'
  if (g?.completion_status === 'dropped') return 'dropped'
  return 'current'            // playing, no status
}

export function countTabs(games, keep = () => true) {
  const c = { current: 0, on_hold: 0, finished: 0, dropped: 0, hidden: 0, removed: 0 }
  for (const g of games || []) if (keep(g)) c[tabOf(g)]++
  return c
}

// Current is always there, another tab only while it holds a game and isn't turned off
// (Settings > Appearance can leave Hidden and Removed out of the Library).
export function shownTabs(counts, off = []) {
  return LIBRARY_TABS.filter(k => k === 'current' || (counts?.[k] > 0 && !off.includes(k)))
}

// A tab that emptied (the last removed game was restored) or was turned off goes back to Current.
export function settleTab(tab, counts, off = []) {
  return LIBRARY_TABS.includes(tab) && (tab === 'current' || (counts?.[tab] > 0 && !off.includes(tab))) ? tab : 'current'
}

// A ?show= link, then the tab used earlier in this run, then a one-time move of an old
// On hold / Finished / Dropped status filter (those are tabs now).
export function startTab({ show, remembered, savedStatus } = {}) {
  if (LIBRARY_TABS.includes(show)) return show
  if (LIBRARY_TABS.includes(remembered)) return remembered
  if (savedStatus === 'on_hold' || savedStatus === 'finished' || savedStatus === 'dropped') return savedStatus
  return 'current'
}

// The status dropdown on Current: '' = all, 'playing', 'none' = no status yet.
export function matchesStatus(g, filter) {
  if (!filter) return true
  if (filter === 'none') return !g?.completion_status
  return g?.completion_status === filter
}
