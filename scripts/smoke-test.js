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

const { app } = require('electron')
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
setTimeout(() => { console.error('  FAIL  timed out after 150s'); fail++; finish(1) }, 150000).unref()

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
  ]
  for (const [hash, label, hasMenu] of pages) {
    const before = errors.length
    await go(hash, 1800)
    const st = await ev(`(() => {
      const main = document.querySelector('.app-main')
      return { text: (main?.innerText || '').trim().length, boundary: /Something went wrong/i.test(document.body.innerText),
               over: main ? main.scrollWidth > main.clientWidth + 2 : true }
    })()`)
    check(`${label}: renders`, st.text > 20 && !st.boundary, JSON.stringify(st))
    check(`${label}: no errors`, errorsSince(before).length === 0, errorsSince(before).join(' | '))
    check(`${label}: no sideways scroll`, !st.over)
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
      const out = { width: d?.offsetWidth || 0, room, tabs: [...(d?.querySelectorAll('[role=tab]') || [])].map(t => t.innerText.trim()), text: d?.innerText || '' }
      d?.querySelector('button[aria-label="Close dialog"]')?.click()
      await new Promise(r => setTimeout(r, 300))
      return out
    })()`)
    const steam = await open('Smoke Window Steam')
    check('Game List window: full width at once', steam.width === Math.min(1120, steam.room), `${steam.width} of ${steam.room}`)
    check('Game List window: store tabs and Edit', ['Overview', 'About', 'Details', 'System requirements', 'Edit'].every(t => steam.tabs.includes(t)), steam.tabs.join(', '))
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

  // Upcoming, Picked for you: a day with releases shows games, not just a count.
  const upcoming = await ev(`(async () => {
    localStorage.setItem('kozo:calendar:view', 'steam')
    localStorage.setItem('kozo:calendar:pick', 'picked')
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
    await ev(`[...document.querySelectorAll('button')].find(b => /Pick for me/.test(b.innerText))?.click(); true`)
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

  check('no renderer errors overall', errors.length === 0, errors.join(' | '))
  finish(fail ? 1 : 0)
}).catch((e) => { check('smoke test ran', false, e.stack || e.message); finish(1) })
