// Where to look for how to unlock an achievement (the maker asked for a guide button on locked
// achievements). KoZo makes up no hints: these are searches for this achievement by name.
// Steam guides need the game's Steam id (a game with no launcher keeps a matched one in
// manual_appid); YouTube and the web always work.
export function guideLinks(game, ach) {
  const appId = game?.steam_app_id || game?.manual_appid || null
  const name = ach?.display_name || ach?.steam_api_name || ''
  const gameName = game?.name || ''
  const links = []
  if (appId) links.push({ key: 'steam', label: 'Steam guides', url: `https://steamcommunity.com/app/${appId}/guides/?searchText=${encodeURIComponent(name)}` })
  links.push({ key: 'youtube', label: 'YouTube', url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${gameName} ${name} achievement guide`)}` })
  links.push({ key: 'web', label: 'Search the web', url: `https://duckduckgo.com/?q=${encodeURIComponent(`${gameName} "${name}" achievement how to unlock`)}` })
  return links
}

export function openGuide(url) {
  window.kozo?.api?.shell?.openExternal?.(url)
}
