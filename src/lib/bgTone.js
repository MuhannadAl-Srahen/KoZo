// The Custom theme's background. Any color can be picked, and every spot in the picker
// gives a different shade: a hard cap made most of the color square land on one color,
// so dragging looked like it did nothing.
// A very light pick (white, pastels, light grays: HSL lightness 70% and up) gives a light
// KoZo: that color at about its own lightness (84% and up), saturation up to 70%, on the Light
// theme's text colors. White stays white (the maker picked white and saw it turned dark),
// and a pink stays pink.
// Anything else stays dark so text and cards stay readable: hue stays, how colorful it is
// sets saturation, how bright it is sets lightness, 4 to 16%, and a very colorful pick sits
// lower because full color already reads as bright.
// Pure. Pair: --cbg-h/s/l in styles/customize.css, `light` sets data-theme="light".
export function bgTone(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return { h: 250, s: 24, l: 8, light: false }
  const n = parseInt(m[1], 16)
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h = Math.round((h * 60 + 360) % 360)
  const hslL = (max + min) / 2
  if (hslL >= 0.7) {
    const hslS = d ? d / (1 - Math.abs(2 * hslL - 1)) : 0
    return {
      h,
      s: Math.round(Math.min(1, hslS) * 70),
      // Its own lightness from 88% up; 70 to 88% is squeezed into 84 to 88%, so every spot still differs.
      l: Math.round((hslL >= 0.88 ? hslL * 100 : 84 + 4 * (hslL - 0.7) / 0.18) * 10) / 10,
      light: true,
    }
  }
  const colorful = max ? d / max : 0
  return {
    h,
    s: Math.round(colorful * 55),
    l: Math.round((4 + 12 * max ** 0.6 * (1 - 0.35 * colorful)) * 10) / 10,
    light: false,
  }
}

// HSL to hex. Pure.
export function hslHex(h, s, l) {
  const sat = s / 100, light = l / 100
  const a = sat * Math.min(light, 1 - light)
  const f = (n) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

// The color the app really shows for a pick, as hex, for the picker's box.
export function bgToneHex(hex) {
  const { h, s, l } = bgTone(hex)
  return hslHex(h, s, l)
}
