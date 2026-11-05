'use strict'
// Builds the landing page's static assets into site/assets: the self-hosted fonts, the favicon,
// and the cover atlas the honeycomb draws from (one image, so 100 cells are one draw call).
// Run through real Electron, which has fetch and a canvas that can write WebP:
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/site-assets.js
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'kozo-site-assets-')))
app.commandLine.appendSwitch('mute-audio')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const OUT = path.join(__dirname, '..', 'site', 'assets')
const FONTS = [
  ['anybody', 'Anybody:wdth,wght@50..150,100..900'],
  ['hanken-grotesk', 'Hanken+Grotesk:wght@100..900'],
  ['martian-mono', 'Martian+Mono:wdth,wght@75..112.5,100..800'],
]
// Well-known games with strong art. Only used to show how a library looks.
const GAMES = [
  1245620, 1091500, 1145360, 1145350, 1086940, 367520, 413150, 1174180, 814380, 105600, 620, 782330,
  292030, 2218750, 1868140, 271590, 1593500, 1817070, 2050650, 1888930, 1623730, 2358720, 1794680,
  892970, 2379780, 990080, 1903340, 582010, 374320, 1627720, 2183900, 2215430, 1850570, 1551360,
  322330, 289070, 1158310, 648800, 1966720, 2344520, 1328670, 2246340, 1030300, 730,
]
const COLS = 8, ROWS = 5, CELL_W = 200, CELL_H = 300, QUALITY = 0.74

async function buildFonts() {
  const dir = path.join(OUT, 'fonts')
  fs.mkdirSync(dir, { recursive: true })
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
  for (const [name, family] of FONTS) {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}&display=swap`, { headers: { 'User-Agent': UA } })).text()
    const latin = /\/\* latin \*\/[\s\S]*?url\((https:[^)]+\.woff2)\)/.exec(css)
    if (!latin) throw new Error(`no latin file for ${name}`)
    const buf = Buffer.from(await (await fetch(latin[1])).arrayBuffer())
    fs.writeFileSync(path.join(dir, `${name}.woff2`), buf)
    console.log(`font ${name}: ${Math.round(buf.length / 1024)} KB`)
  }
}

function buildFavicon() {
  const S = 9, VIS = 7.7, W = S * Math.sqrt(3)
  const centers = [[0, 0], [-W, 0], [W, 0], [-W / 2, -S * 1.5], [W / 2, -S * 1.5], [-W / 2, S * 1.5], [W / 2, S * 1.5]]
  const hex = (cx, cy) => Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / 3
    return `${(cx + VIS * Math.cos(a)).toFixed(2)},${(cy + VIS * Math.sin(a)).toFixed(2)}`
  }).join(' ')
  const polys = centers.map(([x, y]) => `<polygon points="${hex(x, y)}" fill="#9FFF02"/>`).join('')
  fs.writeFileSync(path.join(OUT, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-26 -23 52 46">${polys}</svg>\n`)
  console.log('favicon written')
}

async function listCovers() {
  const out = []
  for (let i = 0; i < GAMES.length; i += 50) {
    const input = { ids: GAMES.slice(i, i + 50).map(appid => ({ appid })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } }
    const res = await fetch(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`)
    const data = await res.json()
    for (const item of data?.response?.store_items || []) {
      const a = item.assets
      const file = a?.library_capsule_2x || a?.library_capsule
      if (!file || !a.asset_url_format || !item.name) continue
      out.push({ id: item.appid, name: item.name, url: `https://shared.akamai.steamstatic.com/store_item_assets/${a.asset_url_format.replace('${FILENAME}', file)}` })
    }
  }
  return out
}

// App text has no long dashes, and a trademark sign reads badly on a small label.
const cleanName = (n) => n.replace(/\s*[–—]\s*/g, ": ").replace(/[™®]/g, "").replace(/’/g, "'")

async function buildAtlas() {
  const covers = await listCovers()
  const picked = []
  for (const c of covers) {
    if (picked.length >= COLS * ROWS) break
    try {
      const res = await fetch(c.url)
      if (!res.ok) { console.log(`skip ${c.name}: ${res.status}`); continue }
      const type = res.headers.get('content-type') || 'image/jpeg'
      picked.push({ ...c, data: `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` })
    } catch (e) { console.log(`skip ${c.name}: ${e.message}`) }
  }
  if (picked.length < COLS * ROWS) throw new Error(`only ${picked.length} covers`)
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<canvas id=c></canvas>')
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const list = ${JSON.stringify(picked.map(p => p.data))}
    const c = document.getElementById('c'); c.width = ${COLS * CELL_W}; c.height = ${ROWS * CELL_H}
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'
    for (let i = 0; i < list.length; i++) {
      const img = new Image(); img.src = list[i]; await img.decode()
      const x = (i % ${COLS}) * ${CELL_W}, y = Math.floor(i / ${COLS}) * ${CELL_H}
      // Fill the cell, cropping whatever doesn't fit.
      const s = Math.max(${CELL_W} / img.width, ${CELL_H} / img.height)
      const w = img.width * s, h = img.height * s
      g.drawImage(img, x + (${CELL_W} - w) / 2, y + (${CELL_H} - h) / 2, w, h)
    }
    return c.toDataURL('image/webp', ${QUALITY})
  })()`)
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  fs.writeFileSync(path.join(OUT, 'covers.webp'), buf)
  fs.writeFileSync(path.join(OUT, 'covers.js'), `// Generated by scripts/site-assets.js: the games in covers.webp, in order.\nwindow.KOZO_COVERS = ${JSON.stringify({ cols: COLS, rows: ROWS, names: picked.map(p => cleanName(p.name)) })}\n`)
  console.log(`atlas: ${picked.length} covers, ${Math.round(buf.length / 1024)} KB`)
  console.log(picked.map(p => p.name).join(' | '))
  win.destroy()
}

// The picture the toast playground shows, as a game on the screen.
async function buildScene() {
  const input = { ids: [{ appid: 1091500 }], context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } }
  const res = await fetch(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`)
  const a = (await res.json())?.response?.store_items?.[0]?.assets
  const file = a?.library_hero_2x || a?.library_hero
  if (!file) throw new Error('no art for the scene')
  const img = await fetch(`https://shared.akamai.steamstatic.com/store_item_assets/${a.asset_url_format.replace('${FILENAME}', file)}`)
  const src = `data:${img.headers.get('content-type') || 'image/jpeg'};base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<canvas id=c></canvas>')
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(src)}; await img.decode()
    const w = Math.min(1920, img.width), h = Math.round(img.height * w / img.width)
    const c = document.getElementById('c'); c.width = w; c.height = h
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h)
    return c.toDataURL('image/webp', 0.8)
  })()`)
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  fs.writeFileSync(path.join(OUT, 'scene.webp'), buf)
  console.log(`scene: ${Math.round(buf.length / 1024)} KB`)
  win.destroy()
}

// The picture a link shows when it's shared: the real first screen, without the top bar and cards.
async function buildOg() {
  const http = require('http')
  const root = path.join(__dirname, '..', 'site')
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' }
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0])
    const file = path.join(root, p === '/' ? 'index.html' : p)
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
      res.end(buf)
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const win = new BrowserWindow({ width: 1000, height: 700, x: -4000, y: 60, show: false, frame: false, webPreferences: { backgroundThrottling: false } })
  win.showInactive()
  win.setPosition(-4000, 60)
  // Attaching to a window with no page yet takes the whole app down.
  await win.loadURL('data:text/html,<title>wait</title>')
  const dbg = win.webContents.debugger
  dbg.attach('1.3')
  const cdp = (m, p) => dbg.sendCommand(m, p)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false })
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`)
  await new Promise(r => setTimeout(r, 3200))
  await win.webContents.insertCSS('html { scrollbar-width: none; } .hud, #toasts, #session, #hive-tag, .eyebrow-score, .cta-row, .meta { display: none !important; } .hero { padding-block: 40px !important; }')
  await new Promise(r => setTimeout(r, 400))
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 86 })
  const buf = Buffer.from(shot.data, 'base64')
  fs.writeFileSync(path.join(OUT, 'og.jpg'), buf)
  console.log(`share picture: ${Math.round(buf.length / 1024)} KB`)
  dbg.detach()
  win.destroy()
  server.close()
}

// A 1200 px copy of every screenshot in shots/sm, for normal screens and phones. site-shots.js
// writes both when it takes them; this rebuilds the small ones from the big ones.
async function buildSmallShots() {
  const dir = path.join(OUT, 'shots'), sm = path.join(dir, 'sm')
  fs.mkdirSync(sm, { recursive: true })
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html,<canvas id=c></canvas>')
  let before = 0, after = 0
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.webp'))) {
    const big = fs.readFileSync(path.join(dir, f))
    const data = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image(); img.src = 'data:image/webp;base64,${big.toString('base64')}'; await img.decode()
      const w = Math.min(1200, img.width), h = Math.round(img.height * w / img.width)
      const c = document.getElementById('c'); c.width = w; c.height = h
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h)
      return c.toDataURL('image/webp', 0.8)
    })()`)
    const buf = Buffer.from(data.split(',')[1], 'base64')
    fs.writeFileSync(path.join(sm, f), buf)
    before += big.length
    after += buf.length
  }
  console.log(`small screenshots: ${Math.round(after / 1024)} KB instead of ${Math.round(before / 1024)} KB`)
  win.destroy()
}

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const only = process.env.ASSETS_ONLY
  if (!only) {
    await buildFonts()
    buildFavicon()
    await buildAtlas()
  }
  if (!only || only === 'scene') await buildScene()
  if (!only || only === 'og') await buildOg()
  if (!only || only === 'small') await buildSmallShots()
  app.exit(0)
}).catch(e => { console.error(e); app.exit(1) })
