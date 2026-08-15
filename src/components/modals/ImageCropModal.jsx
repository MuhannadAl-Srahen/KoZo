import React, { useState, useRef, useEffect, useCallback } from 'react'
import { IconLoader2, IconZoomIn, IconArrowsMove } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import s from './ImageCropModal.module.css'

// Output resolution per kind — chosen for crisp results without huge files.
const OUTPUT = {
  avatar: { w: 512,  aspect: 1,        fmt: 'png'  },
  banner: { w: 1280, aspect: 1280/440, fmt: 'jpeg' },
  cover:  { w: 600,  aspect: 600/900,  fmt: 'jpeg' },
}

// Crop + zoom + pan a source image, then persist the result to userData. The
// source is a data: URL (from dialog.pickImageData) so the canvas is never
// tainted by the kozo:// origin. The visible region of the framed viewport is
// rendered to an off-screen canvas at the kind's output resolution.
export default function ImageCropModal({ src, kind = 'avatar', title, onCancel, onDone }) {
  const out = OUTPUT[kind] || OUTPUT.avatar
  const aspect = out.aspect

  // Viewport (the crop frame) — fixed width, height derived from the aspect.
  const VP_W = aspect >= 1 ? 420 : 300
  const VP_H = Math.round(VP_W / aspect)

  const [img, setImg]       = useState(null)   // HTMLImageElement
  const [zoom, setZoom]     = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })  // image top-left in viewport px
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState('')

  const baseScaleRef = useRef(1)   // scale that makes the image cover the viewport at zoom 1
  const dragRef      = useRef(null)
  const viewportRef  = useRef(null)
  const wheelRef     = useRef(null)

  // Load the source image and centre it at cover scale.
  useEffect(() => {
    let cancelled = false
    const im = new Image()
    im.onload = () => {
      if (cancelled) return
      const base = Math.max(VP_W / im.naturalWidth, VP_H / im.naturalHeight)
      baseScaleRef.current = base
      const dispW = im.naturalWidth * base
      const dispH = im.naturalHeight * base
      setImg(im)
      setZoom(1)
      setOffset({ x: (VP_W - dispW) / 2, y: (VP_H - dispH) / 2 })
    }
    im.onerror = () => { if (!cancelled) setErr('Could not load that image.') }
    im.src = src
    return () => { cancelled = true }
  }, [src])

  // Keep the image covering the viewport (no empty gaps) after any pan/zoom.
  const clamp = useCallback((off, z, im) => {
    if (!im) return off
    const dispW = im.naturalWidth * baseScaleRef.current * z
    const dispH = im.naturalHeight * baseScaleRef.current * z
    return {
      x: Math.min(0, Math.max(VP_W - dispW, off.x)),
      y: Math.min(0, Math.max(VP_H - dispH, off.y)),
    }
  }, [VP_W, VP_H])

  function onPointerDown(e) {
    if (!img) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y }
  }
  function onPointerMove(e) {
    if (!dragRef.current) return
    const d = dragRef.current
    const next = { x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }
    setOffset(clamp(next, zoom, img))
  }
  function onPointerUp() { dragRef.current = null }

  function applyZoom(nz) {
    const z = Math.max(1, Math.min(4, nz))
    if (!img) { setZoom(z); return }
    // Zoom around the viewport centre so it feels anchored.
    const base = baseScaleRef.current
    const cx = VP_W / 2, cy = VP_H / 2
    const imgX = (cx - offset.x) / (base * zoom)
    const imgY = (cy - offset.y) / (base * zoom)
    const nx = cx - imgX * base * z
    const ny = cy - imgY * base * z
    setZoom(z)
    setOffset(clamp({ x: nx, y: ny }, z, img))
  }
  function onWheel(e) {
    e.preventDefault()
    applyZoom(zoom * (e.deltaY < 0 ? 1.08 : 0.92))
  }

  // React registers delegated wheel listeners passively, so a JSX onWheel can't
  // preventDefault and the modal body scrolls while zooming. Bind natively with
  // passive:false, routed through a ref so the listener always sees the current
  // zoom/offset without re-binding every render.
  wheelRef.current = onWheel
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const h = (e) => wheelRef.current(e)
    el.addEventListener('wheel', h, { passive: false })
    return () => el.removeEventListener('wheel', h)
  }, [])

  async function save() {
    if (!img) return
    setSaving(true); setErr('')
    try {
      const base = baseScaleRef.current
      const sx = -offset.x / (base * zoom)
      const sy = -offset.y / (base * zoom)
      const sW = VP_W / (base * zoom)
      const sH = VP_H / (base * zoom)
      const outW = out.w
      const outH = Math.round(out.w / aspect)
      const canvas = document.createElement('canvas')
      canvas.width = outW; canvas.height = outH
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, sx, sy, sW, sH, 0, 0, outW, outH)
      const dataUrl = out.fmt === 'jpeg'
        ? canvas.toDataURL('image/jpeg', 0.92)
        : canvas.toDataURL('image/png')
      const res = await window.kozo?.api?.dialog?.saveCroppedImage?.({ kind, dataUrl })
      if (res?.ok && res.data?.path) onDone(res.data.path)
      else setErr(res?.error || 'Could not save the image.')
    } catch (e) {
      setErr(e.message || 'Crop failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={title || 'Adjust image'}
      icon={<IconArrowsMove size={16} stroke={1.8} />}
      onClose={onCancel}
      width={aspect >= 1 ? 520 : 400}
      footer={
        <div className={s.footer}>
          <button className={ms.btnGhost} onClick={onCancel} disabled={saving}>Cancel</button>
          <button className={ms.btnPrimary} onClick={save} disabled={!img || saving}>
            {saving ? <IconLoader2 size={14} className={s.spin} /> : null} Use image
          </button>
        </div>
      }
    >
      <div className={s.wrap}>
        <div
          ref={viewportRef}
          className={s.viewport}
          style={{ width: VP_W, height: VP_H, borderRadius: kind === 'avatar' ? '50%' : 'var(--r-card)' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {img ? (
            <img
              src={src}
              className={s.cropImg}
              draggable={false}
              style={{
                width:  img.naturalWidth  * baseScaleRef.current * zoom,
                height: img.naturalHeight * baseScaleRef.current * zoom,
                transform: `translate(${offset.x}px, ${offset.y}px)`,
              }}
              alt=""
            />
          ) : (
            <div className={s.loading}><IconLoader2 size={20} className={s.spin} /></div>
          )}
          <div className={s.grid} />
        </div>

        <div className={s.zoomRow}>
          <IconZoomIn size={15} stroke={1.7} style={{ color: 'var(--text-muted)' }} />
          <input
            type="range" min={1} max={4} step={0.01} value={zoom}
            className={s.zoomSlider}
            onChange={e => applyZoom(parseFloat(e.target.value))}
            disabled={!img}
          />
        </div>
        <div className={s.hint}>Drag to reposition · scroll or slide to zoom</div>
        {err && <div className={s.err}>{err}</div>}
      </div>
    </Modal>
  )
}
