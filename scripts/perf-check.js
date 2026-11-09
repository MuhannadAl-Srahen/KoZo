'use strict'

// Speed check: the real app on a throwaway profile with a big pretend library (500 games,
// 30,000 sessions, 20,000 achievements; the same library every run, so runs compare), or with
// PERF_REAL=1 a copy of your own library (keys, accounts and backup folders removed).
// Off screen, muted, never focused, no network. Measures:
//   - start until the Library shows its cards
//   - each page: time until its content shows, and until it stops moving
//   - every request to the background process (slowest first), and any freeze there
//   - graphics memory after scrolling the whole Library
//   - Finished, Year review, XP and Library list query times, plus a fingerprint of their
//     results, so a faster query can be checked to give exactly the same answer
//
//   npx vite build && electron scripts/perf-check.js            (PERF_OUT=file.json to save)
//
// Development only: build.files leaves scripts/ out of the installer.

const { app, BrowserWindow, session, ipcMain, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { performance, monitorEventLoopDelay } = require('perf_hooks')

const root = path.join(__dirname, '..')
const REAL = process.env.PERF_REAL === '1'
const OUT = process.env.PERF_OUT || null
const N_GAMES = 500, N_SESS = 30000, ACH_PER = 40, N_UNLOCK = 8000
if (!fs.existsSync(path.join(root, 'renderer-dist', 'index.html'))) { console.error('run `npx vite build` first'); process.exit(2) }

// Off screen and muted; the overlay is see-through and off screen too.
{
  const realTop = BrowserWindow.prototype.setAlwaysOnTop
  BrowserWindow.prototype.setAlwaysOnTop = function (...a) { try { this.setOpacity(0); this.setPosition(-3000, 60) } catch {} return realTop.apply(this, a) }
}
BrowserWindow.prototype.show = function () { this.showInactive() }
BrowserWindow.prototype.focus = function () {}
app.on('browser-window-created', (_e, w) => { try { w.setPosition(-3000, 60); w.webContents.setBackgroundThrottling(false); w.webContents.setAudioMuted(true) } catch {} })
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('mute-audio')
// Memory is read after a forced clean-up (gc), or it swings 100 MB+ from run to run.
app.commandLine.appendSwitch('js-flags', '--expose-gc')
// No network from the background process (axios follows these); the window's is cancelled below.
process.env.HTTPS_PROXY = process.env.HTTP_PROXY = 'http://127.0.0.1:9'

// Every request to the background process, timed.
let where = 'start'
const ipcStats = {}
const realHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (ch, fn) => realHandle(ch, async (...a) => {
  const t = performance.now()
  try { return await fn(...a) } finally {
    const d = performance.now() - t
    const s = ipcStats[ch] || (ipcStats[ch] = { n: 0, total: 0, max: 0, maxAt: '' })
    s.n++; s.total += d
    if (d > s.max) { s.max = d; s.maxAt = where }
  }
})

const realDb = path.join(app.getPath('appData'), 'KoZo', 'kozo.db')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kozo-perf-'))
app.setPath('userData', tmp)
app.setPath('documents', path.join(tmp, 'Documents'))
process.env.KOZO_SMOKE = '1'
process.env.KOZO_RENDERER = 'dist'
// The app icons are drawn once per profile and kept (electron/appIcon.js); reuse them so a run
// measures a usual start, not the very first one.
try { fs.cpSync(path.join(app.getPath('appData'), 'KoZo', 'icon-cache'), path.join(tmp, 'icon-cache'), { recursive: true }) } catch {}
if (!fs.existsSync(path.join(tmp, 'icon-cache'))) { try { const ic = require(path.join(root, 'electron', 'appIcon.js')); ic.getWindowImage(); ic.getTrayImage() } catch {} }

// Same numbers every run.
let seed = 20261109
const rand = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }
const rnd = (n) => Math.floor(rand() * n)
const pick = (a) => a[rnd(a.length)]

function buildLibrary() {
  const D = require(path.join(root, 'node_modules', 'better-sqlite3'))
  const dbFile = path.join(tmp, 'kozo.db')
  if (fs.existsSync(realDb)) {
    const real = new D(realDb, { readonly: true, fileMustExist: true })
    real.exec(`VACUUM INTO '${dbFile.replace(/\\/g, '/').replace(/'/g, "''")}'`)
    real.close()
  }
  const db = new D(dbFile)
  if (!fs.existsSync(realDb)) { db.close(); return }   // a fresh profile: the app makes its own tables
  db.prepare(`DELETE FROM settings WHERE key LIKE 'gdrive%' OR key LIKE 'steam%' OR key IN ('steamgriddb_key','discord_client_id','discord_presence','auto_backup_dir','saves_backup_dir','backup_base','backup_copy_dir','sync_folder','install_id','auto_detect_steam','profile_avatar_path','profile_banner_path')`).run()
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_done', '1')`).run()
  if (REAL) { db.close(); return }

  db.exec('DELETE FROM achievement_unlocks; DELETE FROM achievements; DELETE FROM sessions; DELETE FROM custom_list_games; DELETE FROM game_list; DELETE FROM games;')
  // One 600x900 cover, copied per game (the size KoZo stores covers at).
  const cover = nativeImage.createFromPath(path.join(root, 'build', 'icon.png')).resize({ width: 600, height: 900 }).toJPEG(85)
  const GEN = ['Action', 'RPG', 'Indie', 'Strategy', 'Puzzle', 'Adventure', 'Shooter', 'Simulation', 'Racing', 'Horror']
  const ST = ['playing', 'finished', 'not_started', 'dropped', 'on_hold', 'playing', 'finished']
  const lib = path.join(tmp, 'lib'), ban = path.join(tmp, 'banners')
  fs.mkdirSync(ban, { recursive: true })
  const insG = db.prepare(`INSERT INTO games (name, exe_name, install_path, banner_local_path, source, is_cracked, is_installed, completion_status, genres, is_favorite) VALUES (?,?,?,?,?,?,1,?,?,?)`)
  const ids = []
  db.transaction(() => {
    for (let i = 1; i <= N_GAMES; i++) {
      const dir = path.join(lib, `Test Game ${i}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `TestGame${i}.exe`), 'MZ')
      const b = path.join(ban, `test-${i}.jpg`)
      fs.writeFileSync(b, cover)
      const noLauncher = i % 3 === 0
      ids.push(insG.run(`Test Game ${i}`, `TestGame${i}.exe`, dir, b, noLauncher ? 'cracked' : 'manual', noLauncher ? 1 : 0, pick(ST), JSON.stringify([pick(GEN), pick(GEN)]), i % 25 === 0 ? 1 : 0).lastInsertRowid)
    }
  })()
  const insS = db.prepare(`INSERT INTO sessions (game_id, started_at, ended_at, duration_seconds, idle_seconds) VALUES (?,?,?,?,?)`)
  const anchor = Date.UTC(2026, 10, 1), span = 3 * 365 * 864e5
  const byGame = {}
  db.transaction(() => {
    for (let k = 0; k < N_SESS; k++) {
      const g = ids[Math.floor(Math.pow(rand(), 2) * ids.length)]   // a few games played a lot
      const st = anchor - rnd(span), dur = 600 + rnd(10200), idle = rnd(300)
      const end = new Date(st + (dur + idle) * 1000).toISOString()
      const id = insS.run(g, new Date(st).toISOString(), end, dur, idle).lastInsertRowid
      ;(byGame[g] = byGame[g] || []).push({ id, end })
    }
  })()
  db.exec(`UPDATE games SET total_playtime_seconds = COALESCE((SELECT SUM(duration_seconds) FROM sessions s WHERE s.game_id = games.id), 0),
    first_played_at = (SELECT MIN(started_at) FROM sessions s WHERE s.game_id = games.id), last_played_at = (SELECT MAX(ended_at) FROM sessions s WHERE s.game_id = games.id)`)
  const insA = db.prepare(`INSERT INTO achievements (game_id, steam_api_name, display_name, description, global_unlock_percent) VALUES (?,?,?,?,?)`)
  const achs = []
  db.transaction(() => { for (const g of ids) for (let j = 1; j <= ACH_PER; j++) achs.push({ g, id: insA.run(g, `ACH_${j}`, `Achievement ${j}`, `Do thing number ${j}`, rand() * 90).lastInsertRowid }) })()
  const insU = db.prepare(`INSERT OR IGNORE INTO achievement_unlocks (achievement_id, session_id, unlocked_at, source) VALUES (?,?,?,?)`)
  db.transaction(() => {
    for (let k = 0; k < N_UNLOCK; k++) {
      const a = pick(achs), ss = byGame[a.g], s = ss ? pick(ss) : null
      insU.run(a.id, s ? s.id : null, s ? s.end : new Date(anchor - rnd(span)).toISOString(), a.g % 3 === 0 ? 'crack' : 'steam')
    }
  })()
  const insL = db.prepare(`INSERT INTO game_list (game_id, name, status, rating, planned_month, display_order) VALUES (?,?,?,?,?,?)`)
  const months = [...Array(8)].map((_, i) => { const d = new Date(anchor); d.setUTCMonth(d.getUTCMonth() - 3 + i); return d.toISOString().slice(0, 7) })
  db.transaction(() => {
    ids.forEach((g, i) => insL.run(g, `Test Game ${i + 1}`, pick(['playing', 'finished', 'want_to_play', 'on_hold', 'dropped']), i % 4 === 0 ? 1 + rnd(10) : null, i % 5 === 0 ? pick(months) : null, i))
    for (let i = 0; i < 300; i++) insL.run(null, `Wanted Game ${i}`, pick(['want_to_play', 'upcoming', 'want_to_play']), null, i % 4 === 0 ? pick(months) : null, 1000 + i)
  })()
  db.close()
}

const sleep = (t) => new Promise(r => setTimeout(r, t))
const ms = (n) => Math.round(n)
const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)

// Built before KoZo's main code loads: it opens the database as soon as the app is ready.
buildLibrary()
// Background freezes: a 50 ms timer that fires late (watched from here on, after the build).
const stalls = []
{ let last = performance.now(); setInterval(() => { const now = performance.now(); const late = now - last - 50; if (late > 80) stalls.push({ at: where, ms: ms(late) }); last = now }, 50).unref() }
const eld = monitorEventLoopDelay({ resolution: 10 }); eld.enable()
// PERF_PROFILE=1: what the background process spends its time on from start until the
// Library is up, as the functions that took longest themselves (and a .cpuprofile beside OUT).
let profiler = null
if (process.env.PERF_PROFILE === '1') {
  const inspector = require('inspector')
  profiler = new inspector.Session()
  profiler.connect()
  profiler.post('Profiler.enable')
  profiler.post('Profiler.setSamplingInterval', { interval: 500 })
  profiler.post('Profiler.start')
}
function stopProfile() {
  return new Promise((resolve) => {
    if (!profiler) return resolve(null)
    profiler.post('Profiler.stop', (err, res) => {
      if (err || !res) return resolve(null)
      const p = res.profile
      if (OUT) fs.writeFileSync(OUT.replace(/\.json$/, '') + '.cpuprofile', JSON.stringify(p))
      const dt = {}; const byId = new Map(p.nodes.map(n => [n.id, n]))
      for (let i = 0; i < p.samples.length; i++) { const id = p.samples[i]; dt[id] = (dt[id] || 0) + (p.timeDeltas[i] || 0) }
      const self = {}
      for (const [id, us] of Object.entries(dt)) {
        const n = byId.get(Number(id)); const f = n.callFrame
        if (/^\((idle|program|garbage collector)\)$/.test(f.functionName)) continue
        const key = `${f.functionName || '(anonymous)'} ${String(f.url).replace(/^.*[\\/](electron|node_modules)[\\/]/, '$1/')}:${f.lineNumber + 1}`
        self[key] = (self[key] || 0) + us
      }
      resolve(Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => `${Math.round(us / 1000)} ms  ${k}`))
    })
  })
}
const tMain = performance.now()
const main = require(path.join(root, 'electron', 'main.js'))

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => cb({ cancel: !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(d.url) }))

  let win
  for (let i = 0; i < 600 && !win; i++) {
    const w = main.getMainWindow()
    if (w && !w.isDestroyed() && !w.webContents.isLoading() && w.webContents.getURL()) win = w
    else await sleep(50)
  }
  const wc = win.webContents
  win.setContentSize(1400, 880)
  const ev = (code) => wc.executeJavaScript(code, true)
  for (let i = 0; i < 400; i++) { if (await ev(`document.querySelectorAll('.app-main [data-gpnav]').length > 2`).catch(() => false)) break; await sleep(50) }
  const startMs = ms(performance.now() - tMain)
  // The window itself: first paint, and how long its own start blocked it (script + first render).
  const paint = await ev(`new Promise(res => {
    const fcp = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime
    let blocked = 0
    try { new PerformanceObserver(() => {}).observe({ type: 'longtask', buffered: true }) } catch {}
    try { for (const e of performance.getEntriesByType('longtask')) blocked += e.duration } catch {}
    res({ firstPaint: Math.round(fcp || 0), cardsAt: Math.round(performance.now()), scriptsKB: Math.round(performance.getEntriesByType('resource').filter(r => /\\.js$/.test(r.name)).reduce((s, r) => s + (r.decodedBodySize || 0), 0) / 1024) })
  })`).catch(() => null)

  // Behave as if someone were looking at the window; close one-time dialogs.
  await ev(`(() => { document.hasFocus = () => true; const el = document.documentElement; const off = () => { if (el.hasAttribute('data-inactive')) el.removeAttribute('data-inactive') }; new MutationObserver(off).observe(el, { attributes: true, attributeFilter: ['data-inactive'] }); off(); return true })()`)
  setInterval(() => { ev("[...document.querySelectorAll('[role=dialog]')].forEach(d => [...d.querySelectorAll('button')].find(b => /^(OK|Not now|Close|Skip)$/i.test(b.innerText.trim()))?.click()); true").catch(() => {}) }, 700)
  await sleep(4000)
  const profileTop = await stopProfile()
  if (profileTop) { console.log('Start, longest functions (own time):'); for (const l of profileTop) console.log('  ' + l) }
  // PERF_START_ONLY=1: only the start (to compare starts over a few quick runs).
  if (process.env.PERF_START_ONLY === '1') {
    const memMb = Math.round(app.getAppMetrics().filter(m => m.type === 'Tab').reduce((s, m) => s + (m.memory.privateBytes || m.memory.workingSetSize), 0) / 1024)
    console.log(`START ${startMs} ms | first paint ${paint?.firstPaint} ms | scripts ${paint?.scriptsKB} KB | window memory ${memMb} MB | freezes ${stalls.filter(s => s.at === 'start').map(s => s.ms).join(',') || 'none'}`)
    app.isQuitting = true
    return setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} ; app.exit(0) }, 300)
  }

  // Queries, timed in place, with a fingerprint of their answers.
  where = 'perf-check timing the queries itself'
  const gamesQ = require(path.join(root, 'electron', 'db', 'queries', 'games.js'))
  const yr = require(path.join(root, 'electron', 'db', 'queries', 'yearReview.js'))
  const xp = require(path.join(root, 'electron', 'services', 'xp.js'))
  const timeIt = (fn) => { const t = performance.now(); const v = fn(); return { ms: +(performance.now() - t).toFixed(1), v } }
  const fin = timeIt(() => gamesQ.listFinishedGames())
  const year = new Date(Date.UTC(2026, 5, 1)).getFullYear()
  const yrs = timeIt(() => yr.availableYears(fin.v, 2026))
  const rev = timeIt(() => yr.yearReview(year, fin.v))
  const rev2 = timeIt(() => yr.yearReview(year - 1, fin.v))
  const xp1 = timeIt(() => xp.computeXp())
  const xp2 = timeIt(() => xp.computeXp())
  const list = timeIt(() => gamesQ.listGamesWithStats())
  const queries = {
    finished: fin.ms, years: yrs.ms, yearReview: rev.ms, xpFirst: xp1.ms, xpAgain: xp2.ms, libraryList: list.ms,
    answers: { finished: hash(fin.v), years: hash(yrs.v), yearReview: hash([rev.v, rev2.v]), xp: hash(xp1.v), xpAgain: hash(xp2.v), list: hash(list.v) },
  }

  await ev(`(() => { window.__lt = 0; window.__ltMax = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__lt += e.duration; window.__ltMax = Math.max(window.__ltMax, e.duration) } }).observe({ type: 'longtask', buffered: false }); return true })()`)
  const gid = await ev('window.kozo.api.games.list().then(r => (r.data || []).sort((a,b)=>(b.total_playtime_seconds||0)-(a.total_playtime_seconds||0))[0]?.id)')
  const route = ['#/', '#/game-list', '#/plan', '#/finished', '#/activity?tab=overview', '#/activity?tab=sessions', '#/activity?tab=achievements', '#/activity?tab=year', '#/profile',
    `#/game/${gid}`, '#/settings?tab=general', '#/settings?tab=appearance', '#/settings?tab=tracking', '#/settings?tab=backups', '#/settings?tab=storage', '#/settings?tab=about', '#/big', '#/']
  const navOnce = (hash) => ev(`new Promise(res => {
    const t0 = performance.now(); const lt0 = window.__lt; window.__ltMax = 0
    const a = [...document.querySelectorAll('a[href]')].find(x => x.getAttribute('href') === ${JSON.stringify(hash)})
    if (a) a.click(); else location.hash = ${JSON.stringify(hash)}
    const check = () => {
      const main = document.querySelector('.app-main') || document.body
      const txt = (main.innerText || '').trim().length
      const busy = !!document.querySelector('[class*="_sk_"], [class*="skeleton" i]')
      if (txt > 20 && !busy) { const ready = Math.round(performance.now() - t0); const settle = () => { const moving = document.getAnimations().filter(x => x.playState === 'running' && x.effect?.getComputedTiming?.().endTime !== Infinity).length; if (!moving || performance.now() - t0 > 6000) return res({ ready, still: Math.round(performance.now() - t0), longTasks: Math.round(window.__lt - lt0) }); requestAnimationFrame(settle) }; return requestAnimationFrame(settle) }
      if (performance.now() - t0 > 15000) return res({ ready: 'timeout', still: null, longTasks: Math.round(window.__lt - lt0) })
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })`)
  const pages = {}
  for (let r = 0; r < 2; r++) {
    for (const h of route) {
      where = h
      ;(pages[h] = pages[h] || []).push(await navOnce(h))
      await sleep(1500)
    }
  }

  // The Library scrolled from top to bottom, then graphics memory. Card-size cover copies
  // are made once and kept, so the scroll waits for them, as on any later start.
  where = 'Library scroll'
  await ev(`location.hash = '#/'; true`); await sleep(2500)
  try {
    const cards = require(path.join(root, 'electron', 'services', 'cardCovers.js'))
    await ev(`(async () => { const sc = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (!sc) return; for (let y = 0; y < sc.scrollHeight; y += 600) { sc.scrollTop = y; await new Promise(r => setTimeout(r, 40)) } sc.scrollTop = 0 })()`)
    for (let i = 0; i < 240 && cards.pending(); i++) await sleep(500)
    if (cards.pending()) console.log('card covers still being made:', cards.pending())
    wc.reload(); await sleep(3000)
    await ev(`(() => { document.hasFocus = () => true; const el = document.documentElement; const off = () => { if (el.hasAttribute('data-inactive')) el.removeAttribute('data-inactive') }; new MutationObserver(off).observe(el, { attributes: true, attributeFilter: ['data-inactive'] }); off(); return true })()`)
    await ev(`location.hash = '#/'; true`); await sleep(2500)
  } catch {}
  const scroll = await ev(`new Promise(res => { const sc = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (!sc) return res(null)
    let frames = 0, worst = 0, last = performance.now(); const t0 = last
    const step = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++; sc.scrollTop += 60; if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2 || now - t0 > 8000) return res({ fps: Math.round(frames / ((now - t0) / 1000)), worstFrame: Math.round(worst) }); requestAnimationFrame(step) }
    requestAnimationFrame(step) })`)
  await sleep(5000)
  await ev('window.gc && window.gc(); true').catch(() => {}); await sleep(1500)
  const memory = {}
  for (const m of app.getAppMetrics()) {
    const k = m.type === 'Tab' ? 'window' : m.type === 'GPU' ? 'graphics' : m.type === 'Browser' ? 'background' : 'other'
    memory[k] = (memory[k] || 0) + Math.round((m.memory.privateBytes || m.memory.workingSetSize) / 1024)
  }

  // The background process at rest, window hidden.
  where = 'at rest, window hidden'
  win.hide()
  const c0 = process.cpuUsage(); const t0 = performance.now()
  await sleep(30000)
  const cu = process.cpuUsage(c0)
  const restCpu = +((cu.user + cu.system) / 1000 / (performance.now() - t0) * 100).toFixed(2)

  const slow = Object.entries(ipcStats).map(([ch, s]) => ({ ch, calls: s.n, avg: +(s.total / s.n).toFixed(1), max: ms(s.max), at: s.maxAt })).sort((a, b) => b.max - a.max)
  const result = { library: REAL ? 'your library (copy)' : `${N_GAMES} games, ${N_SESS} sessions`, startMs, paint, queries, pages, scroll, memory, restCpu, slow, stalls, loopDelayMaxMs: ms(eld.max / 1e6) }

  console.log(`\nLibrary: ${result.library}`)
  console.log(`Start until the Library shows cards: ${startMs} ms; window's first paint ${paint?.firstPaint} ms after it began loading, ${paint?.scriptsKB} KB of scripts`)
  console.log(`Queries (ms): Finished ${queries.finished}, years ${queries.years}, Year review ${queries.yearReview}, XP ${queries.xpFirst} then ${queries.xpAgain}, Library list ${queries.libraryList}`)
  console.log(`Answers: ${JSON.stringify(queries.answers)}`)
  console.log('Pages (shows / stops moving, ms, both visits):')
  for (const [h, l] of Object.entries(pages)) console.log(`  ${h.padEnd(28)} ${l.map(x => `${x.ready} / ${x.still}`).join('   ')}`)
  console.log(`Library scroll: ${scroll?.fps} fps, worst frame ${scroll?.worstFrame} ms`)
  console.log(`Memory (MB): ${JSON.stringify(memory)}`)
  console.log(`Background at rest: ${restCpu}% of one core`)
  console.log('Slowest requests:')
  for (const s of slow.slice(0, 12)) console.log(`  ${s.ch.padEnd(30)} max ${s.max} ms (${s.at}), avg ${s.avg} ms, ${s.calls} calls`)
  console.log(`Background freezes over 80 ms: ${stalls.length ? stalls.map(s => `${s.ms} ms (${s.at})`).join(', ') : 'none'}`)
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1))

  app.isQuitting = true
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} ; app.exit(0) }, 500)
}).catch((e) => { console.log('failed', e.stack || e.message); app.exit(1) })
setTimeout(() => { console.log('timed out'); app.exit(2) }, 480000).unref()
