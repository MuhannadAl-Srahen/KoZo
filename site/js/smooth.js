/* Smooth scrolling for the mouse wheel: the page glides to where the wheel asked instead of
   jumping about 100 px a notch, so the pinned scenes and stretching titles move smoothly too.
   Links to a part of the page glide there. Touch, keys and the scrollbar stay the browser's own.
   Off when the page's Animations switch is off. */
;(function () {
  'use strict'
  var root = document.documentElement
  var target = 0, current = 0, raf = 0, last = 0, lastSet = -1, glideTo = null

  function off() { return root.dataset.motion === 'off' }
  function max() { return Math.max(0, root.scrollHeight - innerHeight) }
  function clamp(v) { return Math.min(max(), Math.max(0, v)) }

  // A panel under the pointer that can still scroll that way keeps the wheel for itself.
  function panelTakes(el, dy) {
    for (; el && el !== document.body && el !== root; el = el.parentElement) {
      if (el.nodeType !== 1) continue
      var o = getComputedStyle(el).overflowY
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true
      }
    }
    return false
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    glideTo = null
    lastSet = -1
    target = current = scrollY
    root.style.scrollBehavior = ''
  }

  function frame(now) {
    raf = 0
    // The scrollbar, a key or find-in-page moved the page: let them have it.
    if (lastSet >= 0 && Math.abs(scrollY - lastSet) > 2) { stop(); return }
    var dt = last ? Math.min(64, now - last) : 16.7
    last = now
    if (glideTo) {
      var p = Math.min(1, (now - glideTo.start) / glideTo.ms)
      current = glideTo.from + (glideTo.to - glideTo.from) * (1 - Math.pow(1 - p, 4))
      if (p >= 1) { current = target = glideTo.to; glideTo = null }
    } else {
      target = clamp(target)
      current += (target - current) * (1 - Math.pow(0.86, dt / 16.7))
      if (Math.abs(target - current) < 0.5) current = target
    }
    window.scrollTo(0, current)
    lastSet = scrollY
    if (glideTo || current !== target) raf = requestAnimationFrame(frame)
    else stop()
  }

  function run() {
    if (raf) return
    root.style.scrollBehavior = 'auto'
    last = 0
    lastSet = scrollY
    raf = requestAnimationFrame(frame)
  }

  addEventListener('wheel', function (e) {
    if (off() || e.ctrlKey || e.shiftKey || e.defaultPrevented) return
    var dy = e.deltaY
    if (!dy || Math.abs(e.deltaX) > Math.abs(dy)) return
    if (e.deltaMode === 1) dy *= 33
    else if (e.deltaMode === 2) dy *= innerHeight
    if (panelTakes(e.target, dy)) return
    e.preventDefault()
    if (!raf) current = target = scrollY
    glideTo = null
    target = clamp(target + dy)
    run()
  }, { passive: false })

  function glide(to) {
    stop()
    to = clamp(to)
    var dist = Math.abs(to - scrollY)
    if (dist < 1) return
    glideTo = { from: scrollY, to: to, start: performance.now(), ms: Math.min(1400, 450 + dist * 0.1) }
    current = scrollY
    target = to
    run()
  }

  document.addEventListener('click', function (e) {
    if (off() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    var a = e.target.closest && e.target.closest('a[href^="#"]')
    if (!a) return
    var id = a.getAttribute('href').slice(1)
    var el = id && document.getElementById(id)
    if (!el) return
    e.preventDefault()
    var pad = parseFloat(getComputedStyle(root).scrollPaddingTop) || 0
    glide(id === 'top' ? 0 : el.getBoundingClientRect().top + scrollY - pad)
    try { history.pushState(null, '', '#' + id) } catch (err) {}
  })

  window.kozoSmooth = { glide: glide, stop: stop }
})()
