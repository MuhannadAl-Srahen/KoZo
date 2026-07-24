import React from 'react'
import { useNavigate } from 'react-router-dom'
import { IconTrophy, IconCheck, IconClock, IconPlayerPlayFilled, IconStar, IconCircleCheckFilled, IconPlayerPauseFilled, IconX, IconEyeOff } from '@tabler/icons-react'
import { getBannerBg, getBannerIcon, formatPlaytime, formatDate, fileUrl, LAUNCHERS, parseGenres } from '../lib/utils'
import InfoModal from './ui/InfoModal'
import s from './GameCard.module.css'

export { formatPlaytime }

// Unified game statuses — shared vocabulary with the Game List page.
export const STATUS_META = {
  playing:  { label: 'Playing',  color: 'var(--status-playing)',  Icon: IconPlayerPlayFilled },
  finished: { label: 'Finished', color: 'var(--status-finished)', Icon: IconCircleCheckFilled },
  dropped:  { label: 'Dropped',  color: 'var(--status-dropped)',  Icon: IconX },
  on_hold:  { label: 'On hold',  color: 'var(--status-onhold)',   Icon: IconPlayerPauseFilled },
}

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

function PortraitCard({ game, variant, selectionMode, selected, onToggle, onFavorite, onContextMenu }) {
  const navigate = useNavigate()
  const Icon     = getBannerIcon(game.name)
  const bg       = getBannerBg(game.id)
  const iconSize = variant === 'big' ? 40 : 24
  const src      = sourceBadge(game)
  const genres   = parseGenres(game)
  const [launchError, setLaunchError] = React.useState(null)

  function handleClick() {
    if (selectionMode) { onToggle?.(game.id) } else { navigate(`/game/${game.id}`) }
  }

  async function handlePlay(e) {
    e.stopPropagation()
    const res = await window.kozo?.api?.games?.launch(game.id)
    if (!res?.ok) setLaunchError(res?.error || 'Failed to launch')
  }

  return (
    <div
      className={`${s.card} ${(!game.is_installed || game.is_hidden) && !selectionMode ? s.cardDimmed : ''} ${selected ? s.cardSelected : ''}`}
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

        {/* Text badges — one top-left column so they never collide with the
            round play/favorite buttons or the title overlay */}
        {!selectionMode && (
          <div className={s.badgeStack}>
            {src && (
              <div className={s.sourceBadge} style={{ color: src.color, borderColor: src.color + '44', background: src.color + '18' }}>
                {src.label}
              </div>
            )}
            {STATUS_META[game.completion_status] && (() => {
              const st = STATUS_META[game.completion_status]
              return (
                <div
                  className={`${s.statusBadge} ${variant === 'small' ? s.statusBadgeSmall : ''}`}
                  style={{ color: st.color, borderColor: st.color + '44' }}
                  title={`Status: ${st.label}`}
                >
                  <st.Icon size={variant === 'small' ? 10 : 12} />
                  {st.label}
                </div>
              )
            })()}
            {game._isLive && (
              <div className={s.liveBadge}><span className={s.liveDot} />LIVE</div>
            )}
            {!game.is_installed && (
              <div className={s.notInstalledBadge}>Not installed</div>
            )}
            {!!game.is_hidden && (
              <div className={s.hiddenBadge}><IconEyeOff size={10} stroke={1.8} />Hidden</div>
            )}
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

        {/* Favorite star — top-right corner; stays visible when starred */}
        {!selectionMode && (
          <button
            className={`${s.favBtn} ${game.is_favorite ? s.favBtnActive : ''}`}
            onClick={(e) => toggleFavorite(e, game, onFavorite)}
            title={game.is_favorite ? 'Remove from favorites' : 'Pin to top (favorite)'}
          >
            <IconStar size={variant === 'small' ? 14 : 16} stroke={1.8}
              fill={game.is_favorite === 1 ? 'currentColor' : 'none'} />
          </button>
        )}

        {/* Play button — left of the star, only when installed */}
        {!selectionMode && !!game.is_installed && (
          <button
            className={s.playBtn}
            onClick={handlePlay}
            title={`Launch ${game.name}`}
          >
            <IconPlayerPlayFilled size={variant === 'small' ? 14 : 16} />
          </button>
        )}

        {/* Name + genres overlay at bottom */}
        <div className={`${s.bannerName} ${variant === 'small' ? s.bannerNameSmall : ''}`}>
          <div className={s.bannerTitle}>{game.name}</div>
          {variant !== 'small' && genres.length > 0 && (
            <div className={s.bannerGenres}>{genres.slice(0, 3).join(' · ')}</div>
          )}
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
    </div>
  )
}

// ── Library list card ────────────────────────────────────────────────────────

function ListCard({ game, selectionMode, selected, onToggle, onFavorite, onContextMenu }) {
  const navigate = useNavigate()
  const Icon     = getBannerIcon(game.name)
  const bg       = getBannerBg(game.id)
  const src      = sourceBadge(game)
  const total    = game._total ?? 0
  const unlocked = game._unlocked ?? 0
  const achPct   = total > 0 ? Math.round((unlocked / total) * 100) : 0
  const genres   = parseGenres(game)
  const [launchError, setLaunchError] = React.useState(null)

  function handleClick() {
    if (selectionMode) { onToggle?.(game.id) } else { navigate(`/game/${game.id}`) }
  }

  async function handlePlay(e) {
    e.stopPropagation()
    const res = await window.kozo?.api?.games?.launch(game.id)
    if (!res?.ok) setLaunchError(res?.error || 'Failed to launch')
  }

  return (
    <div
      className={`${s.listCard} ${(!game.is_installed || game.is_hidden) && !selectionMode ? s.cardDimmed : ''} ${selected ? s.listCardSelected : ''}`}
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
          {STATUS_META[game.completion_status] && !selectionMode && (() => {
            const st = STATUS_META[game.completion_status]
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
        <span className={`${s.listStatItem} ${game.total_playtime_seconds ? '' : s.listStatItemDim}`}>
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
    </div>
  )
}

// ── Exports ───────────────────────────────────────────────────────────────────

export default function GameCard({ game, view = 'big', selectionMode = false, selected = false, onToggle, onFavorite, onContextMenu }) {
  if (view === 'list') return <ListCard game={game} selectionMode={selectionMode} selected={selected} onToggle={onToggle} onFavorite={onFavorite} onContextMenu={onContextMenu} />
  const variant = view === 'small' ? 'small' : 'big'
  return <PortraitCard game={game} variant={variant} selectionMode={selectionMode} selected={selected} onToggle={onToggle} onFavorite={onFavorite} onContextMenu={onContextMenu} />
}
