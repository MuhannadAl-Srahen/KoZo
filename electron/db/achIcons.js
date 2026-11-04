'use strict'

// Steam's API still hands out achievement icons on its old image servers
// (steamcdn-a.akamaihd.net, cdn.*.steamstatic.com under /steamcommunity/...).
// Newer icons were never put there and answer 404: 166 of Halls of Torment's 666
// showed as broken images. Every stored icon, old and new, exists on this one.
const ICON_HOST = 'https://shared.fastly.steamstatic.com/community_assets/images/apps/'
const OLD_PATH = /^https?:\/\/[^/]+\/steamcommunity\/public\/images\/apps\//i

function achIconUrl(url) {
  if (typeof url !== 'string') return url ?? null
  return url.replace(OLD_PATH, ICON_HOST)
}

module.exports = { achIconUrl }
