import React from 'react'
import { useNavigate } from 'react-router-dom'
import { IconTrophy, IconCheck, IconClock, IconPlayerPlayFilled, IconStar, IconEyeOff } from '@tabler/icons-react'
import { getBannerBg, getBannerIcon, formatPlaytime, formatDate, fileUrl, parseGenres } from '../lib/utils'
import { LIBRARY_STATUSES, sourceOf, accentOf } from '../lib/cardModel'
import InfoModal from './ui/InfoModal'
import s from './GameCard.module.css'

export { formatPlaytime }

// The status vocabulary now lives in src/lib/cardModel.js so the Library and the
// Game List describe a card the same way. Re-exported for existing importers.
export { LIBRARY_STATUSES as STATUS_META }

// Toggle favorite. Prefer the parent's optimistic handler (instant star fill +
// re-pin, no grid reload flash); fall back to the direct API + game:updated
// broadcast if no handler was provided.
function toggleFavorite(e, game, onFavorite) {
  e.stopPropagation()
  if (onFavorite) onFavorite(game)
  else window.kozo?.api?.games?.update(game.id, { is_favorite: game.is_favorite ? 0 : 1 })
}

// ── Portrait card (big / small) ───────────────────────────────────────────────

function PortraitCard({ game, variant, selectionMode, selected, onToggle, onFavorite, onContextMenu }) {
  const navigate = useNavigate()
  const Icon     = getBannerIcon(game.name)
  const bg       = getBannerBg(game.id)
  const iconSize = variant === 'big' ? 40 : 24
  const src      = sourceOf(game)
  const accent   = accentOf(game)
  const genres   = parseGenres(game)
  const [launchError, setLaunchError] = React.useState(null)
  const [launchWarning, setLaunchWarning] = React.useState(null)

  function handleClick() {
    if (selectionMode) { onToggle?.(game.id) } else { navigate(`/game/${game.id}`) }
  }

  async function handlePlay(e) {
    e.stopPropagation()
    const res = await window.kozo?.api?.games?.launch(game.id)
    if (!res?.ok) setLaunchError(res?.error || 'Failed to launch')
    else if (res?.data?.warning) setLaunchWarning(res.data.warning)
  }

  return (
    <div
      className={`${s.card} ${variant === 'small' ? s.cardSmall : ''} ${(!game.is_installed || game.is_hidden) && !selectionMode ? s.cardDimmed : ''} ${game._isLive && !selectionMode ? s.cardLive : ''} ${selected ? s.cardSelected : ''}`}
      onClick={handleClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, game) } : undefined}
    >
      <div className={s.banner} style={{ background: bg }}>
        {/* Icon is the base layer; a blurred fill + the contained cover overlay
            it. If the image fails to load the icon shows again. */}
        <Icon size={iconSize} className={s.bannerIcon} stroke={1.1} style={{ zIndex: 0 }} />
        {(() => {
          const localSrc = game.banner_local_path ? fileUrl(game.banner_local_path, game._imgBust) : null
          const src = localSrc || game.banner_url
          if (!src) return null
          // A local banner file can go missing (e.g. after a backup restore that
          // only round-trips DB rows, not the banners folder) — fall back to the
          // remote cover instead of just going blank.
          function handleError(e) {
            const img = e.target
            if (localSrc && game.banner_url && img.src !== game.banner_url && !img.dataset.fallbackTried) {
              img.dataset.fallbackTried = '1'
              img.src = game.banner_url
              return
            }
            img.style.display = 'none'
            if (img.className.includes(s.bannerImg)) {
              const b = img.previousElementSibling
              if (b) b.style.display = 'none'
            }
          }
          return (
            <>
              <img src={src} className={s.bannerBlur} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={handleError} />
              <img src={src} className={s.bannerImg} alt="" loading="lazy" decoding="async" onError={handleError} />
            </>
          )
        })()}

        {/* Status LED — top-left corner of the cover, on a dark ring plate so it
            reads over any art. Colour carries the state; words in the tooltip. */}
        {accent && !selectionMode && (
          <span
            className={`${s.statusLed} ${accent.tone === 'live' ? s.stateDotLive : ''}`}
            style={{ '--state-color': accent.color }}
            title={src ? `${src.label} · ${accent.label}` : accent.label}
          />
        )}

        {!selectionMode && !!game.is_hidden && (
          <span className={s.hiddenBadge}><IconEyeOff size={10} stroke={1.8} />Hidden</span>
        )}

        {/* Name + genres overlaid on the cover's bottom scrim (the look the
            user asked back for) — the stats strip stays below the art. */}
        <div className={s.artScrim} aria-hidden="true" />
        <div className={s.artInfo}>
          <div className={s.artTitleRow}>
            {/* title attr: the name can still truncate on narrow cards */}
            <div className={s.bannerTitle} title={src ? `${game.name} — ${src.label}` : game.name}>
              {game.name}
            </div>
            {!selectionMode && (
              <button
                className={`${s.favBtn} ${game.is_favorite ? s.favBtnActive : ''}`}
                onClick={(e) => toggleFavorite(e, game, onFavorite)}
                title={game.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
                aria-label={game.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <IconStar size={14} stroke={1.8}
                  fill={game.is_favorite === 1 ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
          {genres.length > 0 && (
            <div className={s.bannerGenres}>{genres.slice(0, 2).join(' · ')}</div>
          )}
        </div>

        {/* Selection checkbox — top-right */}
        {selectionMode && (
          <>
            {selected && <div className={s.selectedOverlay} />}
            <div className={`${s.checkbox} ${selected ? s.checkboxSelected : ''}`}>
              {selected && <IconCheck size={12} stroke={3} />}
            </div>
          </>
        )}

        {/* Play — centred on the art, revealed on hover. The only thing that
            ever appears over the cover, and only while pointing at it. */}
        {!selectionMode && !!game.is_installed && (
          <button
            className={s.playBtn}
            onClick={handlePlay}
            title={`Launch ${game.name}`}
            aria-label={`Launch ${game.name}`}
          >
            <IconPlayerPlayFilled size={variant === 'small' ? 16 : 18} />
          </button>
        )}
      </div>

      {/* Stats strip below the art: progress bar, then trophies | last played |
          playtime — the date back in the middle, like the layout the user
          asked to keep. */}
      <div className={`${s.gameInfo} ${variant === 'small' ? s.gameInfoSmall : ''}`}>
        {game._total > 0 && (
          <div className={s.achTrack} aria-hidden="true">
            <div
              className={s.achFill}
              style={{ width: `${Math.min(100, Math.round(((game._unlocked ?? 0) / game._total) * 100))}%` }}
            />
          </div>
        )}
        <div className={s.meta}>
          <span className={`${s.trophies} ${!game._total ? s.metaEmpty : ''}`}>
            <IconTrophy size={12} stroke={1.5} />
            {game._total ? `${game._unlocked ?? 0}/${game._total}` : '—'}
          </span>
          <span className={s.lastPlayed} title={game.last_played_at ? 'Last played' : 'Never played'}>
            {formatDate(game.last_played_at) || '—'}
          </span>
          <span className={`${s.playtime} ${!game.total_playtime_seconds ? s.metaEmpty : ''}`}>
            <IconClock size={12} stroke={1.6} />
            {formatPlaytime(game.total_playtime_seconds)}
          </span>
        </div>
      </div>

      {launchError && (
        <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}>
          <InfoModal
            variant="error"
            title="Couldn't launch"
            message={`${game.name}: ${launchError}`}
            onClose={() => setLaunchError(null)}
          />
        </div>
      )}
      {launchWarning && (
        <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}>
          <InfoModal
            variant="warning"
            title={game.name}
            message={launchWarning}
            onClose={() => setLaunchWarning(null)}
          />
        </div>
      )}
    </div>
  )
}

// ── Library list card ────────────────────────────────────────────────────────

function ListCard({ game, selectionMode, selected, onToggle, onFavorite, onContextMenu }) {
  const navigate = useNavigate()
  const Icon     = getBannerIcon(game.name)
  const bg       = getBannerBg(game.id)
  const src      = sourceOf(game)
  const accent   = accentOf(game)
  const total    = game._total ?? 0
  const unlocked = game._unlocked ?? 0
  const achPct   = total > 0 ? Math.round((unlocked / total) * 100) : 0
  const genres   = parseGenres(game)
  const [launchError, setLaunchError] = React.useState(null)
  const [launchWarning, setLaunchWarning] = React.useState(null)

  function handleClick() {
    if (selectionMode) { onToggle?.(game.id) } else { navigate(`/game/${game.id}`) }
  }

  async function handlePlay(e) {
    e.stopPropagation()
    const res = await window.kozo?.api?.games?.launch(game.id)
    if (!res?.ok) setLaunchError(res?.error || 'Failed to launch')
    else if (res?.data?.warning) setLaunchWarning(res.data.warning)
  }

  return (
    <div
      className={`${s.listCard} ${(!game.is_installed || game.is_hidden) && !selectionMode ? s.cardDimmed : ''} ${game._isLive && !selectionMode ? s.listCardLive : ''} ${selected ? s.listCardSelected : ''}`}
      onClick={handleClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, game) } : undefined}
    >
      {/* Portrait thumbnail — blurred fill + contain cover, selection overlay */}
      <div className={s.listThumb} style={{ background: bg }}>
        <Icon size={20} stroke={1.2} style={{ color: 'rgba(255,255,255,0.15)', position: 'relative', zIndex: 0 }} />
        {(() => {
          const localSrc = game.banner_local_path ? fileUrl(game.banner_local_path, game._imgBust) : null
          const src = localSrc || game.banner_url
          if (!src) return null
          function handleError(e) {
            const img = e.target
            if (localSrc && game.banner_url && img.src !== game.banner_url && !img.dataset.fallbackTried) {
              img.dataset.fallbackTried = '1'
              img.src = game.banner_url
              return
            }
            img.style.display = 'none'
            if (img.className.includes(s.listThumbImg)) {
              const b = img.previousElementSibling
              if (b?.tagName === 'IMG') b.style.display = 'none'
            }
          }
          return (
            <>
              <img src={src} className={s.listThumbBlur} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={handleError} />
              <img src={src} className={s.listThumbImg} alt="" loading="lazy" decoding="async" onError={handleError} />
            </>
          )
        })()}
        {game._isLive && !selectionMode && <div className={s.listLiveBar} />}
        {selectionMode && (
          <div className={`${s.listSelOverlay} ${selected ? s.listSelOverlaySelected : ''}`}>
            <div className={`${s.listCheckbox} ${selected ? s.listCheckboxSelected : ''}`}>
              {selected && <IconCheck size={11} stroke={3} />}
            </div>
          </div>
        )}
      </div>

      {/* Center — name + badges + achievement bar */}
      <div className={s.listInfo}>
        <div className={s.listName} title={game.name}>{game.name}</div>
        <div className={s.listSub}>
          {src && (
            <span className={s.listSourceBadge}>
              <span className={s.sourceDot} style={{ color: src.color }} />
              {src.label}
            </span>
          )}
          {game._isLive && !selectionMode && (
            <span className={s.listLivePill}><span className={s.liveDot} />Live now</span>
          )}
          {!game.is_installed && !selectionMode && (
            <span className={s.listNotInstalledTag}>Not installed</span>
          )}
          {LIBRARY_STATUSES[game.completion_status] && !selectionMode && (() => {
            const st = LIBRARY_STATUSES[game.completion_status]
            return (
              <span className={s.listStatusTag} style={{ color: st.color }}>
                <st.Icon size={11} />{st.label}
              </span>
            )
          })()}
          {!!game.is_hidden && !selectionMode && (
            <span className={s.listHiddenTag}>Hidden</span>
          )}
          {genres.length > 0 && (
            <span className={s.listGenre}>{genres.slice(0, 3).join(' · ')}</span>
          )}
        </div>
        {total > 0 && (
          <div className={s.listAchRow}>
            <div className={s.listAchBar}>
              <div className={s.listAchFill} style={{ width: `${achPct}%` }} />
            </div>
            <span className={s.listAchText}>{unlocked}/{total}</span>
          </div>
        )}
      </div>

      {/* Favorite star — empty span keeps the grid track occupied when hidden */}
      {!selectionMode ? (
        <button
          className={`${s.listFavBtn} ${game.is_favorite ? s.listFavBtnActive : ''}`}
          onClick={(e) => toggleFavorite(e, game, onFavorite)}
          title={game.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
        >
          <IconStar size={15} stroke={1.8} fill={game.is_favorite === 1 ? 'currentColor' : 'none'} />
        </button>
      ) : <span aria-hidden="true" />}

      {/* Play button — placeholder keeps its column when not installed */}
      {!selectionMode && !!game.is_installed ? (
        <button className={s.listPlayBtn} onClick={handlePlay} title={`Launch ${game.name}`}>
          <IconPlayerPlayFilled size={13} />
          Play
        </button>
      ) : <span aria-hidden="true" />}

      {/* Right stats — fixed sub-columns (playtime | achievements | date) */}
      <div className={s.listStats}>
        <span className={`${s.listStatItem} ${game.total_playtime_seconds ? '' : s.listStatItemDim} ${game._isLive && !selectionMode && game.total_playtime_seconds ? s.listStatLive : ''}`}>
          <IconClock size={11} stroke={1.5} />
          {formatPlaytime(game.total_playtime_seconds) || '—'}
        </span>
        <span className={s.listStatItem}>
          <IconTrophy size={11} stroke={1.5} />
          {unlocked}/{total || '—'}
        </span>
        <span className={s.listDate}>{formatDate(game.last_played_at)}</span>
      </div>

      {launchError && (
        <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}>
          <InfoModal
            variant="error"
            title="Couldn't launch"
            message={`${game.name}: ${launchError}`}
            onClose={() => setLaunchError(null)}
          />
        </div>
      )}
      {launchWarning && (
        <div onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()}>
          <InfoModal
            variant="warning"
            title={game.name}
            message={launchWarning}
            onClose={() => setLaunchWarning(null)}
          />
        </div>
      )}
    </div>
  )
}

// ── Exports ───────────────────────────────────────────────────────────────────

export default function GameCard({ game, view = 'big', selectionMode = false, selected = false, onToggle, onFavorite, onContextMenu }) {
  if (view === 'list') return <ListCard game={game} selectionMode={selectionMode} selected={selected} onToggle={onToggle} onFavorite={onFavorite} onContextMenu={onContextMenu} />
  const variant = view === 'small' ? 'small' : 'big'
  return <PortraitCard game={game} variant={variant} selectionMode={selectionMode} selected={selected} onToggle={onToggle} onFavorite={onFavorite} onContextMenu={onContextMenu} />
}
