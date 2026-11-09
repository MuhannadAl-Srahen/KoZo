// Everything below the hero that does something: the dive into the app, the toast playground, the
// session chart, Scan PC, the sideways rail, the tiers, the looks, the restore points and the end.
(function () {
  'use strict'
  var $ = function (id) { return document.getElementById(id) }
  var game = window.kozoGame
  var clamp = function (v, a, b) { return Math.min(b === undefined ? 1 : b, Math.max(a === undefined ? 0 : a, v)) }
  var smooth = function (t) { return t * t * (3 - 2 * t) }
  var span = function (v, a, b) { return clamp((v - a) / (b - a)) }
  var reduced = document.documentElement.dataset.motion === 'off'
  var flat = function () { return document.documentElement.classList.contains('flat') }
  var HEX = '<svg class="hex" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2 20.66,7 20.66,17 12,22 3.34,17 3.34,7"/></svg>'

  // The logo wherever it's drawn small.
  var logoCells = $('hud-logo').innerHTML
  document.querySelectorAll('.win-logo, .foot-logo').forEach(function (s) { s.innerHTML = logoCells })

  // ── KoZo is for Windows: anywhere else the button sends it to your PC ──────
  if (!/Windows/i.test(navigator.userAgent)) {
    document.querySelectorAll('[data-download]').forEach(function (a) {
      var label = a.querySelector('[data-download-label]')
      if (label) label.textContent = 'Send it to your PC'
      a.addEventListener('click', function (e) {
        e.preventDefault()
        var url = location.href.split('#')[0]
        var told = function (name, desc) { game.toast({ title: 'KoZo', headIcon: 'i-win', name: name, desc: desc, icon: 'i-win', tone: getComputedStyle(document.documentElement).getPropertyValue('--a') }) }
        if (navigator.share) navigator.share({ title: 'KoZo', text: 'KoZo for Windows', url: url }).catch(function () {})
        else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { told('Link copied', 'Open it on your Windows PC to download KoZo.') }, function () { told('KoZo is for Windows', url) })
        else told('KoZo is for Windows', url)
      })
    })
  }

  // ── Scroll: one listener, one frame ─────────────────────────────────────────
  var ticking = false
  var onFrame = []
  function requestTick() {
    if (ticking) return
    ticking = true
    requestAnimationFrame(function () { ticking = false; onFrame.forEach(function (f) { f() }) })
  }
  addEventListener('scroll', requestTick, { passive: true })
  addEventListener('resize', requestTick)
  window.addEventListener('kozo:hive-layout', requestTick)

  // ── The dive: the wall comes closer, the middle cell opens, the app is inside ──
  var hero = $('hero'), dive = $('dive'), diveOpen = $('dive-open'), diveLine = $('dive-line'), shade = $('hero-shade')
  var beats = Array.prototype.slice.call(document.querySelectorAll('.beat'))
  var diveDone = false
  onFrame.push(function () {
    if (flat()) {
      diveOpen.style.removeProperty('--r')
      return
    }
    var y = window.scrollY
    var heroH = hero.offsetHeight
    var vh = innerHeight
    var len = dive.offsetHeight - vh
    var a = clamp(y / heroH)                     // the hero leaving
    var b = clamp((y - dive.offsetTop) / len)    // through the dive

    var open = smooth(span(b, 0.02, 0.26))       // the hexagon opening
    var zoom = 1 + smooth(a) * 0.45 + open * open * 3.4
    var hive = window.kozoHive
    if (hive) hive.setCamera(zoom, smooth(a), open >= 1)
    shade.style.opacity = String(1 - smooth(span(a, 0.1, 0.95)))

    // "Step inside." comes up in the middle just before it opens.
    var line = span(a, 0.55, 0.92) * (1 - span(b, 0.03, 0.1))
    diveLine.style.opacity = String(line)
    diveLine.style.transform = 'translate(-50%, -50%) scale(' + (0.92 + line * 0.08 + open * 0.3).toFixed(3) + ')'

    // The window opens from exactly the middle cell.
    var start = hive ? hive.cellRadius() : 90
    var full = Math.hypot(innerWidth, vh) * 0.72
    diveOpen.style.setProperty('--r', (b <= 0.02 ? 0 : start + (full - start) * open).toFixed(1) + 'px')
    diveOpen.style.setProperty('--enter', (1 + (1 - open) * 0.18).toFixed(3))

    // Inside: each next screen opens in the same hexagon shape.
    var next1 = smooth(span(b, 0.47, 0.58))
    var next2 = smooth(span(b, 0.73, 0.84))
    beats[1].style.setProperty('--r', (next1 * full).toFixed(1) + 'px')
    beats[2].style.setProperty('--r', (next2 * full).toFixed(1) + 'px')

    if (b > 0.3 && !diveDone) { diveDone = true; game.unlock('hive') }
  })
  // Without the dive, seeing the three screens is enough.
  new IntersectionObserver(function (e) {
    if (e[0].isIntersecting && flat() && !diveDone) { diveDone = true; game.unlock('hive') }
  }).observe(beats[2])

  // ── Unlock something ────────────────────────────────────────────────────────
  var RARITIES = [
    { key: 'common', label: 'Common', color: '#b4b4d0', pct: 90, name: 'First Steps', desc: 'Finished the opening.' },
    { key: 'uncommon', label: 'Uncommon', color: '#fbbf24', pct: 50, name: 'Hoarder', desc: 'Carry 500 items at once.' },
    { key: 'rare', label: 'Rare', color: '#34d399', pct: 20, name: 'Untouchable', desc: 'Beat a boss without taking a hit.' },
    { key: 'very', label: 'Very rare', color: '#60a5fa', pct: 8, name: 'Against the Clock', desc: 'Finish a chapter in under an hour.' },
    { key: 'ultra', label: 'Ultra rare', color: '#c084fc', pct: 2, name: 'The Long Road', desc: 'Find every secret in the game.' },
  ]
  var soundOn = false, audio = null
  function tone(c, t0, freq, dur, peak) {
    // The app's chime (src/lib/sounds.js): a sine with a quiet triangle an octave up.
    [['sine', 1, 1], ['triangle', 2, 0.25]].forEach(function (l) {
      var osc = c.createOscillator(), g = c.createGain()
      osc.type = l[0]
      osc.frequency.setValueAtTime(freq * l[1], t0)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(peak * l[2], t0 + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      osc.connect(g).connect(c.destination)
      osc.start(t0)
      osc.stop(t0 + dur + 0.05)
    })
  }
  function chime() {
    if (!soundOn) return
    try {
      var AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      audio = audio || new AC()
      if (audio.state === 'suspended') audio.resume()
      var t = audio.currentTime
      tone(audio, t, 880, 0.3, 0.1)
      tone(audio, t + 0.1, 1318.5, 0.55, 0.12)
    } catch (e) {}
  }
  var rarityRow = $('rarity-row')
  rarityRow.innerHTML = RARITIES.map(function (r) {
    return '<button class="rarity" type="button" data-key="' + r.key + '" style="--tone:' + r.color + '">' + HEX +
      '<span class="rarity-name">' + r.label + '</span><span class="rarity-xp">+' + game.xpFor(r.pct) + ' XP</span></button>'
  }).join('')
  rarityRow.addEventListener('click', function (e) {
    var b = e.target.closest('.rarity')
    if (!b) return
    var r = RARITIES.filter(function (x) { return x.key === b.dataset.key })[0]
    $('scene-hint').hidden = true
    game.toastInto($('scene-toasts'), {
      title: 'Achievement unlocked', headIcon: 'i-trophy', xp: game.xpFor(r.pct), name: r.name, desc: r.desc, game: r.label, icon: 'i-trophy', tone: r.color,
    })
    chime()
    if (window.kozoHive) window.kozoHive.wave(r.color)
    game.unlock('unlock')
  })
  $('sound-toggle').addEventListener('click', function () {
    soundOn = !soundOn
    this.setAttribute('aria-pressed', String(soundOn))
    $('sound-label').textContent = soundOn ? 'Sound on' : 'Sound off'
    chime()
  })

  // ── The session chart: a bar is a day, and its sessions show right under the bars ──
  var DAY = 86400000
  var UNLOCKS = [
    ['Ember Keeper', 'Light every bonfire in the first region.', 'Uncommon', '#fbbf24'],
    ['Deep Diver', 'Reach the bottom of the old mine.', 'Rare', '#34d399'],
    ['No Rest', 'Play through a whole night cycle.', 'Common', '#b4b4d0'],
    ['Last One Standing', 'Win the arena without healing.', 'Very rare', '#60a5fa'],
  ]
  // A month of sample play, the same for everyone.
  var days = []
  ;(function () {
    var today = new Date(); today.setHours(0, 0, 0, 0)
    var h = function (i, s) { var x = Math.sin(i * 12.9898 + s * 78.233) * 43758.5453; return x - Math.floor(x) }
    for (var i = 29; i >= 1; i--) {
      var date = new Date(today.getTime() - i * DAY)
      var sessions = []
      var count = h(i, 1) < 0.34 ? 0 : h(i, 2) < 0.62 ? 1 : h(i, 3) < 0.7 ? 2 : 3
      var clock = 17 * 60 + Math.floor(h(i, 4) * 180)
      for (var n = 0; n < count; n++) {
        var played = 25 + Math.floor(h(i, 5 + n) * 170)
        var paused = h(i, 9 + n) < 0.35 ? 5 + Math.floor(h(i, 11 + n) * 30) : 0
        var ach = h(i, 13 + n) < 0.3 ? 1 + Math.floor(h(i, 15 + n) * 2.4) : 0
        sessions.push({ id: i + '-' + n, start: clock, played: played, paused: paused, unlocks: ach, seed: i + n })
        clock += played + paused + 20 + Math.floor(h(i, 17 + n) * 60)
      }
      days.push({ date: date, sessions: sessions })
    }
    days.push({ date: today, today: true, sessions: [{ id: 'live', live: true, start: new Date().getHours() * 60 + new Date().getMinutes(), played: 0, paused: 0, unlocks: 0, seed: 0 }] })
  })()
  var dayTotal = function (d) { return d.sessions.reduce(function (s, x) { return s + x.played }, 0) }
  var maxDay = Math.max.apply(null, days.map(dayTotal))
  var pickedDay = -1, openSession = null

  function clockText(mins) {
    var h = Math.floor(mins / 60) % 24, m = Math.floor(mins % 60)
    return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM')
  }
  // The app's formatPlaytime: 1h35m, 45m.
  function playtime(mins) {
    var total = Math.round(mins)
    var h = Math.floor(total / 60), m = total % 60
    return h ? h + 'h' + (m ? m + 'm' : '') : m + 'm'
  }
  function shortDate(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  function liveMinutes() { return game.playedSeconds() / 60 }

  function renderBars() {
    $('chart-bars').innerHTML = days.map(function (d, i) {
      var total = d.today ? Math.max(liveMinutes(), 1) : dayTotal(d)
      var height = total ? Math.max(4, total / maxDay * 100) : 0
      var label = shortDate(d.date) + ', ' + (d.today ? 'your visit' : (d.sessions.length ? d.sessions.length + (d.sessions.length === 1 ? ' session, ' : ' sessions, ') + playtime(total) : 'no play'))
      return '<button class="bar' + (d.today ? ' bar-live' : '') + (pickedDay === i ? ' on' : '') + '" type="button" data-i="' + i + '"' +
        (d.sessions.length ? '' : ' disabled') + ' aria-pressed="' + (pickedDay === i) + '" aria-label="' + label + '" title="' + label + '"><i style="height:' + height.toFixed(1) + '%"></i></button>'
    }).join('')
    var sum = days.reduce(function (s, d) { return s + (d.today ? 0 : dayTotal(d)) }, 0)
    $('chart-total').textContent = playtime(sum)
    $('axis-start').textContent = shortDate(days[0].date)
  }

  function sessionsToShow() {
    if (pickedDay >= 0) return days[pickedDay].sessions.map(function (s) { return { s: s, d: days[pickedDay] } })
    var all = []
    days.forEach(function (d) { d.sessions.forEach(function (s) { all.push({ s: s, d: d }) }) })
    return all.reverse().slice(0, 5)
  }
  function renderRows() {
    var list = sessionsToShow()
    var longest = Math.max.apply(null, list.map(function (x) { return x.s.live ? 1 : x.s.played }).concat(1))
    $('chart-rows').innerHTML = list.map(function (x) {
      var s = x.s
      var mins = s.live ? liveMinutes() : s.played
      var open = openSession === s.id
      var trophies = s.unlocks ? '<span class="row-ach"><svg aria-hidden="true"><use href="#i-trophy"/></svg>' + s.unlocks + '</span>' : '<span class="row-ach"></span>'
      var row = '<button class="row' + (open ? ' open' : '') + '" type="button" data-id="' + s.id + '" aria-expanded="' + open + '">' +
        '<span class="row-date">' + (x.d.today ? 'Today' : shortDate(x.d.date)) + '</span>' +
        '<span class="row-time">' + clockText(s.start) + '</span>' +
        '<span class="row-track"><i style="width:' + clamp(mins / longest * 100, 2, 100).toFixed(1) + '%"></i></span>' +
        '<span class="row-dur">' + (s.live ? game.clock(game.playedSeconds()) : playtime(mins)) + '</span>' + trophies + '</button>'
      if (!open) return row
      if (s.live) {
        return row + '<div class="row-detail"><p class="row-line">Your visit, still running. Time away from this tab isn\'t in it.</p></div>'
      }
      var pausedText = s.paused ? ', ' + playtime(s.paused) + ' paused' : ''
      var line = clockText(s.start) + ' to ' + clockText(s.start + s.played + s.paused) + ', ' + playtime(s.played) + ' played' + pausedText
      var unlocks = ''
      for (var i = 0; i < s.unlocks; i++) {
        var u = UNLOCKS[(s.seed + i) % UNLOCKS.length]
        unlocks += '<div class="row-unlock" style="--tone:' + u[3] + '">' + HEX + '<span><b>' + u[0] + '</b><small>' + u[1] + '</small></span><em>' + u[2] + '</em></div>'
      }
      return row + '<div class="row-detail"><p class="row-line">' + line + '</p>' + (unlocks || '<p class="row-none">Nothing unlocked in this session.</p>') + '</div>'
    }).join('')
  }
  function renderChart() { renderBars(); renderRows() }
  $('chart-bars').addEventListener('click', function (e) {
    var b = e.target.closest('.bar')
    if (!b || b.disabled) return
    var i = Number(b.dataset.i)
    // The same bar again shows every session. A day with one session opens it.
    pickedDay = pickedDay === i ? -1 : i
    openSession = pickedDay >= 0 && days[pickedDay].sessions.length === 1 ? days[pickedDay].sessions[0].id : null
    renderChart()
    game.unlock('bar')
  })
  $('chart-rows').addEventListener('click', function (e) {
    var r = e.target.closest('.row')
    if (!r) return
    openSession = openSession === r.dataset.id ? null : r.dataset.id
    renderRows()
    var again = $('chart-rows').querySelector('.row[data-id="' + r.dataset.id + '"]')
    if (again) again.focus({ preventScroll: true })
  })
  renderChart()
  // The live bar grows with your visit. Only while the chart is on screen.
  var chartSeen = false
  new IntersectionObserver(function (e) { chartSeen = e[0].isIntersecting }).observe($('chart-card'))
  setInterval(function () {
    if (!chartSeen) return
    var bars = $('chart-bars').querySelectorAll('.bar')
    var live = bars[bars.length - 1]
    if (live) live.firstChild.style.height = Math.max(4, Math.max(liveMinutes(), 1) / maxDay * 100).toFixed(1) + '%'
    var row = $('chart-rows').querySelector('.row[data-id="live"] .row-dur')
    if (row) row.textContent = game.clock(game.playedSeconds())
  }, 1000)

  // ── Scan PC ─────────────────────────────────────────────────────────────────
  var covers = window.KOZO_COVERS
  var cols = covers ? covers.cols : 8, rows = covers ? covers.rows : 5
  var CARDS = [
    // cover name part, shown name, store, file, state
    ['ELDEN RING', 'ELDEN RING', 'Steam', 'eldenring.exe', 'in'],
    ['Hades', 'Hades', 'Epic', 'Hades.exe', 'new'],
    ['Cyberpunk', 'Cyberpunk 2077', 'GOG', 'Cyberpunk2077.exe', 'new'],
    ['Forza', 'Forza Horizon 5', 'Xbox', 'ForzaHorizon5.exe', 'new'],
    ['Hollow Knight', 'Hollow Knight', 'No launcher', 'hollow_knight.exe', 'new'],
    ['Baldur', "Baldur's Gate 3", 'Steam', 'bg3.exe', 'in'],
    ['Stardew', 'Stardew Valley', 'No launcher', 'Stardew Valley.exe', 'new'],
    [null, 'Old Mod Tools', 'No launcher', null, 'nofile'],
  ]
  function coverStyle(part) {
    if (!covers || !part) return ''
    var i = covers.names.findIndex(function (n) { return n.indexOf(part) >= 0 })
    if (i < 0) return ''
    var c = i % cols, r = Math.floor(i / cols)
    return 'background-position:' + (c / (cols - 1) * 100).toFixed(3) + '% ' + (r / (rows - 1) * 100).toFixed(3) + '%'
  }
  $('scan-grid').innerHTML = CARDS.map(function (c, i) {
    var tag = c[4] === 'in' ? '<span class="scan-flag">In Library</span>' : c[4] === 'nofile' ? '<span class="scan-flag">No game file</span>' : ''
    var line = c[4] === 'nofile' ? '<span class="scan-file warn">Only tools in this folder</span>' : '<span class="scan-file">' + c[3] + '</span>'
    return '<div class="scan-card' + (c[4] === 'new' ? ' is-new' : ' is-dim') + '" style="--i:' + i + '">' +
      '<div class="scan-art" style="' + coverStyle(c[0]) + '">' + tag + '<span class="scan-store">' + c[2] + '</span></div>' +
      '<p class="scan-name">' + c[1] + '</p>' + line + '</div>'
  }).join('')
  var scanning = false
  function runScan() {
    if (scanning) return
    scanning = true
    var win = $('scan-win')
    win.classList.remove('done')
    win.classList.add('going')
    $('scan-title').textContent = 'Scan PC'
    var start = performance.now(), length = reduced ? 1 : 2400
    ;(function step(now) {
      var p = clamp((now - start) / length)
      $('scan-fill').style.width = (p * 100).toFixed(1) + '%'
      var shown = Math.floor(p * CARDS.length)
      win.style.setProperty('--shown', shown)
      win.querySelectorAll('.scan-card').forEach(function (c, i) { c.classList.toggle('in', i < shown || p >= 1) })
      $('scan-status').textContent = p < 0.42 ? 'Looking in your folders' : p < 0.8 ? 'Checking each game file' : 'Reading Epic, GOG and Xbox'
      if (p < 1) { requestAnimationFrame(step); return }
      scanning = false
      win.classList.remove('going')
      win.classList.add('done')
      var fresh = CARDS.filter(function (c) { return c[4] === 'new' }).length
      $('scan-status').textContent = CARDS.length + ' found, ' + fresh + ' new'
    })(start)
  }
  $('scan-again').addEventListener('click', runScan)
  new IntersectionObserver(function (e, obs) {
    if (e[0].isIntersecting) { runScan(); obs.disconnect() }
  }, { threshold: 0.35 }).observe($('scan-win'))

  // ── The band of store names ─────────────────────────────────────────────────
  var band = $('band'), bandTrack = $('band-track')
  onFrame.push(function () {
    if (reduced) return
    var r = band.getBoundingClientRect()
    if (r.bottom < 0 || r.top > innerHeight) return
    var p = (innerHeight - r.top) / (innerHeight + r.height)
    bandTrack.style.transform = 'translate3d(' + (-p * 34).toFixed(2) + '%,0,0)'
  })

  // ── The rail: scrolling down moves it sideways ──────────────────────────────
  var rail = $('rail'), railTrack = $('rail-track')
  function sizeRail() {
    if (flat()) { rail.style.height = ''; railTrack.style.transform = ''; return }
    rail.style.height = (railTrack.scrollWidth - innerWidth + innerHeight).toFixed(0) + 'px'
  }
  onFrame.push(function () {
    if (flat()) return
    var len = rail.offsetHeight - innerHeight
    if (len <= 0) return
    var p = clamp((window.scrollY - rail.offsetTop) / len)
    railTrack.style.transform = 'translate3d(' + (-(railTrack.scrollWidth - innerWidth) * p).toFixed(1) + 'px,0,0)'
  })
  addEventListener('resize', sizeRail)
  addEventListener('load', sizeRail)
  ;(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () { sizeRail(); requestTick() })

  // ── Rookie to Mythic ────────────────────────────────────────────────────────
  var TIER_ROW = [[1, 'Rookie'], [3, 'Apprentice'], [7, 'Adept'], [12, 'Seasoned'], [18, 'Veteran'], [25, 'Master'], [35, 'Legend'], [45, 'Grandmaster'], [60, 'Mythic']]
  $('tier-row').innerHTML = TIER_ROW.map(function (t, i) {
    return '<li class="tier" data-level="' + t[0] + '" style="--n:' + i + '"><div class="tier-hex">' + HEX + '<b>' + t[0] + '</b></div><span>' + t[1] + '</span></li>'
  }).join('')

  // ── Make it yours ───────────────────────────────────────────────────────────
  var LOOKS = [
    { name: 'Hot Pink', color: '#f472b6', img: 'assets/shots/look-pink.webp', cap: 'Hot Pink, Poster cards, slim sidebar' },
    { name: 'Electric Blue', color: '#60a5fa', img: 'assets/shots/look-blue.webp', cap: 'Electric Blue, Glass cards, Midnight theme' },
    { name: 'Amber', color: '#fbbf24', img: 'assets/shots/look-amber.webp', cap: 'Amber, Minimal cards, your own background color' },
    { name: 'Lime', color: '#9fff02', img: 'assets/shots/look-lime.webp', cap: 'Lime, Classic cards, black background' },
    { name: 'Light', color: '#9fff02', img: 'assets/shots/look-light.webp', cap: 'The Light theme, Classic cards' },
  ]
  $('look-btns').innerHTML = LOOKS.map(function (l, i) {
    return '<button class="look-btn" type="button" data-i="' + i + '" aria-pressed="' + (i === 0) + '" style="--tone:' + l.color + '">' + HEX + '<span>' + l.name + '</span></button>'
  }).join('')
  $('look-btns').addEventListener('click', function (e) {
    var b = e.target.closest('.look-btn')
    if (!b) return
    var l = LOOKS[Number(b.dataset.i)]
    document.querySelectorAll('.look-btn').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)) })
    var lookImg = $('look-img')
    lookImg.srcset = l.img.replace('shots/', 'shots/sm/') + ' 1200w, ' + l.img + ' 2000w'
    lookImg.src = l.img
    $('look-cap').textContent = l.cap
    game.setAccent(l.color, true)
  })
  // Fetched ahead, so a press changes the picture at once.
  new IntersectionObserver(function (e, obs) {
    if (!e[0].isIntersecting) return
    LOOKS.forEach(function (l) { var i = new Image(); i.src = l.img })
    obs.disconnect()
  }, { rootMargin: '600px' }).observe($('look'))

  // ── Restore points ──────────────────────────────────────────────────────────
  var POINTS = [
    ['Today, 9:41 PM', 'After play', '12.4 MB'],
    ['Today, 7:02 PM', 'Before play', '12.1 MB'],
    ['Yesterday, 11:18 PM', 'After play', '12.1 MB'],
    ['Nov 1', 'Daily', '11.8 MB'],
    ['Oct 19', 'Weekly', '10.2 MB'],
  ]
  $('saves-list').innerHTML = POINTS.map(function (p, i) {
    return '<li class="save-row"><span class="save-mark"></span><div class="save-text"><b>' + p[0] + '</b><small>' + p[1] + ', ' + p[2] + '</small></div>' +
      '<button class="save-btn" type="button" data-i="' + i + '">Put it back</button></li>'
  }).join('')
  $('saves-list').addEventListener('click', function (e) {
    var b = e.target.closest('.save-btn')
    if (!b) return
    game.toast({ title: 'KoZo', headIcon: 'i-clock', name: 'Put back: ' + POINTS[Number(b.dataset.i)][0], desc: 'The save you had is kept as a restore point. In the app, this restores the real files.', icon: 'i-save', tone: getComputedStyle(document.documentElement).getPropertyValue('--a') })
  })

  // ── A controller, if there is one ───────────────────────────────────────────
  var padDone = false, padTimer = 0, padWasDown = false
  function pollPad() {
    var pad = (navigator.getGamepads ? Array.prototype.slice.call(navigator.getGamepads()) : []).filter(Boolean)[0]
    if (!pad) { padTimer = 0; return }
    var down = !!(pad.buttons[0] && pad.buttons[0].pressed)
    if (down && !padWasDown) {
      if (!padDone) {
        padDone = true
        $('pad-text').textContent = 'That\'s how it feels on the couch.'
        game.toast({ title: 'Achievement unlocked', headIcon: 'i-trophy', name: 'Couch Mode', desc: 'Pressed A on a website. A bonus, this one.', game: 'Secret', icon: 'i-pad', tone: '#c084fc' })
      }
    }
    padWasDown = down
    padTimer = requestAnimationFrame(pollPad)
  }
  addEventListener('gamepadconnected', function () {
    if (!padDone) $('pad-text').textContent = 'Controller connected. Press A.'
    $('pad-state').classList.add('on')
    if (!padTimer) padTimer = requestAnimationFrame(pollPad)
  })
  addEventListener('gamepaddisconnected', function () { $('pad-state').classList.remove('on') })

  // ── The end ─────────────────────────────────────────────────────────────────
  var finaleHex = $('finale-hex')
  finaleHex.innerHTML = '<svg viewBox="-26 -23 52 46">' + logoCells + '</svg>'
  function renderFinale() {
    var s = game.summary()
    $('stat-time').textContent = game.clock(game.playedSeconds())
    $('stat-ach').textContent = s.count + '/7'
    $('stat-level').textContent = 'Level ' + s.level
    $('stat-tier').textContent = s.tier
    finaleHex.querySelectorAll('polygon').forEach(function (p, i) { p.classList.toggle('on', i < s.count) })
    $('finale-note').textContent = s.count >= 7
      ? 'Every achievement on this page, and you reached ' + s.tier + '. Level 60 is Mythic. That takes actual games.'
      : (7 - s.count) + (7 - s.count === 1 ? ' achievement' : ' achievements') + ' left up there, if you want them. The list is in the bar at the top.'
    document.querySelectorAll('.tier').forEach(function (t) {
      var lv = Number(t.dataset.level)
      t.classList.toggle('reached', lv <= s.level)
    })
    var here = null
    document.querySelectorAll('.tier').forEach(function (t) { if (Number(t.dataset.level) <= s.level) here = t })
    document.querySelectorAll('.tier').forEach(function (t) { t.classList.toggle('here', t === here) })
  }
  window.addEventListener('kozo:score', renderFinale)
  renderFinale()
  setInterval(renderFinale, 1000)

  // The timer steps aside at the bottom, where the buttons and links are.
  new IntersectionObserver(function (e) { $('session').classList.toggle('tucked', e[0].isIntersecting) }, { rootMargin: '0px 0px -20% 0px' }).observe($('faq'))

  sizeRail()
  requestTick()
})()
