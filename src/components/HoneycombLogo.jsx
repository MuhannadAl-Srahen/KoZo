import React from 'react'

// Pointy-top hex grid: S = spacing radius, VIS = visual (drawn) radius
const S = 9
const VIS = 7.7
const W = S * Math.sqrt(3)  // horizontal distance between adjacent centers

const CENTERS = [
  [0, 0],               // center
  [-W, 0],              // left
  [W, 0],               // right
  [-W / 2, -S * 1.5],   // top-left
  [W / 2, -S * 1.5],    // top-right
  [-W / 2, S * 1.5],    // bottom-left
  [W / 2, S * 1.5],     // bottom-right
]

function hexPoints(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + i * (Math.PI / 3)
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`
  }).join(' ')
}

export default function HoneycombLogo({ size = 32, color = 'var(--a)', style, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-26 -23 52 46"
      xmlns="http://www.w3.org/2000/svg"
      style={style}
      className={className}
      aria-hidden="true"
    >
      {CENTERS.map(([cx, cy], i) => (
        <polygon
          key={i}
          points={hexPoints(cx, cy, VIS)}
          fill={color}
        />
      ))}
    </svg>
  )
}
