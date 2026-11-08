'use strict'

// Smoke test: starts the real app (main process + built renderer) on a fresh,
// throwaway profile, then visits every page and pokes the things that broke
// before a release: right-click menus, controller navigation across page
// changes, Big Picture, Pick for me, page overflow at a narrow width.
//
//   npx vite build && npx electron scripts/smoke-test.js
//
// No extra packages: it drives the renderer from the main process with
// webContents.executeJavaScript. Prints PASS/FAIL like test-parsers.js and
// exits 1 on any failure. Never touches your real KoZo data (own userData).

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = path.join(__dirname, '..')
if (!fs.existsSync(path.join(root, 'renderer-dist', 'index.html'))) {
  console.error('renderer-dist is missing: run `npx vite build` first.')
  process.exit(2)
}

// Before main.js loads: its own DB, logs and single-instance lock.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kozo-smoke-'))
app.setPath('userData', tmp)
// Its own Documents too: backupHome.ensure() runs 45s in and, on this fresh
// profile, would otherwise adopt the real KoZo Backup folder, overwrite the
// real library file and move old backups into this throwaway folder.
app.setPath('documents', path.join(tmp, 'Documents'))
process.env.KOZO_SMOKE = '1'
process.env.KOZO_RENDERER = 'dist'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function finish(code) {
  console.log(`\n${pass} passed, ${fail} failed`)
  app.isQuitting = true
  setTimeout(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    app.exit(code)
  }, 300)
}
setTimeout(() => { console.error('  FAIL  timed out after 240s'); fail++; finish(1) }, 240000).unref()

const main = require(path.join(root, 'electron', 'main.js'))

async function waitForWindow() {
  for (let i = 0; i < 200; i++) {
    const w = main.getMainWindow()
    if (w && !w.isDestroyed() && !w.webContents.isLoading() && w.webContents.getURL()) return w
    await sleep(100)
  }
  throw new Error('main window never loaded')
}

app.whenReady().then(async () => {
  let win
  try { win = await waitForWindow() } catch (e) { check('main window loads', false, e.message); return finish(1) }
  check('main window loads', true)
  const wc = win.webContents
  wc.setBackgroundThrottling(false)
  win.setContentSize(1440, 900)

  // Renderer errors (network failures are expected offline and ignored).
  const errors = []
  wc.on('console-message', (e) => {
    const msg = String(e.message || '')
    if (e.level !== 'error') return
    if (/net::ERR_|Failed to load resource|ERR_INTERNET|ENOTFOUND|status of 4\d\d|status of 5\d\d/i.test(msg)) return
    errors.push(msg.slice(0, 300))
  })
  wc.on('render-process-gone', (_e, d) => errors.push('renderer gone: ' + d.reason))

  const ev = (code) => wc.executeJavaScript(code, true)
  const go = async (hash, wait = 1500) => { await ev(`location.hash = ${JSON.stringify(hash)}; true`); await sleep(wait) }
  const escape = async () => { await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`); await sleep(300) }
  const errorsSince = (n) => errors.slice(n)

  await sleep(1500)
  // ── Seed a small library ──
  const seeded = await ev(`(async () => {
    const api = window.kozo.api
    await api.settings.set('onboarding_done', '1')
    const ids = []
    for (const [name, genres] of [['Smoke Alpha', '["Action","RPG"]'], ['Smoke Beta', '["Puzzle"]'], ['Smoke Gamma', '["Action"]']]) {
      const r = await api.games.add({ name, exe_name: name.replace(' ', '') + '.exe', install_path: 'C:\\\\SmokeGames\\\\' + name, source: 'manual' })
      if (r?.ok) { ids.push(r.data.id); await api.games.update(r.data.id, { genres }) }
    }
    const d = new Date(); const month = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    await api.games.planMonth(ids, month)
    const list = await api.gameList.list({ limit: 50 })
    for (const row of (list.data?.items || [])) await api.gameList.update(row.id, { status: 'want_to_play' })
    await api.games.update(ids[2], { completion_status: 'finished' })
    await api.games.update(ids[1], { is_cracked: 1 })   // a game with no launcher: its page must not say cracked
    return ids
  })()`)
  check('seed 3 games', Array.isArray(seeded) && seeded.length === 3, JSON.stringify(seeded))
  await ev(`location.reload(); true`); await sleep(2500)
  await escape()   // the "rate it" dialog from the Finished game

  // ── Every page ──
  const pages = [
    ['#/', 'Library', true], ['#/game-list', 'Game List', true], ['#/plan', 'Play Plan', true],
    ['#/finished', 'Finished', true], ['#/upcoming', 'Upcoming', false],
    ['#/like', 'Games like', false], ['#/like?app=367520', 'Games like (seeded)', false], ['#/deals', 'Discounts', false],
    ['#/activity?tab=overview', 'Activity overview', false], ['#/activity?tab=sessions', 'Activity sessions', false],
    ['#/activity?tab=achievements', 'Activity achievements', false], ['#/profile', 'Profile', false],
    ['#/settings', 'Settings', false], [`#/game/${seeded?.[0]}`, 'Game page', false],
    [`#/game/${seeded?.[1]}`, 'Game page, no launcher', false],
  ]
  for (const [hash, label, hasMenu] of pages) {
    const before = errors.length
    await go(hash, 1800)
    const st = await ev(`(() => {
      const main = document.querySelector('.app-main')
      return { text: (main?.innerText || '').trim().length, boundary: /Something went wrong/i.test(document.body.innerText),
               over: main ? main.scrollWidth > main.clientWidth + 2 : true,
               crack: (document.body.innerText.match(/.{0,30}\\bcrack(ed|s)?\\b.{0,30}/i) || [''])[0] }
    })()`)
    check(`${label}: renders`, st.text > 20 && !st.boundary, JSON.stringify(st))
    check(`${label}: no errors`, errorsSince(before).length === 0, errorsSince(before).join(' | '))
    check(`${label}: no sideways scroll`, !st.over)
    // The app's words match the site's: games with no launcher, never cracked (the maker's call).
    // Pages listing Steam's store are skipped: a game there can really be called "Crack".
    if (!/^#\/(upcoming|like|deals)/.test(hash)) check(`${label}: never says cracked`, !st.crack, st.crack)
    if (hasMenu) {
      const menu = await ev(`(async () => {
        const card = document.querySelector('.app-main [data-gpnav]')
        if (!card) return 'no card'
        card.scrollIntoView({ block: 'center' })
        await new Promise(r => setTimeout(r, 250))
        const b = card.getBoundingClientRect()
        const t = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 60)) || card
        t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: b.left + b.width / 2, clientY: b.top + 40 }))
        await new Promise(r => setTimeout(r, 300))
        return document.querySelector('[role=menu]') ? 'menu' : 'no menu'
      })()`)
      check(`${label}: right-click menu opens`, menu === 'menu', menu)
      await escape()
    }
  }

  // Settings tabs
  const tabs = await ev(`(async () => {
    location.hash = '#/settings'; await new Promise(r => setTimeout(r, 1200))
    const out = []
    const sel = '.app-main nav[aria-label="Settings sections"] button'
    const n = document.querySelectorAll(sel).length
    for (let i = 0; i < n; i++) {
      document.querySelectorAll(sel)[i].click()
      await new Promise(r => setTimeout(r, 500))
      out.push(document.querySelector('.app-main').innerText.trim().length > 20)
    }
    return out
  })()`)
  check('Settings: every tab renders', tabs.length > 3 && tabs.every(Boolean), JSON.stringify(tabs))
  const crackTabs = await ev(`(async () => {
    const out = [], sel = '.app-main nav[aria-label="Settings sections"] button'
    for (let i = 0; i < document.querySelectorAll(sel).length; i++) {
      document.querySelectorAll(sel)[i].click()
      await new Promise(r => setTimeout(r, 400))
      const m = document.body.innerText.match(/.{0,30}\\bcrack(ed|s)?\\b.{0,30}/i)
      if (m) out.push(m[0])
    }
    return out
  })()`)
  check('Settings: no tab says cracked', crackTabs.length === 0, crackTabs.join(' | '))

  // The Edit window of a game with no launcher, More options open: its Store option said
  // "Cracked" after the rest of the app had stopped saying it.
  await go(`#/game/${seeded?.[1]}`, 1500)
  const editText = await ev(`(async () => {
    const more = [...document.querySelectorAll('button')].find(x => x.title === 'Game options')
    if (!more) return 'no menu button'
    more.click()
    await new Promise(r => setTimeout(r, 300))
    const edit = [...document.querySelectorAll('button')].find(b => /^\\s*edit game\\s*$/i.test(b.innerText))
    if (!edit) return 'no edit item'
    edit.click()
    await new Promise(r => setTimeout(r, 700))
    const dlg = document.querySelector('[role=dialog]')
    if (!dlg) return 'no dialog'
    ;[...dlg.querySelectorAll('button')].find(b => /more options/i.test(b.innerText))?.click()
    await new Promise(r => setTimeout(r, 300))
    return document.querySelector('[role=dialog]')?.innerText || 'closed'
  })()`)
  check('Edit: opens for a game with no launcher', /No launcher/.test(editText), editText.slice(0, 80))
  check('Edit: never says cracked', !/\bcrack(ed|s)?\b/i.test(editText), (editText.match(/.{0,30}\bcrack.{0,30}/i) || [''])[0])
  await escape()

  // Backups: a copy in a folder of your own (a path skips the folder dialog).
  const copyTo = fs.mkdtempSync(path.join(os.homedir(), '.kozo-smoke-copy-'))
  const copyRes = await ev(`(async () => {
    const api = window.kozo.api
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const text = () => document.querySelector('.app-main').innerText
    location.hash = '#/settings?tab=data'; await wait(1800)
    const summary = text()
    const click = (label) => [...document.querySelectorAll('.app-main button')].find(x => x.innerText.trim() === label)?.click()
    click('Set up'); await wait(400)
    const before = document.body.innerText
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(300)
    click('Get everything back'); await wait(400)
    const getBack = document.body.innerText
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(300)
    const set = await api.backup.copySet(${JSON.stringify(copyTo)})
    await api.backup.copyNow()
    const status = (await api.backup.copyStatus()).data
    await wait(500)
    return { summary, before, getBack, set, status, during: text() }
  })()`)
  check('Backups: page is short (the choices are in pop-ups)', /Off this PC/.test(copyRes.summary) && !/Choose a folder|A \.kozo file/.test(copyRes.summary), copyRes.summary.slice(0, 300))
  check('Backups: Set up offers a cloud folder', /Keep a copy off this PC/.test(copyRes.before) && /Choose a folder/.test(copyRes.before), copyRes.before.slice(-300))
  check('Backups: Get everything back lists the sources', /A folder/.test(copyRes.getBack) && /A \.kozo file/.test(copyRes.getBack), copyRes.getBack.slice(-300))
  check('Backups: never offers OneDrive', !/OneDrive/i.test(copyRes.before))
  check('Backups: copy folder is set', copyRes.set?.ok && copyRes.status?.configured && copyRes.status?.reachable && !copyRes.status?.error, JSON.stringify(copyRes.status))
  check('Backups: page shows the copy', /Copy now/.test(copyRes.during) && /Stop copying/.test(await ev(`document.documentElement.textContent`)), copyRes.during.slice(0, 300))
  const copyOff = await ev(`(async () => {
    await window.kozo.api.backup.copyOff()
    await new Promise(r => setTimeout(r, 400))
    return document.querySelector('.app-main').innerText
  })()`)
  check('Backups: stop copying goes back to Set up', /Off this PC/.test(copyOff) && /Set up/.test(copyOff), copyOff.slice(0, 300))

  // Restoring from that folder: the library and saves come back, the folder stays
  // where it is and becomes the copy, and KoZo's own backup home doesn't move.
  const settingsQ = require(path.join(root, 'electron', 'db', 'queries', 'settings.js'))
  const backupHome = require(path.join(root, 'electron', 'services', 'backupHome.js'))
  const copyHome = path.join(copyTo, 'KoZo Backup')
  const blob = path.join('Saves', 'Smoke Restored', 'vault', 'blobs', 'abc.gz')
  fs.mkdirSync(path.join(copyHome, path.dirname(blob)), { recursive: true })
  fs.writeFileSync(path.join(copyHome, blob), 'saved game')
  fs.mkdirSync(path.join(copyHome, 'Data'), { recursive: true })
  const payload = require(path.join(root, 'electron', 'services', 'autoBackup.js')).buildPayload()
  fs.writeFileSync(path.join(copyHome, 'Data', 'kozo-autobackup.json'), JSON.stringify(payload))
  const baseBefore = backupHome.base()
  const restored = await ev(`window.kozo.api.backup.restoreFolder(${JSON.stringify(copyTo)}, { copy: true })`)
  check('Restore: reads the backup from the folder', restored?.ok && restored.data?.data?.games === payload.games.length, JSON.stringify(restored).slice(0, 200))
  check('Restore: backup home did not move', backupHome.base() === baseBefore, `${baseBefore} -> ${backupHome.base()}`)
  check('Restore: the folder becomes the copy', settingsQ.getSetting('backup_copy_dir') === copyHome, settingsQ.getSetting('backup_copy_dir'))
  check('Restore: saves came down to this PC', fs.existsSync(path.join(require(path.join(root, 'electron', 'services', 'saveBackup.js')).rootPath(), 'Smoke Restored', 'vault', 'blobs', 'abc.gz')))
  check('Restore: the folder keeps its files', fs.existsSync(path.join(copyHome, blob)))
  const noBackup = fs.mkdtempSync(path.join(os.homedir(), '.kozo-smoke-empty-'))
  const refused = await ev(`window.kozo.api.backup.restoreFolder(${JSON.stringify(noBackup)}, { copy: true })`)
  check('Restore: a folder with no backup is refused', refused?.ok === false && /No KoZo backup/.test(refused.error || ''), JSON.stringify(refused))
  await ev(`window.kozo.api.backup.copyOff()`)
  try { fs.rmSync(copyTo, { recursive: true, force: true }); fs.rmSync(noBackup, { recursive: true, force: true }) } catch {}

  // The Game List window: full width with the store tabs from the first frame for
  // a Steam game, the small form without one. Neither needs Steam to answer.
  {
    const api = `window.kozo.api.gameList`
    await ev(`(async () => {
      await ${api}.add({ name: 'Smoke Window Steam', steam_app_id: 814380, status: 'want_to_play', rating: null, game_id: null })
      await ${api}.add({ name: 'Smoke Window Plain', steam_app_id: null, status: 'want_to_play', rating: null, game_id: null })
      return true
    })()`)
    await ev(`location.hash = '#/plan'; true`); await sleep(300)
    await ev(`location.hash = '#/game-list'; true`)
    const open = (name) => ev(`(async () => {
      let wrap = null
      for (let i = 0; i < 100 && !wrap; i++) {
        wrap = [...document.querySelectorAll('.app-main [data-gpnav]')].find(c => c.innerText.includes(${JSON.stringify(name)}))
        if (!wrap) await new Promise(r => setTimeout(r, 100))
      }
      wrap?.firstElementChild?.click()
      let d = null
      for (let i = 0; i < 60 && !d; i++) {
        await new Promise(r => setTimeout(r, 50))
        d = document.querySelector('[role=dialog]')
      }
      // Layout width, not the on-screen box: the window opens with a small scale
      // animation. It also has to fit the screen, and the release machine's is small.
      const o = d?.parentElement
      const cs = o && getComputedStyle(o)
      const room = o ? Math.floor(o.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) : 0
      const out = { width: d?.offsetWidth || 0, room, tabs: [...(d?.querySelectorAll('[role=tab]') || [])].map(t => t.innerText.trim()), text: d?.innerText || '',
        editButtons: [...(d?.querySelectorAll('button') || [])].filter(b => b.innerText.trim() === 'Edit' && b.getAttribute('role') !== 'tab').length }
      d?.querySelector('button[aria-label="Close dialog"]')?.click()
      await new Promise(r => setTimeout(r, 300))
      return out
    })()`)
    const steam = await open('Smoke Window Steam')
    check('Game List window: full width at once', steam.width === Math.min(1120, steam.room), `${steam.width} of ${steam.room}`)
    check('Game List window: store tabs, Prices and Edit', ['Overview', 'About', 'Details', 'System requirements', 'Prices', 'Edit'].every(t => steam.tabs.includes(t)), steam.tabs.join(', '))
    check('Game List window: one way into editing', steam.editButtons === 0, steam.editButtons)
    const plain = await open('Smoke Window Plain')
    check('Game List window: no Steam page keeps the small form', plain.width === Math.min(560, plain.room) && plain.tabs.length === 0 && /Status/i.test(plain.text), `${plain.width} of ${plain.room}`)
    await ev(`location.hash = '#/settings?tab=appearance'; true`); await sleep(1800)
    check('Settings: Game List window switch', await ev(`[...document.querySelectorAll('button[role=radio]')].some(b => b.innerText.includes('On the Overview'))`))
    await ev(`location.hash = '#/settings?tab=tracking'; true`); await sleep(1800)
    check('Settings: stop counting after switching away, 1 minute by default', await ev(`document.querySelector('[aria-label="Stop counting after switching away"] [aria-pressed=true]')?.innerText === '1m'`))
    // Leave the list as it was: Pick for me below chooses from it.
    await ev(`(async () => {
      const rows = (await ${api}.list({ limit: 50 })).data?.items || []
      for (const r of rows) if (/^Smoke Window /.test(r.name)) await ${api}.delete(r.id)
      return true
    })()`)
  }

  // Your year, on seeded sessions: the numbers on the page match the database, and
  // sharing makes a real picture. Steam isn't needed for any of it.
  {
    const before = errors.length
    const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
    const y = new Date().getFullYear()
    const addSession = db.prepare('INSERT INTO sessions (game_id, started_at, ended_at, duration_seconds, idle_seconds) VALUES (?, ?, ?, ?, 0)')
    const added = [
      [seeded[0], `${y}-02-10T12:00:00.000Z`, `${y}-02-10T13:00:00.000Z`, 3600],
      [seeded[0], `${y}-02-11T12:00:00.000Z`, `${y}-02-11T12:30:00.000Z`, 1800],
      [seeded[1], `${y}-03-15T12:00:00.000Z`, `${y}-03-15T14:00:00.000Z`, 7200],
      [seeded[1], `${y - 1}-06-15T12:00:00.000Z`, `${y - 1}-06-15T12:40:00.000Z`, 2400],
    ].map(a => addSession.run(...a).lastInsertRowid)
    const year = await ev(`window.kozo.api.stats.year(${y})`)
    const d = year?.data
    check('Your year: totals', d?.seconds === 12600 && d.sessions === 3 && d.games === 2 && d.days === 3, JSON.stringify(d && { s: d.seconds, n: d.sessions, g: d.games, days: d.days }))
    check('Your year: last year stays out', (await ev(`window.kozo.api.stats.year(${y - 1})`))?.data?.seconds === 2400)
    check('Your year: streak and busiest month', d?.streak === 2 && d.busiestMonth === 3, JSON.stringify(d && [d.streak, d.busiestMonth]))
    check('Your year: most played first', d?.topGames?.[0]?.id === seeded[1] && d.topGames[0].seconds === 7200)
    check('Your year: both years offered', JSON.stringify((await ev(`window.kozo.api.stats.years()`))?.data?.slice(0, 2)) === JSON.stringify([y, y - 1]))
    await go('#/activity?tab=year', 1500)
    const page = await ev(`(() => ({
      hours: document.querySelector('[data-year-hours]')?.innerText || '',
      bars: document.querySelectorAll('.app-main [class*=_col_]').length,
      over: document.querySelector('.app-main').scrollWidth > document.querySelector('.app-main').clientWidth + 2,
      boundary: /Something went wrong/i.test(document.body.innerText),
    }))()`)
    check('Your year: shows the hours', /^3h/.test(page.hours), page.hours)
    check('Your year: a bar place for each month', page.bars === 12, String(page.bars))
    check('Your year: no sideways scroll', !page.over && !page.boundary)
    await ev(`[...document.querySelectorAll('.app-main button')].find(b => b.innerText.trim() === 'Share')?.click(); true`)
    await sleep(700)
    const shot = await ev(`(async () => {
      const r = document.querySelector('[data-share-card]')?.getBoundingClientRect()
      if (!r) return null
      const z = window.kozo.ui.getZoom()
      return window.kozo.api.stats.captureCard({ x: r.left * z, y: r.top * z, width: r.width * z, height: r.height * z }, 'probe', ${y})
    })()`)
    check('Your year: sharing makes a real picture', shot?.ok && shot.data.width > 100 && shot.data.colors > 8 && shot.data.bytes > 1000, JSON.stringify(shot))
    await escape(); await sleep(300)
    db.prepare(`DELETE FROM sessions WHERE id IN (${added.map(() => '?').join(',')})`).run(...added)
    check('Your year: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // The chart's bars are days. A bar narrows the rows under the bars to that day, a row
  // opens what happened in it, under itself. No popups. Seeded, so Steam isn't needed.
  {
    const before = errors.length
    const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
    const ago = (h) => new Date(Date.now() - h * 3600000).toISOString()
    const addSession = db.prepare('INSERT INTO sessions (game_id, started_at, ended_at, duration_seconds, idle_seconds, achievements_unlocked) VALUES (?, ?, ?, ?, ?, ?)')
    const session = addSession.run(seeded[0], ago(3), ago(1), 3600, 3600, 2).lastInsertRowid
    const near = addSession.run(seeded[0], ago(4), ago(3.5), 1800, 0, 1).lastInsertRowid   // usually the same day
    const older = addSession.run(seeded[0], ago(72), ago(71.5), 1800, 0, 1).lastInsertRowid
    const addAch = db.prepare('INSERT INTO achievements (game_id, steam_api_name, display_name, description) VALUES (?, ?, ?, ?)')
    const unlock = db.prepare("INSERT INTO achievement_unlocks (achievement_id, session_id, unlocked_at, source) VALUES (?, ?, ?, 'manual')")
    const achs = ['First', 'Second', 'Near', 'Older', 'Elsewhere', 'Locked'].map(n => addAch.run(seeded[0], 'smoke_' + n, 'Smoke ' + n, 'A test achievement').lastInsertRowid)
    unlock.run(achs[1], session, ago(1.5))
    unlock.run(achs[0], session, ago(2.5))
    unlock.run(achs[2], near, ago(3.8))
    unlock.run(achs[3], older, ago(71.75))
    unlock.run(achs[4], null, ago(2))
    const keyOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    const dayKey = keyOf(ago(3)), olderKey = keyOf(ago(72))
    const sameDay = dayKey === keyOf(ago(4))
    await go(`#/game/${seeded[0]}`, 2500)
    const open = await ev(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const details = () => [...document.querySelectorAll('[data-session-detail]')]
      const text = () => details().map(d => d.innerText).join(' | ')
      const rows = () => document.querySelectorAll('[data-session-row]').length
      const row = (id) => document.querySelector('[data-session-row="' + id + '"]')
      const openRow = async (id) => { row(id)?.click(); await wait(300) }
      const dialogs = () => document.querySelectorAll('[role="dialog"]').length
      const esc = async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(300) }
      const tab = (name) => [...document.querySelectorAll('.app-main button')].find(b => new RegExp('^' + name).test(b.innerText.trim()))?.click()
      const bar = async (key) => { document.querySelector('[data-month-day="' + key + '"]')?.click(); await wait(300) }
      tab('Sessions')
      await wait(300)
      const allRows = rows()
      const bars = document.querySelectorAll('[data-month-day]').length
      const zero = document.querySelectorAll('.app-main div[title$="no play"]').length

      await bar('${dayKey}')
      const chartBottom = document.querySelector('[data-month-day]').getBoundingClientRect().bottom
      const rowTop = row('${session}')?.getBoundingClientRect().top ?? -1
      const picked = { popup: dialogs(), rows: rows(), under: rowTop >= chartBottom, pressed: document.querySelector('[data-month-day="${dayKey}"]')?.getAttribute('aria-pressed'), closed: text(), allButton: [...document.querySelectorAll('.app-main button')].some(b => /All sessions/.test(b.innerText)), rowText: row('${session}')?.innerText }
      await openRow('${session}')
      const opened = text()
      const detailTop = details()[0]?.getBoundingClientRect().top ?? -1
      const underRow = detailTop >= (row('${session}')?.getBoundingClientRect().bottom ?? 1e9)
      await openRow('${near}')
      const switched = text()
      await openRow('${near}')
      const closedAgain = details().length
      await bar('${dayKey}')
      const backRows = rows()

      await bar('${olderKey}')
      const olderDay = text(), olderRows = rows()
      await bar('${olderKey}')
      const allAgain = rows()

      await openRow('${session}')
      const fromRow = text(), rowDialogs = dialogs(), rowKeepsList = rows()
      ;[...details()[0].querySelectorAll('button')].find(b => b.innerText.includes('Smoke First'))?.click()
      await wait(300)
      const stacked = dialogs(), stillThere = details().length
      await esc()
      const afterEsc = dialogs(), dayAfterEsc = details().length

      tab('Overview')
      await wait(400)
      await bar('${olderKey}')
      const fromOverview = text()
      tab('Overview')
      await wait(400)
      document.querySelector('[data-session-row="${session}"]')?.click()
      await wait(300)
      const rowFromOverview = text()
      return { allRows, bars, zero, picked, opened, underRow, switched, closedAgain, backRows, olderDay, olderRows, allAgain, fromRow, rowDialogs, rowKeepsList, stacked, stillThere, afterEsc, dayAfterEsc, fromOverview, rowFromOverview }
    })()`)
    check('Chart: a bar is a day, and only days with play can be clicked', open?.bars === (sameDay ? 2 : 3) && open.zero >= 1, JSON.stringify(open && [open.bars, open.zero]))
    check('Chart: every session is listed before a bar is picked', open?.allRows === 3, open?.allRows)
    check('Chart: a bar opens no popup', open?.picked?.popup === 0)
    check('Chart: the day shows as rows under the bars, with nothing else added', open?.picked?.under && open.picked.allButton === false && /\d/.test(open.picked.rowText || ''), JSON.stringify(open?.picked)?.slice(0, 200))
    check('Chart: only that day\'s sessions', open?.picked?.rows === (sameDay ? 2 : 1), open?.picked?.rows)
    check('Chart: the picked bar is marked', open?.picked?.pressed === 'true')
    if (sameDay) {
      check('Chart: several sessions start closed', !/Smoke First|Smoke Near/.test(open?.picked?.closed || ''), open?.picked?.closed?.slice(0, 160))
      check('Chart: opening a session shows what happened in it', /Smoke First/.test(open?.opened || '') && !/Smoke Near/.test(open?.opened || ''), open?.opened?.slice(0, 160))
      check('Chart: it opens right under its row', open?.underRow === true)
      check('Chart: opening another shows that one instead', /Smoke Near/.test(open?.switched || '') && !/Smoke First/.test(open?.switched || ''), open?.switched?.slice(0, 160))
      check('Chart: the same row again closes it', open?.closedAgain === 0, open?.closedAgain)
    }
    check('Chart: the session says played and paused', /1h played, 1h paused/i.test(open?.opened || ''), open?.opened?.slice(0, 160))
    check('Chart: the picked bar again goes back to every session', open?.backRows === 3)
    check('Chart: a day with one session opens it', open?.olderRows === 1 && /Smoke Older/.test(open?.olderDay || '') && !/Smoke First|Smoke Near/.test(open?.olderDay || ''), open?.olderDay?.slice(0, 160))
    check('Chart: that bar again goes back too', open?.allAgain === 3)
    check('Session row: opens itself in the full list, no popup', /Smoke First/.test(open?.fromRow || '') && /Smoke Second/.test(open?.fromRow || '') && open.rowDialogs === 0 && open.rowKeepsList === 3, open?.fromRow?.slice(0, 160))
    check('Session row: in the order they came', (open?.fromRow || '').indexOf('Smoke First') < (open?.fromRow || '').indexOf('Smoke Second'))
    check('Session row: only what this session earned', !/Smoke Older|Smoke Elsewhere|Smoke Locked/.test(open?.fromRow || ''))
    check('Session row: an achievement opens on top, and the session stays open', open?.stacked === 1 && open.stillThere === 1 && open.afterEsc === 0 && open.dayAfterEsc === 1, JSON.stringify(open && [open.stacked, open.afterEsc, open.dayAfterEsc]))
    check('Overview: a bar goes to that day under the bars', /Smoke Older/.test(open?.fromOverview || ''), open?.fromOverview?.slice(0, 120))
    check('Overview: a session goes there, open', /Smoke First/.test(open?.rowFromOverview || ''), open?.rowFromOverview?.slice(0, 120))
    db.prepare(`DELETE FROM achievements WHERE id IN (${achs.map(() => '?').join(',')})`).run(...achs)
    db.prepare('DELETE FROM sessions WHERE id IN (?, ?, ?)').run(session, near, older)
    await ev(`location.hash = '#/'; true`); await sleep(600)
    check('Session window: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // A tool or an installer as a game's exe: its page says so, until it has sessions.
  {
    const before = errors.length
    const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
    const tool = db.prepare("INSERT INTO games (name, exe_name, source, is_installed) VALUES ('Smoke Tool Game', 'WorldBuilder.exe', 'cracked', 1)").run().lastInsertRowid
    await go(`#/game/${tool}`, 1500)
    const note = () => ev(`document.querySelector('[data-exe-note]')?.innerText || ''`)
    check('Wrong exe: the page says what KoZo is watching', /WorldBuilder\.exe/.test(await note()) && /tracked/.test(await note()), await note())
    const opened = await ev(`(async () => {
      document.querySelector('[data-exe-note] button')?.click()
      await new Promise(r => setTimeout(r, 400))
      return document.querySelectorAll('[role="dialog"]').length
    })()`)
    check('Wrong exe: its button opens Edit', opened === 1, opened)
    await escape(); await sleep(300)
    const sid = db.prepare("INSERT INTO sessions (game_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, 600)").run(tool, new Date(Date.now() - 3600000).toISOString(), new Date().toISOString()).lastInsertRowid
    await go('#/', 400); await go(`#/game/${tool}`, 1200)
    check('Wrong exe: a game with sessions shows no note', (await note()) === '')
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid)
    db.prepare('UPDATE games SET exe_name = ? WHERE id = ?').run('The Real Game.exe', tool)
    await go('#/', 400); await go(`#/game/${tool}`, 1200)
    check('Wrong exe: a real exe shows no note', (await note()) === '')
    db.prepare('DELETE FROM games WHERE id = ?').run(tool)
    await go('#/', 400)
    check('Wrong exe: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // Signing in with a Google account that holds another PC's backup: three questions, one
  // after another. A pretend Drive, so no account and no network. Ids collide on purpose:
  // the other PC's first game has the id of a different game here.
  {
    const before = errors.length
    const { createFakeDrive, install } = require('./fake-drive')
    const zlib = require('zlib'), crypto = require('crypto')
    const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
    const settings = require(path.join(root, 'electron', 'db', 'queries', 'settings.js'))
    const googleDrive = require(path.join(root, 'electron', 'services', 'googleDrive.js'))
    const saveVault = require(path.join(root, 'electron', 'services', 'saveVault.js'))
    const saveBackup = require(path.join(root, 'electron', 'services', 'saveBackup.js'))
    const autoBackup = require(path.join(root, 'electron', 'services', 'autoBackup.js'))
    const drive = createFakeDrive()
    const undo = install(drive)
    const realConnect = googleDrive.connect
    googleDrive.connect = async () => ({ email: 'someone@example.com' })
    const was = { id: settings.getSetting('gdrive_client_id'), secret: settings.getSetting('gdrive_client_secret') }
    settings.setSetting('gdrive_client_id', 'smoke.apps.googleusercontent.com')
    settings.setSetting('gdrive_client_secret', 'smoke')
    settings.setSetting('gdrive_token', 'raw:' + Buffer.from(JSON.stringify({ refresh_token: 'fake' })).toString('base64'))

    const here = db.prepare('SELECT id, name FROM games WHERE id IN (?, ?)').all(seeded[0], seeded[1])
    const hereFirst = here.find(g => g.id === seeded[0]), hereSecond = here.find(g => g.id === seeded[1])
    const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
    const at = (h) => new Date(Date.now() - h * 3600000).toISOString()
    const content = Buffer.from('a save from the other PC')
    const hash = crypto.createHash('sha1').update(content).digest('hex')
    const payload = {
      version: 1, app: 'kozo', install: 'other-pc', pc: 'SMOKE-PC', exported_at: at(2), auto: true,
      games: [
        { id: seeded[0], name: 'Smoke Other PC Game', steam_app_id: null, exe_name: 'other.exe', source: 'manual', install_path: 'Q:/nowhere', is_installed: 1, total_playtime_seconds: 3600, created_at: at(90) },
        { id: 987654, name: hereSecond.name, steam_app_id: null, exe_name: 'theirs.exe', source: 'manual', total_playtime_seconds: 1800 },
      ],
      sessions: [
        { id: 1, game_id: seeded[0], started_at: at(30), ended_at: at(29), duration_seconds: 3600, achievements_unlocked: 1 },
        { id: 2, game_id: 987654, started_at: at(40), ended_at: at(39.5), duration_seconds: 1800, achievements_unlocked: 0 },
      ],
      achievements: [{ id: 1, game_id: seeded[0], steam_api_name: 'smoke_other', display_name: 'Smoke Other Unlock' }],
      achievement_unlocks: [{ id: 1, achievement_id: 1, session_id: 1, unlocked_at: at(29.5), source: 'crack' }],
      game_list: [
        { id: 1, game_id: seeded[0], name: 'Smoke Other PC Game', status: 'playing' },
        { id: 2, game_id: 987654, name: hereSecond.name, status: 'dropped' },
        { id: 3, game_id: null, name: 'Smoke Wish', steam_app_id: 987001, status: 'upcoming' },
        { id: 4, game_id: null, name: 'Smoke Wish', steam_app_id: 987001, status: 'upcoming' },
      ],
      settings: [{ key: 'smoke_from_other_pc', value: '1' }],
    }
    const folder = 'Smoke Other PC Game'
    const snap = { id: '2026-01-01T00-00-00-000Z_manual', gameId: seeded[0], gameName: folder, createdAt: at(2), reason: 'manual', label: null, sources: ['C:\\Users\\SomeoneElse\\AppData\\Roaming\\SmokeOther'], files: [{ s: 0, p: 'save.dat', h: hash, n: content.length, m: Date.now() }], bytes: content.length }
    const root0 = (await drive.request({ method: 'post', url: 'https://www.googleapis.com/drive/v3/files', data: { name: 'KoZo Backup', mimeType: 'application/vnd.google-apps.folder' } })).data.id
    const put = (name, bytes) => drive.add({ name, parents: [root0] }, Buffer.from(bytes))
    put('Data/kozo-library-other-pc.json', JSON.stringify(payload))
    put(`Saves/${folder}/vault/blobs/${hash}.gz`, zlib.gzipSync(content))
    put(`Saves/${folder}/vault/snapshots/${snap.id}.json`, JSON.stringify(snap))
    put(`Saves/${folder}/vault/meta.json`, JSON.stringify({ gameId: seeded[0], gameName: folder, vault: 1 }))
    const otherFile = Buffer.from(drive.read('Data/kozo-library-other-pc.json'))

    const offerStep = () => ev(`document.querySelector('[data-drive-offer]')?.dataset.driveOffer || ''`)
    const offerText = () => ev(`document.querySelector('[data-drive-offer]')?.innerText || ''`)
    const waitStep = async (want) => { for (let i = 0; i < 60 && (await offerStep()) !== want; i++) await sleep(100); return offerStep() }
    const press = (which) => ev(`document.querySelector('[data-offer-${which}]')?.click(); true`)
    const startCounts = { games: count('games'), list: count('game_list'), sessions: count('sessions') }
    const playedBefore = db.prepare('SELECT total_playtime_seconds t FROM games WHERE id = ?').get(seeded[1]).t || 0

    const signedIn = await ev('window.kozo.api.drive.connect()')
    check('Google: sign-in finds the other PC', signedIn?.ok && signedIn.data?.offer?.anything === true && signedIn.data.offer.pcs?.[0]?.name === 'SMOKE-PC', JSON.stringify(signedIn?.data?.offer)?.slice(0, 200))
    check('Google: the first question is the Game List', (await waitStep('list')) === 'list', await offerStep())
    const q1 = await offerText()
    check('Google: it says duplicates stay out', /Game List from SMOKE-PC/.test(q1) && /won't be added twice/.test(q1) && /Question 1 of 3/.test(q1), q1.slice(0, 200))
    check('Google: it counts only what is new', /3 games on it, 2 not on this PC/.test(q1), q1.slice(0, 200))
    check('Google: nothing changed before an answer', count('games') === startCounts.games && count('game_list') === startCounts.list)

    await press('yes')
    check('Google: the Library comes second', (await waitStep('library')) === 'library', await offerStep())
    check('Google: Game List added what is new', count('game_list') === startCounts.list + 2, count('game_list') - startCounts.list)
    check('Google: no duplicates on the list', db.prepare("SELECT COUNT(*) c FROM game_list WHERE name = 'Smoke Wish'").get().c === 1 && db.prepare('SELECT COUNT(*) c FROM game_list WHERE lower(name) = lower(?)').get(hereSecond.name).c === 1)
    check('Google: a row already here keeps its status', db.prepare('SELECT status FROM game_list WHERE lower(name) = lower(?)').get(hereSecond.name).status !== 'dropped')
    check('Google: that question added no games', count('games') === startCounts.games)
    check('Google: the second question says what comes', /Library from SMOKE-PC/.test(await offerText()) && /Question 2 of 3/.test(await offerText()), (await offerText()).slice(0, 200))

    await press('yes')
    check('Google: game saves come third', (await waitStep('saves')) === 'saves', await offerStep())
    const added = db.prepare("SELECT * FROM games WHERE name = 'Smoke Other PC Game'").get()
    check('Google: a new game with this PC\'s own id', count('games') === startCounts.games + 1 && added && added.id !== seeded[0], JSON.stringify(added?.id))
    check('Google: the game that had that id is untouched', db.prepare('SELECT name FROM games WHERE id = ?').get(seeded[0]).name === hereFirst.name)
    check('Google: a game not on this PC shows as not installed', added?.is_installed === 0)
    check('Google: its session and achievement moved to it', db.prepare('SELECT COUNT(*) c FROM sessions WHERE game_id = ?').get(added?.id).c === 1 && db.prepare("SELECT au.session_id s FROM achievement_unlocks au JOIN achievements a ON a.id = au.achievement_id WHERE a.game_id = ?").get(added?.id)?.s != null)
    check('Google: the same game gets the other PC\'s playtime', (db.prepare('SELECT total_playtime_seconds t FROM games WHERE id = ?').get(seeded[1]).t || 0) === playedBefore + 1800)
    check('Google: a game already here keeps its exe', db.prepare('SELECT exe_name e FROM games WHERE id = ?').get(seeded[1]).e !== 'theirs.exe')
    check('Google: the list row from question 1 is linked, not doubled', db.prepare("SELECT game_id g FROM game_list WHERE name = 'Smoke Other PC Game'").all().map(r => r.g).join() === String(added?.id))
    check('Google: settings of the other PC stay out on a PC with a library', settings.getSetting('smoke_from_other_pc') == null)
    const xp = require(path.join(root, 'electron', 'services', 'xp.js')).computeXp()
    check('Google: no surprise XP after the next session', Number(settings.getSetting('xp_last_total')) === xp.totalXp, settings.getSetting('xp_last_total') + ' vs ' + xp.totalXp)

    check('Google: the saves question says they stay backups', /Question 3 of 3/.test(await offerText()) && /current saves stay/.test(await offerText()), (await offerText()).slice(0, 200))
    await press('yes')
    check('Google: then it is done', (await waitStep('done')) === 'done', await offerStep())
    const lines = await offerText()
    check('Google: the end says what was added', /Game List: 2 games added/.test(lines) && /Library: 1 game added/.test(lines) && /Game saves: backups for 1 game/.test(lines), lines)
    const snaps = saveVault.listSnapshots({ id: added?.id, name: added?.name })
    check('Google: the saves are on the right game', snaps.length === 1, snaps.length)
    check('Google: not on the game that has their old id', !saveVault.listSnapshots({ id: seeded[0], name: hereFirst.name }).some(x => x.id === snap.id))
    check('Google: a restore goes to this PC\'s home folder', snaps[0]?.sources?.[0] === path.join(require('os').homedir(), 'AppData', 'Roaming', 'SmokeOther'), snaps[0]?.sources?.[0])

    await press('done')
    await sleep(2500)
    const again = await ev('window.kozo.api.drive.offer()')
    check('Google: asked again, nothing is left to add', again?.ok && again.data.anything === false, JSON.stringify(again?.data)?.slice(0, 200))

    // This PC's own file goes up beside the other PC's, which stays as it was.
    await autoBackup.writeNow({ force: true })
    const synced = await googleDrive.sync()
    const me = settings.getSetting('install_id')
    check('Google: this PC has its own library file', synced && !synced.error && drive.names().includes(`Data/kozo-library-${me}.json`), JSON.stringify(synced)?.slice(0, 160))
    check('Google: the other PC\'s file is untouched', otherFile.equals(drive.read('Data/kozo-library-other-pc.json')))
    check('Google: nothing of the other PC was deleted', drive.calls.remove.length === 0, drive.calls.remove.join())
    check('Google: the old shared file is not written', !drive.names().includes('Data/kozo-autobackup.json'))

    // A No leaves everything as it was, and closes when there's nothing else to ask.
    put('Data/kozo-library-third.json', JSON.stringify({ app: 'kozo', install: 'third', pc: 'THIRD', exported_at: at(1), games: [], game_list: [{ id: 1, name: 'Smoke Third Wish', status: 'want_to_play' }] }))
    const listBefore = count('game_list')
    await ev('window.kozo.api.drive.connect()')
    check('Google: only what has something new is asked', (await waitStep('list')) === 'list' && !/Question/.test(await offerText()), (await offerText()).slice(0, 120))
    await press('no')
    await sleep(300)
    check('Google: No adds nothing and closes', count('game_list') === listBefore && (await offerStep()) === '', await offerStep())

    // Later, the other PC has more: a bar at the top, once. Not a window.
    const bar = () => ev(`document.querySelector('[data-drive-news]')?.innerText || ''`)
    const news = async () => { await ev('window.kozo.api.drive.checkNews()'); await sleep(300) }
    const wishFrom = (pc, name) => JSON.stringify({ app: 'kozo', install: pc, pc: pc.toUpperCase(), exported_at: at(1), games: [], game_list: [{ id: 1, name, status: 'want_to_play' }] })
    await news()
    check('Google news: what was already asked is not news', (await bar()) === '', await bar())
    put('Data/kozo-library-fourth.json', wishFrom('fourth', 'Smoke Fourth Wish'))
    await news()
    check('Google news: something new shows the bar', /something new/.test(await bar()) && /1 game on the Game List/.test(await bar()) || /2 games on the Game List/.test(await bar()), await bar())
    check('Google news: no window, and nothing added', (await offerStep()) === '' && count('game_list') === listBefore)
    await ev(`document.querySelector('[data-drive-news-hide]').click(); true`); await sleep(200)
    check('Google news: the X hides it', (await bar()) === '')
    await news()
    check('Google news: the same thing is not said twice', (await bar()) === '', await bar())
    put('Data/kozo-library-fifth.json', wishFrom('fifth', 'Smoke Fifth Wish'))
    await news()
    check('Google news: the next new thing shows it again', /something new/.test(await bar()), await bar())
    await ev(`document.querySelector('[data-drive-news-open]').click(); true`)
    check('Google news: See what\'s new opens the questions', (await waitStep('list')) === 'list', await offerStep())
    check('Google news: the bar goes away', (await bar()) === '')
    for (let i = 0; i < 4 && (await offerStep()); i++) { await press('no'); await sleep(250) }
    await news()
    check('Google news: answering No is an answer', (await bar()) === '', await bar())

    googleDrive.connect = realConnect
    await googleDrive.disconnect()
    undo()
    for (const k of ['gdrive_client_id', 'gdrive_client_secret']) settings.setSetting(k, (k.endsWith('id') ? was.id : was.secret) || '')
    db.prepare("DELETE FROM game_list WHERE name IN ('Smoke Other PC Game', 'Smoke Wish')").run()
    db.prepare('DELETE FROM games WHERE id = ?').run(added?.id)
    db.prepare('UPDATE games SET total_playtime_seconds = ? WHERE id = ?').run(playedBefore, seeded[1])
    db.prepare('DELETE FROM sessions WHERE game_id = ? AND duration_seconds = 1800').run(seeded[1])
    try { fs.rmSync(path.join(saveBackup.rootPath(), folder), { recursive: true, force: true }) } catch {}
    await go('#/', 600)
    check('Google: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // A game that isn't on the Steam account answers "Profile is not public". That must
  // never raise the account-wide warning. Steam is stubbed, so this works offline.
  {
    const before = errors.length
    const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
    const settings = require(path.join(root, 'electron', 'db', 'queries', 'settings.js'))
    const steam = require(path.join(root, 'electron', 'services', 'steamApi.js'))
    const real = { accountPrivacy: steam.accountPrivacy, getPlayerAchievements: steam.getPlayerAchievements, getPlayerAchievementsXml: steam.getPlayerAchievementsXml }
    const was = { id: settings.getSetting('steam_user_id'), flag: settings.getSetting('steam_profile_private') }
    settings.setSetting('steam_user_id', '76561190000000000')
    const notOwned = db.prepare("INSERT INTO games (name, exe_name, steam_app_id, source) VALUES ('Smoke Not Owned', 'smokenotowned.exe', '999001', 'steam')").run().lastInsertRowid
    const flag = () => settings.getSetting('steam_profile_private') || ''
    const recheck = () => ev('window.kozo.api.steam.recheckPrivacy()')
    steam.getPlayerAchievements = steam.getPlayerAchievementsXml = async () => ({ unlocks: [], error: 'private' })

    settings.setSetting('steam_profile_private', '')
    steam.accountPrivacy = async () => null
    let r = await recheck()
    check('Steam privacy: a game not on the account raises no warning', flag() === '' && r?.data?.checked === false, JSON.stringify(r?.data))
    settings.setSetting('steam_profile_private', 'private')
    steam.accountPrivacy = async () => 'public'
    r = await recheck()
    check('Steam privacy: a public account clears an old warning', flag() === '' && r?.data?.private === false && r.data.changed === true, JSON.stringify(r?.data))
    steam.accountPrivacy = async () => 'private'
    r = await recheck()
    check('Steam privacy: a really private account still warns', flag() === 'private' && r?.data?.private === true, JSON.stringify(r?.data))

    // No answer about the account: a game Steam served before can still tell.
    steam.accountPrivacy = async () => null
    const ach = db.prepare("INSERT INTO achievements (game_id, steam_api_name, display_name) VALUES (?, 'smoke_served', 'Smoke Served')").run(notOwned).lastInsertRowid
    db.prepare("INSERT INTO achievement_unlocks (achievement_id, unlocked_at, source) VALUES (?, ?, 'steam_api')").run(ach, new Date().toISOString())
    settings.setSetting('steam_profile_private', '')
    r = await recheck()
    check('Steam privacy: a game Steam served before, now refused, warns', flag() === 'private' && r?.data?.private === true, JSON.stringify(r?.data))

    Object.assign(steam, real)
    db.prepare('DELETE FROM games WHERE id = ?').run(notOwned)
    settings.setSetting('steam_user_id', was.id || '')
    settings.setSetting('steam_profile_private', was.flag || '')
    check('Steam privacy: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // The version tag, from files in a throwaway folder. No Steam id, so nothing goes online.
  {
    const before = errors.length
    const fs = require('fs')
    const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
    const was = db.prepare('SELECT install_path, exe_name, steam_app_id FROM games WHERE id = ?').get(seeded[1])
    const dir = path.join(app.getPath('userData'), 'version-test', 'Game.Name.v3.4.5-TEST')
    fs.mkdirSync(path.join(dir, 'steam_settings'), { recursive: true })
    const exe = path.join(dir, 'kozo-version-test.exe')
    fs.writeFileSync(exe, 'not a real exe')
    db.prepare('UPDATE games SET install_path = ?, exe_name = ?, steam_app_id = NULL WHERE id = ?').run(dir, 'kozo-version-test.exe', seeded[1])
    const tag = () => ev(`document.querySelector('[data-game-version]')?.innerText?.trim() || ''`)
    check('Version: from the folder name', (await ev(`window.kozo.api.games.version(${seeded[1]})`))?.data?.text === 'v3.4.5')
    fs.writeFileSync(path.join(dir, 'steam_settings', 'branches.json'), JSON.stringify([{ name: 'public', build_id: 4242, time_updated: 1764856145 }]))
    const built = (await ev(`window.kozo.api.games.version(${seeded[1]})`))?.data
    check('Version: the folder still names it, with the build in the hint', built?.text === 'v3.4.5' && /2025/.test(built.hint), JSON.stringify(built))
    await go(`#/game/${seeded[1]}`, 2000)
    check('Version: the tag is on the game page', /^v3\.4\.5/.test(await tag()), await tag())
    check('Version: nothing to compare with, so no claim about updates', !/Update out|Up to date|outdated/i.test(await tag()), await tag())
    fs.rmSync(path.join(app.getPath('userData'), 'version-test'), { recursive: true, force: true })
    check('Version: a folder that is gone gives no tag', (await ev(`window.kozo.api.games.version(${seeded[1]})`))?.data === null)
    db.prepare('UPDATE games SET install_path = ?, exe_name = ?, steam_app_id = ? WHERE id = ?').run(was.install_path, was.exe_name, was.steam_app_id, seeded[1])
    await ev(`location.hash = '#/'; true`); await sleep(600)
    check('Version: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // Steam wishlist, price alerts and news. These work with Steam unreachable too,
  // so the checks that need its answer only run when there is one.
  {
    const before = errors.length
    const steamId = (await ev(`window.kozo.api.settings.get('steam_user_id')`))?.data || ''
    await ev(`window.kozo.api.settings.set('steam_user_id', '')`)
    await go('#/game-list?wishlist=1', 1500)
    const wishState = await ev(`document.querySelector('[data-wishlist-state]')?.getAttribute('data-wishlist-state') || 'none'`)
    check('Wishlist: not connected says so', wishState === 'not_connected', wishState)
    await ev(`window.kozo.api.settings.set('steam_user_id', ${JSON.stringify(steamId)})`)
    check('Wishlist: the address is clean afterwards', await ev(`!location.hash.includes('wishlist')`))
    await escape(); await sleep(300)
    check('Wishlist: toolbar button', await ev(`[...document.querySelectorAll('.app-main button')].some(b => b.getAttribute('aria-label') === 'Steam wishlist')`))
    const imported = await ev(`window.kozo.api.gameList.wishlistImport([])`)
    check('Wishlist: importing nothing adds nothing', imported?.ok && imported.data.added === 0, JSON.stringify(imported))

    const deals = require(path.join(root, 'electron', 'services', 'deals.js'))
    const ow2 = require(path.join(root, 'electron', 'overlayWindow.js'))
    const APP = 814380
    const set = await ev(`window.kozo.api.deals.setTarget(${APP}, 500, { name: 'Smoke Alert' })`)
    check('Price alert: saves', set?.ok && set.data.target === 500, JSON.stringify(set)?.slice(0, 200))
    const rowOf = () => ev(`(async () => ((await window.kozo.api.gameList.list({ limit: 50 })).data?.items || []).find(r => r.steam_app_id == ${APP}))()`)
    const row = await rowOf()
    check('Price alert: a game not on the list joins it', row?.status === 'want_to_play' && row.price_target_cents === 500, JSON.stringify(row)?.slice(0, 200))
    if (row) {
      const { buildPayload } = require(path.join(root, 'electron', 'services', 'autoBackup.js'))
      const saved = buildPayload().game_list.find(r => r.id === row.id)
      check('Price alert: part of the backup', saved?.price_target_cents === 500 && !!saved.price_target_cc, JSON.stringify(saved)?.slice(0, 160))
    }
    // A price Steam really gave: the toast speaks once, and not again.
    if (set?.data?.price) {
      const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
      db.prepare('UPDATE game_list SET price_target_cents = ?, price_target_hit = 0 WHERE steam_app_id = ?').run(99999900, APP)
      const real = ow2.sendPriceFlash
      let flashes = 0
      ow2.sendPriceFlash = (data) => { flashes++; real(data) }
      await deals.refreshAlerts(); await deals.refreshAlerts()
      ow2.sendPriceFlash = real
      check('Price alert: speaks once when reached', flashes === 1, String(flashes))
    }
    // The Prices tab, whatever Steam answers.
    await ev(`location.hash = '#/plan'; true`); await sleep(300)
    await ev(`location.hash = '#/game-list'; true`); await sleep(1200)
    const tab = await ev(`(async () => {
      const wrap = [...document.querySelectorAll('.app-main [data-gpnav]')].find(c => c.innerText.includes('Sekiro') || c.innerText.includes('Smoke Alert') || c.innerText.includes('SEKIRO'))
      wrap?.firstElementChild?.click()
      let t = null
      for (let i = 0; i < 60 && !t; i++) { await new Promise(r => setTimeout(r, 50)); t = [...document.querySelectorAll('[role=dialog] [role=tab]')].find(x => x.innerText.trim() === 'Prices') }
      t?.click()
      let text = ''
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 100))
        text = document.querySelector('[role=dialog]')?.innerText || ''
        if (/where to buy|could not get the prices/i.test(text)) break
      }
      document.querySelector('[role=dialog] button[aria-label="Close dialog"]')?.click()
      return text.slice(0, 400)
    })()`)
    check('Prices tab: shows', /where to buy|could not get the prices/i.test(tab), tab.slice(0, 160).replace(/\s+/g, ' '))
    await sleep(300)
    const off = await ev(`window.kozo.api.deals.setTarget(${APP}, null)`)
    check('Price alert: removes', off?.ok && off.data.target === null, JSON.stringify(off)?.slice(0, 160))
    const again = await rowOf()
    if (again) await ev(`window.kozo.api.gameList.delete(${again.id})`)

    const news = await ev(`window.kozo.api.steam.news(${APP})`)
    check('News: answers, or nothing, never an error', news?.ok && Array.isArray(news.data), JSON.stringify(news)?.slice(0, 160))
    check('News: no Steam game, no news', (await ev(`window.kozo.api.steam.news(0)`))?.data?.length === 0)
    await ev(`window.kozo.api.games.update(${seeded[0]}, { steam_app_id: '${APP}' })`)
    await go(`#/game/${seeded[0]}`, 2500)
    const newsTab = await ev(`(async () => {
      const t = [...document.querySelectorAll('.app-main button')].find(b => /^News/.test(b.innerText.trim()))
      if (!t) return 'none'
      t.click()
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100))
        if (document.querySelector('.app-main article')) break
      }
      const head = document.querySelector('.app-main article button')
      if (!head) return 'no items'
      head.click()
      await new Promise(r => setTimeout(r, 200))
      return document.querySelector('.app-main article').innerText.length > 40 ? 'opened' : 'short'
    })()`)
    check('News tab: opens an item when there is news', news?.data?.length ? newsTab === 'opened' : true, newsTab)
    await ev(`window.kozo.api.games.update(${seeded[0]}, { steam_app_id: null })`)

    await ev(`location.hash = '#/settings?tab=tracking'; true`); await sleep(1500)
    check('Settings: break reminder is off by default', await ev(`document.querySelector('[aria-label="Break reminder"] [aria-pressed="true"]')?.innerText.trim() === 'Off'`))
    await ev(`location.hash = '#/'; true`); await sleep(600)
    check('Wishlist, alerts, news: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // Upcoming, All: a day with releases shows games, not just a count.
  const upcoming = await ev(`(async () => {
    localStorage.setItem('kozo:calendar:view', 'steam')
    localStorage.setItem('kozo:calendar:pick', 'all')
    location.hash = '#/upcoming'
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (document.querySelector('.app-main [class*=steamCapFrame]')) break
    }
    const days = [...document.querySelectorAll('.app-main [class*=steamDay_]')].filter(d => d.querySelector('[class*=steamDayHead]'))
    return { days: days.length, empty: days.filter(d => !d.querySelector('[class*=steamCapFrame]')).length, text: document.querySelector('.app-main').innerText }
  })()`)
  // Offline there are no games at all, which isn't what this checks.
  if (upcoming.days) {
    check('Upcoming: every day shows games', upcoming.empty === 0, `${upcoming.empty} of ${upcoming.days} days are empty`)
    check('Upcoming: no "No picks" days', !/No picks/.test(upcoming.text))
  }

  // Upcoming's top bar, on made-up releases so it runs the same on GitHub's machine.
  {
    const before = errors.length
    const steam = require(path.join(root, 'electron', 'services', 'steamApi.js'))
    const real = { getPicks: steam.getPicks, getComingSoon: steam.getComingSoon, getAppAssets: steam.getAppAssets }
    const dayText = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const fake = (id, name, n) => ({ appid: id, name, release: dayText(n), capsule: null })
    const items = [fake(9100001, 'Smoke Match A', 3), fake(9100002, 'Smoke Other A', 3), fake(9100003, 'Smoke Match B', 4), fake(9100004, 'Smoke Other B', 5)]
    const answer = (picks) => ({ picks, sources: Object.keys(picks).length ? 2 : 0, names: ['Smoke Source'], wanted: [] })
    steam.getPicks = async () => answer({ 9100001: { pct: 90, because: ['Smoke Source'] }, 9100003: { pct: 70, because: ['Smoke Source'] } })
    steam.getComingSoon = async (feed, page) => ({ items: feed === 'soon' && page === 0 ? items : [], total: items.length })
    steam.getAppAssets = async () => ({})

    const open = async (pick) => {
      await ev(`localStorage.setItem('kozo:calendar:view', 'steam'); ${pick ? `localStorage.setItem('kozo:calendar:pick', '${pick}')` : "localStorage.removeItem('kozo:calendar:pick')"}; location.hash = '#/upcoming'; location.reload(); true`)
      await sleep(600)
      for (let i = 0; i < 60; i++) {
        if (await ev(`!!document.querySelector('[data-pick]') && !document.querySelector('.app-main [class*=coverPending]')`).catch(() => false)) break
        await sleep(100)
      }
      await sleep(300)
    }
    const caps = () => ev(`[...document.querySelectorAll('.app-main [class*=steamCapHit]')].map(b => b.title).sort().join()`)
    const active = () => ev(`document.querySelector('[data-pick][class*=viewBtnActive]')?.dataset.pick`)
    const press = async (pick) => { await ev(`document.querySelector('[data-pick=${pick}]').click(); true`); await sleep(350) }

    await open('picked')
    check('Upcoming: the old choice opens on Like my games', (await active()) === 'like', await active())
    check('Upcoming: Like my games shows only matches', (await caps()) === 'Smoke Match A,Smoke Match B', await caps())
    await press('others')
    check('Upcoming: Other games shows only the rest', (await caps()) === 'Smoke Other A,Smoke Other B', await caps())
    check('Upcoming: the banner follows the choice', !/% match/.test(await ev(`document.querySelector('[data-upcoming-hero]')?.innerText || ''`)))
    await press('all')
    check('Upcoming: All shows both', (await caps()) === 'Smoke Match A,Smoke Match B,Smoke Other A,Smoke Other B', await caps())
    check('Upcoming: the choice is remembered', (await ev(`localStorage.getItem('kozo:calendar:pick')`)) === 'all')
    await open(null)
    check('Upcoming: with matches, a first visit starts on Like my games', (await active()) === 'like', await active())

    // Nothing like yours: nobody opens on an empty calendar, and the empty one explains itself.
    steam.getPicks = async () => answer({})
    await open(null)
    check('Upcoming: without matches, a first visit starts on All', (await active()) === 'all', await active())
    check('Upcoming: and shows the releases', (await caps()).split(',').length === 4, await caps())
    await press('like')
    check('Upcoming: an empty Like my games says what to do', (await caps()) === '' && /Add a few games to your Library or Game List/.test(await ev(`document.querySelector('.app-main').innerText`)))

    // Steam failing doesn't leave skeletons on the page for ever.
    steam.getPicks = async () => { throw new Error('offline') }
    await open('like')
    check('Upcoming: Steam failing is said, not stuck', /Steam didn't answer/.test(await ev(`document.querySelector('.app-main').innerText`)))
    await press('all')
    check('Upcoming: and All still works', (await caps()).split(',').length === 4, await caps())

    Object.assign(steam, real)
    await ev(`localStorage.removeItem('kozo:calendar:pick'); location.hash = '#/'; location.reload(); true`)
    await sleep(800)
    check('Upcoming top bar: no errors', errors.length === before, errors.slice(before).join(' | '))
  }

  // Fixes from the review, and the Play check.
  {
    const before = errors.length
    const db = require(path.join(root, 'electron', 'db', 'database.js')).getDb()
    const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const startAt = new Date(Date.now() - 6 * 3600e3), endAt = new Date(startAt.getTime() + 3 * 3600e3)
    const g = db.prepare("INSERT INTO games (name, exe_name, source, is_installed, total_playtime_seconds, completion_status) VALUES ('Smoke Paused Game', 'smokepaused.exe', 'manual', 1, 3600, 'playing')").run().lastInsertRowid
    db.prepare('INSERT INTO sessions (game_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, 3600)').run(g, startAt.toISOString(), endAt.toISOString())
    await ev(`window.dispatchEvent(new CustomEvent('kozo:profile-updated')); true`)

    await go('#/activity?tab=sessions', 2000)
    const row = await ev(`[...document.querySelectorAll('.app-main *')].filter(e => e.children.length === 0 && / to /.test(e.innerText || '')).map(e => e.innerText).join(' | ')`)
    check('Sessions: the real end time, pauses and all', row.includes(`${clock(startAt)} to ${clock(endAt)}`), row.slice(0, 160))
    check('Sessions: no Windows date boxes', await ev(`document.querySelectorAll('input[type=date]').length === 0 && document.querySelectorAll('[data-date-picker]').length === 2`))
    const picked = await ev(`(async () => {
      const b = document.querySelector('[data-date-picker]')
      b.click()
      await new Promise(r => setTimeout(r, 250))
      const pop = document.querySelector('[data-date-popover]')
      if (!pop) return { open: false }
      const days = pop.querySelectorAll('[data-day]').length
      const key = new Date(); const day = key.getFullYear() + '-' + String(key.getMonth() + 1).padStart(2, '0') + '-' + String(key.getDate()).padStart(2, '0')
      pop.querySelector('[data-day="' + day + '"]').click()
      await new Promise(r => setTimeout(r, 250))
      return { open: true, days, closed: !document.querySelector('[data-date-popover]'), text: b.innerText.trim() }
    })()`)
    check('Sessions: the date box opens a month', picked.open && picked.days === 42, JSON.stringify(picked))
    check('Sessions: picking a day closes it and shows the date', picked.closed && /\d{4}/.test(picked.text), picked.text)
    await ev(`document.querySelector('[data-date-picker] [title="Clear"]')?.click(); true`); await sleep(200)
    check('Sessions: the date can be cleared', await ev(`!/\\d{4}/.test(document.querySelector('[data-date-picker]').innerText)`))

    await go('#/activity?tab=overview', 2000)
    check('Statistics: Longest sessions say when', await ev(`document.querySelectorAll('.app-main [class*=rankDate]').length > 0`))

    await go(`#/game/${g}`, 1500)
    const status = await ev(`[...document.querySelectorAll('.app-main button')].map(b => b.innerText.trim()).find(t => /^Status:/.test(t)) || ''`)
    check('Game page: the status button says it is a status', /^Status:\s*Playing/.test(status), status)
    check('Game page: Play and the status look different', await ev(`(() => {
      const play = [...document.querySelectorAll('.app-main button')].find(b => b.innerText.trim() === 'Play')?.querySelector('svg')
      const st = [...document.querySelectorAll('.app-main button')].find(b => /^Status:/.test(b.innerText.trim()))?.querySelector('svg')
      return !!play && !!st && play.getAttribute('class') !== st.getAttribute('class')
    })()`))

    // Play Plan
    const month = new Date().toISOString().slice(0, 7)
    const rows = ['A', 'B', 'C', 'D'].map(x => db.prepare("INSERT INTO game_list (name, status, planned_month) VALUES (?, 'want_to_play', ?)").run('Smoke Plan ' + x, month).lastInsertRowid)
    await ev(`localStorage.setItem('kozo:plan:view', 'board'); location.hash = '#/'; true`); await sleep(300)
    await go('#/plan', 1500)
    check('Play Plan: three views up front', (await ev(`[...document.querySelectorAll('.app-main [role=tab]')].map(t => t.title).join()`)) === 'Timeline,Focus,Board')
    const heights = await ev(`[...document.querySelectorAll('.app-main [class*=bdCol]')].filter(e => /bdCol/.test(e.className) && e.tagName === 'SECTION').map(e => e.offsetHeight)`)
    check('Play Plan: Board columns are one height', heights.length === 3 && new Set(heights).size === 1, heights.join())
    const wall = await ev(`(async () => {
      document.querySelector('[data-plan-more] button').click()
      await new Promise(r => setTimeout(r, 200))
      const opts = [...document.querySelectorAll('[role=option]')].map(o => o.innerText.trim())
      ;[...document.querySelectorAll('[role=option]')].find(o => o.innerText.trim() === 'Wall')?.click()
      await new Promise(r => setTimeout(r, 400))
      return { opts: opts.join(), on: !!document.querySelector('.app-main [class*=wallMonth]'), label: document.querySelector('[data-plan-more]').innerText.trim() }
    })()`)
    check('Play Plan: the other views are under More views', /Wall/.test(wall.opts) && /Roadmap/.test(wall.opts) && /List/.test(wall.opts), wall.opts)
    check('Play Plan: picking one opens it and says so', wall.on && wall.label === 'Wall', wall.label)
    await ev(`localStorage.setItem('kozo:plan:view', 'timeline'); true`)
    for (const id of rows) db.prepare('DELETE FROM game_list WHERE id = ?').run(id)

    // One row, at every size
    for (const [w, h] of [[1000, 720], [1280, 800], [1440, 900]]) {
      win.setContentSize(w, h); await sleep(300)
      for (const [hash, label] of [['#/', 'Library'], ['#/game-list', 'Game List']]) {
        await go(hash, 1200)
        const t = await ev(`(() => {
          const bar = document.querySelector('.app-main [class*=toolbar]')
          const seen = [...bar.children].filter(c => c.offsetParent !== null && c.getBoundingClientRect().width > 0)
          const mid = seen.map(c => { const r = c.getBoundingClientRect(); return r.top + r.height / 2 })
          const right = Math.max(...seen.map(c => c.getBoundingClientRect().right))
          return { spread: Math.round(Math.max(...mid) - Math.min(...mid)), wide: right > bar.getBoundingClientRect().right + 1, width: Math.round(bar.clientWidth), n: seen.length }
        })()`)
        check(`${label} at ${w}: the toolbar stays on one row`, t.spread < 10 && !t.wide, JSON.stringify(t))
      }
    }
    win.setContentSize(1440, 900); await sleep(300)

    // The size slider
    await go('#/', 1200)
    const sized = await ev(`(async () => {
      const r = document.querySelector('[data-card-size]')
      if (!r) return { there: false }
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(r, String(Number(r.min) + 16))
      r.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(res => setTimeout(res, 200))
      return { there: true, min: r.min, css: document.querySelector('[style*="--zoom-grid"]')?.style.getPropertyValue('--card-min'), saved: localStorage.getItem('kozo:cardsize:library:big') }
    })()`)
    check('Library: a slider resizes the cards', sized.there && parseInt(sized.css) === Number(sized.min) + 16 && Number(sized.saved) === Number(sized.min) + 16, JSON.stringify(sized))
    await ev(`localStorage.removeItem('kozo:cardsize:library:big'); true`)

    // Background color
    const lookBefore = await ev(`window.kozo.api.settings.get('appearance').then(r => r?.data ?? null)`)
    await go('#/settings?tab=appearance', 1800)
    const typeHex = (hex) => ev(`(async () => {
      const i = document.querySelector('[aria-label="Hex color"]')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(i, ${JSON.stringify(hex)})
      i.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 200))
      return { box: document.querySelector('button[aria-label="Background color"]')?.innerText.trim(), result: document.querySelector('[data-color-result]')?.innerText || '', bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), theme: document.documentElement.dataset.theme }
    })()`)
    await ev(`document.querySelector('button[aria-label="Background color"]').click(); true`); await sleep(250)
    const white = await typeHex('#ffffff'), gray = await typeHex('#808080'), black = await typeHex('#000000'), red = await typeHex('#ff0000')
    check('Background: white shows the color really used', white.box === '#292929' && white.result.includes('#292929'), JSON.stringify(white))
    check('Background: every pick is a different color', new Set([white.box, gray.box, black.box, red.box]).size === 4, [white.box, gray.box, black.box, red.box].join())
    check('Background: picking one switches to Custom', white.theme === 'custom', white.theme)
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
    await ev(`window.kozo.api.settings.set('appearance', ${JSON.stringify(lookBefore)}); location.hash = '#/'; location.reload(); true`); await sleep(2200)

    // Play, and the watched file never starts. The process list is made up, so no real
    // program is involved; the toast is only recorded.
    const launchCheck = require(path.join(root, 'electron', 'services', 'launchCheck.js'))
    const pw = require(path.join(root, 'electron', 'services', 'processWatcher.js'))
    const overlay = require(path.join(root, 'electron', 'overlayWindow.js'))
    const gamesQ = require(path.join(root, 'electron', 'db', 'queries', 'games.js'))
    const folder = path.join(tmp, 'smoke-game')
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'smoke-real-game.exe'), 'not a real program')
    fs.writeFileSync(path.join(folder, 'UnityPlayer.dll'), '')   // an engine beside it, so it counts as a game
    const never = db.prepare("INSERT INTO games (name, exe_name, install_path, source, is_installed) VALUES ('Smoke Never Starts', 'smoke-never-starts.exe', ?, 'manual', 1)").run(folder).lastInsertRowid
    const real = { list: pw.getRunningProcesses, active: pw.isSessionActive, toast: overlay.sendLaunchMiss, local: launchCheck.delays.local }
    let running = []
    const toasts = []
    pw.getRunningProcesses = async () => running
    overlay.sendLaunchMiss = (d) => toasts.push(d)
    launchCheck.delays.local = 150
    const press = async () => {
      running = [{ name: 'smoke-already-open.exe' }, { name: 'smoke-real-game.exe' }, { name: 'smartscreen.exe' }]
      launchCheck.arm(gamesQ.getGame(never), { launched: 'spawn' })
      await sleep(550)
    }
    const card = () => ev(`document.querySelector('[data-launch-miss]')?.innerText || ''`)
    const picks = () => ev(`[...document.querySelectorAll('[data-launch-pick]')].map(b => b.dataset.launchPick).join()`)
    await press()
    check('Play check: it asks which program it is', /Which program is Smoke Never Starts/.test(await card()) && /smoke-never-starts\.exe/.test(await card()), (await card()).slice(0, 160))
    check('Play check: only the game file in its folder is offered, never a Windows program', (await picks()) === 'smoke-real-game.exe', await picks())
    await ev(`document.querySelector('[data-launch-all]').click(); true`); await sleep(200)
    check('Play check: All programs lists what is running', await ev(`!!document.querySelector('[data-launch-miss] input')`))
    await ev(`document.querySelector('[data-launch-later]').click(); true`); await sleep(200)
    check('Play check: Not now closes it', (await card()) === '')
    launchCheck.arm(gamesQ.getGame(never), { launched: 'steam' }); await sleep(350)
    check('Play check: never for Steam, which starts a game when it is ready', (await card()) === '')
    pw.isSessionActive = () => true
    await press()
    check('Play check: never while a game is being tracked', (await card()) === '')
    pw.isSessionActive = real.active
    running = [{ name: 'smoke-never-starts.exe' }]
    launchCheck.arm(gamesQ.getGame(never), { launched: 'spawn' }); await sleep(350)
    check('Play check: not when the watched file is running after all', (await card()) === '')
    await press()
    await ev(`document.querySelector('[data-launch-later]').click(); true`); await sleep(200)
    await press()
    check('Play check: after two Not nows it stops asking about this game', (await card()) === '', await card())
    db.prepare("UPDATE settings SET value = '{}' WHERE key = 'launch_miss_dismissed'").run()
    await press()
    await ev(`document.querySelector('[data-launch-pick="smoke-real-game.exe"]').click(); true`); await sleep(350)
    const after = gamesQ.getGame(never)
    check('Play check: picking one makes KoZo watch it', after.exe_name === 'smoke-real-game.exe' && after.install_path === folder, after.exe_name)
    check('Play check: a file that is gone is not kept as the launcher', !after.launch_file, after.launch_file)
    check('Play check: and the card goes', (await card()) === '')
    pw.getRunningProcesses = real.list; pw.isSessionActive = real.active; overlay.sendLaunchMiss = real.toast; launchCheck.delays.local = real.local
    db.prepare('DELETE FROM games WHERE id IN (?, ?)').run(never, g)
    db.prepare('DELETE FROM game_list WHERE game_id IS NULL AND name IN (?, ?)').run('Smoke Never Starts', 'Smoke Paused Game')

    // Deleting a game takes its blank card along.
    const blank = db.prepare("INSERT INTO games (name, exe_name, source) VALUES ('Smoke Blank', 'smokeblank.exe', 'manual')").run().lastInsertRowid
    const blankRow = db.prepare("INSERT INTO game_list (game_id, name, status) VALUES (?, 'Smoke Blank', 'want_to_play')").run(blank).lastInsertRowid
    const planned = db.prepare("INSERT INTO games (name, exe_name, source) VALUES ('Smoke Planned', 'smokeplanned.exe', 'manual')").run().lastInsertRowid
    const plannedRow = db.prepare("INSERT INTO game_list (game_id, name, status, planned_month) VALUES (?, 'Smoke Planned', 'want_to_play', '2030-01')").run(planned).lastInsertRowid
    await ev(`window.kozo.api.games.delete([${blank}, ${planned}])`)
    check('Delete: a blank card goes with its game', !db.prepare('SELECT id FROM game_list WHERE id = ?').get(blankRow))
    check('Delete: a row with a plan stays', !!db.prepare('SELECT id FROM game_list WHERE id = ?').get(plannedRow))
    db.prepare('DELETE FROM game_list WHERE id = ?').run(plannedRow)
    await go('#/', 600)
    check('Review fixes: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
  }

  // Narrow window
  win.setContentSize(1000, 720); await sleep(400)
  for (const [hash, label] of [['#/', 'Library'], ['#/plan', 'Play Plan'], ['#/finished', 'Finished'], ['#/profile', 'Profile']]) {
    await go(hash, 1200)
    const over = await ev(`(() => { const m = document.querySelector('.app-main'); return m.scrollWidth > m.clientWidth + 2 })()`)
    check(`${label} at 1000px: no sideways scroll`, !over)
  }
  win.setContentSize(1440, 900); await sleep(300)

  // ── Controller (the 1.5.0 bug: it stopped after a page change) ──
  win.show(); win.focus()
  await go('#/', 1200)
  await ev(`(() => {
    const pad = { connected: true, index: 0, id: 'Smoke pad', buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] }
    navigator.getGamepads = () => [pad]
    window.__pad = pad
    window.dispatchEvent(new Event('gamepadconnected'))
    window.dispatchEvent(new Event('focus'))
    return true
  })()`)
  const tap = async (i) => {
    // No synthetic focus event here: a focus event restarts polling and would
    // hide exactly the bug this section is for. Real focus is put back only if
    // something took it (KoZo ignores the pad while unfocused, by design);
    // an already focused window gets no event.
    if (!win.isFocused()) { win.focus(); await sleep(200) }
    await ev(`window.__pad.buttons[${i}].pressed = true; true`)
    await sleep(180)
    await ev(`window.__pad.buttons[${i}].pressed = false; true`)
    await sleep(700)
  }
  const hash = () => ev('location.hash')
  await tap(13)   // wakes the ring
  const h0 = await hash()
  await tap(5)    // RB
  const h1 = await hash()
  await tap(5)    // RB again: the old bug died here
  const h2 = await hash()
  check('controller: RB changes page', h1 !== h0, `${h0} -> ${h1}`)
  check('controller: still works after a page change', h2 !== h1, `${h1} -> ${h2}`)
  await tap(13)
  check('controller: ring moves on the new page', await ev(`!!document.querySelector('[data-gpfocus]')`))
  await go('#/', 1500)
  // Down until a card: how many rows the toolbar takes depends on the window's width.
  let focusedCard = false
  for (let i = 0; i < 5 && !focusedCard; i++) {
    await tap(13)
    focusedCard = await ev(`!!document.querySelector('.app-main [data-gpnav][data-gpfocus]')`)
  }
  check('controller: down lands on a Library card', focusedCard, await ev(`(document.querySelector('[data-gpfocus]')?.outerHTML || 'nothing focused').slice(0, 160) + ' focus=' + document.hasFocus()`))
  await tap(2)    // X
  check('controller: X opens the card menu', await ev(`!!document.querySelector('[role=menu]')`))
  await tap(1)    // B
  check('controller: B closes the menu', await ev(`!document.querySelector('[role=menu]')`))

  // ── Pick for me ──
  {
    const before = errors.length
    await go('#/game-list', 1500)
    await ev(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Pick for me' || /Pick for me/.test(b.innerText))?.click(); true`)
    await sleep(2500)
    const txt = await ev(`document.querySelector('[role=dialog]')?.innerText || ''`)
    check('Pick for me: picks a game', /Smoke (Alpha|Beta|Gamma)/.test(txt), txt.slice(0, 120))
    check('Pick for me: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))
    await escape()
  }

  // ── Big Picture ──
  {
    const before = errors.length
    await go('#/big', 2000)
    check('Big Picture: opens without the sidebar', await ev(`!!document.querySelector('[data-bigpicture-root]') && !document.querySelector('aside')`))
    check('Big Picture: full screen', win.isFullScreen())
    check('Big Picture: shows the games', await ev(`document.querySelectorAll('[data-bigpicture-root] [data-game-id]').length >= 3`))
    await escape(); await sleep(1200)
    check('Big Picture: Escape leaves', await ev(`!document.querySelector('[data-bigpicture-root]')`))
    check('Big Picture: back to a window', !win.isFullScreen())
    check('Big Picture: no errors', errorsSince(before).length === 0, errorsSince(before).join(' | '))

    // ── Overlay: its own small page, up before the toast, and toasts still show ──
    const ow = require(path.join(root, 'electron', 'overlayWindow.js'))
    ow.warm({ show: true })
    const owin = ow.getWindow()
    const overlayErrors = []
    owin.webContents.on('console-message', (e) => { if (e.level === 'error') overlayErrors.push(String(e.message).slice(0, 200)) })
    for (let i = 0; i < 80 && (owin.webContents.isLoading() || !owin.isVisible()); i++) await sleep(100)
    check('overlay: loads its own page', /overlay\.html/.test(owin.webContents.getURL()), owin.webContents.getURL())
    check('overlay: on screen before any toast', owin.isVisible())
    ow.sendAchievements({ gameId: 0, gameName: 'Smoke Alpha', achievements: [{ display_name: 'Smoke unlock', description: 'A test', icon_url: null, xp: 25 }] })
    ow.sendSessionStarted({ gameId: 0, gameName: 'Smoke Beta', artPath: null, artUrl: null })
    await sleep(700)
    const shown = await owin.webContents.executeJavaScript('document.body.innerText', true)
    check('overlay: achievement toast shows', /Smoke unlock/.test(shown) && /\+25 XP/.test(shown), shown.slice(0, 120))
    check('overlay: session toast shows', /Smoke Beta/.test(shown), shown.slice(0, 120))
    ow.sendBreakReminder({ gameName: 'Smoke Break', playedSec: 7200, artPath: null, artUrl: null })
    ow.sendPriceFlash({ games: [{ name: 'Smoke Price', artUrl: null, priceText: '$4.99', targetText: '$5.00' }] })
    await sleep(500)
    const shown2 = await owin.webContents.executeJavaScript('document.body.innerText', true)
    check('overlay: break reminder shows', /Time for a break/i.test(shown2) && /Smoke Break/.test(shown2) && /2h 0m/.test(shown2), shown2.slice(0, 160))
    check('overlay: price alert shows', /At your price/i.test(shown2) && /Smoke Price/.test(shown2) && /\$4\.99/.test(shown2), shown2.slice(0, 160))
    const look = await owin.webContents.executeJavaScript(`(() => {
      const css = (el) => el ? getComputedStyle(el) : null
      const bar = [...document.querySelectorAll('div')].find(d => /progressFill/.test(d.className))
      const t = [...document.querySelectorAll('div')].find(d => /_toast_|toast/.test(d.className) && getComputedStyle(d).borderRadius === '8px')
      return { font: css(t)?.fontFamily || '', name: css([...document.querySelectorAll('div')].find(d => /toastName/.test(d.className)))?.fontFamily || '',
               a: getComputedStyle(document.documentElement).getPropertyValue('--a').trim(), barAnim: css(bar)?.animationName || 'none',
               body: getComputedStyle(document.body).backgroundColor }
    })()`, true)
    check('overlay: keeps its font', /DM Sans/.test(look.name), look.name)
    check('overlay: has the design tokens', look.a.length > 0, JSON.stringify(look))
    check('overlay: stays see-through', /rgba\(0, 0, 0, 0\)|transparent/.test(look.body), look.body)
    check('overlay: timer bar animates', look.barAnim !== 'none', look.barAnim)
    check('overlay: no errors', overlayErrors.length === 0, overlayErrors.join(' | '))

  }

  // ── Tray: Windows' own menu (the KoZo popup was slow to open, the maker's call) ──
  {
    const watcher = require(path.join(root, 'electron', 'services', 'processWatcher.js'))
    const labels = (m) => (m ? m.items.map(i => i.label).filter(Boolean) : [])
    const find = (m, label) => (m ? m.items.find(i => i.label === label) : null)
    const menu = require(path.join(root, 'electron', 'tray.js')).currentMenu()
    check('tray: the menu builds', !!menu)
    check('tray: has a way into KoZo and out', labels(menu).includes('Open KoZo') && labels(menu).includes('Quit KoZo'), labels(menu).join(' | '))
    const pauseItem = find(menu, 'Pause tracking')
    check('tray: offers Pause tracking', !!pauseItem, labels(menu).join(' | '))
    if (pauseItem) {
      pauseItem.click()
      const after = require(path.join(root, 'electron', 'tray.js')).currentMenu()
      check('tray: pausing works and the menu says Resume', watcher.isPaused() === true && !!find(after, 'Resume tracking'), labels(after).join(' | '))
      find(after, 'Resume tracking')?.click()
      check('tray: resuming works', watcher.isPaused() === false)
    }
    const jump = find(menu, 'Jump back in')
    if (jump) check('tray: Jump back in lists games', jump.submenu.items.length > 0 && jump.submenu.items.length <= 5, String(jump.submenu.items.length))
  }

  check('no renderer errors overall', errors.length === 0, errors.join(' | '))
  finish(fail ? 1 : 0)
}).catch((e) => { check('smoke test ran', false, e.stack || e.message); finish(1) })
