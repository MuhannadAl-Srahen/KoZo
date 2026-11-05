'use strict'
// Checks the landing page in real Chromium at every size that matters, with real clicks and taps.
// Off screen and muted. Device emulation gives the exact size, even larger than this monitor.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/site-check.js
//   SITE_SIZES=phone,laptop     only these
//   SITE_SHOTS=<folder>         also save pictures of each section
const { app, BrowserWindow } = require('electron')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'site')
const SHOTS = process.env.SITE_SHOTS || null
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kozo-sitecheck-')))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('mute-audio')

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const SIZES = [
  // name, width, height, touch device
  ['ultrawide', 3440, 1440, false],
  ['qhd', 2560, 1440, false],
  ['fhd', 1920, 1080, false],
  ['laptop', 1440, 900, false],
  ['laptop-small', 1366, 768, false],
  ['short', 1280, 640, false],
  ['old', 1024, 768, false],
  ['tablet-wide', 1180, 820, true],
  ['tablet', 820, 1180, true],
  ['tablet-small', 768, 1024, true],
  ['phone-wide', 844, 390, true],
  ['phone-big', 430, 932, true],
  ['phone', 390, 844, true],
  ['phone-small', 360, 800, true],
  ['phone-tiny', 320, 568, true],
].filter(s => !process.env.SITE_SIZES || process.env.SITE_SIZES.split(',').includes(s[0]))

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' }
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0])
  // A pretend newer release, so the Download buttons can be checked without asking GitHub.
  if (p === '/__release.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    return res.end(JSON.stringify({ tag_name: 'v9.9.9', draft: false, assets: [
      { name: 'KoZo-Installer-9.9.9.exe.blockmap', size: 140000, state: 'uploaded', browser_download_url: 'https://example.invalid/blockmap' },
      { name: 'KoZo-Installer-9.9.9.exe', size: 134000000, state: 'uploaded', browser_download_url: 'https://example.invalid/KoZo-Installer-9.9.9.exe' },
    ] }))
  }
  const file = path.join(ROOT, p === '/' ? 'index.html' : p)
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(buf)
  })
})

let pass = 0, fail = 0
const failures = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
function check(where, name, ok, extra = '') {
  if (ok) { pass++; return }
  fail++
  const line = `${where}: ${name}${extra !== '' ? '  (' + extra + ')' : ''}`
  failures.push(line)
  console.log('FAIL  ' + line)
}

// What's checked once: the words on the site and the links between its files.
function checkFiles() {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  const pages = ['index.html', 'privacy.html', 'terms.html']
  const texts = [...pages, 'js/game.js', 'js/sections.js', 'js/smooth.js', 'assets/covers.js']
  for (const f of texts) {
    const t = read(f)
    check('words', `${f} has no long dashes`, !/[–—]/.test(t))
    check('words', `${f} never says cracked or OneDrive`, !/cracked|onedrive/i.test(t), (t.match(/.{20}(cracked|onedrive).{20}/i) || [''])[0])
    check('words', `${f} never says free`, !/\bfree\b/i.test(t), (t.match(/.{20}\bfree\b.{20}/i) || [''])[0])
  }
  for (const f of pages) {
    for (const m of read(f).matchAll(/(?:src|href)="([^"#]+?)"/g)) {
      if (/^(https?:|mailto:|data:)/.test(m[1])) continue
      check('links', `${f} points at ${m[1]}`, fs.existsSync(path.join(ROOT, m[1])))
    }
  }
  // Addresses on the real domain have to exist in site/ too, or they're dead once it's published.
  for (const f of pages) {
    for (const m of read(f).matchAll(/"https:\/\/kozoapp\.cloud\/([^"]*)"/g)) {
      if (m[1]) check('links', `${f} names ${m[1]}`, fs.existsSync(path.join(ROOT, m[1])))
    }
  }
  // Google's brand check: the home page must link the privacy policy, at the address given to Google.
  check('google', 'the home page links Privacy and Terms', /href="privacy\.html"/.test(read('index.html')) && /href="terms\.html"/.test(read('index.html')))
  check('google', 'the privacy page says how Google data is used', /drive\.file/.test(read('privacy.html')) && /Limited Use/.test(read('privacy.html')))
  for (const f of pages) {
    for (const m of read(f).matchAll(/srcset="([^"]+)"/g)) {
      for (const part of m[1].split(',')) { const u = part.trim().split(/\s+/)[0]; check('links', `${f} points at ${u}`, fs.existsSync(path.join(ROOT, u))) }
    }
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'assets/shots')).filter(n => n.endsWith('.webp'))) {
    check('weight', `shots/${f} has a small copy`, fs.existsSync(path.join(ROOT, 'assets/shots/sm', f)))
  }
  const css = read('css/site.css')
  for (const m of css.matchAll(/url\('\.\.\/([^']+)'\)/g)) check('links', `the stylesheet points at ${m[1]}`, fs.existsSync(path.join(ROOT, m[1])))
  const js = ['js/hive.js', 'js/game.js', 'js/sections.js', 'js/smooth.js'].reduce((s, f) => s + fs.statSync(path.join(ROOT, f)).size, 0)
  const first = js + fs.statSync(path.join(ROOT, 'css/site.css')).size + fs.statSync(path.join(ROOT, 'index.html')).size +
    fs.statSync(path.join(ROOT, 'assets/covers.webp')).size + ['anybody', 'hanken-grotesk', 'martian-mono'].reduce((s, n) => s + fs.statSync(path.join(ROOT, `assets/fonts/${n}.woff2`)).size, 0)
  console.log(`weight: scripts ${Math.round(js / 1024)} KB, first screen ${Math.round(first / 1024)} KB`)
  check('weight', 'the first screen stays under 1 MB', first < 1024 * 1024, Math.round(first / 1024) + ' KB')
}

// Runs in the page: anything sticking out past the window, or out of its card, or cut off.
const AUDIT = `(() => {
  const out = { past: [], cut: [], card: [], small: [] }
  // The window is scaled up on purpose while the hexagon opens around it; the beats check it after.
  const allowed = '.band, .rail-track, .hive-wrap, .toasts, svg, .hive-tag' + (document.documentElement.classList.contains('flat') ? '' : ', .dive-open')
  const show = (e) => (e.className && e.className.baseVal === undefined ? e.className : e.tagName) + ':' + (e.innerText || '').trim().slice(0, 24)
  for (const e of document.querySelectorAll('header *, main *, footer *')) {
    if (e.closest(allowed)) continue
    const r = e.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (r.right > innerWidth + 1 || r.left < -1) out.past.push(show(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right))
  }
  for (const e of document.querySelectorAll('main p, main h1, main h2, main h3, main li, main dt, main dd, summary, footer p, button, a')) {
    if (e.closest('.scan-name, .scan-file, svg, .toasts')) continue
    const s = getComputedStyle(e)
    if (s.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 0) out.cut.push(show(e))
  }
  for (const c of document.querySelectorAll('.chart-card, .scan-win, .saves-card, .rarity, .tier, .page-points li, .facts > div, .xp-list > div, .finale-stats > div, .look-btn, .row, .save-row, .cta-row')) {
    const box = c.getBoundingClientRect()
    if (!box.width) continue
    for (const k of c.querySelectorAll('*')) {
      if (k.closest('svg') && k.tagName !== 'svg') continue
      const r = k.getBoundingClientRect()
      if (r.width && (r.right > box.right + 2 || r.left < box.left - 2)) { out.card.push(show(c) + ' > ' + show(k)); break }
    }
  }
  return out
})()`

async function runSize([name, width, height, touch], port) {
  const win = new BrowserWindow({
    width: 1000, height: 700, x: -4000, y: 60, show: false, frame: false,
    webPreferences: { backgroundThrottling: false, partition: 'check-' + name },
  })
  win.showInactive()
  win.setPosition(-4000, 60)
  const wc = win.webContents
  // Attaching to a window with no page yet takes the whole app down.
  await win.loadURL('data:text/html,<title>wait</title>')
  const dbg = wc.debugger
  dbg.attach('1.3')
  const cdp = (m, p) => dbg.sendCommand(m, p)
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: touch, screenWidth: width, screenHeight: height })
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  if (touch) {
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp('Emulation.setUserAgentOverride', { userAgent: IPHONE })
  }
  const errors = []
  wc.on('console-message', (e) => { if (e.level >= 2 && !/api\.github\.com|net::ERR/.test(e.message)) errors.push(e.message) })
  wc.on('render-process-gone', () => errors.push('the page crashed'))
  wc.session.webRequest.onBeforeRequest({ urls: ['https://api.github.com/*'] }, (d, cb) => cb({ redirectURL: `http://127.0.0.1:${port}/__release.json` }))
  await win.loadURL(`http://127.0.0.1:${port}/`)
  const ev = (code) => wc.executeJavaScript(code, true)
  const where = `${name} ${width}x${height}`
  let shotNo = 0
  const shot = async (label) => {
    if (!SHOTS) return
    shotNo++
    const r = await cdp('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOTS, `${name}-${String(shotNo).padStart(2, '0')}-${label}.png`), Buffer.from(r.data, 'base64'))
  }
  const scrollTo = async (y, wait = 260) => { await ev(`document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, ${Math.round(y)}); true`); await sleep(wait) }
  const topOf = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top + scrollY`)
  const press = async (sel, index = 0) => {
    await ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${index}]; e.scrollIntoView({ block: 'center', behavior: 'instant' }); return true })()`)
    await sleep(240)
    const p = await ev(`(() => { const r = document.querySelectorAll(${JSON.stringify(sel)})[${index}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } })()`)
    if (touch) {
      // synthesizeTapGesture gives touchstart and touchend but no click, off screen.
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
      await sleep(50)
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    }
    await sleep(180)
    return p
  }

  await sleep(2600)
  const flat = await ev(`document.documentElement.classList.contains('flat')`)
  const newest = await ev(`({ meta: [...document.querySelectorAll('[data-dl-meta]')].map(m => m.hidden ? '' : m.textContent), links: [...document.querySelectorAll('.hud [data-download], #finale [data-download]')].map(a => a.href) })`)
  check(where, 'Download shows the newest release, read from GitHub', newest.meta.length === 2 && newest.meta.every(m => m === 'v9.9.9, 128 MB'), newest.meta.join(' | '))
  if (!touch) check(where, 'every Download button gets the newest installer', newest.links.length >= 2 && newest.links.every(h => h.endsWith('/KoZo-Installer-9.9.9.exe')), newest.links.join(' | '))
  check(where, 'the size is what was asked for', (await ev('innerWidth')) === width, await ev('innerWidth'))
  await shot('hero')

  // ── The first screen ──
  const first = await ev(`(() => {
    const hud = document.querySelector('.hud').getBoundingClientRect()
    const copy = document.querySelector('.hero-copy').getBoundingClientRect()
    const cta = document.querySelector('.hero-copy .btn-hex').getBoundingClientRect()
    const groups = ['.hud-brand', '.hud-score', '.hud-right'].map(s => document.querySelector(s).getBoundingClientRect())
    return { hudBottom: hud.bottom, copyTop: copy.top, ctaBottom: cta.bottom, vh: innerHeight, hudOverlap: groups[0].right > groups[1].left + 1 || groups[1].right > groups[2].left + 1, hudPast: groups[2].right > innerWidth + 1 }
  })()`)
  check(where, 'the top bar fits on one line', !first.hudOverlap && !first.hudPast)
  check(where, 'the hero starts below the top bar', first.copyTop >= first.hudBottom - 1, Math.round(first.copyTop))
  if (height >= 720 && width > 880) check(where, 'Download is on the first screen', first.ctaBottom <= first.vh, Math.round(first.ctaBottom))

  // ── The wheel glides, and so do links to a part of the page ──
  if (!touch) {
    const watch = (ms) => ev(`new Promise(done => { const ys = [], t0 = performance.now(); (function f(now) { ys.push(scrollY); if (now - t0 < ${ms}) requestAnimationFrame(f); else done(ys) })(t0) })`)
    await scrollTo(0, 300)
    let seen = watch(1100)
    await sleep(40)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(width / 2), y: Math.round(height / 2), deltaX: 0, deltaY: 300 })
    let ys = await seen
    let steps = new Set(ys.filter(v => v > 2 && v < 298).map(Math.round)).size
    check(where, 'the wheel glides instead of jumping', steps >= 6, steps + ' steps')
    check(where, '...and lands where the wheel asked', Math.abs(ys[ys.length - 1] - 300) <= 2, Math.round(ys[ys.length - 1]))
    await scrollTo(0, 300)
    const goal = await ev(`document.querySelector('#dive').getBoundingClientRect().top + scrollY - parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)`)
    seen = watch(1800)
    await press('.hero-copy .btn-text')
    ys = await seen
    steps = new Set(ys.filter(v => v > 2 && v < goal - 2).map(Math.round)).size
    check(where, '"See it work" glides to the tour', steps >= 6 && Math.abs(ys[ys.length - 1] - goal) <= 3, steps + ' steps, ended ' + Math.round(ys[ys.length - 1]) + ' of ' + Math.round(goal))
    await scrollTo(0, 300)
  }

  // ── Titles: one width, inside their box ──
  const titles = await ev(`[...document.querySelectorAll('[data-fit]')].map(b => {
    const box = b.getBoundingClientRect().width
    const lines = [...b.querySelectorAll('span')].map(l => { const r = document.createRange(); r.selectNodeContents(l); return r.getBoundingClientRect().width })
    return { label: b.getAttribute('aria-label'), box, lines, size: Math.max(...[...b.querySelectorAll('span')].map(l => parseFloat(getComputedStyle(l).fontSize))) }
  })`)
  // Their letters stretch as they scroll into view, so they're measured in view (below).

  // ── A walk down the whole page ──
  const total = await ev('document.documentElement.scrollHeight')
  let y = 0, walkIssues = new Set()
  while (y < total) {
    await scrollTo(y, 90)
    const a = await ev(AUDIT)
    a.past.forEach(x => walkIssues.add('past the edge: ' + x))
    a.cut.forEach(x => walkIssues.add('cut off: ' + x))
    a.card.forEach(x => walkIssues.add('out of its card: ' + x))
    y += Math.round(height * 0.7)
  }
  check(where, 'nothing sticks out or gets cut off, anywhere on the page', walkIssues.size === 0, [...walkIssues].slice(0, 6).join(' | '))
  check(where, 'no sideways scrolling', (await ev('document.documentElement.scrollWidth')) <= width + 1, await ev('document.documentElement.scrollWidth'))
  const broken = await ev(`[...document.images].filter(i => i.complete && !i.naturalWidth).map(i => i.src.split('/').pop())`)
  check(where, 'every picture loaded', broken.length === 0, broken.join())

  // ── Titles, in view ──
  for (const label of titles.map(t => t.label)) {
    await ev(`(() => { const b = [...document.querySelectorAll('[data-fit]')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (b.closest('#rail-track') && !document.documentElement.classList.contains('flat')) { window.scrollTo(0, document.querySelector('#rail').offsetTop + 2) } else { b.scrollIntoView({ block: 'center', behavior: 'instant' }) } return true })()`)
    await sleep(120)
    const t = await ev(`(() => {
      const b = [...document.querySelectorAll('[data-fit]')].find(x => x.getAttribute('aria-label') === ${JSON.stringify(label)})
      const box = b.getBoundingClientRect()
      const lines = [...b.querySelectorAll('span')].map(l => { const r = document.createRange(); r.selectNodeContents(l); return r.getBoundingClientRect().width })
      return { box: box.width, max: Math.max(...lines), height: box.height, vh: innerHeight, right: box.right }
    })()`)
    check(where, `"${label}" fits its box`, t.max <= t.box + 3, Math.round(t.max) + ' in ' + Math.round(t.box))
    check(where, `"${label}" is on screen and not taller than it`, t.right <= width + 1 && t.height <= t.vh, Math.round(t.height) + ' tall')
  }

  // ── The pinned scenes keep their parts inside the window ──
  if (!flat) {
    const diveTop = await topOf('#dive'), diveLen = (await ev(`document.querySelector('#dive').offsetHeight`)) - height
    for (const [label, p] of [['open', 0.1], ['library', 0.34], ['game', 0.62], ['sessions', 0.92]]) {
      await scrollTo(diveTop + diveLen * p, 450)
      await shot('dive-' + label)
      if (p > 0.3) {
        const b = await ev(`(() => {
          const beat = document.querySelectorAll('.beat')[${p < 0.5 ? 0 : p < 0.8 ? 1 : 2}]
          const win = beat.querySelector('.win').getBoundingClientRect(), cap = beat.querySelector('figcaption').getBoundingClientRect()
          const hud = document.querySelector('.hud').getBoundingClientRect().bottom
          return { winTop: win.top, winBottom: win.bottom, winRight: win.right, capTop: cap.top, capBottom: cap.bottom, capRight: cap.right, hud, vh: innerHeight, vw: innerWidth }
        })()`)
        check(where, `the ${label} window sits below the top bar and inside the screen`, b.winTop >= b.hud - 1 && b.winBottom <= b.vh + 1 && b.winRight <= b.vw + 1, JSON.stringify([Math.round(b.winTop), Math.round(b.winBottom)]))
        check(where, `the ${label} caption is on screen`, b.capTop >= b.hud && b.capBottom <= b.vh && b.capRight <= b.vw, JSON.stringify([Math.round(b.capTop), Math.round(b.capBottom)]))
      }
    }
    const railTop = await topOf('#rail'), railLen = (await ev(`document.querySelector('#rail').offsetHeight`)) - height
    check(where, 'the rail is long enough to scroll through', railLen > width * 0.5, railLen)
    await scrollTo(railTop + railLen, 400)
    const last = await ev(`(() => { const s = [...document.querySelectorAll('.slide')].pop().getBoundingClientRect(); return { right: s.right, left: s.left, bottom: s.bottom, vw: innerWidth, vh: innerHeight } })()`)
    check(where, 'the rail ends with its last picture on screen', last.right <= last.vw && last.left >= 0, JSON.stringify([Math.round(last.left), Math.round(last.right)]))
    check(where, 'rail pictures and captions fit the height', last.bottom <= last.vh, Math.round(last.bottom))
    await scrollTo(railTop + railLen * 0.35, 500)
    await shot('rail')
  } else {
    await scrollTo(await topOf('#dive'), 400)
    await shot('tour')
    await scrollTo(await topOf('#rail'), 400)
    await shot('rail')
    const r = await ev(`(() => { const t = document.querySelector('#rail-track'); return { scrolls: t.scrollWidth > t.clientWidth, snap: getComputedStyle(t).scrollSnapType } })()`)
    check(where, 'the rail scrolls sideways by finger', r.scrolls)
  }

  // ── Doing things, with real clicks and taps ──
  const got = () => ev(`document.querySelectorAll('#ach-list .ach-row.got').length`)
  const hasAch = (id) => ev(`JSON.parse(localStorage.getItem('kozo-site') || '{}').got?.includes(${JSON.stringify(id)}) || false`)

  await press('.rarity', 2)
  await sleep(160)
  check(where, 'pressing a rarity shows a toast over the game', (await ev(`document.querySelectorAll('#scene-toasts .toast').length`)) >= 1)
  const sceneFit = await ev(`(() => { const t = document.querySelector('#scene-toasts .toast')?.getBoundingClientRect(), s = document.querySelector('#scene').getBoundingClientRect(); return t ? t.right <= s.right + 1 && t.left >= s.left - 1 : false })()`)
  check(where, 'the toast fits inside the game picture', sceneFit)
  check(where, '...and earns First Unlock', await hasAch('unlock'))
  await shot('toast')

  const barIndex = await ev(`(() => { const b = [...document.querySelectorAll('.bar')]; return b.findIndex((x, i) => !x.disabled && i > 18 && x !== b[b.length - 1]) })()`)
  const barBox = await press('.bar', barIndex)
  check(where, 'a day\'s bar can be pressed', barBox.w >= 3, Math.round(barBox.w * 10) / 10)
  check(where, 'pressing a bar picks that day', (await ev(`document.querySelectorAll('.bar.on').length`)) === 1)
  check(where, '...and earns Day by Day', await hasAch('bar'))
  await sleep(120)
  await shot('chart')
  const openDetail = await ev(`!!document.querySelector('.row-detail')`)
  if (!openDetail) await press('.row', 0)
  check(where, 'a session opens under its row', await ev(`!!document.querySelector('.row-detail')`))
  await press('.bar', barIndex)
  check(where, 'the same bar again shows every session', (await ev(`document.querySelectorAll('.bar.on').length`)) === 0 && (await ev(`document.querySelectorAll('.row').length`)) >= 3)

  await scrollTo(await topOf('#scan'), 200)
  await ev(`document.querySelector('#scan-win').scrollIntoView({ block: 'center', behavior: 'instant' }); true`)
  await sleep(2900)
  await shot('scan')
  check(where, 'Scan PC finishes by itself', /found/.test(await ev(`document.querySelector('#scan-status').textContent`)), await ev(`document.querySelector('#scan-status').textContent`))

  await press('.look-btn', 1)
  await sleep(300)
  check(where, 'a look changes the page\'s color', (await ev(`getComputedStyle(document.documentElement).getPropertyValue('--a').trim()`)) === '#60a5fa')
  check(where, '...and earns Your Colors', await hasAch('colors'))
  await shot('look')
  await press('.look-btn', 3)

  await press('.save-btn', 1)
  await sleep(120)

  await ev(`window.dispatchEvent(new Event('blur')); true`)
  await sleep(1200)
  const during = await ev(`document.querySelector('#session-state').textContent`)
  check(where, 'leaving says Away, paused', during === 'Away, paused', during)
  await sleep(2300)
  await ev(`window.dispatchEvent(new Event('focus')); true`)
  await sleep(250)
  check(where, 'coming back earns Away, Paused', await hasAch('away'))

  // The colour panel and achievement list fit.
  await scrollTo(0, 200)
  await press('#color-toggle')
  await sleep(120)
  const colorPanel = await ev(`(() => { const p = document.querySelector('#color-panel'); const r = p.getBoundingClientRect(); return { open: !p.hidden, left: r.left, right: r.right, bottom: r.bottom } })()`)
  check(where, 'the color panel opens inside the screen', colorPanel.open && colorPanel.left >= 0 && colorPanel.right <= width && colorPanel.bottom <= height, JSON.stringify(colorPanel))
  await shot('colors')
  await press('#ach-toggle')
  await sleep(120)
  const achPanel = await ev(`(() => { const p = document.querySelector('#ach-panel'); const r = p.getBoundingClientRect(); return { open: !p.hidden, left: r.left, right: r.right, bottom: r.bottom } })()`)
  check(where, 'the achievement list opens inside the screen', achPanel.open && achPanel.left >= 0 && achPanel.right <= width, JSON.stringify(achPanel))
  await shot('list')
  await press('#ach-toggle')

  // Tap targets, on touch screens.
  if (touch) {
    const small = await ev(`[...document.querySelectorAll('main button:not(.bar):not(.swatch), main a:not(.foot a), summary, .hud button, .hud a')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && r.height < 26 && getComputedStyle(e).display !== 'inline' }).map(e => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 8)`)
    check(where, 'buttons are big enough for a finger', small.length === 0, small.join())
    check(where, 'away from Windows, Download offers to send it to your PC', /Send it to your PC/i.test(await ev(`document.querySelector('.hero-copy .btn-hex').innerText`)))
  }

  // The rest of the sections, for looking at.
  for (const sel of ['#unlock', '#sessions', '#band', '#page', '#tiers', '#couch', '#look', '#saves', '#light']) {
    await scrollTo((await topOf(sel)) - (sel === '#couch' ? 0 : 40), 420)
    await shot(sel.slice(1))
  }

  // The end.
  await ev(`document.querySelector('#finale').scrollIntoView({ block: 'start', behavior: 'instant' }); true`)
  await sleep(700)
  await shot('finale')
  check(where, 'reaching the end earns End Credits', await hasAch('end'))
  check(where, 'going through the tour earns Into the Hive', await hasAch('hive'))
  check(where, 'all 7 achievements can be earned', (await got()) === 7, await got())
  check(where, 'every logo cell is filled', (await ev(`document.querySelectorAll('#hud-logo polygon.on').length`)) === 7)
  const fin = await ev(`document.querySelector('#finale-note').textContent`)
  check(where, 'the end knows you got them all', /Every achievement/.test(fin), fin.slice(0, 50))
  const dl = await ev(`document.querySelector('#finale .btn-hex').getBoundingClientRect().right`)
  check(where, 'the last Download fits', dl <= width + 1, Math.round(dl))

  await ev(`document.querySelector('#faq').scrollIntoView({ block: 'start', behavior: 'instant' }); true`)
  await sleep(300)
  await press('summary', 2)
  check(where, 'a question opens', await ev(`document.querySelectorAll('details')[2].open`))
  await shot('faq')
  await scrollTo(1e7, 300)
  await shot('foot')

  for (const page of ['privacy.html', 'terms.html']) {
    await win.loadURL(`http://127.0.0.1:${port}/${page}`)
    await sleep(250)
    const sideways = await ev('document.documentElement.scrollWidth')
    check(where, `${page} fits the width`, sideways <= width + 1, sideways)
    await shot(page.replace('.html', ''))
  }

  check(where, 'no errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '))
  dbg.detach()
  win.destroy()
}

// Speed: the frame rate while scrolling through the heaviest part, on a normal laptop size.
async function runSpeed(port) {
  const win = new BrowserWindow({ width: 1440, height: 900, x: -4000, y: 60, show: false, frame: false, webPreferences: { backgroundThrottling: false, partition: 'check-speed' } })
  win.showInactive()
  win.setPosition(-4000, 60)
  win.setContentSize(1440, 900)
  await win.loadURL(`http://127.0.0.1:${port}/`)
  await sleep(3200)
  const r = await win.webContents.executeJavaScript(`new Promise(done => {
    document.documentElement.style.scrollBehavior = 'auto'
    const end = document.querySelector('#rail').offsetTop + document.querySelector('#rail').offsetHeight
    const start = performance.now(), length = 9000
    let frames = 0, worst = 0, last = start
    function step(now) {
      frames++
      worst = Math.max(worst, now - last)
      last = now
      const p = (now - start) / length
      window.scrollTo(0, end * Math.min(1, p))
      if (p < 1) requestAnimationFrame(step)
      else done({ fps: Math.round(frames / (length / 1000)), worst: Math.round(worst) })
    }
    requestAnimationFrame(step)
  })`, true)
  console.log(`speed: ${r.fps} frames a second while scrolling, worst frame ${r.worst} ms`)
  check('speed', 'scrolling through the whole page stays smooth', r.fps >= 30, r.fps + ' fps')
  win.destroy()
}

async function runMotionOff(port) {
  const name = 'motion-off'
  const win = new BrowserWindow({ width: 1440, height: 900, x: -4000, y: 60, show: false, frame: false, webPreferences: { backgroundThrottling: false, partition: 'check-off' } })
  win.showInactive()
  win.setPosition(-4000, 60)
  win.setContentSize(1440, 900)
  const errors = []
  win.webContents.on('console-message', (e) => { if (e.level >= 2 && !/api\.github\.com|net::ERR/.test(e.message)) errors.push(e.message) })
  await win.loadURL(`http://127.0.0.1:${port}/`)
  await win.webContents.executeJavaScript(`localStorage.setItem('kozo-site', JSON.stringify({ motion: 'off' })); location.reload(); true`)
  await sleep(2400)
  const ev = (c) => win.webContents.executeJavaScript(c, true)
  check(name, 'with Animations off the page is flat', await ev(`document.documentElement.classList.contains('flat')`))
  check(name, 'its switch says off', (await ev(`document.querySelector('#motion-toggle').getAttribute('aria-checked')`)) === 'false')
  check(name, 'everything is still there', (await ev(`document.querySelectorAll('.beat img').length`)) === 3 && (await ev(`getComputedStyle(document.querySelector('.beat figcaption')).position`)) === 'static')
  check(name, 'no sideways scrolling', (await ev('document.documentElement.scrollWidth')) <= (await ev('innerWidth')) + 1)
  await ev(`window.__wheel = null; addEventListener('wheel', e => { window.__wheel = e.defaultPrevented }); true`)
  await win.webContents.sendInputEvent({ type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: -120 })
  await sleep(300)
  check(name, 'with Animations off the wheel is the browser\'s own', (await ev('window.__wheel')) === false, String(await ev('window.__wheel')))
  check(name, 'no errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  win.destroy()
}

app.on('window-all-closed', () => {})
app.whenReady().then(() => server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  try {
    checkFiles()
    for (const s of SIZES) {
      const before = fail
      await runSize(s, port)
      console.log(`${s[0]} ${s[1]}x${s[2]}: ${fail === before ? 'ok' : (fail - before) + ' failed'}`)
    }
    if (!process.env.SITE_SIZES) { await runMotionOff(port); await runSpeed(port) }
  } catch (e) {
    fail++
    console.log('STOPPED: ' + (e.stack || e.message))
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  app.exit(fail ? 1 : 0)
}))
