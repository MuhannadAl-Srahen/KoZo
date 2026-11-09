'use strict'
// Real screenshots for the landing page: the real app from renderer-dist, on a throwaway profile
// with a sample library, off screen, at double resolution. Nothing from the real library is used.
// Every app screenshot is taken in all 12 accent colors (the site swaps them when a visitor
// picks a color): Lime in site/assets/shots, the others in site/assets/shots/<color>/. A
// screenshot is only saved once nothing on it is still loading (no skeleton, every picture
// drawn); one that never finishes fails the run instead of going on the site half loaded.
//   SHOTS_COLORS=lime,pink   only those colors     SHOTS_ONLY=library,big   only those shots
// Rerun it when the app's look changes:
//   npx vite build
//   KOZO_STEAM_KEY=<optional, for real achievement names> env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/site-shots.js
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = path.join(__dirname, '..')
const OUT = path.join(root, 'site', 'assets', 'shots')
fs.mkdirSync(OUT, { recursive: true })
const ONLY = process.env.SHOTS_ONLY ? process.env.SHOTS_ONLY.split(',') : null
// The site's 12 colors (site/js/game.js COLORS and SHOT_DIRS), folder '' = Lime.
const COLORS = [
  ['lime', '#9fff02', ''], ['purple', '#a78bfa', 'purple'], ['blue', '#60a5fa', 'blue'], ['red', '#f87171', 'red'],
  ['green', '#4ade80', 'green'], ['amber', '#fbbf24', 'amber'], ['pink', '#f472b6', 'pink'], ['teal', '#2dd4bf', 'teal'],
  ['tangerine', '#fb923c', 'tangerine'], ['indigo', '#818cf8', 'indigo'], ['sky', '#38bdf8', 'sky'], ['rose', '#fda4af', 'rose'],
].filter(c => !process.env.SHOTS_COLORS || process.env.SHOTS_COLORS.split(',').includes(c[0]))
let failedShots = []

{
  const realTop = BrowserWindow.prototype.setAlwaysOnTop
  BrowserWindow.prototype.setAlwaysOnTop = function (...a) { try { this.setOpacity(0); this.setPosition(-4000, 60) } catch {} return realTop.apply(this, a) }
}
BrowserWindow.prototype.show = function () { this.showInactive() }
BrowserWindow.prototype.focus = function () {}
app.on('browser-window-created', (_e, w) => { try { w.setPosition(-4000, 60); w.webContents.setBackgroundThrottling(false) } catch {} })
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('mute-audio')
app.commandLine.appendSwitch('force-device-scale-factor', '2')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kozo-shots-'))
app.setPath('userData', tmp)
app.setPath('documents', path.join(tmp, 'Documents'))
process.env.KOZO_SMOKE = '1'
process.env.KOZO_RENDERER = 'dist'

// Nothing here may touch real game folders or the real Steam account.
for (const f of ['crackWatcher', 'desktopProbe']) {
  const m = require(path.join(root, 'electron', 'services', `${f}.js`))
  m.start = () => {}; if (m.refresh) m.refresh = () => {}
}
require(path.join(root, 'electron', 'services', 'installCheck.js')).reconcile = async () => ({ checked: 0 })
const sync = require(path.join(root, 'electron', 'services', 'achievementSync.js'))
if (sync.sweepSteamGames) sync.sweepSteamGames = async () => {}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const main = require(path.join(root, 'electron', 'main.js'))

const LIBRARY = [
  // appid, name, status, hours, sessions, rating, unlocked share
  [1245620, 'ELDEN RING', 'playing', 86, 46, null, 0.62],
  [1903340, 'Clair Obscur: Expedition 33', 'playing', 31, 18, null, 0.48],
  [1086940, "Baldur's Gate 3", 'finished', 122, 40, 10, 0.71],
  [1145360, 'Hades', 'finished', 44, 30, 9, 0.84],
  [367520, 'Hollow Knight', 'finished', 38, 20, 10, 0.77],
  [1091500, 'Cyberpunk 2077', 'finished', 71, 25, 9, 0.66],
  [2379780, 'Balatro', 'playing', 27, 22, null, 0.4],
  [1174180, 'Red Dead Redemption 2', 'on_hold', 58, 18, null, 0.35],
  [814380, 'Sekiro: Shadows Die Twice', 'playing', 19, 11, null, 0.3],
  [413150, 'Stardew Valley', null, 64, 24, null, 0.52],
  [292030, 'The Witcher 3: Wild Hunt', 'finished', 93, 28, 10, 0.58],
  [2218750, 'Halls of Torment', null, 12, 9, null, 0.24],
  [1794680, 'Vampire Survivors', null, 22, 15, null, 0.44],
  [2358720, 'Black Myth: Wukong', null, 9, 5, null, 0.2],
]
const WANTED = [
  [1145350, 'Hades II', 'want_to_play', 0], [1627720, 'Lies of P', 'want_to_play', 0], [2215430, "Ghost of Tsushima DIRECTOR'S CUT", 'want_to_play', 0],
  [1850570, "DEATH STRANDING DIRECTOR'S CUT", 'want_to_play', 1], [582010, 'Monster Hunter: World', 'want_to_play', 1], [1868140, 'DAVE THE DIVER', 'want_to_play', 0],
  [990080, 'Hogwarts Legacy', 'want_to_play', 2], [892970, 'Valheim', 'want_to_play', 2],
]
let seed = 1234
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

function monthKey(offset) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

async function seedLibrary(db) {
  const steamApi = require(path.join(root, 'electron', 'services', 'steamApi.js'))
  const gamesQ = require(path.join(root, 'electron', 'db', 'queries', 'games.js'))
  const listQ = require(path.join(root, 'electron', 'db', 'queries', 'gameList.js'))
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(k, v)
  set('onboarding_done', '1')
  set('accent_color', '#9fff02')
  set('appearance', JSON.stringify({ density: 'comfortable', corners: 'default', sidebar: 'full', motion: 'soft', theme: 'custom', bgColor: '#000000', gamePage: 'store', font: 'inter', cardStyle: 'classic', cardGlow: 'soft', glow: 'soft', scrollbar: 'thin', pageWidth: 'full' }))
  set('folder_names_v1', '1')
  if (process.env.KOZO_STEAM_KEY) set('steam_api_key', process.env.KOZO_STEAM_KEY)

  const ids = []
  for (const [appid, name, status, hours] of LIBRARY) {
    const g = gamesQ.addGame({ name, exe_name: `sample-${appid}.exe`, install_path: `C:\\Games\\${name.replace(/[^A-Za-z0-9 ]/g, '')}`, steam_app_id: appid, source: 'steam', is_cracked: 0, is_installed: 1, banner_url: null, banner_local_path: null })
    db.prepare('UPDATE games SET completion_status = ?, total_playtime_seconds = ? WHERE id = ?').run(status, 0, g.id)
    ids.push({ id: g.id, appid, name, status, hours })
    listQ.ensureListRowForGame(gamesQ.getGame(g.id))
  }
  // Art, genres and real achievement lists, a few at a time.
  let next = 0
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (next < ids.length) {
      const g = ids[next++]
      try { const p = await steamApi.downloadBanner(g.appid, g.id); gamesQ.updateGame(g.id, { banner_local_path: p }) } catch (e) { console.log('no banner', g.name, e.message) }
      try { await steamApi.downloadHero(g.appid, g.id) } catch {}
      try { const art = await steamApi.getStoreArt(g.appid); if (art?.genres?.length) gamesQ.updateGame(g.id, { genres: JSON.stringify(art.genres) }) } catch {}
      if (process.env.KOZO_STEAM_KEY) { try { await sync.ensureSchema(g.id, { force: true }) } catch (e) { console.log('no list', g.name, e.message) } }
    }
  }))

  // Sessions: a busy last month and an older spread for the year view.
  const insSession = db.prepare('INSERT INTO sessions (game_id, started_at, ended_at, duration_seconds, achievements_unlocked) VALUES (?, ?, ?, ?, 0)')
  const insUnlock = db.prepare("INSERT OR IGNORE INTO achievement_unlocks (achievement_id, session_id, unlocked_at, source) VALUES (?, ?, ?, 'sample')")
  const DAY = 86400000
  for (const [appid, , , hours, count, rating, share] of LIBRARY) {
    const g = ids.find(x => x.appid === appid)
    const recent = g.status === 'playing' || appid === 413150
    const made = []
    let remaining = hours * 3600
    for (let i = 0; i < count; i++) {
      const dur = i === count - 1 ? Math.max(1500, remaining) : Math.round(Math.max(1500, (hours * 3600 / count) * (0.5 + rnd())))
      remaining = Math.max(0, remaining - dur)
      const daysAgo = recent ? Math.floor(Math.pow(rnd(), 1.5) * 34) : 20 + Math.floor(rnd() * 280)
      const start = new Date(Date.now() - daysAgo * DAY)
      start.setHours(17 + Math.floor(rnd() * 6), Math.floor(rnd() * 60), 0, 0)
      if (start.getTime() > Date.now() - 3600000) start.setTime(start.getTime() - DAY)
      const paused = rnd() < 0.3 ? 300 + Math.floor(rnd() * 1500) : 0
      const end = new Date(start.getTime() + (dur + paused) * 1000)
      const r = insSession.run(g.id, start.toISOString(), end.toISOString(), dur)
      made.push({ id: Number(r.lastInsertRowid), start, end })
    }
    made.sort((a, b) => a.start - b.start)
    const total = db.prepare('SELECT COALESCE(SUM(duration_seconds), 0) s FROM sessions WHERE game_id = ?').get(g.id).s
    db.prepare('UPDATE games SET total_playtime_seconds = ?, first_played_at = ?, last_played_at = ? WHERE id = ?').run(total, made[0].start.toISOString(), made[made.length - 1].end.toISOString(), g.id)

    let achievements = db.prepare('SELECT id FROM achievements WHERE game_id = ?').all(g.id)
    const pick = achievements.filter(() => rnd() < share)
    pick.forEach((a) => {
      const s = made[Math.floor(rnd() * made.length)]
      const at = new Date(s.start.getTime() + rnd() * (s.end - s.start))
      insUnlock.run(a.id, s.id, at.toISOString())
    })
    if (rating) db.prepare('UPDATE game_list SET rating = ? WHERE game_id = ?').run(rating, g.id)
    db.prepare('UPDATE game_list SET status = ? WHERE game_id = ?').run(g.status === 'finished' ? 'finished' : g.status === 'playing' ? 'playing' : g.status === 'on_hold' ? 'on_hold' : 'want_to_play', g.id)
    if (g.status === 'playing') db.prepare('UPDATE game_list SET planned_month = ? WHERE game_id = ?').run(monthKey(0), g.id)
  }

  // The Game List: games wanted, and a plan for the next months.
  const assets = await steamApi.getAppAssets(WANTED.map(w => w[0]))
  const insRow = db.prepare('INSERT INTO game_list (steam_app_id, name, banner_url, status, planned_month, display_order) VALUES (?, ?, ?, ?, ?, ?)')
  WANTED.forEach(([appid, name, status, month], i) => insRow.run(appid, name, assets.get(appid)?.portrait || null, status, monthKey(month), i))
  // Finished games show up on their finished dates.
  try { db.prepare("UPDATE games SET finished_at = last_played_at WHERE completion_status = 'finished'").run() } catch {}
  return ids
}

app.whenReady().then(async () => {
  let win
  for (let i = 0; i < 300 && !win; i++) {
    const w = main.getMainWindow()
    if (w && !w.isDestroyed() && !w.webContents.isLoading() && w.webContents.getURL()) win = w
    else await sleep(100)
  }
  const wc = win.webContents
  const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
  const ids = await seedLibrary(db)
  console.log('library ready:', ids.length, 'games,', db.prepare('SELECT COUNT(*) c FROM achievements').get().c, 'achievements')

  win.setContentSize(1440, 900)
  wc.reload()
  await sleep(3000)
  const ev = (code) => wc.executeJavaScript(code, true)
  setInterval(() => { ev("[...document.querySelectorAll('[role=dialog]')].filter(d => /KoZo updated to/.test(d.innerText)).forEach(d => [...d.querySelectorAll('button')].find(b => /close|got it|ok/i.test(b.innerText + b.getAttribute('aria-label')))?.click())").catch(() => {}) }, 500)
  // Off screen has no focus, and that parks animations and some loading.
  const focus = async () => { await ev(`document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); true`); await sleep(100) }
  await focus()

  // One hidden window turns PNG into WebP, which is about a sixth of the size.
  const encoder = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await encoder.loadURL('data:text/html,<canvas id=c></canvas>')
  const taken = []
  // Each screenshot is saved twice: 2000 px for sharp screens, 1200 px (shots/sm) for the rest.
  // Nothing still loading: no skeleton or shimmer, every picture on screen drawn.
  const loadedNow = () => ev(`(() => {
    const busy = document.querySelector('[class*="_sk_"], [class*="coverPending"], [class*="shimmer"], [aria-busy="true"]')
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth }
    const pending = [...document.images].filter(i => visible(i) && !(i.complete && i.naturalWidth > 0)).length
    return { busy: !!busy && visible(busy), pending }
  })()`)
  async function waitLoaded(name, max = 30000) {
    const t0 = Date.now()
    let st = null
    while (Date.now() - t0 < max) {
      st = await loadedNow().catch(() => ({ busy: true, pending: 1 }))
      if (!st.busy && !st.pending) { await sleep(500); return true }
      await sleep(400)
    }
    console.log(`NOT LOADED: ${name} ${JSON.stringify(st)}`)
    return false
  }
  let dir = ''   // the color being taken ('' = Lime)
  async function save(name, width = 2000, quality = 0.82) {
    if (ONLY && !ONLY.includes(name)) return
    await focus()
    if (!(await waitLoaded(name))) {
      // One more chance after a reload, then the shot fails (the old one stays).
      const hash = await ev('location.hash')
      wc.reload(); await sleep(2500); await ev(`location.hash = ${JSON.stringify(hash)}; true`); await focus()
      if (!(await waitLoaded(name))) { failedShots.push(`${dir || 'lime'}/${name}`); return }
    }
    const banned = await ev(`/cracked/i.test(document.body.innerText)`)
    if (banned) console.log(`WARNING: ${name} says "cracked" somewhere`)
    const png = (await wc.capturePage()).toDataURL()
    const encode = (w, q) => encoder.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = ${JSON.stringify(png)}; await img.decode()
      const c = document.getElementById('c'); const w = Math.min(${w}, img.width); const h = Math.round(img.height * w / img.width)
      c.width = w; c.height = h
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h)
      return c.toDataURL('image/webp', ${q})
    })()`)
    const data = await encode(width, quality)
    const buf = Buffer.from(data.split(',')[1], 'base64')
    const out = /^look-/.test(name) ? OUT : path.join(OUT, dir)
    fs.mkdirSync(path.join(out, 'sm'), { recursive: true })
    fs.writeFileSync(path.join(out, `${name}.webp`), buf)
    fs.writeFileSync(path.join(out, 'sm', `${name}.webp`), Buffer.from((await encode(1200, 0.8)).split(',')[1], 'base64'))
    taken.push(`${dir || 'lime'}/${name} ${Math.round(buf.length / 1024)}KB`)
    console.log('shot', dir || 'lime', name, Math.round(buf.length / 1024) + 'KB')
  }
  const go = async (hash, wait = 2200) => { await ev(`location.hash = ${JSON.stringify(hash)}; true`); await focus(); await sleep(ONLY ? Math.min(wait, 1500) : wait) }
  const clickText = (sel, re) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => ${re}.test(x.innerText)); if (b) b.click(); return !!b })()`)
  const setLook = async (patch) => {
    const cur = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'appearance'").get().value)
    db.prepare("UPDATE settings SET value = ? WHERE key = 'appearance'").run(JSON.stringify({ ...cur, ...patch }))
    if (patch.accent) db.prepare("UPDATE settings SET value = ? WHERE key = 'accent_color'").run(patch.accent)
    wc.reload()
    await sleep(2600)
    await focus()
  }

  const star = ids[0]   // the sample game with the most recent play

  for (const [label, hex, folder] of COLORS) {
    dir = folder
    console.log('color', label)
    await setLook({ accent: hex })
    await go('#/', 3200)
    await save('library')

    await go(`#/game/${star.id}`, 3600)
    await save('game')

    await ev(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Cinematic')?.click(); true`); await sleep(1400)
    await save('game-cinematic')
    await ev(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'Store')?.click(); true`); await sleep(900)

    await clickText('[role=tab]', '/Sessions/'); await sleep(900)
    // A session opened under its row, as in the app.
    await ev(`(() => { const rows = [...document.querySelectorAll('[data-session-row]')]; const best = rows.find(r => /\\d/.test(r.querySelector('[title*="achievements"]')?.innerText || '')) || rows[0]; best?.click(); return rows.length })()`)
    await sleep(800)
    await ev(`document.querySelector('[data-session-detail]')?.scrollIntoView({ block: 'center' }); true`); await sleep(500)
    await save('sessions')

    await go('#/activity?tab=overview', 2600)
    await save('activity')
    await go('#/activity?tab=year', 2600)
    await save('year')
    await go('#/activity?tab=achievements', 2200)
    await save('achievements')

    await go('#/upcoming', 11000)
    await save('upcoming')

    await go('#/deals', 12000)
    await save('discounts')

    await go(`#/like?app=${star.appid}`, 11000)
    await save('like')

    await ev(`localStorage.setItem('kozo:plan:view', 'focus'); true`)
    await go('#/plan', 3200)
    await save('plan-focus')
    await ev(`localStorage.setItem('kozo:plan:view', 'board'); location.hash = '#/'; true`); await sleep(400)
    await go('#/plan', 3000)
    await save('plan-board')

    await go('#/finished', 2800)
    await save('finished')
    await go('#/game-list', 3000)
    await save('gamelist')
    await go('#/profile', 3000)
    await save('profile')
    await go('#/settings?tab=appearance', 2400)
    await save('appearance')
    await go('#/settings?tab=data', 2400)
    await save('backups')

    await go('#/big', 3600)
    await save('big')


  }
  dir = ''

  // The same app in other looks, all real settings.
  await setLook({ accent: '#f472b6', cardStyle: 'poster', sidebar: 'rail' })
  await go('#/', 2800)
  await save('look-pink', 1400, 0.78)
  await setLook({ accent: '#60a5fa', cardStyle: 'glass', sidebar: 'full', theme: 'midnight' })
  await go('#/', 2800)
  await save('look-blue', 1400, 0.78)
  await setLook({ accent: '#fbbf24', cardStyle: 'minimal', sidebar: 'full', theme: 'custom', bgColor: '#1a1206' })
  await go('#/', 2800)
  await save('look-amber', 1400, 0.78)
  await setLook({ accent: '#9fff02', cardStyle: 'classic', theme: 'midnight', bgColor: '#000000' })
  await go('#/', 2800)
  await save('look-lime', 1400, 0.78)
  // The Light theme (new in 1.9.3).
  await setLook({ accent: '#9fff02', cardStyle: 'classic', theme: 'light' })
  await go('#/', 2800)
  await save('look-light', 1400, 0.78)
  await setLook({ accent: '#9fff02', cardStyle: 'classic', theme: 'midnight', bgColor: '#000000' })

  if (failedShots.length) console.log('FAILED (still loading, kept the old picture): ' + failedShots.join(', '))
  console.log(taken.join(' | '))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  app.exit(failedShots.length ? 1 : 0)
}).catch(e => { console.error('SHOTS FAILED', e); app.exit(1) })
