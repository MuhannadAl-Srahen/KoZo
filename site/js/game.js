// The page plays like KoZo: real toasts, XP by the app's own formulas, and a session timer that
// really stops when you leave.
(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }
  var root = document.documentElement
  var reduced = document.documentElement.dataset.motion === 'off'

  // ── The logo: a pointy-top honeycomb of 7 (src/components/HoneycombLogo.jsx) ──
  var S = 9, VIS = 7.7, W = S * Math.sqrt(3)
  // Filled in this order: the middle last, so the logo finishes in the center.
  var CENTERS = [[-W / 2, -S * 1.5], [W / 2, -S * 1.5], [W, 0], [W / 2, S * 1.5], [-W / 2, S * 1.5], [-W, 0], [0, 0]]
  function hexPoints(cx, cy, r) {
    var out = []
    for (var i = 0; i < 6; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 3
      out.push((cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2))
    }
    return out.join(' ')
  }
  var logoCells = CENTERS.map(function (c) { return '<polygon points="' + hexPoints(c[0], c[1], VIS) + '"/>' }).join('')
  $('hud-logo').innerHTML = logoCells
  $('session-logo').innerHTML = logoCells
  var HEX = '<svg class="hex" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2 20.66,7 20.66,17 12,22 3.34,17 3.34,7"/></svg>'

  // ── Achievements ──
  var RARITY = {
    common: { label: 'Common', color: '#b4b4d0' },
    uncommon: { label: 'Uncommon', color: '#fbbf24' },
    rare: { label: 'Rare', color: '#34d399' },
    very: { label: 'Very rare', color: '#60a5fa' },
    ultra: { label: 'Ultra rare', color: '#c084fc' },
  }
  // `pct` only sets the XP, through the app's own formula. It's never shown as a real statistic.
  var ACHIEVEMENTS = [
    { id: 'start', name: 'Press Start', desc: 'Opened KoZo for the first time.', hint: 'Open this page.', rarity: 'common', pct: 90 },
    { id: 'colors', name: 'Your Colors', desc: 'Made it yours.', hint: 'Pick another color from the hexagon up top.', rarity: 'rare', pct: 20 },
    { id: 'away', name: 'Away, Paused', desc: 'You left, and the timer noticed.', hint: 'Leave this tab for a few seconds and come back.', rarity: 'very', pct: 8 },
    { id: 'hive', name: 'Into the Hive', desc: 'Went through the honeycomb.', hint: 'Scroll through the honeycomb.', rarity: 'uncommon', pct: 50 },
    { id: 'unlock', name: 'First Unlock', desc: 'Fired a real KoZo toast.', hint: 'Press a rarity in the playground below.', rarity: 'common', pct: 70 },
    { id: 'bar', name: 'Day by Day', desc: 'Opened a day in the session chart.', hint: 'Click a bar in the session chart.', rarity: 'uncommon', pct: 40 },
    { id: 'end', name: 'End Credits', desc: 'Saw the whole thing.', hint: 'Reach the end of the page.', rarity: 'ultra', pct: 2 },
  ]
  // electron/services/xp.js: an unlock's XP comes from its rarity (Common 55, Uncommon 80,
  // Rare 120, Very Rare 250, Ultra Rare 500), a level costs 50*(L-1)*L.
  function xpFor(pct) { return pct < 5 ? 500 : pct < 15 ? 250 : pct < 30 ? 120 : pct < 50 ? 80 : 55 }
  function levelFor(total) {
    var level = 1
    while (50 * level * (level + 1) <= total) level++
    var base = 50 * (level - 1) * level
    return { level: level, into: total - base, span: 100 * level }
  }
  var TIERS = [[3, 'Apprentice'], [7, 'Adept'], [12, 'Seasoned'], [18, 'Veteran'], [25, 'Master'], [35, 'Legend'], [45, 'Grandmaster'], [60, 'Mythic']]
  function tierFor(level) {
    var name = 'Rookie'
    TIERS.forEach(function (t) { if (level >= t[0]) name = t[1] })
    return name
  }

  // ── Saved on this browser only ──
  var saved = {}
  try { saved = JSON.parse(localStorage.getItem('kozo-site') || '{}') || {} } catch (e) {}
  var got = new Set(Array.isArray(saved.got) ? saved.got : [])
  function save() {
    try { localStorage.setItem('kozo-site', JSON.stringify({ got: Array.from(got), accent: saved.accent, motion: saved.motion, motionTold: saved.motionTold })) } catch (e) {}
  }

  function totalXp() {
    return ACHIEVEMENTS.reduce(function (sum, a) { return sum + (got.has(a.id) ? xpFor(a.pct) : 0) }, 0)
  }

  var shownLevel = levelFor(totalXp()).level
  var shownScore = totalXp()
  var scoreTimer = 0

  function paintScore(value) {
    $('hero-score').textContent = String(value).padStart(5, '0')
  }
  function renderHud() {
    var xp = totalXp()
    var l = levelFor(xp)
    $('hud-level').textContent = l.level
    $('hud-tier').textContent = tierFor(l.level)
    $('hud-into').textContent = l.into
    $('hud-span').textContent = l.span
    $('hud-count').textContent = got.size
    $('hud-fill').style.width = Math.round(l.into / l.span * 100) + '%'
    var polys = $('hud-logo').querySelectorAll('polygon')
    polys.forEach(function (p, i) { p.classList.toggle('on', i < got.size) })

    // The score counts up instead of jumping.
    clearInterval(scoreTimer)
    if (reduced || shownScore === xp) { shownScore = xp; paintScore(xp) } else {
      scoreTimer = setInterval(function () {
        shownScore += Math.max(1, Math.ceil((xp - shownScore) / 8))
        if (shownScore >= xp) { shownScore = xp; clearInterval(scoreTimer) }
        paintScore(shownScore)
      }, 40)
    }
    renderList()
  }
  function renderList() {
    $('ach-list').innerHTML = ACHIEVEMENTS.map(function (a) {
      var has = got.has(a.id)
      return '<li class="ach-row' + (has ? ' got' : '') + '" style="--rarity:' + RARITY[a.rarity].color + '">' + HEX +
        '<div><p class="ach-name">' + a.name + '</p><p class="ach-desc">' + (has ? a.desc : a.hint) + '</p></div>' +
        '<span class="ach-xp">+' + xpFor(a.pct) + ' XP</span></li>'
    }).join('')
  }

  // ── Toasts: one at a time, and a click closes them, as in the app ──
  var queue = [], showing = null
  function toastEl(t) {
    var el = document.createElement('div')
    el.className = 'toast'
    el.style.setProperty('--tone', t.tone)
    el.innerHTML =
      '<div class="toast-head"><svg aria-hidden="true"><use href="#' + t.headIcon + '"/></svg><span class="toast-title">' + t.title + '</span>' +
      (t.xp ? '<span class="toast-xp">+' + t.xp + ' XP</span>' : '') + '</div>' +
      '<div class="toast-body"><div class="toast-icon" style="position:relative">' + HEX + '<svg class="glyph" aria-hidden="true"><use href="#' + t.icon + '"/></svg></div>' +
      '<div class="toast-info"><p class="toast-name">' + t.name + '</p>' +
      (t.desc ? '<p class="toast-desc">' + t.desc + '</p>' : '') +
      (t.game ? '<p class="toast-game">' + t.game + '</p>' : '') + '</div></div>'
    return el
  }
  // A toast in the playground's scene: several can be up, the newest on top.
  function toastInto(box, t) {
    var el = toastEl(t)
    var close = function () {
      if (el.classList.contains('leaving')) return
      el.classList.add('leaving')
      setTimeout(function () { el.remove() }, reduced ? 0 : 280)
    }
    el.addEventListener('click', close)
    setTimeout(close, 3800)
    box.insertBefore(el, box.firstChild)
    while (box.children.length > 3) box.lastChild.remove()
  }
  function pump() {
    if (showing || !queue.length) return
    var t = queue.shift()
    var el = toastEl(t)
    var closed = false
    var close = function () {
      if (closed) return
      closed = true
      el.classList.add('leaving')
      setTimeout(function () { el.remove(); showing = null; pump() }, reduced ? 0 : 280)
    }
    el.addEventListener('click', close)
    var timer = setTimeout(close, queue.length ? 2600 : (t.ms || 5200))
    el.addEventListener('pointerenter', function () { clearTimeout(timer) })
    el.addEventListener('pointerleave', function () { if (!closed) timer = setTimeout(close, 1600) })
    showing = el
    $('toasts').appendChild(el)
  }
  function toast(t) { queue.push(t); pump() }

  function unlock(id) {
    if (got.has(id)) return false
    var a = ACHIEVEMENTS.filter(function (x) { return x.id === id })[0]
    if (!a) return false
    var before = levelFor(totalXp()).level
    got.add(id)
    save()
    var r = RARITY[a.rarity]
    toast({ title: 'Achievement unlocked', headIcon: 'i-trophy', xp: xpFor(a.pct), name: a.name, desc: a.desc, game: r.label, icon: 'i-trophy', tone: r.color })
    if (window.kozoHive) window.kozoHive.wave(r.color)
    renderHud()
    window.dispatchEvent(new CustomEvent('kozo:score'))
    var after = levelFor(totalXp()).level
    if (after > before) {
      shownLevel = after
      toast({ title: 'Level up!', headIcon: 'i-up', name: 'Level ' + after + ', ' + tierFor(after), desc: 'Level 60 is Mythic. That takes actual games.', icon: 'i-up', tone: getComputedStyle(root).getPropertyValue('--a'), ms: 6000 })
    }
    return true
  }
  window.kozoGame = {
    unlock: unlock, toast: toast, toastInto: toastInto, xpFor: xpFor,
    setAccent: function (hex, byHand) { applyAccent(hex, byHand) },
    playedSeconds: function () { return Math.floor(played) },
    clock: function (s) { return clock(s) },
    summary: function () {
      var l = levelFor(totalXp())
      return { count: got.size, level: l.level, tier: tierFor(l.level), xp: totalXp() }
    },
  }

  // ── The color picker: the app's 12 colors (src/context/AccentColorContext.jsx) ──
  var COLORS = [
    ['Lime', '#9fff02'], ['Purple', '#a78bfa'], ['Electric Blue', '#60a5fa'], ['Crimson Red', '#f87171'],
    ['Neon Green', '#4ade80'], ['Amber', '#fbbf24'], ['Hot Pink', '#f472b6'], ['Teal', '#2dd4bf'],
    ['Tangerine', '#fb923c'], ['Indigo', '#818cf8'], ['Sky', '#38bdf8'], ['Rose', '#fda4af'],
  ]
  var current = (saved.accent || '#9fff02').toLowerCase()
  // Every screenshot exists in all 12 colors (scripts/site-shots.js): Lime in assets/shots,
  // the others in assets/shots/<color>/. Picking a color swaps them, so the app on the page
  // is always in the color the page is (the maker's call). The looks keep their own picture.
  var SHOT_DIRS = {
    '#9fff02': '', '#a78bfa': 'purple', '#60a5fa': 'blue', '#f87171': 'red', '#4ade80': 'green', '#fbbf24': 'amber',
    '#f472b6': 'pink', '#2dd4bf': 'teal', '#fb923c': 'tangerine', '#818cf8': 'indigo', '#38bdf8': 'sky', '#fda4af': 'rose',
  }
  function shotsFor(hex) {
    var dir = SHOT_DIRS[hex]
    if (dir === undefined) return
    document.querySelectorAll('img[src*="assets/shots/"]:not([data-own-look])').forEach(function (img) {
      if (!img.dataset.shot) {
        var m = img.getAttribute('src').match(/assets\/shots\/(?:[a-z]+\/)?(?:sm\/)?([a-z0-9-]+)\.webp$/)
        if (!m || /^look-/.test(m[1])) { img.dataset.ownLook = ''; return }
        img.dataset.shot = m[1]
      }
      var base = 'assets/shots/' + (dir ? dir + '/' : '')
      var name = img.dataset.shot
      img.srcset = base + 'sm/' + name + '.webp 1200w, ' + base + name + '.webp 2000w'
      img.src = base + name + '.webp'
    })
  }
  function applyAccent(hex, byHand) {
    current = hex
    root.style.setProperty('--a', hex)
    shotsFor(hex)
    if (window.kozoHive) window.kozoHive.setAccent(hex)
    document.querySelectorAll('.swatch').forEach(function (s) { s.setAttribute('aria-pressed', String(s.dataset.color === hex)) })
    if (byHand) {
      saved.accent = hex
      save()
      unlock('colors')
    }
  }
  $('swatches').innerHTML = COLORS.map(function (c) {
    return '<button class="swatch" type="button" data-color="' + c[1] + '" title="' + c[0] + '" aria-label="' + c[0] + '" aria-pressed="false">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon fill="' + c[1] + '" points="12,1 21.53,6.5 21.53,17.5 12,23 2.47,17.5 2.47,6.5"/></svg></button>'
  }).join('')
  $('swatches').addEventListener('click', function (e) {
    var b = e.target.closest('.swatch')
    if (b) applyAccent(b.dataset.color, true)
  })
  applyAccent(current, false)

  // ── Animations: this page's own setting, as in the app ──
  var motionToggle = $('motion-toggle')
  motionToggle.setAttribute('aria-checked', String(!reduced))
  motionToggle.addEventListener('click', function () {
    saved.motion = reduced ? 'on' : 'off'
    save()
    location.reload()
  })
  // Someone whose PC asks for less motion hears about the switch once.
  if (!reduced && !saved.motionTold && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    saved.motionTold = true
    save()
    setTimeout(function () {
      toast({ title: 'KoZo', headIcon: 'i-clock', name: 'Your system has animations off', desc: 'This page keeps its own. You can turn them off from the hexagon at the top.', icon: 'i-clock', tone: getComputedStyle(root).getPropertyValue('--a'), ms: 7000 })
    }, 2600)
  }

  // ── The two panels in the HUD ──
  // A toast never lands on an open panel: it comes in underneath.
  function placeToasts() {
    var box = $('toasts')
    box.style.top = ''
    var area = box.getBoundingClientRect()
    ;['color-panel', 'ach-panel'].forEach(function (id) {
      var panel = $(id)
      if (panel.hidden) return
      var r = panel.getBoundingClientRect()
      if (r.right > area.left && r.left < area.right) box.style.top = Math.round(r.bottom + 10) + 'px'
    })
  }
  function wirePanel(buttonId, panelId, others) {
    var button = $(buttonId), panel = $(panelId)
    button.addEventListener('click', function (e) {
      e.stopPropagation()
      var open = panel.hidden
      others.forEach(function (o) { $(o[1]).hidden = true; $(o[0]).setAttribute('aria-expanded', 'false') })
      panel.hidden = !open
      button.setAttribute('aria-expanded', String(open))
      placeToasts()
    })
    panel.addEventListener('click', function (e) { e.stopPropagation() })
  }
  wirePanel('color-toggle', 'color-panel', [['ach-toggle', 'ach-panel']])
  wirePanel('ach-toggle', 'ach-panel', [['color-toggle', 'color-panel']])
  function closePanels() {
    [['color-toggle', 'color-panel'], ['ach-toggle', 'ach-panel']].forEach(function (o) { $(o[1]).hidden = true; $(o[0]).setAttribute('aria-expanded', 'false') })
    placeToasts()
  }
  document.addEventListener('click', closePanels)
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanels() })
  $('ach-reset').addEventListener('click', function () {
    got.clear()
    save()
    shownScore = 0
    renderHud()
    window.dispatchEvent(new CustomEvent('kozo:score'))
    closePanels()
    setTimeout(function () { unlock('start') }, 400)
  })

  // ── The session: time on this page, without the time you were away ──
  var IDLE_MS = 120000   // as the app's AFK pause, shorter because this is a web page
  var played = 0, last = performance.now(), awaySince = 0, lastInput = performance.now()
  var baseTitle = document.title
  function clock(s) {
    var m = Math.floor(s / 60), h = Math.floor(m / 60)
    var ss = String(s % 60).padStart(2, '0')
    return h ? h + ':' + String(m % 60).padStart(2, '0') + ':' + ss : m + ':' + ss
  }
  function words(s) {
    return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's'
  }
  function goAway() {
    if (awaySince) return
    awaySince = performance.now()
    $('session').classList.add('away')
    $('session-state').textContent = 'Away, paused'
    document.title = 'Away, paused'
  }
  function comeBack() {
    if (!awaySince) return
    var seconds = Math.round((performance.now() - awaySince) / 1000)
    awaySince = 0
    last = performance.now()
    lastInput = last
    $('session').classList.remove('away')
    $('session-state').textContent = 'Playing now'
    document.title = baseTitle
    if (seconds >= 3) {
      if (!unlock('away')) {
        toast({ title: 'KoZo', headIcon: 'i-clock', name: 'Welcome back', desc: words(seconds) + ' not counted.', icon: 'i-clock', tone: getComputedStyle(root).getPropertyValue('--a') })
      } else {
        toast({ title: 'KoZo', headIcon: 'i-clock', name: 'Welcome back', desc: words(seconds) + ' not counted. The app does this while you play, too.', icon: 'i-clock', tone: getComputedStyle(root).getPropertyValue('--a') })
      }
    }
  }
  setInterval(function () {
    var now = performance.now()
    if (!awaySince && now - lastInput > IDLE_MS) goAway()
    if (!awaySince) played += (now - last) / 1000
    last = now
    $('session-time').textContent = clock(Math.floor(played))
  }, 1000)
  document.addEventListener('visibilitychange', function () { if (document.hidden) goAway(); else comeBack() })
  addEventListener('blur', goAway)
  addEventListener('focus', comeBack)
  ;['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(function (name) {
    addEventListener(name, function () {
      lastInput = performance.now()
      if (awaySince && !document.hidden && document.hasFocus()) comeBack()
    }, { passive: true })
  })

  // ── The headlines: lines of one width. Each line's width setting stays, its size fits. ──
  var lockup = $('lockup')
  function fitLockup() {
    document.querySelectorAll('[data-fit]').forEach(function (block) {
      var box = block.getBoundingClientRect().width
      if (!box || block.kozoFitBox === box) return
      block.kozoFitBox = box
      block.classList.add('measuring')
      block.querySelectorAll('span').forEach(function (line) {
        var wdth = Number(line.dataset.wdth) || 100
        line.style.setProperty('--w', wdth + '%')
        line.style.fontStretch = wdth + '%'
        line.style.fontSize = '100px'
        line.style.display = 'inline-block'
        var width = line.getBoundingClientRect().width
        line.style.display = ''
        if (width > 0) line.style.fontSize = (100 * box / width * 0.995).toFixed(2) + 'px'
      })
      block.classList.remove('measuring')
    })
  }
  function introLockup() {
    fitLockup()
    if (reduced) return
    // The letters stretch out to fill the line.
    lockup.classList.add('packed')
    requestAnimationFrame(function () { requestAnimationFrame(function () { lockup.classList.remove('packed') }) })
  }
  ;(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(introLockup)
  var fitTimer = 0
  addEventListener('resize', function () { clearTimeout(fitTimer); fitTimer = setTimeout(fitLockup, 80) })

  // ── Download: the real file, version and size, from GitHub ──
  // Asked on every visit, so a new release shows as soon as it's published. A tab keeps the answer
  // for 10 minutes only. A release whose installer is still uploading is skipped, and if GitHub
  // doesn't answer, the links already go to the newest release's page.
  function applyRelease(r) {
    if (!r || !r.url) return
    document.querySelectorAll('[data-download]').forEach(function (a) { a.href = r.url })
    document.querySelectorAll('[data-dl-meta]').forEach(function (m) { m.textContent = r.version + ', ' + r.size + ' MB'; m.hidden = false })
  }
  var cachedRelease = null
  try { cachedRelease = JSON.parse(sessionStorage.getItem('kozo-release') || 'null') } catch (e) {}
  if (cachedRelease && cachedRelease.at && Date.now() - cachedRelease.at < 10 * 60 * 1000) applyRelease(cachedRelease)
  else if (window.fetch) {
    fetch('https://api.github.com/repos/MuhannadAl-Srahen/KoZo/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null })
      .then(function (rel) {
        var asset = rel && !rel.draft && (rel.assets || []).filter(function (a) {
          return /\.exe$/i.test(a.name) && a.size > 0 && (!a.state || a.state === 'uploaded')
        })[0]
        if (!asset) return
        var r = { url: asset.browser_download_url, version: rel.tag_name, size: Math.round(asset.size / 1048576), at: Date.now() }
        applyRelease(r)
        try { sessionStorage.setItem('kozo-release', JSON.stringify(r)) } catch (e) {}
      })
      .catch(function () {})
  }

  // ── Going ──
  renderHud()
  paintScore(shownScore)
  var sentinel = $('end-sentinel')
  if (sentinel) new IntersectionObserver(function (e) { if (e[0].isIntersecting) unlock('end') }).observe(sentinel)
  setTimeout(function () { unlock('start') }, reduced ? 200 : 1500)
})()
