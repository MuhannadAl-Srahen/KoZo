import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconChevronLeft, IconChevronRight, IconX, IconMaximize, IconPlayerPlayFilled } from '@tabler/icons-react'
import s from './MediaGallery.module.css'

// Game media, laid out like a Steam store page: a big viewer, a scrollable
// strip of every screenshot with arrow buttons at its ends, and a full-screen
// lightbox (click the big image, ←/→ to browse, Esc to close).
// `items` = [{ thumb, full }] or a trailer { thumb, video: { hls, mp4, webm } };
// the first item is shown first. Trailers play with hls.js (Steam's new
// trailers are HLS streams), loaded only when a trailer is shown.

function VideoPlayer({ video, poster, className }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let hls = null, dead = false
    if (video.hls) {
      import('hls.js').then(({ default: Hls }) => {
        if (dead) return
        if (Hls.isSupported()) {
          hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 20 })
          hls.loadSource(video.hls)
          hls.attachMedia(el)
        } else el.src = video.mp4 || video.webm || ''
      }).catch(() => { el.src = video.mp4 || video.webm || '' })
    } else el.src = video.mp4 || video.webm || ''
    return () => { dead = true; hls?.destroy() }
  }, [video.hls, video.mp4])
  return <video ref={ref} className={className} poster={poster} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />
}

// Shows the (already cached) thumbnail the instant the picture changes, then
// fades the full-size image in once it has downloaded. Keyed by the image, so
// switching never leaves the previous picture on screen while the next loads.
function ProgressiveImg({ item, fit = 'cover', onClick, onError }) {
  const [loaded, setLoaded] = useState(false)
  const full = item.full || item.thumb
  return (
    <span className={`${s.prog} ${fit === 'contain' ? s.progContain : ''}`} onClick={onClick}>
      {item.thumb && item.thumb !== full && !loaded && <img className={s.progThumb} src={item.thumb} alt="" />}
      <img
        className={`${s.progFull} ${loaded ? s.progFullIn : ''}`}
        src={full}
        alt=""
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
    </span>
  )
}

// Warm the browser cache with the pictures either side of the current one.
function usePreloadAround(items, index) {
  useEffect(() => {
    if (items.length < 2) return
    for (const d of [1, -1, 2]) {
      const m = items[(index + d + items.length) % items.length]
      if (m?.full && !m.video) { const img = new Image(); img.decoding = 'async'; img.src = m.full }
    }
  }, [items.length, index])   // items is rebuilt every render; its length + index are what matter
}

export default function MediaGallery({ items = [], height }) {
  const list = items.filter(m => m && (m.full || m.thumb || m.video))
  const [index, setIndex] = useState(0)
  const [zoom, setZoom] = useState(false)
  const [broken, setBroken] = useState(() => new Set())
  const stripRef = useRef(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  useEffect(() => { setIndex(0) }, [list.length && list[0].full])
  usePreloadAround(list, index)

  // Which strip arrows are useful (is there more to either side?).
  function measure() {
    const el = stripRef.current
    if (!el) return
    const left = el.scrollLeft > 8
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 8
    setEdges(prev => (prev.left === left && prev.right === right ? prev : { left, right }))
  }
  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [list.length, broken.size])
  // Keep the selected thumbnail in view, like Steam does.
  useEffect(() => {
    stripRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  }, [index])
  const scrollStrip = (d) => stripRef.current?.scrollBy({ left: d * stripRef.current.clientWidth * 0.8, behavior: 'smooth' })

  const shown = list.filter(m => !broken.has(m.full || m.thumb))
  if (!shown.length) return null
  const i = Math.min(index, shown.length - 1)
  const cur = shown[i]
  const step = (d) => setIndex((i + d + shown.length) % shown.length)
  const markBroken = (m) => setBroken(prev => new Set(prev).add(m.full || m.thumb))

  return (
    <div className={s.gallery}>
      <div
        className={s.viewer}
        style={height ? { height } : undefined}
        tabIndex={0}
        onMouseEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
          if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
        }}
      >
        {cur.video
          ? <VideoPlayer key={cur.video.hls || cur.video.mp4} video={cur.video} poster={cur.thumb} className={s.video} />
          : <ProgressiveImg
              key={cur.full || cur.thumb}
              item={cur}
              onClick={() => setZoom(true)}
              onError={() => markBroken(cur)}
            />}
        {shown.length > 1 && (
          <>
            <button className={`${s.arrow} ${s.arrowLeft}`} onClick={() => step(-1)} aria-label="Previous"><IconChevronLeft size={18} /></button>
            <button className={`${s.arrow} ${s.arrowRight}`} onClick={() => step(1)} aria-label="Next"><IconChevronRight size={18} /></button>
          </>
        )}
        {!cur.video && <button className={s.expand} onClick={() => setZoom(true)} aria-label="View full screen"><IconMaximize size={14} /></button>}
        {shown.length > 1 && <span className={s.counter}>{i + 1} / {shown.length}</span>}
      </div>

      {shown.length > 1 && (
        <div className={s.stripWrap}>
          <div className={s.strip} ref={stripRef} onScroll={measure}>
            {shown.map((m, k) => (
              <button key={m.full || m.thumb} data-active={k === i ? '1' : undefined}
                className={`${s.thumb} ${k === i ? s.thumbActive : ''}`} onClick={() => setIndex(k)}>
                <img src={m.thumb || m.full} alt="" loading="lazy" onError={() => markBroken(m)} onLoad={measure} />
                {m.video && <span className={s.thumbPlay}><IconPlayerPlayFilled size={16} /></span>}
              </button>
            ))}
          </div>
          {edges.left && (
            <button className={`${s.stripArrow} ${s.stripArrowLeft}`} onClick={() => scrollStrip(-1)} aria-label="Scroll left">
              <IconChevronLeft size={16} />
            </button>
          )}
          {edges.right && (
            <button className={`${s.stripArrow} ${s.stripArrowRight}`} onClick={() => scrollStrip(1)} aria-label="Scroll right">
              <IconChevronRight size={16} />
            </button>
          )}
        </div>
      )}

      {zoom && <Lightbox items={shown} index={i} onIndex={setIndex} onClose={() => setZoom(false)} />}
    </div>
  )
}

export function Lightbox({ items, index, onIndex, onClose }) {
  const step = (d) => onIndex((index + d + items.length) % items.length)
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  const cur = items[index]
  usePreloadAround(items, index)
  return createPortal(
    <div className={s.lightbox} onClick={onClose}>
      <div className={s.lbStage}>
        {cur.video
          ? <VideoPlayer key={cur.video.hls || cur.video.mp4} video={cur.video} poster={cur.thumb} className={s.lbVideo} />
          : <ProgressiveImg key={cur.full || cur.thumb} item={cur} fit="contain" onClick={(e) => e.stopPropagation()} />}
      </div>
      {items.length > 1 && (
        <>
          <button className={`${s.lbArrow} ${s.arrowLeft}`} onClick={(e) => { e.stopPropagation(); step(-1) }} aria-label="Previous"><IconChevronLeft size={26} /></button>
          <button className={`${s.lbArrow} ${s.arrowRight}`} onClick={(e) => { e.stopPropagation(); step(1) }} aria-label="Next"><IconChevronRight size={26} /></button>
          <span className={s.lbCounter}>{index + 1} / {items.length}</span>
        </>
      )}
      <button className={s.lbClose} onClick={onClose} aria-label="Close"><IconX size={20} /></button>
    </div>,
    document.body
  )
}
