import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconEdit, IconCheck, IconX, IconClock, IconDeviceGamepad2,
  IconTrophy, IconHistory, IconFlame, IconCalendar, IconPhoto, IconStar,
  IconLoader2, IconPalette, IconTrash, IconCircleCheckFilled, IconChevronRight,
  IconUser,
} from '@tabler/icons-react'
import { fileUrl, formatPlaytime, getBannerBg } from '../lib/utils'
import { useAccentColor } from '../context/AccentColorContext'
import ImageCropModal from '../components/modals/ImageCropModal'
import Modal from '../components/ui/Modal'
import EmptyState from '../components/ui/EmptyState'
import { Skeleton } from '../components/ui/Skeleton'
import s from './Profile.module.css'


// Banner gradient themes — pick a vibe without uploading an image.
const BANNER_STYLES = {
  accent: 'radial-gradient(120% 120% at 15% 0%, var(--ad), transparent 60%), linear-gradient(135deg, var(--surface-2), var(--bg))',
  sunset: 'linear-gradient(135deg, #f97316, #db2777 65%, #1a0f1e)',
  ocean: 'linear-gradient(135deg, #0ea5e9, #2dd4bf 65%, #0a1422)',
  aurora: 'linear-gradient(135deg, #22c55e, #a855f7 65%, #0b0b18)',
  ember: 'linear-gradient(135deg, #ef4444, #f59e0b 65%, #190f0a)',
  grape: 'linear-gradient(135deg, #7c3aed, #ec4899 65%, #140b1e)',
  forest: 'linear-gradient(135deg, #166534, #84cc16 65%, #0a0f0a)',
  mono: 'linear-gradient(135deg, #2b2b3a, #0c0c14)',
}
const BANNER_ORDER = ['accent', 'sunset', 'ocean', 'aurora', 'ember', 'grape', 'forest', 'mono']

const TITLES = ['', 'Completionist', 'Achievement Hunter', 'Collector', 'Explorer',
  'Night Owl', 'Speedrunner', 'Backlog Slayer', 'Veteran', 'Casual Gamer']

const MAX_SHOWCASE = 4

// Icon tints. Every one is a token so the palette can never drift from
// variables.css (and so the accent-driven ones follow the user's accent).
const TINT_PLAY  = 'var(--a)'
const TINT_GAMES = 'var(--green)'
const TINT_ACH   = 'var(--amber)'
const TINT_SESS  = 'var(--blue)'
const TINT_FIRE  = 'var(--orange)'

// A token colour can't be string-concatenated into an alpha hex, so the soft
// fill/border are mixed at paint time instead.
function tint(color, pct) {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`
}

function initials(name) {
  const p = (name || '').trim().split(/\s+/).filter(Boolean)
  if (!p.length) return 'P'
  return (p[0][0] + (p[1]?.[0] || '')).toUpperCase()
}
function memberSince(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
function parseIds(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
}

// Collapse repeated same-game session entries from the same calendar day into
// one "N sessions" row so the feed isn't spammed by short play bursts.
// Achievement/finished entries pass through untouched; newest-first preserved.
function mergeXpHistory(entries) {
  const merged = []
  const sessionKey = new Map()   // "label|YYYY-M-D" -> merged entry
  for (const e of entries) {
    if (e.type !== 'session') { merged.push(e); continue }
    const d = new Date(e.ts)
    const key = `${e.label}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    const hit = sessionKey.get(key)
    if (hit) {
      hit.xp += e.xp
      hit.count += 1
      hit.totalSeconds += e.detail || 0
    } else {
      const entry = { ...e, count: 1, totalSeconds: e.detail || 0 }
      sessionKey.set(key, entry)
      merged.push(entry)
    }
  }
  return merged
}

// Cover <img> onError: if the local file is missing (e.g. right after a backup
// restore), retry once with the remote banner_url before hiding the image.
function coverError(e, remote) {
  const img = e.target
  if (remote && img.src !== remote && !img.dataset.fallbackTried) {
    img.dataset.fallbackTried = '1'
    img.src = remote
    return
  }
  img.style.display = 'none'
}

// Compact "when" for XP history rows: "2m ago", "3h ago", "Yesterday", "Jun 12".
function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diffMin = Math.floor((Date.now() - then) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD === 1) return 'Yesterday'
  if (diffD < 7) return `${diffD}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const XP_EVENT_META = {
  session: { Icon: IconClock, color: TINT_PLAY, verb: 'Played' },
  achievement: { Icon: IconTrophy, color: TINT_ACH, verb: 'Unlocked' },
  finished: { Icon: IconCircleCheckFilled, color: TINT_GAMES, verb: 'Finished' },
}

// One compact Recent-XP entry card — shared by the profile grid and the
// full-history modal so they always look identical.
function XpEntryCard({ entry }) {
  const meta = XP_EVENT_META[entry.type] || XP_EVENT_META.session
  const sub = [timeAgo(entry.ts)]
  if (entry.type === 'session') {
    if (entry.count > 1) sub.push(`${entry.count} sessions`)
    if (entry.totalSeconds) sub.push(formatPlaytime(entry.totalSeconds))
  }
  const title = `${meta.verb} ${entry.label}`
  const subText = sub.join(' · ')
  return (
    <div className={s.xpEntry}>
      <meta.Icon size={15} stroke={1.8} style={{ color: meta.color, flexShrink: 0 }} />
      <div className={s.xpEntryInfo}>
        <div className={s.xpEntryTitle} title={title}>{title}</div>
        <div className={s.xpEntrySub} title={subText}>{subText}</div>
      </div>
      <span className={s.xpEntryXp}>+{entry.xp}</span>
    </div>
  )
}

// Fixed-height stand-in for the XP hero. It composes the real card's class, so
// the page is exactly as tall before XP resolves as after — the old code moved
// everything below it by 44px the moment the number arrived.
function XpCardGhost() {
  return (
    <div className={s.xpCardGhost} aria-hidden="true">
      <div className={s.xpHero}>
        <Skeleton w={120} h={120} r="50%" />
        <div className={s.xpGhostInfo}>
          <Skeleton w={150} h={20} />
          <Skeleton w={110} h={12} />
          <Skeleton w="100%" h={9} r="var(--r-sm)" />
        </div>
      </div>
      <div className={s.xpBreakdown}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} h={52} r="var(--r-input)" />
        ))}
      </div>
    </div>
  )
}

// Module-level cache of the last loaded profile so navigating back to /profile
// renders instantly from memory and refreshes in the background — instead of
// flashing the full-page loading spinner on every visit.
let profileCache = null

export default function Profile() {
  const navigate = useNavigate()
  const { accent, setAccent, presets } = useAccentColor()

  const [loading, setLoading] = useState(!profileCache)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState(profileCache?.name ?? 'Player')
  const [tagline, setTagline] = useState(profileCache?.tagline ?? '')
  const [title, setTitle] = useState(profileCache?.title ?? '')
  const [avatar, setAvatar] = useState(profileCache?.avatar ?? '')
  const [banner, setBanner] = useState(profileCache?.banner ?? '')
  const [bannerStyle, setBannerStyle] = useState(profileCache?.bannerStyle ?? 'accent')
  const [showcase, setShowcase] = useState(profileCache?.showcase ?? [])     // array of game-id strings
  const [createdAt, setCreatedAt] = useState(profileCache?.createdAt ?? '')
  const [draft, setDraft] = useState(null)

  const [stats, setStats] = useState(profileCache?.stats ?? null)
  const [games, setGames] = useState(profileCache?.games ?? [])
  const [imgBust, setImgBust] = useState(0)
  const [crop, setCrop] = useState(null)   // { src, kind, setter }
  const [xp, setXp] = useState(profileCache?.xp ?? null)
  const [xpHistory, setXpHistory] = useState(profileCache?.xpHistory ?? [])
  const [xpModalOpen, setXpModalOpen] = useState(false)

  const load = useCallback(async () => {
    if (!window.kozo?.api) return
    const [allRes, statsRes, gamesRes, xpRes, xpHistRes] = await Promise.all([
      window.kozo.api.settings.getAll(),
      window.kozo.api.stats.get('all'),
      window.kozo.api.games.list(),
      window.kozo.api.stats.xp(),
      window.kozo.api.stats.xpHistory?.(30),
    ])
    const d = allRes?.ok ? allRes.data : {}
    setName(d.profile_name || 'Player')
    setTagline(d.profile_tagline || '')
    setTitle(d.profile_title || '')
    setAvatar(d.profile_avatar_path || '')
    setBanner(d.profile_banner_path || '')
    setBannerStyle(d.profile_banner_style || 'accent')
    // Migrate the old single-favorite key into the showcase list.
    let ids = parseIds(d.profile_showcase_ids)
    if (!ids.length && d.profile_favorite_game_id) ids = [String(d.profile_favorite_game_id)]
    let created = d.profile_created_at
    if (!created) { created = new Date().toISOString(); await window.kozo.api.settings.set('profile_created_at', created) }
    setCreatedAt(created)
    const st = statsRes?.ok ? statsRes.data : (profileCache?.stats ?? null)
    const gm = gamesRes?.ok ? (gamesRes.data || []) : (profileCache?.games ?? [])
    // Drop stale ids of deleted games — ghosts silently ate showcase slots
    // (the cap counted them, so a visible 3/4 refused a fourth pick).
    ids = ids.filter(sid => gm.some(g => String(g.id) === sid))
    setShowcase(ids)
    const xpv = xpRes?.ok ? xpRes.data : (profileCache?.xp ?? null)
    const xph = xpHistRes?.ok ? (xpHistRes.data || []) : (profileCache?.xpHistory ?? [])
    setStats(st); setGames(gm); setXp(xpv); setXpHistory(xph)
    profileCache = {
      name: d.profile_name || 'Player', tagline: d.profile_tagline || '', title: d.profile_title || '',
      avatar: d.profile_avatar_path || '', banner: d.profile_banner_path || '',
      bannerStyle: d.profile_banner_style || 'accent', showcase: ids, createdAt: created,
      stats: st, games: gm, xp: xpv, xpHistory: xph,
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Live-refresh the XP/stats portions when gameplay data changes (an achievement
  // unlocks, a session ends, a game is marked finished) so the level ring, streak
  // and pillar XP stay real-time instead of only updating on a page revisit. Only
  // the stats are re-pulled (not the editable profile fields), and never mid-edit.
  const refreshStats = useCallback(async () => {
    if (!window.kozo?.api || editing) return
    const [statsRes, gamesRes, xpRes, xpHistRes] = await Promise.all([
      window.kozo.api.stats.get('all'),
      window.kozo.api.games.list(),
      window.kozo.api.stats.xp(),
      window.kozo.api.stats.xpHistory?.(30),
    ])
    if (statsRes?.ok) { setStats(statsRes.data); if (profileCache) profileCache.stats = statsRes.data }
    if (gamesRes?.ok) { setGames(gamesRes.data || []); if (profileCache) profileCache.games = gamesRes.data || [] }
    if (xpRes?.ok) { setXp(xpRes.data); if (profileCache) profileCache.xp = xpRes.data }
    if (xpHistRes?.ok) { setXpHistory(xpHistRes.data || []); if (profileCache) profileCache.xpHistory = xpHistRes.data || [] }
  }, [editing])

  useEffect(() => {
    if (!window.kozo?.events) return
    // Unsubscribe THIS page's own listeners only — removeAll() is window-wide
    // and would tear down the always-mounted Sidebar's listeners too.
    const offs = [
      window.kozo.events.onGameUpdated(refreshStats),
      window.kozo.events.onAchievementUnlocked?.(refreshStats),
      window.kozo.events.onSessionEnded(refreshStats),
    ]
    return () => { for (const off of offs) off?.() }
  }, [refreshStats])

  function startEdit() {
    setDraft({ name, tagline, title, avatar, banner, bannerStyle, showcase: [...showcase] })
    setEditing(true)
  }
  function cancelEdit() {
    if (draft) {
      setName(draft.name); setTagline(draft.tagline); setTitle(draft.title)
      setAvatar(draft.avatar); setBanner(draft.banner); setBannerStyle(draft.bannerStyle)
      setShowcase(draft.showcase)
    }
    setDraft(null); setEditing(false)
  }
  async function saveEdit() {
    if (saving) return
    setSaving(true)
    const api = window.kozo.api.settings
    await Promise.all([
      api.set('profile_name', name.trim() || 'Player'),
      api.set('profile_tagline', tagline.trim()),
      api.set('profile_title', title),
      api.set('profile_avatar_path', avatar || ''),
      api.set('profile_banner_path', banner || ''),
      api.set('profile_banner_style', bannerStyle || 'accent'),
      api.set('profile_showcase_ids', JSON.stringify(showcase)),
    ])
    setSaving(false); setEditing(false); setDraft(null); setImgBust(Date.now())
    // The Sidebar profile chip listens for this — never drop it.
    window.dispatchEvent(new Event('kozo:profile-updated'))
  }

  // Pick → crop → save. Opens the native file dialog (returns raw bytes as a
  // data: URL so the crop canvas isn't tainted), then shows the crop modal.
  async function chooseImage(kind, setter) {
    const res = await window.kozo?.api?.dialog?.pickImageData?.()
    if (res?.ok && res.data?.dataUrl) setCrop({ src: res.data.dataUrl, kind, setter })
  }

  function toggleShowcase(id) {
    const sid = String(id)
    setShowcase(prev => {
      if (prev.includes(sid)) return prev.filter(x => x !== sid)
      if (prev.length >= MAX_SHOWCASE) return prev   // cap reached
      return [...prev, sid]
    })
  }

  // First load: the real skeleton, toolbar included — this page used to render a
  // bare centred spinner with no toolbar at all.
  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.toolbar}>
          <div className={s.toolbarIdentity}>
            {avatar
              ? <img className={s.toolbarAvatar} src={fileUrl(avatar)} alt="" />
              : <span className={`${s.toolbarAvatar} ${s.toolbarAvatarEmpty}`}><IconUser size={12} stroke={1.8} /></span>}
            <span className={s.toolbarName}>{name}</span>
          </div>
        </div>
        <div className={s.scroll}>
          <div className={s.scrollInner}>
            <div className={s.hero}>
              <div className={s.heroGradient} style={{ background: BANNER_STYLES.accent }} />
              <div className={s.heroShade} />
            </div>
            <div className={s.body}>
              <XpCardGhost />
              <div className={s.statGrid}>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className={s.statCard}>
                    <Skeleton w={38} h={38} r="var(--r-input)" />
                    <div className={s.statBody}>
                      <Skeleton w={70} h={16} />
                      <Skeleton w={95} h={11} style={{ marginTop: 6 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const playSec = stats?.playtime?.seconds ?? 0
  const sessions = stats?.sessionCount?.count ?? 0
  const unlocked = stats?.achievementCounts?.unlocked ?? 0
  const longest = stats?.longestSessions?.[0]?.duration_seconds ?? 0
  const mostPlayed = stats?.topGames?.[0]?.name || '—'

  const avatarSrc = avatar ? fileUrl(avatar, imgBust || undefined) : null
  const showcaseGames = showcase.map(id => games.find(g => String(g.id) === id)).filter(Boolean)

  const STAT_CARDS = [
    { Icon: IconClock, label: 'Total playtime', value: formatPlaytime(playSec) || '—', color: TINT_PLAY },
    { Icon: IconDeviceGamepad2, label: 'Games', value: games.length, color: TINT_GAMES },
    { Icon: IconTrophy, label: 'Achievements', value: unlocked, color: TINT_ACH },
    { Icon: IconHistory, label: 'Sessions', value: sessions, color: TINT_SESS },
    { Icon: IconFlame, label: 'Longest session', value: longest ? formatPlaytime(longest) : '—', color: TINT_FIRE },
    { Icon: IconStar, label: 'Most played', value: mostPlayed, color: TINT_PLAY },
  ]

  const heroBg = banner ? undefined : (BANNER_STYLES[bannerStyle] || BANNER_STYLES.accent)
  const bannerSrc = banner ? fileUrl(banner, imgBust || undefined) : null
  // No uploaded banner → use the first showcase game's art as a blurred backdrop
  // behind the gradient, so the hero feels personal out of the box.
  const showcaseArt = !banner && showcaseGames[0]
    ? (showcaseGames[0].hero_local_path
      ? fileUrl(showcaseGames[0].hero_local_path, imgBust || undefined)
      : (showcaseGames[0].banner_local_path
        ? fileUrl(showcaseGames[0].banner_local_path, imgBust || undefined)
        : showcaseGames[0].banner_url))
    : null

  // Top genres — aggregate library genres weighted by playtime.
  const genreSeconds = {}
  for (const g of games) {
    let gs = []
    try { gs = JSON.parse(g.genres || '[]') } catch { }
    for (const name of gs) {
      genreSeconds[name] = (genreSeconds[name] || 0) + (g.total_playtime_seconds || 0) + 1
    }
  }
  const topGenres = Object.entries(genreSeconds)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)

  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        {/* Identity cluster instead of a bare "Profile" label (user request):
            avatar, name, level — the toolbar mirrors who the page is about. */}
        <div className={s.toolbarIdentity}>
          {avatarSrc
            ? <img className={s.toolbarAvatar} src={avatarSrc} alt="" />
            : <span className={`${s.toolbarAvatar} ${s.toolbarAvatarEmpty}`}><IconUser size={12} stroke={1.8} /></span>}
          <span className={s.toolbarName}>{name}</span>
          {xp && <span className={s.toolbarLvl}>LVL {xp.level}</span>}
        </div>
        <div className={s.toolbarSpacer} />
        {!editing
          ? <button className={s.editBtn} onClick={startEdit}>
            <IconEdit size={14} stroke={1.8} /> Edit profile
          </button>
          : <>
            <button className={s.cancelBtn} onClick={cancelEdit}>
              <IconX size={14} stroke={2} /> Cancel
            </button>
            <button
              className={`${s.saveBtn} ${saving ? s.saveBtnBusy : ''}`}
              onClick={saveEdit}
              aria-busy={saving || undefined}
            >
              {saving
                ? <IconLoader2 size={14} stroke={1.8} className="spin" />
                : <IconCheck size={14} stroke={2.2} />} Save
            </button>
          </>}
      </div>

      <div className={s.scroll}>
        <div className={s.scrollInner}>
          {/* Hero — full-bleed, so it keeps no gutter of its own */}
          <div className={s.hero}>
            {bannerSrc
              ? <>
                <img src={bannerSrc} className={s.heroBlur} alt="" aria-hidden="true" decoding="async" onError={e => { e.target.style.display = 'none' }} />
                <img src={bannerSrc} className={s.heroImg} alt="" decoding="async" onError={e => { e.target.style.display = 'none' }} />
              </>
              : <>
                {showcaseArt && (
                  <img
                    src={showcaseArt}
                    className={s.heroBlur}
                    alt=""
                    aria-hidden="true"
                    decoding="async"
                    onError={e => {
                      // Local hero/banner file missing (e.g. post-restore) —
                      // fall back to the remote cover once, then give up.
                      const img = e.target
                      const remote = showcaseGames[0]?.banner_url
                      if (remote && img.src !== remote && !img.dataset.fallbackTried) {
                        img.dataset.fallbackTried = '1'
                        img.src = remote
                        return
                      }
                      img.style.display = 'none'
                    }}
                  />
                )}
                <div className={`${s.heroGradient} ${showcaseArt ? s.heroGradientOverArt : ''}`} style={{ background: heroBg }} />
              </>}
            <div className={s.heroShade} />

            {/* Banner art controls stay on the hero: they only exist in edit
                mode and they act on the artwork directly underneath them. */}
            {editing && (
              <div className={s.bannerControls}>
                <button className={s.bannerBtn} onClick={() => chooseImage('banner', setBanner)}>
                  <IconPhoto size={13} stroke={1.8} /> Upload image
                </button>
                {banner && (
                  <button className={s.bannerBtn} onClick={() => setBanner('')}>
                    <IconTrash size={13} stroke={1.8} /> Remove
                  </button>
                )}
                {!banner && (
                  <div className={s.bannerStyles}>
                    {BANNER_ORDER.map(k => (
                      <button key={k} type="button" title={k}
                        aria-label={`${k} banner style`}
                        aria-pressed={bannerStyle === k}
                        className={`${s.bannerSwatch} ${bannerStyle === k ? s.bannerSwatchOn : ''}`}
                        style={{ background: BANNER_STYLES[k] }}
                        onClick={() => setBannerStyle(k)} />
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className={s.heroBottom}>
              <div className={s.avatarWrap}>
                <div className={s.avatar} style={{ background: avatarSrc ? 'transparent' : 'linear-gradient(135deg, var(--a), var(--ab))' }}>
                  {avatarSrc
                    ? <img src={avatarSrc} alt="" decoding="async" onError={e => { e.target.style.display = 'none' }} />
                    : <span className={s.avatarInitials}>{initials(name)}</span>}
                </div>
                {editing && (
                  <button className={s.avatarPick} title="Change avatar" aria-label="Change avatar" onClick={() => chooseImage('avatar', setAvatar)}>
                    <IconPhoto size={13} stroke={1.9} />
                  </button>
                )}
                {editing && avatar && (
                  <button className={s.avatarClear} title="Remove avatar" aria-label="Remove avatar" onClick={() => setAvatar('')}>
                    <IconX size={11} stroke={2.4} />
                  </button>
                )}
              </div>

              <div className={s.identity}>
                <div className={s.nameRow}>
                  {editing
                    ? <input className={s.nameInput} value={name} maxLength={32} onChange={e => setName(e.target.value)} placeholder="Your name" aria-label="Profile name" />
                    : <div className={s.name} title={name}>{name}</div>}
                  {!editing && title && <span className={s.titlePill}>{title}</span>}
                  {!editing && xp && <span className={s.levelPill}>LVL {xp.level}</span>}
                </div>
                {editing
                  ? <input className={s.taglineInput} value={tagline} maxLength={80} onChange={e => setTagline(e.target.value)} placeholder="Add a tagline…" aria-label="Profile tagline" />
                  : (tagline ? <div className={s.tagline}>{tagline}</div> : <div className={s.taglineMuted}>No tagline yet</div>)}
              </div>

            </div>
          </div>

          {/* One gutter for everything below the hero */}
          <div className={s.body}>
            {/* Title picker (edit only) */}
            {editing && (
              <div className={s.titlePicker}>
                <span className={s.titlePickerLabel}>Title</span>
                <div className={s.titleOptions}>
                  {TITLES.map(t => (
                    <button key={t || 'none'} type="button"
                      aria-pressed={title === t}
                      className={`${s.titleOpt} ${title === t ? s.titleOptOn : ''}`}
                      onClick={() => setTitle(t)}>
                      {t || 'None'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* XP / Level — motivational hero (the single progression system; the old
                playtime "rank ladder" bar was removed — it duplicated this). While XP
                is still loading the ghost holds the exact same height. */}
            {!xp ? <XpCardGhost /> : (() => {
              const R = 52, C = 2 * Math.PI * R
              const dash = C * Math.min(1, (xp.progress || 0) / 100)
              return (
                <div className={s.xpCard}>
                  <div className={s.xpHero}>
                    {/* Circular level ring */}
                    <div className={s.xpRing}>
                      <svg width="120" height="120" viewBox="0 0 120 120">
                        {/* Progress stroke gradient: accent → brightened accent.
                            stop-color lives in the CSS module so both stops
                            re-derive from var(--a) when the accent changes. */}
                        <defs>
                          <linearGradient id="xpRingGrad" x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0%" className={s.xpGradStart} />
                            <stop offset="100%" className={s.xpGradEnd} />
                          </linearGradient>
                        </defs>
                        <circle cx="60" cy="60" r={R} className={s.xpRingTrack} />
                        <circle cx="60" cy="60" r={R} className={s.xpRingFill}
                          strokeDasharray={`${dash} ${C}`} strokeLinecap="round"
                          transform="rotate(-90 60 60)" />
                      </svg>
                      <div className={s.xpRingInner}>
                        <span className={s.xpRingLvl}>{xp.level}</span>
                        <span className={s.xpRingWord}>LEVEL</span>
                      </div>
                    </div>

                    <div className={s.xpHeroInfo}>
                      <div className={s.xpTier}>{xp.tier}</div>
                      <div className={s.xpTotal}>{xp.totalXp.toLocaleString()} XP earned</div>
                      {/* Next-reward hook */}
                      <div className={s.xpHook}>
                        <strong>{(xp.toNextLevel ?? 0).toLocaleString()} XP</strong> to Level {xp.level + 1}
                        {xp.nextTier && (
                          <span className={s.xpHookTier}>
                            <IconChevronRight size={12} stroke={2} />
                            {xp.nextTier.level - xp.level} {xp.nextTier.level - xp.level === 1 ? 'level' : 'levels'} to {xp.nextTier.name}
                          </span>
                        )}
                      </div>
                      <div className={s.xpBarTrack}><div className={s.xpBarFill} style={{ width: `${xp.progress}%` }} /></div>
                    </div>

                    <div className={s.xpStreaks}>
                      <div className={s.xpStreak} title="Days played in a row right now">
                        <IconFlame size={16} stroke={1.8} style={{ color: xp.currentStreak > 0 ? TINT_FIRE : 'var(--text-muted)' }} />
                        <span><strong>{xp.currentStreak}</strong>d</span>
                      </div>
                      <div className={s.xpStreakSub}>streak</div>
                      <div className={s.xpStreakSub}>best {xp.longestStreak}d</div>
                    </div>
                  </div>

                  <div className={s.xpBreakdown}>
                    {[
                      { Icon: IconClock, label: 'Playtime', value: xp.breakdown.playtime, color: TINT_PLAY, sub: `${xp.playDays} days played` },
                      { Icon: IconTrophy, label: 'Achievements', value: xp.breakdown.achievements, color: TINT_ACH, sub: `${xp.unlockCount} unlocked` },
                      { Icon: IconCircleCheckFilled, label: 'Finished', value: xp.breakdown.finished, color: TINT_GAMES, sub: `${xp.finishedCount} game${xp.finishedCount === 1 ? '' : 's'}` },
                      { Icon: IconFlame, label: 'Streaks', value: xp.breakdown.streak, color: TINT_FIRE, sub: `best ${xp.longestStreak}d` },
                    ].map(b => (
                      <div key={b.label} className={s.xpSource}>
                        <b.Icon size={15} stroke={1.7} style={{ color: b.color }} />
                        <span className={s.xpSourceVal}>+{b.value.toLocaleString()}</span>
                        <span className={s.xpSourceLabel} title={b.label}>{b.label}</span>
                        <span className={s.xpSourceSub} title={b.sub}>{b.sub}</span>
                      </div>
                    ))}
                  </div>

                  {/* Recent XP — same-day sessions merged per game, newest 6 in a
                      compact grid; "Show all" opens a modal so the page never grows. */}
                  {xpHistory.length > 0 && (() => {
                    const entries = mergeXpHistory(xpHistory)
                    return (
                      <div className={s.xpHistory}>
                        <div className={s.xpHistoryTitle}>Recent XP</div>
                        <div className={s.xpHistoryGrid}>
                          {entries.slice(0, 6).map((e, i) => (
                            <XpEntryCard key={`${e.type}-${e.ts}-${i}`} entry={e} />
                          ))}
                        </div>
                        {entries.length > 6 && (
                          <button className={s.xpShowAll} onClick={() => setXpModalOpen(true)}>
                            Show all ({entries.length})
                          </button>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )
            })()}

            {/* Stat grid */}
            <div className={s.statGrid}>
              {STAT_CARDS.map(({ Icon, label, value, color }) => (
                <div key={label} className={s.statCard}>
                  <div className={s.statIcon} style={{ color, background: tint(color, 12), borderColor: tint(color, 24) }}>
                    <Icon size={17} stroke={1.6} />
                  </div>
                  <div className={s.statBody}>
                    <div className={s.statValue} title={String(value)}>{value}</div>
                    <div className={s.statLabel}>{label}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className={s.memberRow}>
              <IconCalendar size={13} stroke={1.7} /> Member since {memberSince(createdAt)}
            </div>

            {/* Top genres — what you actually play, weighted by playtime */}
            {topGenres.length > 0 && (
              <div className={s.section}>
                <div className={s.sectionTitle}>Top Genres</div>
                <div className={s.genreRow}>
                  {topGenres.map(([gName, sec], i) => (
                    <span key={gName} className={`${s.genreTag} ${i === 0 ? s.genreTagTop : ''}`}>
                      {gName}
                      <span className={s.genreTagTime}>{formatPlaytime(sec) || '—'}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Showcase shelf */}
            <div className={s.section}>
              <div className={s.sectionTitle}>
                Showcase
                {editing && <span className={s.sectionHint}> — pick up to {MAX_SHOWCASE} ({showcase.length}/{MAX_SHOWCASE})</span>}
              </div>

              {!editing && (
                showcaseGames.length
                  ? <div className={s.shelf}>
                    {showcaseGames.map((g, i) => {
                      const src = g.banner_local_path ? fileUrl(g.banner_local_path, imgBust || undefined) : g.banner_url
                      return (
                        <div key={g.id} className={s.shelfCard} onClick={() => navigate(`/game/${g.id}`)} title={g.name}>
                          <div className={s.shelfBanner} style={{ background: getBannerBg(g.id) }}>
                            {src
                              ? <>
                                <img src={src} className={s.shelfBlur} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={e => coverError(e, g.banner_url)} />
                                <img src={src} className={s.shelfImg} alt="" loading="lazy" decoding="async" onError={e => coverError(e, g.banner_url)} />
                              </>
                              : <IconDeviceGamepad2 size={24} stroke={1.1} style={{ color: 'var(--on-art-muted)' }} />}
                            {i === 0 && <div className={s.favTag}><IconStar size={10} stroke={2} /> Favorite</div>}
                          </div>
                          <div className={s.shelfName} title={g.name}>{g.name}</div>
                          <div className={s.shelfMeta}>{formatPlaytime(g.total_playtime_seconds) || '—'}</div>
                        </div>
                      )
                    })}
                  </div>
                  : <EmptyState
                    size="sm"
                    Icon={IconStar}
                    title="No games pinned yet"
                    desc={`Pin up to ${MAX_SHOWCASE} favorites and they'll headline your profile.`}
                    action={{ label: 'Edit profile', onClick: startEdit, Icon: IconEdit }}
                  />
              )}

              {editing && (
                games.length
                  ? <div className={s.picker}>
                    {games.map(g => {
                      const sid = String(g.id)
                      const idx = showcase.indexOf(sid)
                      const on = idx !== -1
                      const src = g.banner_local_path ? fileUrl(g.banner_local_path, imgBust || undefined) : g.banner_url
                      return (
                        <button type="button" key={g.id}
                          aria-pressed={on}
                          className={`${s.pickCard} ${on ? s.pickCardOn : ''}`}
                          onClick={() => toggleShowcase(g.id)} title={g.name}>
                          <div className={s.pickBanner} style={{ background: getBannerBg(g.id) }}>
                            {src
                              ? <>
                                <img src={src} className={s.pickImgBlur} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={e => coverError(e, g.banner_url)} />
                                <img src={src} className={s.pickImg} alt="" loading="lazy" decoding="async" onError={e => coverError(e, g.banner_url)} />
                              </>
                              : <IconDeviceGamepad2 size={20} stroke={1.1} style={{ color: 'var(--on-art-muted)' }} />}
                            {on && <span className={s.pickOrder}>{idx + 1}</span>}
                          </div>
                          <div className={s.pickName} title={g.name}>{g.name}</div>
                        </button>
                      )
                    })}
                  </div>
                  : <EmptyState
                    size="sm"
                    Icon={IconDeviceGamepad2}
                    title="Nothing to show off yet"
                    desc="Add games to your library first — they'll appear here as showcase picks."
                  />
              )}
            </div>

            {/* Accent quick-pick */}
            <div className={s.section}>
              <div className={s.sectionTitle}>
                <IconPalette size={13} stroke={1.7} /> Accent Color
              </div>
              <div className={s.accentRow}>
                {presets.map(p => (
                  <button key={p.value}
                    className={`${s.accentDot} ${accent === p.value ? s.accentDotActive : ''}`}
                    style={{ '--dot': p.value }} onClick={() => setAccent(p.value)}
                    title={p.label} aria-label={p.label} aria-pressed={accent === p.value}>
                    {accent === p.value && <IconCheck size={11} stroke={3} />}
                  </button>
                ))}
              </div>
              <div className={s.accentHint}>Custom hex + more in Settings → Appearance. The accent flows through the whole app — toasts, overlay, badges, everything.</div>
            </div>
          </div>
        </div>
      </div>

      {crop && (
        <ImageCropModal
          src={crop.src}
          kind={crop.kind}
          title={crop.kind === 'banner' ? 'Adjust banner' : 'Adjust avatar'}
          onCancel={() => setCrop(null)}
          onDone={(path) => { crop.setter(path); setImgBust(Date.now()); setCrop(null) }}
        />
      )}

      {xpModalOpen && (
        <Modal title="Recent XP" icon={<IconHistory size={17} stroke={1.6} />} width={640} onClose={() => setXpModalOpen(false)}>
          <div className={s.modalScroll}>
            <div className={s.xpHistoryGrid}>
              {mergeXpHistory(xpHistory).map((e, i) => (
                <XpEntryCard key={`${e.type}-${e.ts}-${i}`} entry={e} />
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
