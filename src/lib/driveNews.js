import { formatPlaytime } from './utils'

// The bar's one line: what another PC on this Google account has that this one doesn't. Pure.
const many = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

export function driveNewsText(offer) {
  const pcs = offer?.pcs || []
  const who = pcs.length === 1 && pcs[0].name ? pcs[0].name : pcs.length > 1 ? 'Your other PCs' : 'Your other PC'
  const parts = []
  if (offer?.list?.fresh > 0) parts.push(`${many(offer.list.fresh, 'game')} on the Game List`)
  if (offer?.library?.fresh > 0) parts.push(`${many(offer.library.fresh, 'game')} in the Library`)
  if (offer?.library?.seconds > 0) parts.push(`${formatPlaytime(offer.library.seconds)} of play`)
  else if (offer?.library?.sessions > 0) parts.push(many(offer.library.sessions, 'session'))
  if (offer?.library?.unlocks > 0) parts.push(many(offer.library.unlocks, 'achievement'))
  if (offer?.saves?.games > 0) parts.push(`saves for ${many(offer.saves.games, 'game')}`)
  const verb = pcs.length > 1 ? 'have' : 'has'
  return parts.length ? `${who} ${verb} something new: ${parts.join(', ')}.` : `${who} ${verb} something new.`
}
