import { useEffect, useRef } from 'react'

// Calls onReach when the element (a sentinel under a list) comes within `margin` pixels of the
// bottom of its page's own scroll panel: the endless lists on Games like and Discounts (the
// maker asked for scrolling over buttons). Same idea as the Game List's: the observer is made
// again whenever `key` changes, so a short batch that leaves the sentinel in view asks again.
export default function useNearEnd(ref, onReach, { enabled = true, margin = 600, key } = {}) {
  const cb = useRef(onReach)
  cb.current = onReach
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return
    let root = el.parentElement
    while (root && root !== document.body) {
      const oy = getComputedStyle(root).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      root = root.parentElement
    }
    if (root === document.body) root = null
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) cb.current?.()
    }, { root, rootMargin: `0px 0px ${margin}px 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, enabled, margin, key])
}
