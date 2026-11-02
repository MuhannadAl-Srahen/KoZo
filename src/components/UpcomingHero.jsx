import React, { useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronLeft, IconChevronRight, IconClock, IconSparkles, IconFlame, IconBrandSteam } from '@tabler/icons-react'
import { countdownTo } from '../lib/utils'
import { matchTone, MATCH_MIN } from '../lib/tasteMatch'
import s from './UpcomingHero.module.css'

// Top of Upcoming: the most anticipated games of the next 30 days in a big
// rotating banner, each with its trailer loop playing muted (Steam's
// "microtrailer", steamApi.trailerOf), a live countdown and your match; then
// a "This week" row of everything landing in the next 7 days, best match
// first. Rotation and video stop while KoZo is hidden or unfocused
// (html[data-inactive]) and with Animations off.

const HERO_COUNT = 6
const ROTATE_MS = 9000
const DAY = 86400000

// Ticks every `ms` so countdowns stay live.
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// True while KoZo is hidden / unfocused or animations are off.
function useQuiet() {
  const read = () => {
    const el = document.documentElement
    return el.hasAttribute('data-inactive') || el.dataset.motion === 'off'
  }
  const [quiet, setQuiet] = useState(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setQuiet(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-inactive', 'data-motion'] })
    return () => mo.disconnect()
  }, [])
  return quiet
}

const trailerCache = new Map()   // appid → trailer | null
function useTrailer(appid) {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!appid || trailerCache.has(appid)) return
    trailerCache.set(appid, null)
    window.kozo?.api?.steam?.storeDetails?.(appid).then(r => {
      trailerCache.set(appid, r?.ok ? r.data?.trailer || null : null)
      bump(n => n + 1)
    }).catch(() => {})
  }, [appid])
  return appid ? trailerCache.get(appid) || null : null
}

function wideArt(g) {
  return g.art?.hero || g.art?.header || g.art?.capsule || g.capsule || null
}

function Slide({ g, active, quiet, now, isTracked, onOpen, renderTrack }) {
  const trailer = useTrailer(active ? g.appid : null)
  const videoRef = useRef(null)
  const [videoOk, setVideoOk] = useState(true)
  useEffect(() => { setVideoOk(true) }, [g.appid])
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (quiet || !active) v.pause()
    else v.play().catch(() => {})
  }, [quiet, active, trailer])
  const when = new Date(g.rel.ts)
  const cd = countdownTo(g.rel, now)
  return (
    <div className={`${s.slide} ${active ? s.slideOn : ''}`} aria-hidden={!active}>
      {wideArt(g) && <img className={s.art} src={wideArt(g)} alt="" />}
      {active && trailer && videoOk && (
        <video
          ref={videoRef}
          key={g.appid}
          className={s.video}
          muted
          loop
          playsInline
          autoPlay={!quiet}
          preload="auto"
          onError={() => setVideoOk(false)}
        >
          {trailer.webm && <source src={trailer.webm} type="video/webm" />}
          {trailer.mp4 && <source src={trailer.mp4} type="video/mp4" />}
        </video>
      )}
      <div className={s.shade} />
      <div className={s.info}>
        <div className={s.kicker}>
          <IconFlame size={14} /> Most anticipated
          {g.match >= MATCH_MIN && (
            <span className={`${s.match} ${s['match_' + matchTone(g.match)]}`}><IconSparkles size={12} /> {g.match}% match</span>
          )}
        </div>
        <h2 className={s.name}>{g.name}</h2>
        {g.reason && <div className={s.reason}>Like {g.reason.name}{g.reason.shared.length ? `: ${g.reason.shared.join(', ')}` : ''}</div>}
        <div className={s.when}>
          <span className={s.date}>{when.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
          {cd && <span className={s.countdown}><IconClock size={14} /> {cd}</span>}
        </div>
        <div className={s.actions}>
          <button type="button" className={s.primary} onClick={() => onOpen(g)} tabIndex={active ? 0 : -1}>Details</button>
          <span className={s.track}>{renderTrack(g, false)}</span>
          <button type="button" className={s.ghost} tabIndex={active ? 0 : -1}
            onClick={() => window.kozo?.api?.shell?.openExternal?.(`https://store.steampowered.com/app/${g.appid}`)}>
            <IconBrandSteam size={14} /> Store page
          </button>
          {isTracked(g) && <span className={s.trackedTag}>Tracked</span>}
        </div>
      </div>
    </div>
  )
}

export default function UpcomingHero({ games, isTracked, onOpen, renderTrack }) {
  const now = useNow(30000)
  const quiet = useQuiet()
  const [i, setI] = useState(0)
  const [hold, setHold] = useState(false)   // hovered or focused: no rotation

  const { featured, week } = useMemo(() => {
    const t = Date.now()
    const dated = games.filter(g => g.rel?.precision === 'day' && g.rel.ts != null && g.rel.ts >= t - DAY)
    const pop = (g) => Math.min(g.wishRank ?? 1e4, g.popRank ?? 1e4 + 500)
    const featured = dated
      .filter(g => g.rel.ts <= t + 30 * DAY && (g.art?.hero || g.art?.header))
      .sort((a, b) => pop(a) - pop(b) || b.match - a.match)
      .slice(0, HERO_COUNT)
    const week = dated
      .filter(g => g.rel.ts <= t + 7 * DAY)
      .sort((a, b) => b.match - a.match || pop(a) - pop(b))
      .slice(0, 14)
    return { featured, week }
  }, [games])

  useEffect(() => { if (i >= featured.length) setI(0) }, [featured.length])
  useEffect(() => {
    if (quiet || hold || featured.length < 2) return
    const t = setTimeout(() => setI(n => (n + 1) % featured.length), ROTATE_MS)
    return () => clearTimeout(t)
  }, [i, quiet, hold, featured.length])

  if (!featured.length && !week.length) return null
  const go = (d) => setI(n => (n + d + featured.length) % featured.length)

  return (
    <div className={s.wrap} data-zoom-ignore="">
      {featured.length > 0 && (
        <section
          className={s.hero}
          onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)}
          onFocus={() => setHold(true)} onBlur={() => setHold(false)}
          aria-roledescription="carousel" aria-label="Most anticipated releases"
        >
          {featured.map((g, n) => (
            <Slide key={g.appid} g={g} active={n === i} quiet={quiet} now={now}
              isTracked={isTracked} onOpen={onOpen} renderTrack={renderTrack} />
          ))}
          {featured.length > 1 && (
            <>
              <button type="button" className={`${s.arrow} ${s.arrowL}`} onClick={() => go(-1)} aria-label="Previous"><IconChevronLeft size={20} /></button>
              <button type="button" className={`${s.arrow} ${s.arrowR}`} onClick={() => go(1)} aria-label="Next"><IconChevronRight size={20} /></button>
              <div className={s.thumbs}>
                {featured.map((g, n) => (
                  <button key={g.appid} type="button" className={`${s.thumb} ${n === i ? s.thumbOn : ''}`} onClick={() => setI(n)} title={g.name}>
                    {g.art?.capsule || g.art?.header ? <img src={g.art.capsule || g.art.header} alt="" loading="lazy" /> : null}
                    {n === i && !quiet && !hold && <span className={s.thumbBar} key={`${i}`} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {week.length > 0 && (
        <section className={s.week}>
          <div className={s.weekHead}>
            <span className={s.weekTitle}>This week</span>
            <span className={s.weekSub}>Landing in the next 7 days, best match first</span>
          </div>
          <div className={s.weekRow}>
            {week.map(g => (
              <button key={g.appid} type="button" className={s.weekCard} onClick={() => onOpen(g)} title={g.name}>
                <span className={s.weekArt}>
                  {(g.art?.capsule || g.art?.header || g.capsule) && <img src={g.art?.capsule || g.art?.header || g.capsule} alt="" loading="lazy" />}
                  <span className={s.weekCount}><IconClock size={11} /> {countdownTo(g.rel, now)}</span>
                  {g.match >= MATCH_MIN && <span className={`${s.weekMatch} ${s['match_' + matchTone(g.match)]}`}>{g.match}%</span>}
                </span>
                <span className={s.weekName}>{g.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
