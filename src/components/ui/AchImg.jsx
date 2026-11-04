import React, { useState } from 'react'

// An achievement icon that shows `fallback` instead of a broken image when the
// link has no picture behind it. Keyed on the link, so a new one gets a new try.
export default function AchImg({ src, fallback = null, ...img }) {
  const [failed, setFailed] = useState(null)
  if (!src || failed === src) return fallback
  return <img src={src} alt="" {...img} onError={() => setFailed(src)} />
}
