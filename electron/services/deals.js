'use strict'
// Discount games (/deals). What makes it more than a sale list:
//  - Your list on sale: every Game List game you want (Want to play, Upcoming,
//    On hold) that is discounted right now, first, with a sidebar badge for
//    new ones (setting deals_seen).
//  - Lowest price ever and the other stores: CheapShark compares Steam with
//    GOG, Humble, Fanatical, GMG, Epic (only the games it lists) and more, and
//    knows each game's all-time low, so a "deal" that is really the usual price
//    says so. Its prices are US dollars. Epic's own price services refuse outside
//    requests (checked), so CheapShark is the only route to its prices.
//  - Price alerts: a price you choose per game (game_list.price_target_*). An
//    overlay toast and the sidebar badge say so once it's reached.
//  - Deal score: how deep the discount is, how well the game is reviewed and
//    how close it is to what YOU play (Steam tags of your most played and best
//    rated games), so the top of the page is the best deal for you, not the
//    biggest number.
// Prices come from Steam for the country Steam's store uses for this PC (storeCountry), the
// price you'd really pay there.

const fs = require('fs')
const path = require('path')
const logger = require('../logger')

const TTL = 60 * 60 * 1000          // whole page: one hour
const LOW_TTL = 6 * 60 * 60 * 1000  // CheapShark facts: six hours
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 KoZo' }
const WANT = ['want_to_play', 'upcoming', 'on_hold']
const UNKNOWN_TTL = 7 * 24 * 60 * 60 * 1000   // a game CheapShark doesn't list: ask again in a week

function axios() { return require('axios') }
function steam() { return require('./steamApi') }
function settings() { return require('../db/queries/settings') }

// ── Which country's prices ───────────────────────────────────────────────────
// Steam prices by the country its store gives this PC, not by Windows' region setting: with
// Windows set to US, Discounts said Sniper Elite 5 was $4.99 (the US price) while Steam sold it
// to the maker for $2.29 (Jordan's regional price). Steam names that country in the
// steamCountry cookie on any store page ("JO%7C<hash>"); kept a day in setting
// `steam_store_cc` ({ cc, at }, per PC). Until Steam has answered once, Windows' region.
const CC_SETTING = 'steam_store_cc'
const CC_TTL = 24 * 3600000
let storeCc = null
function savedCc() {
  if (storeCc) return storeCc
  try { storeCc = JSON.parse(settings().getSetting(CC_SETTING) || 'null') } catch {}
  return storeCc
}
function localeCountry() {
  try { return (require('electron').app.getLocaleCountryCode() || 'US').toUpperCase() } catch { return 'US' }
}
function country() {
  return savedCc()?.cc || localeCountry()
}
// Pure: the country in Steam's Set-Cookie headers, or null.
function ccFromCookies(setCookie) {
  for (const c of [].concat(setCookie || [])) {
    const m = /(?:^|;\s*)steamCountry=([A-Za-z]{2})(?=%7C|\||;|$)/.exec(String(c))
    if (m) return m[1].toUpperCase()
  }
  return null
}
let ccRun = null
async function askStoreCountry() {
  try {
    // A HEAD of a tiny store page: Steam sets the cookie, nothing is downloaded.
    const r = await axios().head('https://store.steampowered.com/app/10/', { timeout: 6000, headers: UA, maxRedirects: 0, validateStatus: () => true })
    const cc = ccFromCookies(r.headers?.['set-cookie'])
    if (cc) {
      if (cc !== savedCc()?.cc) logger.info('deals: Steam store country', { cc, windows: localeCountry() })
      storeCc = { cc, at: Date.now() }
      try { settings().setSetting(CC_SETTING, JSON.stringify(storeCc)) } catch {}
    }
  } catch (e) { logger.warn('deals: could not ask Steam for the store country', { message: e.message }) }
  return country()
}
// Known and under a day old: at once. Known but old: asked again behind, the old one used now.
// Never asked: waits for Steam (6 s at most), since every price depends on it.
async function storeCountry() {
  const s = savedCc()
  if (s?.cc && Date.now() - (s.at || 0) < CC_TTL) return s.cc
  if (!ccRun) ccRun = askStoreCountry().finally(() => { ccRun = null })
  return s?.cc ? s.cc : ccRun
}

let cache = null      // { at, cc, data }
let running = null
const lowCache = new Map()   // steam appid -> { at, info }
const gameIdOf = new Map()   // steam appid -> CheapShark game id (kept on disk: it never changes)
const unknownAt = new Map()  // steam appid -> when CheapShark last said it doesn't list it

function cacheFile() { return path.join(require('electron').app.getPath('userData'), 'deals-cache.json') }
let diskRead = false
function loadDisk() {
  if (diskRead) return
  diskRead = true
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (d?.data && !cache) cache = { at: d.at, cc: d.cc, data: d.data, more: d.more || null }
    for (const [k, v] of Object.entries(d?.ids || {})) gameIdOf.set(Number(k), v)
    for (const [k, v] of Object.entries(d?.unknownIds || {})) if (Date.now() - v < UNKNOWN_TTL) unknownAt.set(Number(k), v)
  } catch {}
}
function saveDisk() {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify({ ...cache, ids: Object.fromEntries(gameIdOf), unknownIds: Object.fromEntries(unknownAt) }))
  } catch {}
}

// ── Steam ──────────────────────────────────────────────────────────────────
// Steam's sales, 100 at a time: 'rev' = best reviewed first, 'top' = top sellers. Steam has
// thousands; the page shows the first page of each and asks for the next as you scroll
// (moreDeals). Through steamApi.storeGet, so a "slow down" from Steam pauses every store call.
const SPECIAL_SORTS = { rev: { sort_by: 'Reviews_DESC' }, top: { filter: 'topsellers' } }
async function specialsPage(kind, page) {
  try {
    const r = await steam().storeGet('https://store.steampowered.com/search/results/', {
      timeout: 15000, headers: UA,
      params: { specials: 1, category1: 998, infinite: 1, start: page * 100, count: 100, cc: country(), supportedlang: 'english', ...SPECIAL_SORTS[kind] },
    })
    const ids = [...new Set([...String(r.data?.results_html || '').matchAll(/data-ds-appid="(\d+)"/g)].map(m => Number(m[1])))]
    return { ids, total: Number(r.data?.total_count) || 0, ok: true }
  } catch (e) {
    return { ids: [], total: 0, ok: false, error: e.message }
  }
}

async function specialsIds() {
  const [best, sellers] = await Promise.all([specialsPage('rev', 0), specialsPage('top', 0)])
  return { ids: [...new Set([...best.ids, ...sellers.ids])], ok: best.ok || sellers.ok, totals: { rev: best.total, top: sellers.total } }
}

// Pure. Is there more of one list to ask for? At most 12 pages of each (1,200 sales).
const MAX_SPECIAL_PAGES = 12
function cursorDone(page, total, max = MAX_SPECIAL_PAGES) {
  return page >= max || (total > 0 && page * 100 >= total)
}
// Pure. The ids not seen yet.
function freshIds(ids, seen) {
  return [...new Set((ids || []).map(Number))].filter(id => id > 0 && !seen.has(id))
}

// GetItems with prices (in this PC's currency), tags, reviews and art.
async function priced(appIds) {
  const ids = [...new Set(appIds.map(Number).filter(n => n > 0))]
  const out = new Map()
  const batches = []
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50))
  await Promise.all(batches.map(async (batch) => {
    try {
      const input = {
        ids: batch.map(appid => ({ appid })),
        context: { language: 'english', country_code: country() },
        data_request: { include_assets: true, include_tag_count: 20, include_reviews: true, include_release: true, include_all_purchase_options: true, include_basic_info: true },
      }
      const r = await axios().get('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/', { timeout: 15000, params: { input_json: JSON.stringify(input) } })
      for (const it of r.data?.response?.store_items || []) {
        const p = it.best_purchase_option
        const rv = it.reviews?.summary_filtered
        const a = it.assets
        const end = p?.active_discounts?.map(d => Number(d.discount_end_date) || 0).filter(Boolean).sort()[0] || null
        out.set(it.appid, {
          appid: it.appid,
          name: it.name || '',
          type: it.type ?? null,
          tags: (it.tags || []).map(t => ({ id: t.tagid, w: t.weight || 0 })),
          reviews: rv ? { count: rv.review_count || 0, pct: rv.percent_positive || 0, label: rv.review_score_label || '' } : null,
          releasedAt: it.release?.steam_release_date ? it.release.steam_release_date * 1000 : null,
          header: steam().assetUrl(a, 'header_2x', 'header'),
          capsule: steam().assetUrl(a, 'main_capsule_2x', 'main_capsule'),
          portrait: steam().assetUrl(a, 'library_capsule_2x', 'library_capsule'),
          price: p ? {
            final: Number(p.final_price_in_cents) || 0,
            original: Number(p.original_price_in_cents) || Number(p.final_price_in_cents) || 0,
            pct: p.discount_pct || 0,
            finalText: p.formatted_final_price || null,
            originalText: p.formatted_original_price || null,
            endsAt: end ? end * 1000 : null,
          } : null,
          developers: (it.basic_info?.developers || []).map(d => d.name).filter(Boolean),
        })
      }
    } catch (e) { logger.warn('deals: GetItems failed', { message: e.message }) }
  }))
  return out
}

// ── CheapShark: other stores and the all-time low (USD) ────────────────────
let storeNames = null
async function stores() {
  if (storeNames) return storeNames
  try {
    const r = await axios().get('https://www.cheapshark.com/api/1.0/stores', { timeout: 10000, headers: UA })
    const names = new Map((r.data || []).map(s => [String(s.storeID), s.storeName]))
    if (names.size) storeNames = names   // a failed call is asked again next time
    return names
  } catch { return new Map() }
}

// CheapShark is a small free API that answers 429 to bursts: few calls, one
// at a time, and a 15-minute pause after a 429.
let backoffUntil = 0
async function cs(params) {
  if (Date.now() < backoffUntil) throw new Error('rate limited')
  try {
    return (await axios().get('https://www.cheapshark.com/api/1.0/' + params.path, { timeout: 15000, headers: UA, params: params.q })).data
  } catch (e) {
    if (e.response?.status === 429) backoffUntil = Date.now() + 15 * 60 * 1000
    throw e
  }
}
const pause = (ms) => new Promise(r => setTimeout(r, ms))

// steam appids -> CheapShark game ids, 25 per call. storeID=1 answers one row per
// game, on sale or not, so a call can't run past its page and leave games out.
// A failed call stops here; the rest are asked next time.
async function learnGameIds(appIds) {
  const now = Date.now()
  const todo = appIds.filter(id => !gameIdOf.has(id) && !(now - (unknownAt.get(id) || 0) < UNKNOWN_TTL))
  for (let i = 0; i < todo.length; i += 25) {
    const chunk = todo.slice(i, i + 25)
    try {
      const list = await cs({ path: 'deals', q: { storeID: 1, steamAppID: chunk.join(','), pageSize: 60 } })
      for (const d of list || []) if (d.steamAppID && d.gameID) gameIdOf.set(Number(d.steamAppID), d.gameID)
      for (const id of chunk) if (!gameIdOf.has(id)) unknownAt.set(id, Date.now())
    } catch { break }
    await pause(400)
  }
}

// steam appids -> Map(appid -> { lowest, lowestDate, steamUsd, best, stores })
async function lowInfo(appIds) {
  const out = new Map()
  const need = []
  for (const id of appIds) {
    const hit = lowCache.get(id)
    if (hit && Date.now() - hit.at < LOW_TTL) { if (hit.info) out.set(id, hit.info) } else need.push(id)
  }
  if (!need.length) return out
  const names = await stores()
  await learnGameIds(need)
  // 25 games per call: all-time low and every store's current deal.
  const byGame = need.filter(id => gameIdOf.has(id)).map(id => [id, gameIdOf.get(id)])
  for (let i = 0; i < byGame.length; i += 25) {
    const chunk = byGame.slice(i, i + 25)
    try {
      const data = await cs({ path: 'games', q: { ids: chunk.map(([, g]) => g).join(',') } })
      for (const [appid, gid] of chunk) {
        const g = data?.[gid]
        if (!g) continue
        const deals = (g.deals || []).map(d => ({ store: names.get(String(d.storeID)) || 'Store', storeID: String(d.storeID), price: Number(d.price), retail: Number(d.retailPrice) || null, dealID: d.dealID }))
        const steamDeal = deals.find(d => d.storeID === '1')
        const best = deals.slice().sort((x, y) => x.price - y.price)[0] || null
        const info = {
          lowest: g.cheapestPriceEver ? Number(g.cheapestPriceEver.price) : null,
          lowestDate: g.cheapestPriceEver?.date ? g.cheapestPriceEver.date * 1000 : null,
          steamUsd: steamDeal ? steamDeal.price : null,
          steamRetail: steamDeal ? steamDeal.retail : null,
          best: best && steamDeal && best.price < steamDeal.price - 0.01
            ? { store: best.store, price: best.price, save: Math.round((1 - best.price / steamDeal.price) * 100), url: dealUrl(best.dealID) }
            : null,
          stores: deals.map(d => ({ store: d.store, storeID: d.storeID, price: d.price, retail: d.retail, url: dealUrl(d.dealID) })).sort((x, y) => x.price - y.price),
        }
        lowCache.set(appid, { at: Date.now(), info })
        out.set(appid, info)
      }
    } catch (e) { logger.debug('deals: CheapShark failed', { message: e.message }); break }
    await pause(400)
  }
  return out
}

function dealUrl(dealID) { return `https://www.cheapshark.com/redirect?dealID=${dealID}` }

// ── Your taste: Steam tags of what you play and rate highly ────────────────
// Kept an hour: Discounts' next pages and Upcoming's calendar both ask for it.
let tasteMemo = null
async function tasteVector() {
  if (tasteMemo && Date.now() - tasteMemo.at < 3600000) return tasteMemo.vec
  const vec = await computeTaste()
  tasteMemo = { at: Date.now(), vec }
  return vec
}
function forgetTaste() { tasteMemo = null }
async function computeTaste() {
  const db = require('../db/database').getDb()
  const w = new Map()
  for (const g of db.prepare('SELECT steam_app_id AS appid, total_playtime_seconds AS secs FROM games WHERE steam_app_id IS NOT NULL AND is_archived = 0').all()) {
    w.set(Number(g.appid), (w.get(Number(g.appid)) || 0) + 1 + Math.log1p((g.secs || 0) / 3600))
  }
  for (const r of db.prepare('SELECT steam_app_id AS appid, rating, status FROM game_list WHERE steam_app_id IS NOT NULL').all()) {
    const id = Number(r.appid), rating = Number(r.rating) || 0
    let add = r.status === 'finished' ? 1.5 : r.status === 'playing' ? 1 : 0
    if (rating >= 8) add += 3; else if (rating >= 6) add += 1
    if (r.status === 'dropped' || (rating > 0 && rating <= 4)) { w.delete(id); continue }
    if (add) w.set(id, (w.get(id) || 0) + add)
  }
  const seeds = [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  if (!seeds.length) return null
  const facts = await steam().getGameFacts(seeds.map(([id]) => id))
  const vec = new Map()
  for (const [id, weight] of seeds) {
    const f = facts.get(id)
    ;(f?.tags || []).slice(0, 20).forEach((t, i) => vec.set(t.id, (vec.get(t.id) || 0) + weight * (1 - i / 22) ** 2))
  }
  return vec.size ? vec : null
}

// Tags almost every game has, and adult ones: never a reason on their own.
const GENERIC = new Set(['Singleplayer', 'Multiplayer', 'Action', 'Adventure', 'Indie', 'Casual', '2D', '3D', 'Great Soundtrack', 'Atmospheric', 'Story Rich', 'Colorful', 'Cute', 'Funny', 'Simulation', 'Strategy', 'RPG', 'Early Access', 'Free to Play', 'Co-op', 'Online Co-Op', 'PvP', 'PvE', 'Controller', 'Family Friendly', 'Beautiful', 'Classic', 'Female Protagonist', 'Third Person', 'First-Person', 'Nudity', 'Sexual Content', 'Mature', 'NSFW', 'Hentai'])

// Pure: 0..1 closeness of a game's tags to the taste vector.
function tasteMatch(vec, tags) {
  if (!vec || !tags?.length) return 0
  let dot = 0, cn = 0
  tags.slice(0, 20).forEach((t, i) => { const x = (1 - i / 22) ** 2; cn += x * x; dot += x * (vec.get(t.id) || 0) })
  const vn = Math.sqrt([...vec.values()].reduce((a, b) => a + b * b, 0)) || 1
  return dot / (vn * (Math.sqrt(cn) || 1))
}

// Pure: is a sale worth showing to someone who hasn't asked for this game? Steam's own
// "Very Positive" line: 80% or more, of at least 500 reviews (the maker's call: the page
// filled with tiny games at 100% of a dozen reviews). Game List games always show.
const MIN_REVIEWS = 500
const MIN_POSITIVE = 80
function wellReviewed(reviews) {
  return (reviews?.count || 0) >= MIN_REVIEWS && (reviews?.pct || 0) >= MIN_POSITIVE
}

// Pure: the deal score (0..99). Discount depth, review quality (a Wilson
// lower bound, so 20 reviews at 100% do not beat 50,000 at 95%) and your
// taste; an all-time low adds a bonus, a "sale" above the usual low loses some.
function dealScore({ pct, reviews, match, low }) {
  const n = reviews?.count || 0, p = (reviews?.pct || 0) / 100, z = 1.96
  const quality = n ? (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n) : 0.4
  let s = 100 * (0.35 * Math.min(1, (pct || 0) / 90) + 0.35 * quality + 0.3 * Math.min(1, match || 0))
  if (low === 'lowest') s += 8
  else if (low === 'above') s -= 6
  return Math.max(1, Math.min(99, Math.round(s)))
}

// Where today's Steam price sits against the all-time low.
function lowState(info) {
  if (!info?.lowest || info.steamUsd == null) return null
  if (info.steamUsd <= info.lowest * 1.02 + 0.01) return 'lowest'
  if (info.steamUsd <= info.lowest * 1.25) return 'near'
  return 'above'
}

// Pure: an amount in the same format as a price Steam wrote for this country,
// so "$19.99" gives "$10.00", "19,99€" gives "10,00€", "₹ 1,299" gives "₹ 1,000".
// Steam's cents are always the price times 100, also for currencies with no
// decimals, so the number of decimals comes from the sample.
function moneyText(cents, sample) {
  const value = Math.max(0, Number(cents) || 0) / 100
  const text = String(sample || '')
  const m = text.match(/\d[\d\s.,'\u00a0\u202f]*\d|\d/)
  if (!m) return value.toFixed(2)
  const num = m[0]
  const dec = num.match(/([.,])(\d{1,2})$/)
  const body = dec ? num.slice(0, -dec[0].length) : num
  const group = body.match(/\D/)?.[0] ?? null
  const [whole, frac] = value.toFixed(dec ? dec[2].length : 0).split('.')
  const out = (group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, group) : whole) + (dec ? dec[1] + frac : '')
  return text.replace(num, () => out)
}

// Pure: where a price alert stands.
function targetState({ final, target, targetCc, cc }) {
  if (target == null) return null
  if (targetCc && cc && targetCc !== cc) return 'currency'
  if (final == null) return 'unknown'
  return final <= target ? 'reached' : 'waiting'
}

// Pure: what to do with alerts after a price check. An alert speaks once when
// the price reaches it, and only again after the price has gone back above it.
// No answer from Steam, or another currency, changes nothing.
function alertChanges(alerts) {
  return {
    fire: alerts.filter(a => a.state === 'reached' && !a.hit),
    clear: alerts.filter(a => a.state === 'waiting' && a.hit),
  }
}

// ── Price alerts ───────────────────────────────────────────────────────────
function targetRows() {
  return require('../db/database').getDb().prepare(`
    SELECT id, name, steam_app_id AS appid, banner_url, price_target_cents AS target,
           price_target_cc AS targetCc, price_target_hit AS hit
    FROM game_list WHERE price_target_cents IS NOT NULL AND steam_app_id IS NOT NULL
  `).all()
}
function ownedIds() {
  return new Set(require('../db/database').getDb().prepare('SELECT steam_app_id AS id FROM games WHERE steam_app_id IS NOT NULL').all().map(r => Number(r.id)))
}

function buildAlerts(rows, facts, owned) {
  const cc = country()
  return rows.filter(r => !owned.has(Number(r.appid))).map(r => {
    const id = Number(r.appid), f = facts.get(id), info = lowCache.get(id)?.info || null
    const state = targetState({ final: f?.price ? f.price.final : null, target: r.target, targetCc: r.targetCc, cc })
    const { fix, convert } = alertFixes({ state, target: r.target, targetCc: r.targetCc, price: f?.price, info })
    const money = (c) => (c != null && f?.price?.finalText ? moneyText(c, f.price.finalText) : null)
    return {
      listId: r.id, appid: id, name: f?.name || r.name, hit: !!r.hit,
      state,
      header: f?.header || null, capsule: f?.capsule || null, portrait: f?.portrait || r.banner_url || null,
      price: f?.price || null, target: r.target,
      targetText: money(r.target),
      lowest: info?.lowest ?? null, lowestDate: info?.lowestDate ?? null,
      fix, fixText: money(fix), convert, convertText: money(convert),
    }
  }).sort((a, b) => (a.state === 'reached' ? 0 : 1) - (b.state === 'reached' ? 0 : 1) || a.name.localeCompare(b.name))
}

// Applies alertChanges: the toast, and the row's "already told" flag.
function applyAlerts(alerts) {
  const { fire, clear } = alertChanges(alerts)
  if (!fire.length && !clear.length) return
  const set = require('../db/database').getDb().prepare('UPDATE game_list SET price_target_hit = ? WHERE id = ?')
  for (const a of fire) { set.run(1, a.listId); a.hit = true }
  for (const a of clear) { set.run(0, a.listId); a.hit = false }
  if (clear.length) {
    // Reached again later is news again: the badge may come back.
    const gone = new Set(clear.map(a => alertKey(a.appid)))
    try { settings().setSetting('deals_seen', JSON.stringify(seen().filter(k => !gone.has(k)))) } catch {}
  }
  if (fire.length) {
    const games = fire.map(a => ({ name: a.name, artUrl: a.portrait || a.header, priceText: a.price?.finalText || null, targetText: a.targetText }))
    const one = games.length === 1 ? games[0] : null
    require('./notifications').notify({
      kind: 'price',
      title: one ? `${one.name} is at your price` : `${games.length} games reached your price`,
      body: one ? (one.priceText ? `Now ${one.priceText} on Steam. Your alert was ${one.targetText}.` : 'See it under Discounts.') : listNames(games),
      artUrl: games[0].artUrl, open: '/deals?tab=mine',
      overlay: () => require('../overlayWindow').sendPriceFlash({ games }),
    }).catch(e => logger.warn('deals: price notice failed', { message: e.message }))
  }
}

function listNames(list, max = 4) {
  const shown = list.slice(0, max).map(g => g.name).join(', ')
  return list.length > max ? `${shown} and ${list.length - max} more` : shown
}

// Pure: which sales on your Game List are news. `yours` = the games you want that are on sale
// now, `state` = what was said before ({ day, sales: { appid: key }, lows: { appid: key } }, or
// null the very first time), `today` = the local day. A sale is news once (its key is the
// discount and its end); new sales are said at most once a day, grouped, and wait for the next
// day otherwise. A game at its lowest price ever is said once per sale. The first run only
// remembers what is on sale already: 63 games at once would say nothing useful.
function saleNews(yours, state, today) {
  const key = (g) => `${g.price?.pct || 0}:${g.price?.endsAt || ''}`
  const first = !state
  const prev = state || { day: null, sales: {}, lows: {} }
  const next = { day: prev.day, sales: {}, lows: {} }
  const fresh = [], lows = []
  for (const g of yours || []) {
    const id = String(g.appid), k = key(g)
    if (prev.sales[id] === k) next.sales[id] = k
    else if (!first) fresh.push(g)
    else next.sales[id] = k
    if (g.low === 'lowest') {
      if (prev.lows[id] !== k && !first) lows.push(g)
      next.lows[id] = k
    }
  }
  let sales = []
  if (fresh.length && prev.day !== today) {
    sales = fresh
    for (const g of fresh) next.sales[String(g.appid)] = key(g)
    next.day = today
  }
  return { sales, lows, next }
}

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// After a price check: tell the user about new sales on the Game List and new lowest prices.
function announceSales(yours) {
  try {
    let state = null
    try { state = JSON.parse(settings().getSetting('deals_notified') || 'null') } catch {}
    const { sales, lows, next } = saleNews(yours, state, localDay())
    settings().setSetting('deals_notified', JSON.stringify(next))
    const n = require('./notifications')
    const art = (g) => g?.header || g?.portrait || null
    const deal = (g) => `-${g.price.pct}% · ${g.price.finalText}${g.price.originalText ? ` (was ${g.price.originalText})` : ''}`
    if (lows.length) {
      const one = lows.length === 1 ? lows[0] : null
      const title = one ? `${one.name} is at its lowest price ever` : `${lows.length} games on your list are at their lowest price ever`
      const body = one ? `${deal(one)} on Steam.` : listNames(lows)
      n.notify({ kind: 'lowest', title, body, artUrl: art(lows[0]), open: '/deals?tab=mine',
        overlay: n.overlayNotice({ kind: 'lowest', header: 'Lowest price ever', title: one ? one.name : title, body, artUrl: art(lows[0]) }) })
        .catch(() => {})
    }
    const sale = sales.filter(g => !lows.includes(g)).sort((a, b) => (b.price?.pct || 0) - (a.price?.pct || 0))
    if (sale.length) {
      const one = sale.length === 1 ? sale[0] : null
      const title = one ? `${one.name} is on sale` : `${sale.length} games on your list are on sale`
      const body = one ? `${deal(one)} on Steam.` : listNames(sale)
      n.notify({ kind: 'sale', title, body, artUrl: art(sale[0]), open: '/deals?tab=mine',
        overlay: n.overlayNotice({ kind: 'sale', header: 'On sale', title: one ? one.name : title, body, artUrl: art(sale[0]) }) })
        .catch(() => {})
    }
  } catch (e) { logger.warn('deals: sale notice failed', { message: e.message }) }
}

// After an alert changes: fresh prices for the alerts only, not the whole page.
async function refreshAlerts() {
  loadDisk()
  await storeCountry()
  const rows = targetRows()
  const facts = await priced(rows.map(r => Number(r.appid)))
  const alerts = buildAlerts(rows, facts, ownedIds())
  applyAlerts(alerts)
  if (cache?.data) {
    cache.data = { ...cache.data, alerts }
    saveDisk()
    broadcast('deals:updated', view(cache.data))
  }
  markNewSales()
  return alerts
}

// Sets (or, with cents = null, removes) a game's price alert. A game not on the
// Game List joins it as Want to play. Already at that price: nothing to announce,
// the window says so itself.
async function setTarget(appid, cents, meta = {}) {
  await storeCountry()
  const db = require('../db/database').getDb()
  const id = Number(appid)
  if (!(id > 0)) throw new Error('This game has no Steam page.')
  let row = db.prepare('SELECT id FROM game_list WHERE steam_app_id = ?').get(id)
  if (cents == null) {
    if (row) db.prepare('UPDATE game_list SET price_target_cents = NULL, price_target_cc = NULL, price_target_hit = 0 WHERE id = ?').run(row.id)
  } else {
    const value = Math.round(Number(cents))
    if (!Number.isFinite(value) || value < 0) throw new Error('Enter a price.')
    if (!row) row = await addToList(id, meta)
    const now = (await priced([id])).get(id)?.price
    db.prepare('UPDATE game_list SET price_target_cents = ?, price_target_cc = ?, price_target_hit = ? WHERE id = ?')
      .run(value, country(), now && now.final <= value ? 1 : 0, row.id)
  }
  try { require('./autoBackup').markDirty() } catch {}
  await refreshAlerts()
  broadcast('game:updated', null)
  return gamePrices(id)
}

async function addToList(id, { name, banner_url = null } = {}) {
  const db = require('../db/database').getDb()
  const gameListQ = require('../db/queries/gameList')
  let banner = banner_url
  try { banner = (await steam().resolveBannerUrl(id)) || banner } catch {}
  try {
    return gameListQ.addGameListItem({ steam_app_id: id, name: name || `App ${id}`, banner_url: banner, status: 'want_to_play' })
  } catch {
    // The same name with no Steam id: that row is this game.
    const same = db.prepare('SELECT id FROM game_list WHERE lower(name) = lower(?)').get(name || '')
    if (!same) throw new Error('Could not add the game to your Game List.')
    db.prepare('UPDATE game_list SET steam_app_id = ? WHERE id = ?').run(id, same.id)
    return same
  }
}

// "Tell me at its lowest price" from a right-click: a price alert at the deepest discount the game
// has had (lowestTarget), through setTarget, which tells you once when Steam's price gets there.
async function alertAtLowest(appid, meta = {}) {
  const p = await gamePrices(appid)
  if (p.lowestTarget == null) throw new Error("KoZo doesn't know this game's lowest price yet.")
  await setTarget(appid, p.lowestTarget, meta)
  return { target: p.lowestTarget, text: p.lowestTargetText }
}

// Pure: is a price Steam wrote in US dollars? "$2.29" (the US, Jordan and other countries Steam sells
// to in dollars), not "CDN$ 2.99", "A$ 3.95" or "2,29€".
function isUsd(text) { return /^\$\s?\d/.test(String(text || '').trim()) }

// Pure: the cheapest other store under your own Steam price, both in US dollars (CheapShark lists
// the stores' US prices). Shown instead of Steam's, the maker's call: "if there is a price lower than
// Steam's, display it instead". stores: [{ store, storeID, price, url }], steamCents: your price.
function cheaperStore(stores, steamCents) {
  if (!(steamCents > 0)) return null
  const best = (stores || []).filter(s => String(s.storeID) !== '1' && s.price > 0).sort((a, b) => a.price - b.price)[0]
  if (!best) return null
  const cents = Math.round(best.price * 100)
  if (cents >= steamCents) return null
  return { store: best.store, price: best.price, cents, save: Math.round((1 - cents / steamCents) * 100), url: best.url }
}

// Steam's deepest sales are 90% off. CheapShark's lowest ever is the lowest at ANY store (a key
// shop's bundle price), and CheapShark has no Steam-only low (its deal lookup gives the same
// number), so alerts set from it could never be reached on Steam: HITMAN's was $0.47 with Steam
// at $13.19, Celeste's $0.94. No alert from it goes below 90% off.
const STEAM_DEEPEST = 0.9
// 90% off, rounded down: exactly 90% off is still reachable.
function steamFloor(price) { return price?.original ? Math.max(1, Math.floor(price.original * (1 - STEAM_DEEPEST) + 1e-9)) : null }

// Pure: "tell me at its lowest price", in your money. CheapShark's lowest ever is a US price, so its
// share of Steam's US full price is the deepest discount the game has had; that share of your full
// price is the alert, never below 90% off (STEAM_DEEPEST). In US dollars with no US full price
// known, the lowest ever itself, with the same floor.
function lowestTarget(price, info) {
  if (!price?.original || info?.lowest == null) return null
  const floor = steamFloor(price)
  if (info.steamRetail > 0) return Math.max(floor, Math.round(price.original * Math.min(1, info.lowest / info.steamRetail)))
  return isUsd(price.finalText) ? Math.max(floor, Math.round(info.lowest * 100)) : null
}

// Pure: an alert's one-click fixes. `fix`: the alert is below anything Steam sells for (deeper
// than 90% off), so it can't be reached; the suggestion is the game's lowest price, capped.
// `convert`: the alert was set in US dollars for the US store and this PC buys in another
// country; the same share of the full price here (Pacific Drive's stayed "set in another
// currency" for good). Both null when there's nothing to fix.
function alertFixes({ state, target, targetCc, price, info }) {
  const out = { fix: null, convert: null }
  if (!price?.original) return out
  if (state === 'currency') {
    if (targetCc === 'US' && info?.steamRetail > 0 && target != null) {
      out.convert = Math.max(1, Math.round(target * price.original / Math.round(info.steamRetail * 100)))
    }
    return out
  }
  const floor = steamFloor(price)
  if (state === 'waiting' && target != null && target < floor) out.fix = lowestTarget(price, info) ?? floor
  return out
}

// One game's prices, for its window: Steam's in this PC's currency, the other
// stores, the lowest ever and the alert. Never waits long for CheapShark.
async function gamePrices(appid) {
  loadDisk()
  await storeCountry()
  const db = require('../db/database').getDb()
  const id = Number(appid)
  const [facts, lows] = await Promise.all([
    priced([id]),
    Promise.race([lowInfo([id]).catch(() => new Map()), pause(6000).then(() => new Map())]),
  ])
  const price = facts.get(id)?.price || null
  const info = lows.get(id) || null
  const row = db.prepare('SELECT id, price_target_cents AS target, price_target_cc AS targetCc FROM game_list WHERE steam_app_id = ?').get(id)
  const cc = country(), us = cc === 'US'
  const lowCents = lowestTarget(price, info)
  const offer = (label, cents) => ({ label, cents, text: moneyText(cents, price?.finalText) })
  return {
    cc, us, price, owned: ownedIds().has(id), onList: !!row,
    lowest: info?.lowest ?? null, lowestDate: info?.lowestDate ?? null,
    stores: (info?.stores || []).filter(s => s.storeID !== '1'),
    cheaper: price && isUsd(price.finalText) ? cheaperStore(info?.stores, price.final) : null,
    lowestTarget: lowCents, lowestTargetText: lowCents != null ? moneyText(lowCents, price?.finalText) : null,
    target: row?.target ?? null,
    targetText: row?.target != null && price?.finalText ? moneyText(row.target, price.finalText) : null,
    targetState: targetState({ final: price ? price.final : null, target: row?.target ?? null, targetCc: row?.targetCc, cc }),
    quick: price ? [
      offer('50% off', Math.round(price.original * 0.5)),
      offer('75% off', Math.round(price.original * 0.25)),
      ...(lowCents != null ? [offer('Lowest ever', lowCents)] : []),
    ].filter(q => q.cents > 0 && q.cents < price.final) : [],
  }
}

function shape(f, extra) {
  return {
    appid: f.appid, name: f.name, header: f.header, capsule: f.capsule, portrait: f.portrait,
    header2x: f.header2x, portrait2x: f.portrait2x,
    reviews: f.reviews, releasedAt: f.releasedAt, price: f.price, developers: f.developers,
    ...extra,
  }
}

// One card's data. ctx = { facts, lows, vec, names }.
function buildDeal(ctx, id, mine) {
  const { facts, lows, vec, names } = ctx
  const f = facts.get(id)
  const info = lows.get(id) || null
  const low = lowState(info)
  const match = tasteMatch(vec, f.tags)
  const tagNames = f.tags.slice(0, 20).map(t => names.get(t.id)).filter(Boolean)
  const why = vec ? f.tags.filter(t => vec.has(t.id) && !GENERIC.has(names.get(t.id))).sort((a, b) => vec.get(b.id) - vec.get(a.id)).slice(0, 3).map(t => names.get(t.id)).filter(Boolean) : []
  return shape(f, {
    mine,
    match: Math.round(match * 100),
    score: dealScore({ pct: f.price.pct, reviews: f.reviews, match, low }),
    low, lowest: info?.lowest ?? null, lowestDate: info?.lowestDate ?? null,
    elsewhere: isUsd(f.price?.finalText) ? cheaperStore(info?.stores, f.price?.final) : null,
    tags: tagNames.slice(0, 4), why,
  })
}

function wantedIds(owned) {
  const db = require('../db/database').getDb()
  const wantedRows = db.prepare(`SELECT id, name, status, steam_app_id AS appid FROM game_list WHERE steam_app_id IS NOT NULL AND status IN (${WANT.map(() => '?').join(',')})`).all(...WANT)
  return [...new Set(wantedRows.map(r => Number(r.appid)))].filter(id => !owned.has(id))
}

// How far down Steam's lists the page has gone (moreDeals), kept a day so the hourly refresh
// prices those games again instead of dropping what was scrolled to.
const EXTRA_KEEP_MS = 24 * 3600000
function depthOf(c) {
  const m = c?.more
  if (!m || !m.extraAt || Date.now() - m.extraAt > EXTRA_KEEP_MS) return { cursor: { rev: 1, top: 1 }, totals: {}, extraIds: [], extraAt: 0 }
  return { cursor: m.cursor || { rev: 1, top: 1 }, totals: m.totals || {}, extraIds: m.extraIds || [], extraAt: m.extraAt }
}
const hasMore = (d) => !(cursorDone(d.cursor.rev, d.totals.rev) && cursorDone(d.cursor.top, d.totals.top))

async function compute() {
  loadDisk()
  await storeCountry()
  const owned = ownedIds()
  const wantIds = wantedIds(owned)

  const [specials, vec] = await Promise.all([specialsIds(), tasteVector().catch(() => null)])
  // Steam's search failed (a "slow down", no network): keep the last list rather than replace
  // it with an empty one for an hour. Asked again in 5 minutes.
  if (!specials.ok && cache?.data?.deals?.length) {
    logger.warn('deals: Steam search failed, keeping the last list')
    retryAt = Date.now() + 5 * 60000
    return view(cache.data)
  }
  const depth = depthOf(cache)
  depth.totals = { ...depth.totals, ...Object.fromEntries(Object.entries(specials.totals || {}).filter(([, v]) => v)) }
  const specialIds = [...new Set([...specials.ids, ...depth.extraIds])]
  const alertRows = targetRows()
  const facts = await priced([...wantIds, ...alertRows.map(r => Number(r.appid)), ...specialIds])
  const names = await steam().getTagNames().catch(() => new Map())
  const topTags = vec ? [...vec.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => names.get(id)).filter(n => n && !GENERIC.has(n)).slice(0, 6) : []

  const onSale = (id) => { const f = facts.get(id); return f && f.price && f.price.pct > 0 && f.type === 0 ? f : null }
  const yoursIds = wantIds.filter(onSale)
  const dealIds = specialIds.filter(id => onSale(id) && wellReviewed(facts.get(id).reviews) && !owned.has(id) && !wantIds.includes(id))
  // CheapShark: your list, plus the Steam deals it knows (a few calls).
  // The page never waits long for it: after 5 seconds it shows what is known,
  // and the rest arrives with a deals:updated push when CheapShark answers.
  const lowIds = [...new Set([...alertRows.map(r => Number(r.appid)).filter(id => !owned.has(id)), ...yoursIds, ...dealIds])]
  const lowRun = lowInfo(lowIds).catch(() => new Map())
  let lows = await Promise.race([lowRun, pause(5000).then(() => null)])
  const late = !lows
  if (late) lows = new Map(lowIds.map(id => [id, lowCache.get(id)?.info]).filter(([, v]) => v))
  // Store prices outside Steam are US prices: compared only when Steam's are too.
  const us = country() === 'US'

  const build = (id, mine) => buildDeal({ facts, lows, vec, names, us }, id, mine)
  const assemble = () => ({
    cc: country(),
    at: new Date().toISOString(),
    taste: topTags,
    yours: yoursIds.map(id => build(id, true)).sort((a, b) => b.score - a.score),
    deals: dealIds.map(id => build(id, false)).sort((a, b) => b.score - a.score),
    wantedCount: wantIds.length,
    alerts: buildAlerts(alertRows, facts, owned),
    more: hasMore(depth),
  })
  const data = assemble()
  applyAlerts(data.alerts)
  cache = { at: Date.now(), cc: data.cc, data, more: depth }
  saveDisk()
  markNewSales()
  if (!late) announceSales(view(data).yours)
  if (late) {
    lowRun.then((full) => {
      lows = full
      const again = assemble()
      again.alerts = again.alerts.map(a => ({ ...a, hit: data.alerts.find(x => x.listId === a.listId)?.hit ?? a.hit }))
      cache = { at: Date.now(), cc: again.cc, data: again, more: cache?.more || depth }
      saveDisk()
      broadcast('deals:updated', view(again))
      // Said once CheapShark has answered, so a lowest price isn't missed.
      announceSales(view(again).yours)
    })
  }
  return view(data)
}

function broadcast(channel, payload) {
  for (const w of require('electron').BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, payload) } catch {}
  }
}

// Sidebar badge: Game List games newly on sale since you last opened Deals.
// A reached price alert counts too, under its own key: a game can have been seen
// on sale long before it reached your price.
function seen() { try { return JSON.parse(settings().getSetting('deals_seen') || '[]') } catch { return [] } }
function alertKey(appid) { return `alert:${appid}` }
function reachedKeys(v) { return (v?.alerts || []).filter(a => a.state === 'reached').map(a => alertKey(a.appid)) }
function unseen() {
  loadDisk()
  const s = new Set(seen())
  const v = view(cache?.data)
  return [...(v?.yours || []).map(g => g.appid), ...reachedKeys(v)].filter(k => !s.has(k))
}
// The same, with names, for the sidebar badge's tooltip and the New pills on the page (the
// maker saw "a number on the discount but I don't know what game for").
function unseenDetails() {
  loadDisk()
  const s = new Set(seen())
  const v = view(cache?.data)
  const sales = (v?.yours || []).filter(g => !s.has(g.appid)).map(g => ({ appid: g.appid, name: g.name }))
  const reached = (v?.alerts || []).filter(a => a.state === 'reached' && !s.has(alertKey(a.appid))).map(a => ({ appid: a.appid, name: a.name }))
  return { count: sales.length + reached.length, sales, reached }
}
function markNewSales() { broadcast('deals:changed', unseen().length) }
function markSeen() {
  loadDisk()
  const v = view(cache?.data)
  settings().setSetting('deals_seen', JSON.stringify([...(v?.yours || []).map(g => g.appid), ...reachedKeys(v)]))
  markNewSales()
  return true
}

// Game List games on sale, for the badge on their cards (the maker: "-50%" in the Game List,
// not only on Discounts). The stored answer only, never a request: the 6-hourly refresh and
// the Discounts page keep it current. A sale past its end, or an answer over 2 days old, says
// nothing.
function saleMap() {
  loadDisk()
  if (!cache?.data || Date.now() - (cache.at || 0) > 2 * 86400000) return {}
  const now = Date.now()
  const out = {}
  for (const g of view(cache.data).yours || []) {
    if (!(g.price?.pct > 0)) continue
    if (g.price.endsAt && g.price.endsAt < now) continue   // endsAt is in ms
    out[g.appid] = { pct: g.price.pct, finalText: g.price.finalText || null, originalText: g.price.originalText || null, lowest: g.low === 'lowest' }
  }
  return out
}

// Cached answer at once (memory or disk); refreshed in the background when
// older than an hour. `force`, or prices for another country, wait for a fresh one: another
// country's prices are wrong prices, not old ones.
let retryAt = 0
async function getDeals({ force = false } = {}) {
  loadDisk()
  await storeCountry()
  const fresh = cache && cache.cc === country() && (Date.now() - cache.at < TTL || Date.now() < retryAt)
  if (force || !cache || cache.cc !== country()) {
    if (!running) running = compute().finally(() => { running = null })
    return running
  }
  if (!fresh && !running) running = compute().catch(e => logger.warn('deals: refresh failed', { message: e.message })).finally(() => { running = null })
  // As the Game List is now; and a list saved before the review floor existed loses its small games.
  return view(cache.data)
}

// Pure: a stored answer as the Game List is NOW. `want` = the Steam ids you want and don't own,
// `owned` = in the Library, `alertIds` = Game List rows with a price alert. A game taken off
// the Game List stayed under "On your Game List" until the hourly refresh; now it leaves at
// once (and is one of the other deals, if it is one), and a deal you add moves up there.
function currentView(data, want, owned = new Set(), alertIds = null) {
  if (!data) return data
  const yours = [], deals = []
  const keep = (g) => !owned.has(Number(g.appid))
  for (const g of data.yours || []) {
    if (want.has(Number(g.appid))) yours.push(g)
    else if (keep(g) && wellReviewed(g.reviews)) deals.push({ ...g, mine: false })
  }
  for (const g of data.deals || []) {
    if (want.has(Number(g.appid))) yours.push({ ...g, mine: true })
    else if (keep(g) && wellReviewed(g.reviews)) deals.push(g)
  }
  return {
    ...data,
    yours: yours.sort((a, b) => b.score - a.score),
    deals,
    wantedCount: want.size,
    alerts: alertIds ? (data.alerts || []).filter(a => alertIds.has(a.listId)) : (data.alerts || []),
  }
}
function view(data) {
  if (!data) return data
  try {
    const owned = ownedIds()
    return currentView(data, new Set(wantedIds(owned)), owned, new Set(targetRows().map(r => r.id)))
  } catch { return data }
}

// The Game List changed (ipc.js: add, edit, delete, untrack, to the Library): an open
// Discounts page and the sidebar badge follow at once, from the stored answer.
function listChanged() {
  loadDisk()
  if (!cache?.data) return
  broadcast('deals:updated', view(cache.data))
  markNewSales()
}

// The Discounts window's Add / Remove: is this Steam game on the Game List, or in the Library.
function listState(appid) {
  const id = Number(appid)
  const row = require('../db/database').getDb()
    .prepare('SELECT id, status, game_id FROM game_list WHERE steam_app_id = ? ORDER BY game_id IS NOT NULL LIMIT 1').get(id)
  return { onList: !!row, listId: row?.id ?? null, status: row?.status ?? null, owned: ownedIds().has(id) }
}

// Takes a Steam game off the Game List from the Discounts window (its price alert with it).
// A row tied to a Library game stays: every Library game keeps its row.
function removeFromList(appid) {
  const id = Number(appid)
  const db = require('../db/database').getDb()
  const gameListQ = require('../db/queries/gameList')
  const rows = db.prepare('SELECT id FROM game_list WHERE steam_app_id = ? AND game_id IS NULL').all(id)
  for (const r of rows) gameListQ.deleteGameListItem(r.id)
  if (rows.length) {
    try { require('./autoBackup').markDirty() } catch {}
    broadcast('game:updated', null)
    listChanged()
  }
  return listState(id)
}

// The next page of Steam's sales, when Discounts is scrolled to its end. Up to three rounds
// (a page can hold nothing new: Steam's best-reviewed order goes band by band), stopping once
// a dozen or more were added. Returns the same shape as getDeals.
let moreRun = null
function moreDeals() {
  if (!moreRun) moreRun = fetchMoreDeals().finally(() => { moreRun = null })
  return moreRun
}

async function fetchMoreDeals() {
  loadDisk()
  await storeCountry()
  if (!cache?.data) await getDeals({ force: true })
  if (!cache?.data) return { deals: [], more: false }
  const depth = depthOf(cache)
  const owned = ownedIds()
  const wantIds = wantedIds(owned)
  const seen = new Set([...(cache.data.deals || []), ...(cache.data.yours || []), ...(cache.data.alerts || [])].map(g => Number(g.appid)))
  for (const id of [...owned, ...wantIds, ...depth.extraIds]) seen.add(Number(id))
  const [vec, names] = await Promise.all([tasteVector().catch(() => null), steam().getTagNames().catch(() => new Map())])
  const us = country() === 'US'
  const added = []
  let failed = false
  for (let round = 0; round < 3 && added.length < 12 && hasMore(depth); round++) {
    const kinds = ['rev', 'top'].filter(k => !cursorDone(depth.cursor[k], depth.totals[k]))
    const pages = await Promise.all(kinds.map(k => specialsPage(k, depth.cursor[k])))
    if (pages.every(p => !p.ok)) { failed = true; break }
    kinds.forEach((k, i) => {
      if (!pages[i].ok) return
      depth.cursor[k]++
      if (pages[i].total) depth.totals[k] = pages[i].total
      if (!pages[i].ids.length) depth.totals[k] = depth.cursor[k] * 100   // an empty page: the end
    })
    const fresh = freshIds(pages.flatMap(p => p.ids), seen)
    for (const id of fresh) seen.add(id)
    depth.extraIds.push(...fresh)
    if (!fresh.length) continue
    const facts = await priced(fresh)
    const keep = fresh.filter(id => {
      const f = facts.get(id)
      return f && f.price && f.price.pct > 0 && f.type === 0 && wellReviewed(f.reviews)
    })
    if (!keep.length) continue
    const lowRun = lowInfo(keep).catch(() => new Map())
    let lows = await Promise.race([lowRun, pause(5000).then(() => null)])
    if (!lows) lows = new Map(keep.map(id => [id, lowCache.get(id)?.info]).filter(([, v]) => v))
    added.push(...keep.map(id => buildDeal({ facts, lows, vec, names, us }, id, false)))
  }
  if (!depth.extraAt) depth.extraAt = Date.now()
  const have = new Set((cache.data.deals || []).map(g => g.appid))
  const data = { ...cache.data, deals: [...(cache.data.deals || []), ...added.filter(g => !have.has(g.appid))], more: failed || hasMore(depth) }
  cache = { ...cache, data, more: depth }
  saveDisk()
  logger.info('deals: more', { added: added.length, cursor: depth.cursor, failed })
  return { ...view(data), ...(failed ? { error: 'Steam did not answer. Scroll again in a moment.' } : {}) }
}

// Background: every 6 hours when no game is running, so the badge appears on
// its own when something you want goes on sale.
let timer = null
function start() {
  if (timer) return
  const tick = () => {
    try { require('./processWatcher').runWhenIdle('dealsRefresh', () => { compute().catch(() => {}) }) } catch {}
  }
  setTimeout(tick, 5 * 60 * 1000)
  timer = setInterval(tick, 6 * 60 * 60 * 1000)
}

module.exports = { getDeals, moreDeals, saleMap, gamePrices, setTarget, refreshAlerts, lowInfo, markSeen, unseen, start, dealScore, wellReviewed, tasteMatch, tasteVector, forgetTaste, lowState, moneyText, targetState, alertChanges, cursorDone, freshIds,
  listChanged, listState, removeFromList, currentView, ccFromCookies, storeCountry,
  alertAtLowest, isUsd, cheaperStore, lowestTarget, alertFixes, saleNews, unseenDetails, steamFloor,
  // For the checks in scripts/: what a price check says, without a store request.
  announceSales, applyAlerts }
