import { IconInfoCircle, IconPlus, IconTrash, IconBell, IconBellOff, IconSparkles, IconBuildingStore, IconBrandSteam } from '@tabler/icons-react'

// One right-click menu for a Steam game on Discounts and Games like this (the maker asked for one on
// both, with a way to be told about the lowest price). Upcoming's calendar keeps its own. Each action
// is optional: a page leaves out what it can't do, and ContextMenu skips the empty rows.
// g = { appid, name }; cheaper = deals' cheaperStore answer, when another store is under Steam.
export function storeMenuItems(g, { onOpen, onList, onAdd, onRemove, alertSet, onAlert, onUnalert, onLike, cheaper } = {}) {
  const open = (url) => window.kozo?.api?.shell?.openExternal?.(url)
  return [
    onOpen && { label: 'Details', Icon: IconInfoCircle, onClick: () => onOpen(g) },
    onList
      ? onRemove && { label: 'Remove from Game List', Icon: IconTrash, onClick: () => onRemove(g) }
      : onAdd && { label: 'Add to Game List', Icon: IconPlus, onClick: () => onAdd(g) },
    alertSet
      ? onUnalert && { label: 'Remove price alert', Icon: IconBellOff, onClick: () => onUnalert(g) }
      : onAlert && { label: 'Tell me at its lowest price', Icon: IconBell, onClick: () => onAlert(g) },
    onLike && { label: 'Find games like this', Icon: IconSparkles, onClick: () => onLike(g) },
    { divider: true },
    cheaper && { label: `Buy at ${cheaper.store} for $${Number(cheaper.price).toFixed(2)}`, Icon: IconBuildingStore, onClick: () => open(cheaper.url) },
    g?.appid && { label: 'Steam page', Icon: IconBrandSteam, onClick: () => open(`https://store.steampowered.com/app/${g.appid}`) },
  ]
}

// The text and Undo after "Tell me at its lowest price", for ui/UndoBar.
export async function alertAtLowest(g, onChanged) {
  const r = await window.kozo?.api?.deals?.alertAtLowest?.(g.appid, { name: g.name, banner_url: g.portrait2x || g.portrait || null })
  onChanged?.()
  if (!r?.ok) return { error: r?.error || "KoZo couldn't set the alert." }
  return {
    undo: {
      text: `KoZo will tell you when ${g.name} is ${r.data?.text || 'at its lowest price'} or less.`,
      run: async () => { await window.kozo?.api?.deals?.setTarget?.(g.appid, null); onChanged?.() },
    },
  }
}
