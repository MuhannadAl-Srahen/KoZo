import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  IconSparkles, IconSearch, IconX, IconThumbUp, IconCheck, IconPlus, IconBooks, IconListCheck,
} from '@tabler/icons-react'
import SteamGameModal from '../components/SteamGameModal'
import EmptyState from '../components/ui/EmptyState'
import GeneratedCover from '../components/GeneratedCover'
import { CardSkeletonGrid } from '../components/ui/Skeleton'
import useCardZoom from '../lib/useCardZoom'
import { rankResults } from '../lib/searchRank'
import s from './GamesLike.module.css'

// Games like: pick any game (search, or one of yours) and see the games most
// like it. Ranking is steamApi.similarGames: Steam's own "More like this"
// list plus a search on the game's strongest tags, scored by shared tags,
// Steam's order and reviews. Also used by Game Detail (GamesLikeGrid).

const SHOW = [
  { key: 'released', label: 'Released' },
  { key: 'soon',     label: 'Coming soon' },
  { key: 'all',      label: 'All' },
]
const SORTS = [
  { key: 'match',   label: 'Best match' },
  { key: 'reviews', label: 'Best reviewed' },
  { key: 'newest',  label: 'Newest' },
]

// Module cache: a revisit (or the same seed on Game Detail) paints at once.
const resultCache = new Map()
let ownedCache = null

export function tone(pct) { return pct >= 85 ? 'high' : pct >= 70 ? 'mid' : 'low' }
function year(g) {
  if (g.soon) return g.release?.text || 'Coming soon'
  return g.releasedAt ? String(new Date(g.releasedAt).getFullYear()) : ''
}

// What you already have: Steam ids in the Library and on the Game List.
async function loadOwned() {
  if (ownedCache) return ownedCache
  const [lib, list] = await Promise.all([
    window.kozo?.api?.games?.list?.(),
    window.kozo?.api?.gameList?.list?.({ limit: -1 }),
  ])
  const library = new Map(), listed = new Map()
  const games = lib?.ok && Array.isArray(lib.data) ? lib.data : []
  // gameList:list answers { items, total } (paged).
  const rows = list?.ok ? (Array.isArray(list.data) ? list.data : list.data?.items || []) : []
  for (const g of games) if (g.steam_app_id) library.set(Number(g.steam_app_id), g)
  for (const r of rows) if (r.steam_app_id) listed.set(Number(r.steam_app_id), r)
  ownedCache = { library, listed, games, rows }
  return ownedCache
}
export function forgetOwned() { ownedCache = null }

export function useSimilar(appId) {
  const [state, setState] = useState(() => (appId && resultCache.get(appId)) || null)
  const [error, setError] = useState(null)
  useEffect(() => {
    setError(null)
    if (!appId) { setState(null); return }
    const hit = resultCache.get(appId)
    setState(hit || null)
    if (hit) return
    let alive = true
    window.kozo?.api?.steam?.similar?.(appId).then(res => {
      if (!alive) return
      if (res?.ok) { resultCache.set(appId, res.data); setState(res.data) }
      else setError(res?.error || 'Steam did not answer. Try again in a moment.')
    })
    return () => { alive = false }
  }, [appId])
  return { data: state, error, loading: !!appId && !state && !error }
}

// The results grid with its filters, shared by this page and Game Detail.
export function GamesLikeGrid({ appId, pageKey = 'like', compact = false }) {
  const { data, error, loading } = useSimilar(appId)
  const [owned, setOwned] = useState(ownedCache)
  const [show, setShow] = useState('released')
  const [sort, setSort] = useState('match')
  const [hideOwned, setHideOwned] = useState(false)
  const [open, setOpen] = useState(null)
  const [added, setAdded] = useState(() => new Set())
  const [adding, setAdding] = useState(null)
  const zoomStyle = useCardZoom(pageKey, 'grid', { grid: 230 }, { min: 170, max: 420 })

  useEffect(() => { loadOwned().then(setOwned) }, [])

  const games = useMemo(() => {
    let list = data?.games || []
    if (show === 'released') list = list.filter(g => !g.soon)
    else if (show === 'soon') list = list.filter(g => g.soon)
    if (hideOwned && owned) list = list.filter(g => !owned.library.has(g.appid) && !owned.listed.has(g.appid) && !added.has(g.appid))
    if (sort === 'reviews') list = [...list].sort((a, b) => (b.reviews?.pct || 0) - (a.reviews?.pct || 0) || (b.reviews?.count || 0) - (a.reviews?.count || 0))
    else if (sort === 'newest') list = [...list].sort((a, b) => (b.releasedAt || 9e15) - (a.releasedAt || 9e15))
    return list
  }, [data, show, sort, hideOwned, owned, added])

  async function addToList(g) {
    setAdding(g.appid)
    const res = await window.kozo?.api?.gameList?.add?.({
      steam_app_id: g.appid, name: g.name, banner_url: g.portrait2x || g.portrait || null,
      status: g.soon ? 'upcoming' : 'want_to_play', rating: null, game_id: null,
    })
    setAdding(null)
    if (res?.ok) { setAdded(a => new Set(a).add(g.appid)); forgetOwned() }
  }

  function badge(g) {
    if (owned?.library.has(g.appid)) return { Icon: IconBooks, text: 'In Library' }
    if (owned?.listed.has(g.appid) || added.has(g.appid)) return { Icon: IconListCheck, text: 'On Game List' }
    return null
  }

  if (error) return <EmptyState Icon={IconSparkles} title="Couldn't load similar games" desc={error} />

  return (
    <div className={s.results}>
      <div className={s.filters}>
        <div className={s.seg} role="tablist" aria-label="Show">
          {SHOW.map(o => (
            <button key={o.key} type="button" role="tab" aria-selected={show === o.key}
              className={`${s.segBtn} ${show === o.key ? s.segOn : ''}`} onClick={() => setShow(o.key)}>{o.label}</button>
          ))}
        </div>
        <div className={s.seg} role="tablist" aria-label="Sort">
          {SORTS.map(o => (
            <button key={o.key} type="button" role="tab" aria-selected={sort === o.key}
              className={`${s.segBtn} ${sort === o.key ? s.segOn : ''}`} onClick={() => setSort(o.key)}>{o.label}</button>
          ))}
        </div>
        <label className={s.toggle}>
          <input type="checkbox" checked={hideOwned} onChange={e => setHideOwned(e.target.checked)} />
          <span className={s.toggleBox}>{hideOwned && <IconCheck size={11} stroke={3} />}</span>
          Hide games I have
        </label>
      </div>

      {loading ? (
        <CardSkeletonGrid gridClassName={s.grid} count={compact ? 6 : 12} portrait={false} />
      ) : games.length === 0 ? (
        <EmptyState Icon={IconSparkles} title="Nothing here"
          desc={show === 'soon' ? 'No upcoming games like this one right now.' : 'Try another filter.'} />
      ) : (
        <div className={s.grid} style={zoomStyle}>
          {games.map((g, i) => {
            const b = badge(g)
            return (
              <button key={g.appid} type="button" className={s.card} data-gpnav onClick={() => setOpen(g)}
                style={{ '--i': Math.min(i, 16) }}>
                <div className={s.art}>
                  {g.header || g.capsule ? <img src={g.header || g.capsule} alt="" loading="lazy" decoding="async" /> : null}
                  <span className={`${s.match} ${s['match_' + tone(g.pct)]}`}>{g.pct}%</span>
                  {b && <span className={s.owned}><b.Icon size={12} /> {b.text}</span>}
                </div>
                <div className={s.body}>
                  <div className={s.name} title={g.name}>{g.name}</div>
                  <div className={s.meta}>
                    {g.reviews?.count > 0 && (
                      <span className={s.reviews} title={`${g.reviews.count.toLocaleString()} reviews`}>
                        <IconThumbUp size={12} /> {g.reviews.pct}%
                      </span>
                    )}
                    <span>{year(g)}</span>
                    {g.developers?.[0] && <span className={s.dev}>{g.developers[0]}</span>}
                  </div>
                  {g.shared.length > 0 && (
                    <div className={s.tags}>{g.shared.slice(0, 3).map(t => <span key={t} className={s.tag}>{t}</span>)}</div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {open && (
        <SteamGameModal
          appId={open.appid}
          name={open.name}
          release={open.soon ? open.release?.text : null}
          art={{ header: open.header, header2x: open.header2x, capsule: open.capsule }}
          match={{ pct: open.pct, tone: tone(open.pct), reason: open.shared.length ? `Shares ${open.shared.slice(0, 4).join(', ')} with ${data?.seed?.name || 'this game'}` : null }}
          onClose={() => setOpen(null)}
          actions={badge(open) ? (
            <span className={s.addedNote}><IconCheck size={14} /> {badge(open).text}</span>
          ) : (
            <button type="button" className={s.addBtn} disabled={adding === open.appid} onClick={() => addToList(open)}>
              <IconPlus size={14} /> {adding === open.appid ? 'Adding...' : 'Add to Game List'}
            </button>
          )}
        />
      )}
    </div>
  )
}

// A search hit's picture. Steam's own capsule link always exists; the guessed
// header.jpg answers 404 for newer games, so it's only the second try.
function HitArt({ game }) {
  const sources = [game.capsule, game.header_image].filter(Boolean)
  const [step, setStep] = useState(0)
  if (step >= sources.length) return <div className={s.hitBlank}><GeneratedCover name={game.name} compact /></div>
  return <img src={sources[step]} alt="" onError={() => setStep(n => n + 1)} />
}

export default function GamesLike() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const appId = Number(params.get('app')) || null
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState([])
  const [searching, setSearching] = useState(false)
  const [owned, setOwned] = useState(ownedCache)
  const { data } = useSimilar(appId)
  const timer = useRef(null)

  useEffect(() => { loadOwned().then(setOwned) }, [])

  // Steam search as you type (the same ranking as Add Game).
  useEffect(() => {
    clearTimeout(timer.current)
    const q = query.trim()
    if (q.length < 2) { setHits([]); setSearching(false); return }
    setSearching(true)
    timer.current = setTimeout(async () => {
      const res = await window.kozo?.api?.steam?.search?.(q)
      const list = res?.ok ? (res.data || []) : []
      setHits(rankResults(q, list, []).filter(r => r.kind === 'steam').map(r => r.game).slice(0, 8))
      setSearching(false)
    }, 300)
    return () => clearTimeout(timer.current)
  }, [query])

  function pick(id) {
    setQuery(''); setHits([])
    setParams({ app: String(id) })
  }

  // Quick picks: your most played games, then your best rated ones.
  const seeds = useMemo(() => {
    if (!owned) return []
    const out = [], seen = new Set()
    const played = [...owned.games].filter(g => g.steam_app_id && !g.is_archived)
      .sort((a, b) => (b.total_playtime_seconds || 0) - (a.total_playtime_seconds || 0))
    const rated = [...owned.rows].filter(r => r.steam_app_id && Number(r.rating) >= 7)
      .sort((a, b) => Number(b.rating) - Number(a.rating))
    for (const g of [...played.slice(0, 6), ...rated.slice(0, 6), ...played.slice(6)]) {
      const id = Number(g.steam_app_id)
      if (seen.has(id) || out.length >= 10) continue
      seen.add(id); out.push({ id, name: g.name })
    }
    return out
  }, [owned])

  const seed = data?.seed
  return (
    <div className={s.page}>
      <div className={s.toolbar}>
        <h1 className={s.pageTitle}><IconSparkles size={16} stroke={1.7} /> Games like</h1>
        <div className={s.searchWrap}>
          <IconSearch size={15} className={s.searchIcon} />
          <input className={s.search} value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search any game, for example Sekiro" spellCheck={false} />
          {query && <button type="button" className={s.clear} onClick={() => setQuery('')} aria-label="Clear"><IconX size={14} /></button>}
          {(hits.length > 0 || searching) && (
            <div className={s.hits}>
              {searching && hits.length === 0 && <div className={s.hitMuted}>Searching...</div>}
              {hits.map(h => (
                <button key={h.steam_app_id} type="button" className={s.hit} onClick={() => pick(h.steam_app_id)}>
                  <HitArt game={h} />
                  <span>{h.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={s.content}>
        {seeds.length > 0 && (
          <div className={s.seeds}>
            <span className={s.seedsLabel}>Because you played</span>
            {seeds.map(x => (
              <button key={x.id} type="button" data-gpnav className={`${s.seedChip} ${appId === x.id ? s.seedOn : ''}`} onClick={() => pick(x.id)}>{x.name}</button>
            ))}
          </div>
        )}

        {!appId ? (
          <EmptyState Icon={IconSparkles} title="Find games like the ones you love"
            desc="Search any game, or pick one of yours above. KoZo ranks the games that play most like it, with the reasons." />
        ) : (
          <>
            {seed && (
              <div className={s.seedCard} key={seed.appid}>
                {seed.header && <img className={s.seedArt} src={seed.header} alt="" />}
                <div className={s.seedText}>
                  <div className={s.seedKicker}>Games like</div>
                  <div className={s.seedName}>{seed.name}</div>
                  <div className={s.tags}>{seed.tags.slice(0, 6).map(t => <span key={t} className={s.tag}>{t}</span>)}</div>
                </div>
                {owned?.library.has(seed.appid) && (
                  <button type="button" className={s.ghostBtn} onClick={() => navigate(`/game/${owned.library.get(seed.appid).id}`)}>Open game</button>
                )}
              </div>
            )}
            <GamesLikeGrid appId={appId} />
          </>
        )}
      </div>
    </div>
  )
}
