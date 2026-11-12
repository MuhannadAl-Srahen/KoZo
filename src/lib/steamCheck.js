// What "Check achievements" says when Steam's website refuses a game (pages/GameDetail.jsx).
// Pure, no imports: scripts/test-parsers.js loads this file as text.
//
// Steam answers "Profile is not public" for a private profile AND for a game that simply isn't
// on the connected account, and the window used to tell everyone to make their Game details
// public: also people whose game was on another (shared) account whose privacy isn't theirs to
// change, and people whose unlocks had already been read from the Steam app on this PC.
//
// refresh = steam:refresh's answer ({ playerSyncReason, local: { accounts }, account }),
// diag = steam:diagnose's. Returns null when the website did not refuse (the normal report
// applies), else { variant, title, message, lines, privacyHelp, accountsButton }.

const nameOf = (a) => a?.persona || a?.accountName || 'another Steam account'
const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

export function steamCheckMessage({ name, refresh, diag }) {
  const d = refresh || {}
  const refused = d.playerSyncReason === 'private' || diag?.error === 'private'
  if (!refused) return null

  const account = d.account || {}
  const persona = account.persona || 'your Steam account'
  const many = (account.accounts || 0) > 1
  const files = (d.local?.accounts || []).filter(a => a.unlocked > 0 || a.counted > 0)

  // (a) Steam on this PC has the game's unlocks: nothing is missing, so say what was read.
  if (files.length) {
    const lines = files.map(a => a.mode === 'mine'
      ? `${nameOf(a)} (your account): ${n(a.unlocked, 'achievement')} unlocked`
      : a.counted === a.unlocked
        ? `${nameOf(a)} (shared): ${n(a.counted, 'achievement')} unlocked while you played`
        : `${nameOf(a)} (shared): ${a.counted} of ${a.unlocked} are yours, unlocked while you played. The rest were earned by other people on that account.`)
    if (diag && diag.local_total != null) lines.push(`Stored in KoZo: ${diag.local_unlocked ?? 0} / ${diag.local_total ?? 0}`)
    lines.push(`Steam's website has nothing for this game on ${persona}. Nothing is missing because of it.`)
    return {
      variant: d.local?.added > 0 ? 'success' : 'info',
      title: `Achievements for "${name}"`,
      message: 'Read from the Steam app on this PC.',
      lines, privacyHelp: false, accountsButton: many,
    }
  }

  // (d) The connected account isn't known to be the user's own: never the privacy steps.
  if (account.mode !== 'mine') {
    return {
      variant: 'info',
      title: `Nothing to read yet for "${name}"`,
      message: many && !account.confirmed
        ? 'There are several Steam accounts on this PC and KoZo does not know which one is yours. Pick it under Steam accounts. Achievements are read from the Steam app on this PC, for any account you play on.'
        : `${persona} is a shared account, so its privacy is not yours to change. KoZo counts what you unlock there while you play, read from the Steam app on this PC.`,
      lines: ['Play the game once with KoZo open and its achievements show up.'],
      privacyHelp: false, accountsButton: true,
    }
  }

  // (c) The user's own account, and it really is private.
  if (account.private) {
    return {
      variant: 'warning',
      title: `Steam's website won't list unlocks for "${name}"`,
      message: `${persona} keeps its Game details private. KoZo still reads every unlock made on this PC, so this only matters for unlocks from other PCs.`,
      lines: [], privacyHelp: true, accountsButton: many,
    }
  }

  // (b) The user's own, open account: the game just isn't on it.
  return {
    variant: 'info',
    title: `"${name}" isn't on ${persona}`,
    message: 'Steam\'s website only has achievements for games on your own account. KoZo also reads them from the Steam app on this PC, for any account you play on: play it once with KoZo open and they show up.',
    lines: [], privacyHelp: false, accountsButton: many,
  }
}
