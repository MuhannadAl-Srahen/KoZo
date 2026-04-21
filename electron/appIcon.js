'use strict'

// Programmatic KoZo honeycomb icon (7 pointy-top hexagons) — same shape as the
// in-app HoneycombLogo. Used for the window/taskbar icon and the tray icon so
// the whole app shows one consistent brand mark instead of the default Electron
// atom logo.

const { nativeImage } = require('electron')
const zlib = require('zlib')

// ── Minimal PNG encoder ──────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const t    = Buffer.from(type, 'ascii')
  const body = Buffer.concat([t, data])
  const len  = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crc  = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, t, data, crc])
}

// Renders the honeycomb into an RGBA PNG buffer with 3×3 supersampled AA.
function makeHoneycombPng(size) {
  const [r, g, b] = [167, 139, 250]   // KoZo purple #a78bfa
  const pixels = Buffer.alloc(size * size * 4, 0)

  // Geometry mirrors src/components/HoneycombLogo.jsx (pointy-top hexes)
  const S = 9, VIS = 7.7
  const W = S * Math.sqrt(3)
  const centers = [
    [0, 0], [-W, 0], [W, 0],
    [-W / 2, -S * 1.5], [W / 2, -S * 1.5],
    [-W / 2,  S * 1.5], [W / 2,  S * 1.5],
  ]
  const hexes = centers.map(([cx, cy]) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = -Math.PI / 2 + i * (Math.PI / 3)
      return [cx + VIS * Math.cos(a), cy + VIS * Math.sin(a)]
    })
  )

  const halfExtent = W + VIS
  const scale = (size * 0.92) / (2 * halfExtent)
  const cxp = size / 2, cyp = size / 2

  function inHex(verts, px, py) {
    let hit = false
    for (let i = 0, j = 5; i < 6; j = i++) {
      const [xi, yi] = verts[i]; const [xj, yj] = verts[j]
      if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) hit = !hit
    }
    return hit
  }

  const SS = 3
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const lx = ((x + (sx + 0.5) / SS) - cxp) / scale
          const ly = ((y + (sy + 0.5) / SS) - cyp) / scale
          if (hexes.some(h => inHex(h, lx, ly))) cover++
        }
      }
      if (cover > 0) {
        const i = (y * size + x) * 4
        pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b
        pixels[i + 3] = Math.round((cover / (SS * SS)) * 255)
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6  // 8-bit RGBA

  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// Multi-resolution nativeImage for the small tray icon.
function getTrayImage() {
  const img = nativeImage.createFromBuffer(makeHoneycombPng(32), { scaleFactor: 1.0 })
  try {
    img.addRepresentation({ scaleFactor: 2.0, buffer: makeHoneycombPng(64) })
    img.addRepresentation({ scaleFactor: 0.5, buffer: makeHoneycombPng(16) })
  } catch {}
  return img
}

// Larger nativeImage for the window / taskbar icon.
function getWindowImage() {
  const img = nativeImage.createFromBuffer(makeHoneycombPng(256), { scaleFactor: 1.0 })
  try {
    img.addRepresentation({ scaleFactor: 1.0, buffer: makeHoneycombPng(64) })
    img.addRepresentation({ scaleFactor: 1.0, buffer: makeHoneycombPng(128) })
  } catch {}
  return img
}

module.exports = { makeHoneycombPng, getTrayImage, getWindowImage }
