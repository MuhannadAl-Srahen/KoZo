'use strict'
// News for a game's page (Game Detail): the developer's own Steam announcements.
// feeds=steam_community_announcements matters: without it a popular game's feed
// is mostly outside gaming sites, in any language. No key needed. Fetched only
// when a game page opens, never in the background, and cached for 3 hours.

const logger = require('../logger')

const TTL = 3 * 60 * 60 * 1000
const MAX_CACHED = 100
const CLAN_IMAGES = 'https://clan.fastly.steamstatic.com/images'
const cache = new Map()   // appid -> { at, items }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? all
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all
  })
}

// Formatting that keeps its text. Words in brackets that aren't Steam's markup
// stay as they are: patch notes are full of "[Console]" and "[Patch]".
const INLINE = /\[\/?(?:b|i|u|s|strike|spoiler|noparse|code|quote|url|color|size|emoticon)(?:[= ][^\]]*)?\]/gi
function clean(text) {
  return decode(text.replace(INLINE, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ').trim()
}

function imageUrl(raw) {
  const url = String(raw || '').trim().replace('{STEAM_CLAN_IMAGE}', CLAN_IMAGES)
  return /^https:\/\/[^\s{}]+$/.test(url) ? url : null
}

function attr(attrs, name) {
  const m = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return m ? m[1] : null
}

// Pure: Steam's markup -> [{ type: 'h' | 'p' | 'li', text } | { type: 'img', src }
// | { type: 'link', href, text }]. The page shows these as text and never injects
// the post as HTML.
const MAX_BLOCKS = 600
const BLOCK = /\[(\/?)(p|h[1-6]|list|olist|\*|table|tr|td|th|hr|img|previewyoutube|video|dynamiclink|carousel)(?=[\]\s=])([^\]]*)\]/gi
function newsBlocks(contents) {
  const src = String(contents || '').slice(0, 200000)
  const blocks = []
  let mode = 'p', buf = '', at = 0, cut = false
  const flush = () => {
    const text = clean(buf)
    buf = ''
    if (text) blocks.push({ type: mode, text })
  }
  BLOCK.lastIndex = 0
  for (let m = BLOCK.exec(src); m; m = BLOCK.exec(src)) {
    buf += src.slice(at, m.index)
    at = BLOCK.lastIndex
    const closing = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3]
    if (tag === 'p' || tag === 'tr' || tag === 'table' || tag === 'hr' || tag === 'carousel') {
      flush()
    } else if (tag === 'td' || tag === 'th') {
      if (closing) buf += '  '
    } else if (/^h[1-6]$/.test(tag)) {
      flush()
      mode = closing ? 'p' : 'h'
    } else if (tag === '*') {
      flush()
      mode = closing ? 'p' : 'li'
    } else if (tag === 'list' || tag === 'olist') {
      flush()
      mode = 'p'
    } else if (tag === 'img') {
      if (closing) continue
      flush()
      let url = attr(attrs, 'src')
      if (url == null) {
        const end = src.toLowerCase().indexOf('[/img]', at)
        if (end >= 0) { url = src.slice(at, end); at = end; BLOCK.lastIndex = end }
      }
      const img = imageUrl(url)
      if (img) blocks.push({ type: 'img', src: img })
    } else if (tag === 'dynamiclink') {
      if (closing) continue
      flush()
      const href = attr(attrs, 'href')
      if (href && /^https:\/\//.test(href)) blocks.push({ type: 'link', href, text: 'Open the link' })
    } else if (tag === 'previewyoutube') {
      if (closing) continue
      flush()
      const id = (attrs.match(/=\s*"?([\w-]{6,})/) || [])[1]
      if (id) blocks.push({ type: 'link', href: `https://www.youtube.com/watch?v=${id}`, text: 'Watch the video' })
    }
    // [video] has no address a page can use: nothing to show.
    if (blocks.length > MAX_BLOCKS) { cut = true; break }
  }
  // Past the limit the rest of the post is left out whole: added here, it would show
  // as one paragraph of raw markup.
  if (!cut) buf += src.slice(at)
  flush()
  if (cut) blocks.push({ type: 'p', text: 'This post goes on. The rest is on Steam.' })
  return blocks
}

// Pure: "Dear Adventurers," says nothing about what's in the post.
const GREETING = /^(dear|hello|hi|hey|greetings|good (morning|afternoon|evening|day)|howdy|ahoy|salutations|welcome)\b/i
function isGreeting(text) {
  const t = String(text || '').trim()
  return t.length <= 60 && (GREETING.test(t) || (/,$/.test(t) && t.split(/\s+/).length <= 4))
}
function excerptOf(blocks, max = 200) {
  const texts = blocks.filter(b => b.type === 'p' || b.type === 'li')
  const first = texts.find(b => !isGreeting(b.text)) || texts[0]
  if (!first) return ''
  return first.text.length > max ? first.text.slice(0, max).replace(/\s+\S*$/, '') + '...' : first.text
}

// Pure: Steam's answer -> what the page shows.
function shapeNews(items) {
  return (items || []).map((n) => {
    const blocks = newsBlocks(n.contents)
    return {
      id: String(n.gid),
      title: clean(String(n.title || '')) || 'News',
      url: /^https:\/\//.test(n.url || '') ? n.url : null,
      date: (Number(n.date) || 0) * 1000,
      patch: (n.tags || []).includes('patchnotes'),
      excerpt: excerptOf(blocks),
      blocks,
    }
  })
}

async function getNews(appid) {
  const id = Number(appid)
  if (!(id > 0)) return []
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < TTL) return hit.items
  try {
    const r = await require('axios').get('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/', {
      timeout: 15000,
      params: { appid: id, count: 20, feeds: 'steam_community_announcements', format: 'json' },
    })
    const items = shapeNews(r.data?.appnews?.newsitems)
    cache.delete(id)
    cache.set(id, { at: Date.now(), items })
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
    return items
  } catch (e) {
    // Steam not answering: the last answer is still news, and none is not an error
    // worth a whole message on the page.
    logger.debug?.('steamNews: fetch failed', { appid: id, message: e.message })
    return hit ? hit.items : []
  }
}

module.exports = { getNews, newsBlocks, shapeNews, excerptOf }
