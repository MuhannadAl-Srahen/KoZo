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
// Prices come from Steam in your own currency (app.getLocaleCountryCode).

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
function country() {
  try { return (require('electron').app.getLocaleCountryCode() || 'US').toUpperCase() } catch { return 'US' }
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
    if (d?.data && !cache) cache = { at: d.at, cc: d.cc, data: d.data }
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
async function specialsIds() {
  const get = (params) => axios().get('https://store.steampowered.com/search/results/', {
    timeout: 15000, headers: UA,
    params: { specials: 1, category1: 998, infinite: 1, start: 0, count: 100, cc: country(), supportedlang: 'english', ...params },
  }).then(r => [...new Set([...String(r.data?.results_html || '').matchAll(/data-ds-appid="(\d+)"/g)].map(m => Number(m[1])))]).catch(() => [])
  const [best, sellers] = await Promise.all([get({ sort_by: 'Reviews_DESC' }), get({ filter: 'topsellers' })])
  return [...new Set([...best, ...sellers])]
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
async function tasteVector() {
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
    return {
      listId: r.id, appid: id, name: f?.name || r.name, hit: !!r.hit,
      state: targetState({ final: f?.price ? f.price.final : null, target: r.target, targetCc: r.targetCc, cc }),
      header: f?.header || null, capsule: f?.capsule || null, portrait: f?.portrait || r.banner_url || null,
      price: f?.price || null, target: r.target,
      targetText: f?.price?.finalText ? moneyText(r.target, f.price.finalText) : null,
      lowest: info?.lowest ?? null, lowestDate: info?.lowestDate ?? null,
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
    try {
      require('../overlayWindow').sendPriceFlash({
        games: fire.map(a => ({ name: a.name, artUrl: a.portrait || a.header, priceText: a.price?.finalText || null, targetText: a.targetText })),
      })
    } catch (e) { logger.warn('deals: price toast failed', { message: e.message }) }
  }
}

// After an alert changes: fresh prices for the alerts only, not the whole page.
async function refreshAlerts() {
  loadDisk()
  const rows = targetRows()
  const facts = await priced(rows.map(r => Number(r.appid)))
  const alerts = buildAlerts(rows, facts, ownedIds())
  applyAlerts(alerts)
  if (cache?.data) {
    cache.data = { ...cache.data, alerts }
    saveDisk()
    broadcast('deals:updated', cache.data)
  }
  markNewSales()
  return alerts
}

// Sets (or, with cents = null, removes) a game's price alert. A game not on the
// Game List joins it as Want to play. Already at that price: nothing to announce,
// the window says so itself.
async function setTarget(appid, cents, meta = {}) {
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

// One game's prices, for its window: Steam's in this PC's currency, the other
// stores, the lowest ever and the alert. Never waits long for CheapShark.
async function gamePrices(appid) {
  loadDisk()
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
  const lowCents = us && info?.lowest != null ? Math.round(info.lowest * 100) : null
  const offer = (label, cents) => ({ label, cents, text: moneyText(cents, price?.finalText) })
  return {
    cc, us, price, owned: ownedIds().has(id), onList: !!row,
    lowest: info?.lowest ?? null, lowestDate: info?.lowestDate ?? null,
    stores: (info?.stores || []).filter(s => s.storeID !== '1'),
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
    reviews: f.reviews, releasedAt: f.releasedAt, price: f.price, developers: f.developers,
    ...extra,
  }
}

async function compute() {
  loadDisk()
  const db = require('../db/database').getDb()
  const owned = ownedIds()
  const wantedRows = db.prepare(`SELECT id, name, status, steam_app_id AS appid FROM game_list WHERE steam_app_id IS NOT NULL AND status IN (${WANT.map(() => '?').join(',')})`).all(...WANT)
  const wantIds = [...new Set(wantedRows.map(r => Number(r.appid)))].filter(id => !owned.has(id))

  const [specials, vec] = await Promise.all([specialsIds(), tasteVector().catch(() => null)])
  const alertRows = targetRows()
  const facts = await priced([...wantIds, ...alertRows.map(r => Number(r.appid)), ...specials])
  const names = await steam().getTagNames().catch(() => new Map())
  const topTags = vec ? [...vec.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => names.get(id)).filter(n => n && !GENERIC.has(n)).slice(0, 6) : []

  const onSale = (id) => { const f = facts.get(id); return f && f.price && f.price.pct > 0 && f.type === 0 ? f : null }
  const yoursIds = wantIds.filter(onSale)
  const dealIds = specials.filter(id => onSale(id) && !owned.has(id) && !wantIds.includes(id))
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

  const build = (id, mine) => {
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
      elsewhere: us ? (info?.best || null) : null,
      tags: tagNames.slice(0, 4), why,
    })
  }
  const assemble = () => ({
    cc: country(),
    at: new Date().toISOString(),
    taste: topTags,
    yours: yoursIds.map(id => build(id, true)).sort((a, b) => b.score - a.score),
    deals: dealIds.map(id => build(id, false)).sort((a, b) => b.score - a.score),
    wantedCount: wantIds.length,
    alerts: buildAlerts(alertRows, facts, owned),
  })
  const data = assemble()
  applyAlerts(data.alerts)
  cache = { at: Date.now(), cc: data.cc, data }
  saveDisk()
  markNewSales()
  if (late) {
    lowRun.then((full) => {
      lows = full
      const again = assemble()
      again.alerts = again.alerts.map(a => ({ ...a, hit: data.alerts.find(x => x.listId === a.listId)?.hit ?? a.hit }))
      cache = { at: Date.now(), cc: again.cc, data: again }
      saveDisk()
      broadcast('deals:updated', again)
    })
  }
  return data
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
function reachedKeys() { return (cache?.data?.alerts || []).filter(a => a.state === 'reached').map(a => alertKey(a.appid)) }
function unseen() {
  loadDisk()
  const s = new Set(seen())
  return [...(cache?.data?.yours || []).map(g => g.appid), ...reachedKeys()].filter(k => !s.has(k))
}
function markNewSales() { broadcast('deals:changed', unseen().length) }
function markSeen() {
  loadDisk()
  settings().setSetting('deals_seen', JSON.stringify([...(cache?.data?.yours || []).map(g => g.appid), ...reachedKeys()]))
  markNewSales()
  return true
}

// Cached answer at once (memory or disk); refreshed in the background when
// older than an hour or the country changed. `force` waits for a fresh one.
async function getDeals({ force = false } = {}) {
  loadDisk()
  const fresh = cache && cache.cc === country() && Date.now() - cache.at < TTL
  if (force || !cache) {
    if (!running) running = compute().finally(() => { running = null })
    return running
  }
  if (!fresh && !running) running = compute().catch(e => logger.warn('deals: refresh failed', { message: e.message })).finally(() => { running = null })
  return cache.data
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

module.exports = { getDeals, gamePrices, setTarget, refreshAlerts, lowInfo, markSeen, unseen, start, dealScore, tasteMatch, lowState, moneyText, targetState, alertChanges }
