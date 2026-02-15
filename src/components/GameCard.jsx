import React from 'react'
import { useNavigate } from 'react-router-dom'
import { IconTrophy, IconCheck, IconClock, IconPlayerPlayFilled, IconStar, IconCircleCheckFilled } from '@tabler/icons-react'
import { getBannerBg, getBannerIcon, formatPlaytime, formatDate, fileUrl, LAUNCHERS } from '../lib/utils'
import s from './GameCard.module.css'

export { formatPlaytime }

// A game can be a Steam/Epic/Xbox… game (has steam_app_id for art/achievements)
// AND a cracked copy at the same time. `is_cracked` takes priority for the badge
// so a cracked game never displays as plain "Steam". Unknown sources fall back to
// the neutral "Manual" badge instead of rendering nothing.
function sourceBadge(game) {
  if (game.is_cracked === 1) return LAUNCHERS.cracked
  return LAUNCHERS[game.source] || LAUNCHERS.manual
}

// Toggle favorite. Prefer the parent's optimistic handler (instant star fill +
// re-pin, no grid reload flash); fall back to the direct API + game:updated
// broadcast if no handler was provided.
function toggleFavorite(e, game, onFavorite) {
  e.stopPropagation()
  if (onFavorite) onFavorite(game)
  else window.kozo?.api?.games?.update(game.id, { is_favorite: game.is_favorite ? 0 : 1 })
}

// ── Portrait card (big / small) ───────────────────────────────────────────────

function PortraitCard({ game, variant, selectionMode, selected, onToggle, onFavorite }) {
  const navigate = useNavigate()
  const Icon     = getBannerIcon(game.name)
  const bg       = getBannerBg(game.id)
  const iconSize = variant === 'big' ? 40 : 24
  const src      = sourceBadge(game)

  function handleClick() {
    if (selectionMode) { onToggle?.(game.id) } else { navigate(`/game/${game.id}`) }
  }

  async function handlePlay(e) {
    e.stopPropagation()
    const res = await window.kozo?.api?.games?.launch(game.id)
    if (!res?.ok) alert(res?.error || 'Failed to launch')
  }

  return (
    <div
      className={`${s.card} ${!game.is_installed && !selectionMode ? s.cardDimmed : ''} ${selected ? s.cardSelected : ''}`}
      onClick={handleClick}
    >
      <div className={s.banner} style={{ background: bg }}>
        {/* Icon is the base layer; a blurred fill + the contained cover overlay
            it. If the image fails to load the icon shows again. */}
        <Icon size={iconSize} className={s.bannerIcon} stroke={1.1} style={{ zIndex: 0 }} />
        {(() => {
          const src = game.banner_local_path ? fileUrl(game.banner_local_path, game._imgBust) : game.banner_url
          if (!src) return null
          return (
            <>
              <img src={src} className={s.bannerBlur} alt="" aria-hidden="true"
                onError={e => { e.target.style.display = 'none' }} />
              <img src={src} className={s.bannerImg} alt=""
                onError={e => { e.target.style.display = 'none'; const b = e.target.previousElementSibling; if (b) b.style.display = 'none' }} />
            </>
          )
        })()}

        {/* Source badge — top-left, all sizes */}
        {!selectionMode && src && (
          <div className={s.sourceBadge} style={{ color: src.color, borderColor: src.color + '44', background: src.color + '18' }}>
            {src.label}
          </div>
        )}

        {/* Selection checkbox — top-right */}
        {selectionMode && (
          <>
            {selected && <div className={s.selectedOverlay} />}
            <div className={`${s.checkbox} ${selected ? s.checkboxSelected : ''}`}>
              {selected && <IconCheck size={12} stroke={3} />}
            </div>
          </>
        )}

        {/* LIVE badge — top-right (when not selecting) */}
        {!selectionMode && game._isLive && (
          <div className={s.liveBadge}><span className={s.liveDot} />LIVE</div>
        )}

        {/* Finished badge — bottom-left, above the name */}
        {!selectionMode && game.completion_status === 'finished' && (
          <div className={s.finishedBadge} title="You marked this game finished">
            <IconCircleCheckFilled size={variant === 'small' ? 11 : 12} />
            Finished
          </div>
        )}

        {!selectionMode && !game.is_installed && (
          <div className={s.notInstalledBadge}>Not installed</div>
        )}

        {/* Favorite star — alongside the play button; stays visible when starred */}
        {!selectionMode && (
          <button
            className={`${s.favBtn} ${game.is_favorite ? s.favBtnActive : ''}`}
            style={{ right: game.is_installed ? 45 : 7 }}
            onClick={(e) => toggleFavorite(e, game, onFavorite)}
            title={game.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
          >
            <IconStar size={variant === 'small' ? 14 : 16} stroke={1.8}
              fill={game.is_favorite === 1 ? 'currentColor' : 'none'} />
          </button>
        )}

        {/* Play button — only when not selecting and the game is installed */}
        {!selectionMode && !!game.is_installed && (
          <button
            className={s.playBtn}
            onClick={handlePlay}
            title={`Launch ${game.name}`}
          >
            <IconPlayerPlayFilled size={variant === 'small' ? 14 : 16} />
          </button>
        )}

        {/* Name overlay at bottom */}
        <div className={`${s.bannerName} ${variant === 'small' ? s.bannerNameSmall : ''}`}>
          {game.name}
        </div>
      </div>

      <div className={`${s.gameInfo} ${variant === 'small' ? s.gameInfoSmall : ''}`}>
        <div className={s.meta}>
          <span className={s.trophies}>
            <IconTrophy size={variant === 'small' ? 11 : 12} stroke={1.5} />
            {game._unlocked ?? 0}/{game._total ?? 0}
          </span>
          {variant !== 'small' && (
            <span className={s.lastPlayed}>{formatDate(game.last_played_at)}</span>
          )}
          <span className={s.playtime}>
            <IconClock size={variant === 'small' ? 11 : 12} stroke={1.6} />
            {formatPlaytime(game.total_playtime_seconds) || '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Library list card ────────────────────────────────────────────────────────

function ListCard({ game, selectionMode, selected, onToggle, onFavorite }) {
  const navigate = useNavigate()
  const Icon     = getBannerIcon(game.name)
  const bg       = getBannerBg(game.id)
  const src      = sourceBadge(game)
  const total    = game._total ?? 0
  const unlocked = game._unlocked ?? 0
  const achPct   = total > 0 ? Math.round((unlocked / total) * 100) : 0

  function handleClick() {
    if (selectionMode) { onToggle?.(game.id) } else { navigate(`/game/${game.id}`) }
  }

  async function handlePlay(e) {
    e.stopPropagation()
    const res = await window.kozo?.api?.games?.launch(game.id)
    if (!res?.ok) alert(res?.error || 'Failed to launch')
  }

  return (
    <div
      className={`${s.listCard} ${!game.is_installed && !selectionMode ? s.cardDimmed : ''} ${selected ? s.listCardSelected : ''}`}
      onClick={handleClick}
    >
      {/* Portrait thumbnail — blurred fill + contain cover, selection overlay */}
      <div className={s.listThumb} style={{ background: bg }}>
        <Icon size={20} stroke={1.2} style={{ color: 'rgba(255,255,255,0.15)', position: 'relative', zIndex: 0 }} />
        {(() => {
          const src = game.banner_local_path ? fileUrl(game.banner_local_path, game._imgBust) : game.banner_url
          if (!src) return null
          return (
            <>
              <img src={src} className={s.listThumbBlur} alt="" aria-hidden="true"
                onError={e => { e.target.style.display = 'none' }} />
              <img src={src} className={s.listThumbImg} alt=""
                onError={e => { e.target.style.display = 'none'; const b = e.target.previousElementSibling; if (b?.tagName === 'IMG') b.style.display = 'none' }} />
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
        <div className={s.listName}>{game.name}</div>
        <div className={s.listSub}>
          {src && (
            <span className={s.listSourceBadge} style={{ color: src.color, borderColor: src.color + '44', background: src.color + '12' }}>
              {src.label}
            </span>
          )}
          {game._isLive && !selectionMode && (
            <span className={s.listLivePill}><span className={s.liveDot} />Live now</span>
          )}
          {!game.is_installed && !selectionMode && (
            <span className={s.listNotInstalledTag}>Not installed</span>
          )}
          {game.completion_status === 'finished' && !selectionMode && (
            <span className={s.listFinishedTag}><IconCircleCheckFilled size={11} />Finished</span>
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

      {/* Favorite star */}
      {!selectionMode && (
        <button
          className={`${s.listFavBtn} ${game.is_favorite ? s.listFavBtnActive : ''}`}
          onClick={(e) => toggleFavorite(e, game, onFavorite)}
          title={game.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
        >
          <IconStar size={15} stroke={1.8} fill={game.is_favorite === 1 ? 'currentColor' : 'none'} />
        </button>
      )}

      {/* Play button */}
      {!selectionMode && !!game.is_installed && (
        <button className={s.listPlayBtn} onClick={handlePlay} title={`Launch ${game.name}`}>
          <IconPlayerPlayFilled size={13} />
          Play
        </button>
      )}

      {/* Right stats — inline, no column headers */}
      <div className={s.listStats}>
        <span className={`${s.listStatItem} ${game.total_playtime_seconds ? '' : s.listStatItemDim}`}>
          <IconClock size={11} stroke={1.5} />
          {formatPlaytime(game.total_playtime_seconds) || '—'}
        </span>
        <span className={s.listDot} />
        <span className={s.listStatItem}>
          <IconTrophy size={11} stroke={1.5} />
          {unlocked}/{total || '—'}
        </span>
        <span className={s.listDot} />
        <span className={s.listDate}>{formatDate(game.last_played_at)}</span>
      </div>
    </div>
  )
}

// ── Exports ───────────────────────────────────────────────────────────────────

export default function GameCard({ game, view = 'big', selectionMode = false, selected = false, onToggle, onFavorite }) {
  if (view === 'list') return <ListCard game={game} selectionMode={selectionMode} selected={selected} onToggle={onToggle} onFavorite={onFavorite} />
  const variant = view === 'small' ? 'small' : 'big'
  return <PortraitCard game={game} variant={variant} selectionMode={selectionMode} selected={selected} onToggle={onToggle} onFavorite={onFavorite} />
}
