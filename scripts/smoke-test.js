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
  await tap(13); await tap(13)
  const focusedCard = await ev(`!!document.querySelector('.app-main [data-gpnav][data-gpfocus]')`)
  check('controller: down lands on a Library card', focusedCard, await ev(`(document.querySelector('[data-gpfocus]')?.outerHTML || 'nothing focused').slice(0, 160) + ' focus=' + document.hasFocus()`))
  await tap(2)    // X
  check('controller: X opens the card menu', await ev(`!!document.querySelector('[role=menu]')`))
  await tap(1)    // B
  check('controller: B closes the menu', await ev(`!document.querySelector('[role=menu]')`))

  // ── Pick for me ──
  {
    const before = errors.length
    await go('#/plan', 1500)
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
  }

  check('no renderer errors overall', errors.length === 0, errors.join(' | '))
  finish(fail ? 1 : 0)
}).catch((e) => { check('smoke test ran', false, e.stack || e.message); finish(1) })
