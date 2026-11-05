// The honeycomb: every game in one image, every cell one instance of one draw call, so it stays
// light. It stops drawing when it's off screen or the tab is hidden, as the app does behind a game.
(function () {
  'use strict'
  var canvas = document.getElementById('hive')
  var wrap = document.getElementById('hive-wrap')
  var hero = document.getElementById('hero')
  var covers = window.KOZO_COVERS
  if (!canvas || !covers) return
  var gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'low-power' })
  if (!gl) { document.documentElement.classList.add('no-hive'); return }

  var reduced = document.documentElement.dataset.motion === 'off'
  var COLS = covers.cols, ROWS = covers.rows

  var VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 a_pos;
  layout(location=1) in vec2 i_center;
  layout(location=2) in vec2 i_data;
  uniform vec2 u_res, u_focus, u_mouse, u_wave;
  uniform float u_r, u_t, u_zoom, u_mouseOn, u_waveR, u_waveA, u_ambient;
  out vec2 v_local, v_cell;
  out float v_lit, v_logo, v_wave;
  void main() {
    float d = length(i_center);
    float seed = i_data.y;
    float index = i_data.x;

    // Grows outward from the logo in the middle.
    float grow = clamp((u_t - 0.05 - d * 0.00085 - seed * 0.12) / 0.5, 0.0, 1.0);
    grow = 1.0 - pow(1.0 - grow, 3.0);
    float isLogo = step(d, u_r * 1.8);
    v_logo = isLogo * (1.0 - smoothstep(1.15, 1.75, u_t));

    float hover = smoothstep(u_r * 3.1, u_r * 0.5, distance(i_center, u_mouse)) * u_mouseOn;
    float phase = fract(u_t * 0.065 + seed * 7.0);
    float pulse = step(seed, 0.42) * smoothstep(0.0, 0.03, phase) * (1.0 - smoothstep(0.05, 0.14, phase)) * u_ambient;
    float wave = exp(-pow((distance(i_center, u_wave) - u_waveR) / (u_r * 1.7), 2.0)) * u_waveA;
    v_wave = wave;
    v_lit = clamp(max(max(hover, pulse), wave), 0.0, 1.0);

    float scale = grow * (1.0 + hover * 0.085 + wave * 0.05);
    v_local = a_pos * u_r * 1.1;
    v_cell = vec2(mod(index, ${COLS}.0), floor(index / ${COLS}.0));
    vec2 world = (i_center + v_local * scale) * u_zoom + u_focus;
    vec2 clip = world / u_res * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  }`

  var FS = `#version 300 es
  precision highp float;
  in vec2 v_local, v_cell;
  in float v_lit, v_logo, v_wave;
  uniform sampler2D u_tex;
  uniform vec3 u_accent, u_waveColor;
  uniform float u_vis;
  out vec4 color;
  void main() {
    float apothem = u_vis * 0.8660254;
    vec2 p = abs(v_local);
    float sd = max(p.x, dot(p, vec2(0.5, 0.8660254))) - apothem;
    float alpha = 1.0 - smoothstep(-1.0, 0.5, sd);
    if (alpha <= 0.0) discard;

    // A cover is 2:3, a pointy hexagon a little taller than wide: fill the width, crop the height.
    float hexW = apothem * 2.0;
    vec2 uv = vec2(v_local.x / hexW + 0.5, v_local.y / (hexW * 1.5) + 0.5);
    vec3 art = texture(u_tex, (v_cell + uv) / vec2(${COLS}.0, ${ROWS}.0)).rgb;

    float luma = dot(art, vec3(0.299, 0.587, 0.114));
    vec3 c = mix(vec3(luma), art, 0.62 + 0.38 * v_lit) * (0.5 + 0.55 * v_lit);
    c = mix(c, c * mix(vec3(1.0), u_accent, 0.14), 1.0 - v_lit);

    float rim = smoothstep(-4.5, -0.8, sd);
    c = mix(c, u_accent, rim * (0.1 + v_lit * 0.85));
    c = mix(c, u_waveColor, v_wave * 0.42);
    c = mix(c, u_accent, v_logo);
    color = vec4(c * alpha, alpha);
  }`

  function compile(type, src) {
    var s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  var prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
  gl.useProgram(prog)
  var U = {}
  ;['u_res', 'u_focus', 'u_mouse', 'u_wave', 'u_r', 'u_t', 'u_zoom', 'u_mouseOn', 'u_waveR', 'u_waveA', 'u_ambient', 'u_tex', 'u_accent', 'u_waveColor', 'u_vis'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n) })

  var quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  var inst = gl.createBuffer()
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  var cells = [], W = 0, H = 0, R = 90, count = 0
  var home = { x: 0, y: 0 }                         // where the logo sits at rest
  var camera = { zoom: 1, x: 0, y: 0, away: false } // set while scrolling through the dive

  // Stable from one load to the next, and no two neighbours show the same game.
  function hash(a, b) { var h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h) }

  function layout() {
    var rect = wrap.getBoundingClientRect()
    var dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    W = rect.width; H = rect.height
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)

    var narrow = W <= 880
    R = narrow ? Math.max(52, W / 7.4) : Math.max(70, Math.min(112, W / 15.5))
    home.x = narrow ? W * 0.5 : W * 0.7
    home.y = narrow ? R * 3.4 + 40 : H * 0.47
    camera.x = home.x; camera.y = home.y

    var dx = Math.sqrt(3) * R, dy = 1.5 * R
    var taken = new Map()
    var data = []
    cells = []
    // A wide margin, so the wall still reaches the edges as the camera moves in.
    var margin = narrow ? R * 1.2 : Math.max(W, H) * 0.42
    var reach = Math.ceil((Math.max(W, H) + margin) / dy) + 2
    var total = COLS * ROWS
    for (var r = -reach; r <= reach; r++) {
      for (var q = -reach * 2; q <= reach * 2; q++) {
        var x = dx * (q + r / 2), y = dy * r
        var sx = x + home.x, sy = y + home.y
        if (sx < -margin || sx > W + margin || sy < -margin || sy > H + margin) continue
        var near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]].map(function (o) { return taken.get((q + o[0]) + ',' + (r + o[1])) })
        var idx = Math.floor(hash(q, r) * total)
        for (var tries = 0; tries < total && near.indexOf(idx) >= 0; tries++) idx = (idx + 7) % total
        taken.set(q + ',' + r, idx)
        var seed = hash(r + 3.3, q - 1.7)
        cells.push({ x: x, y: y, idx: idx })
        data.push(x, y, idx, seed)
      }
    }
    count = cells.length
    gl.bindBuffer(gl.ARRAY_BUFFER, inst)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribDivisor(1, 1)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 16, 8)
    gl.vertexAttribDivisor(2, 1)
    wake()
    window.dispatchEvent(new CustomEvent('kozo:hive-layout'))
  }

  function hexToRgb(hex) {
    var n = parseInt(String(hex).trim().replace('#', ''), 16)
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
  }
  var accent = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue('--a') || '#9fff02')

  var state = {
    start: 0, ready: false, visible: true, frame: 0, raf: 0,
    mouse: { x: 1e5, y: 1e5 }, target: { x: 1e5, y: 1e5 }, on: 0, onTarget: 0,
    wave: { x: 0, y: 0, born: -100, color: accent },
  }

  function draw(now) {
    state.raf = 0
    if (!state.ready || !state.visible || camera.away || document.hidden) return
    state.frame++
    var t = reduced ? 10 : (now - state.start) / 1000
    var waveAge = (now - state.wave.born) / 1000
    var waving = waveAge < 2
    var moving = Math.abs(state.on - state.onTarget) > 0.01 || Math.abs(state.mouse.x - state.target.x) + Math.abs(state.mouse.y - state.target.y) > 0.5
    var intro = !reduced && t < 3.2

    state.mouse.x += (state.target.x - state.mouse.x) * 0.16
    state.mouse.y += (state.target.y - state.mouse.y) * 0.16
    state.on += (state.onTarget - state.on) * 0.1

    // With nothing happening, half the frames are enough for the slow pulses.
    if (intro || moving || waving || state.pushed || state.frame % 2 === 0) {
      state.pushed = false
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform2f(U.u_res, W, H)
      gl.uniform2f(U.u_focus, camera.x, camera.y)
      gl.uniform2f(U.u_mouse, state.mouse.x, state.mouse.y)
      gl.uniform1f(U.u_mouseOn, state.on)
      gl.uniform1f(U.u_r, R)
      gl.uniform1f(U.u_vis, R * 0.95)
      gl.uniform1f(U.u_t, t)
      gl.uniform1f(U.u_zoom, camera.zoom)
      gl.uniform1f(U.u_ambient, reduced ? 0 : 1)
      gl.uniform2f(U.u_wave, state.wave.x, state.wave.y)
      gl.uniform1f(U.u_waveR, waveAge * Math.max(W, H) * 0.75)
      gl.uniform1f(U.u_waveA, waving ? Math.max(0, 1 - waveAge / 2) : 0)
      gl.uniform3fv(U.u_accent, accent)
      gl.uniform3fv(U.u_waveColor, state.wave.color)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
    }
    // With reduced motion a still picture is enough, unless someone is pointing at it.
    if (!reduced || moving || waving) wake()
  }
  function wake() { if (!state.raf) state.raf = requestAnimationFrame(draw) }

  // ── The game names under the pointer ──
  var tag = document.getElementById('hive-tag')
  var lastIdx = -1
  function pointAt(e) {
    var rect = wrap.getBoundingClientRect()
    var px = e.clientX - rect.left, py = e.clientY - rect.top
    var overCopy = e.target.closest && e.target.closest('.hero-copy a, .hero-copy button')
    state.target.x = (px - camera.x) / camera.zoom
    state.target.y = (py - camera.y) / camera.zoom
    if (state.onTarget === 0) { state.mouse.x = state.target.x; state.mouse.y = state.target.y }
    state.onTarget = overCopy ? 0 : 1
    var best = null, bestD = R * R * 0.9
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i]
      var d = (c.x - state.target.x) * (c.x - state.target.x) + (c.y - state.target.y) * (c.y - state.target.y)
      if (d < bestD) { bestD = d; best = c }
    }
    // Over the headline the art is dark, and the name would float over the words.
    var dim = W > 880 ? px < W * 0.5 : py > H * 0.5
    if (best && !overCopy && !dim && camera.zoom < 1.05) {
      if (best.idx !== lastIdx) { tag.textContent = covers.names[best.idx]; lastIdx = best.idx }
      tag.hidden = false
      tag.style.left = Math.max(70, Math.min(W - 70, best.x * camera.zoom + camera.x)) + 'px'
      tag.style.top = (best.y * camera.zoom + camera.y - R * 0.72 * camera.zoom + rect.top + window.scrollY) + 'px'
    } else {
      tag.hidden = true
    }
    wake()
  }
  hero.addEventListener('pointermove', pointAt)
  hero.addEventListener('pointerleave', function () { state.onTarget = 0; tag.hidden = true; wake() })

  // ── What the rest of the page can ask of it ──
  window.kozoHive = {
    setAccent: function (hex) { accent = hexToRgb(hex); state.pushed = true; wake() },
    // An achievement goes through the honeycomb as a wave, in its rarity's color.
    wave: function (hex) {
      if (reduced) return
      state.wave = { x: 0, y: 0, born: performance.now(), color: hexToRgb(hex) }
      wake()
    },
    // The dive: where the camera is. `to` is 0 at rest, 1 centered on the middle cell.
    setCamera: function (zoom, to, away) {
      camera.zoom = zoom
      camera.x = home.x + (W / 2 - home.x) * to
      camera.y = home.y + (H / 2 - home.y) * to
      camera.away = !!away
      if (zoom > 1.02) { state.onTarget = 0; tag.hidden = true }
      state.pushed = true
      wake()
    },
    // The size on screen of the middle cell, which the app window opens from.
    cellRadius: function () { return R * 0.95 * camera.zoom },
  }

  document.addEventListener('visibilitychange', wake)
  new IntersectionObserver(function (entries) { state.visible = entries[0].isIntersecting; wake() }).observe(wrap)
  var resizeTimer = 0
  addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 120) })

  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); state.ready = false; document.documentElement.classList.add('no-hive') })

  layout()
  var img = new Image()
  img.src = 'assets/covers.webp'
  img.decode().then(function () {
    var tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(U.u_tex, 0)
    state.start = performance.now()
    state.ready = true
    wake()
  }).catch(function () { document.documentElement.classList.add('no-hive') })
})()
