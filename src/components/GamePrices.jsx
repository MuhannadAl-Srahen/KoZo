import React, { useEffect, useState } from 'react'
import {
  IconBell, IconBellOff, IconBrandSteam, IconBuildingStore, IconCheck, IconExternalLink, IconTrendingDown,
} from '@tabler/icons-react'
import { Skeleton } from './ui/Skeleton'
import { parseMoney } from '../lib/money'
import s from './GamePrices.module.css'

// A game window's Prices tab (Discounts, Game List): what it costs at each store,
// the lowest price ever and a price alert (services/deals.js gamePrices).

// CheapShark's lowest is in US dollars. Everywhere else it's labeled as a US price,
// because a regional Steam price can sit below it.
export function lowestLine(lowest, date, us) {
  if (lowest == null) return null
  const amount = `$${Number(lowest).toFixed(2)}`
  if (!us) return `Lowest ever ${amount} (US price)`
  const when = date ? new Date(date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null
  return `Lowest ever ${amount}${when ? `, ${when}` : ''}`
}

function open(url) { window.kozo?.api?.shell?.openExternal?.(url) }

function StoreRow({ Icon, store, price, was, pct, url }) {
  return (
    <button type="button" className={s.row} data-gpnav onClick={() => open(url)}>
      <Icon size={16} stroke={1.6} className={s.rowIcon} />
      <span className={s.store}>{store}</span>
      {pct > 0 && <span className={s.pct}>-{pct}%</span>}
      {was && <s className={s.was}>{was}</s>}
      <b className={s.price}>{price}</b>
      <IconExternalLink size={14} className={s.rowOpen} />
    </button>
  )
}

function PriceAlert({ data, busy, error, onSet, onRemove }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [wrong, setWrong] = useState(false)

  if (data.owned) return <p className={s.note}>This game is in your Library, so there's no price to watch.</p>
  if (!data.price) return <p className={s.note}>Steam shows no price for this game yet, so there's nothing to watch.</p>

  function submit(e) {
    e.preventDefault()
    const cents = parseMoney(text)
    if (cents == null || cents <= 0) { setWrong(true); return }
    setWrong(false)
    setEditing(false)
    setText('')
    onSet(cents)
  }

  const isSet = data.target != null && data.targetState !== 'currency'
  if (isSet && !editing) {
    return (
      <div className={s.alertSet}>
        {data.targetState === 'reached'
          ? <p className={s.alertReached}><IconCheck size={15} /> It's at your price now: {data.targetText} or less.</p>
          : <p className={s.alertWaiting}><IconBell size={15} /> KoZo tells you when it's {data.targetText} or less.</p>}
        <div className={s.alertBtns}>
          <button type="button" className={s.ghost} data-gpnav disabled={busy} onClick={() => setEditing(true)}>Change</button>
          <button type="button" className={s.ghost} data-gpnav disabled={busy} onClick={onRemove}><IconBellOff size={14} /> Remove</button>
        </div>
        {error && <p className={s.error}>{error}</p>}
      </div>
    )
  }

  return (
    <form className={s.alertForm} onSubmit={submit}>
      {data.targetState === 'currency' && <p className={s.note}>Your alert was set in another currency. Set it again here.</p>}
      <label className={s.label} htmlFor="kozo-price-alert">Tell me when it's at or under</label>
      {data.quick?.length > 0 && (
        <div className={s.quick}>
          {data.quick.map(q => (
            <button key={q.label} type="button" className={s.quickBtn} data-gpnav disabled={busy} onClick={() => onSet(q.cents)}>
              {q.label} <b>{q.text}</b>
            </button>
          ))}
        </div>
      )}
      <div className={s.inputRow}>
        <input
          id="kozo-price-alert"
          className={`${s.input} ${wrong ? s.inputWrong : ''}`}
          inputMode="decimal"
          autoComplete="off"
          placeholder={`Any price, now ${data.price.finalText}`}
          value={text}
          onChange={e => { setText(e.target.value); setWrong(false) }}
        />
        <button type="submit" className={s.primary} data-gpnav disabled={busy || !text.trim()}>
          <IconBell size={14} /> {busy ? 'Saving...' : 'Set alert'}
        </button>
        {editing && <button type="button" className={s.ghost} data-gpnav onClick={() => setEditing(false)}>Cancel</button>}
      </div>
      {wrong && <p className={s.error}>Enter a price, like 9.99.</p>}
      {error && <p className={s.error}>{error}</p>}
      {!data.onList && <p className={s.note}>This also adds the game to your Game List as Want to play.</p>}
    </form>
  )
}

export default function GamePrices({ appId, name, banner, onAlertChanged }) {
  const [data, setData] = useState(undefined)   // undefined = loading, null = failed
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setData(undefined)
    window.kozo?.api?.deals?.gamePrices?.(appId).then(res => { if (alive) setData(res?.ok ? res.data : null) })
    return () => { alive = false }
  }, [appId])

  async function change(cents) {
    setBusy(true)
    setError(null)
    const res = await window.kozo?.api?.deals?.setTarget?.(appId, cents, { name, banner_url: banner || null })
    setBusy(false)
    if (res?.ok) { setData(res.data); onAlertChanged?.() }
    else setError(res?.error || 'Could not save the alert.')
  }

  if (data === undefined) {
    return (
      <div className={s.wrap} aria-busy="true">
        <div className={s.panel}>
          <Skeleton w="30%" h={11} />
          {[0, 1, 2].map(i => <Skeleton key={i} w="100%" h={38} r={8} />)}
        </div>
        <div className={s.panel}>
          <Skeleton w="40%" h={11} />
          <Skeleton w="70%" h={14} />
          <Skeleton w="100%" h={38} r={8} />
        </div>
      </div>
    )
  }
  if (data === null) return <p className={s.note}>Could not get the prices. Try again in a moment.</p>

  const low = lowestLine(data.lowest, data.lowestDate, data.us)
  return (
    <div className={s.wrap}>
      <section className={s.panel}>
        <div className={s.head}><IconBuildingStore size={14} /> Where to buy</div>
        <div className={s.rows}>
          {data.price && (
            <StoreRow
              Icon={IconBrandSteam}
              store="Steam"
              price={data.price.finalText}
              was={data.price.pct > 0 ? data.price.originalText : null}
              pct={data.price.pct}
              url={`https://store.steampowered.com/app/${appId}`}
            />
          )}
          {data.stores.map(x => (
            <StoreRow
              key={x.storeID}
              Icon={IconBuildingStore}
              store={x.store}
              price={`$${x.price.toFixed(2)}`}
              pct={x.retail > x.price ? Math.round((1 - x.price / x.retail) * 100) : 0}
              url={x.url}
            />
          ))}
        </div>
        <p className={s.note}>
          {data.stores.length === 0 && 'No other store is listed for this game. '}
          {!data.us && data.stores.length > 0 && 'Other stores show US prices, and yours may differ. '}
          Other stores come from CheapShark, and a store only shows here if CheapShark lists this game there.
        </p>
      </section>

      <section className={s.panel}>
        <div className={s.head}><IconBell size={14} /> Price alert</div>
        <PriceAlert data={data} busy={busy} error={error} onSet={change} onRemove={() => change(null)} />
        {low && (
          <div className={s.lowest} title="The lowest price at any store CheapShark follows, in US dollars">
            <IconTrendingDown size={15} /> {low}
          </div>
        )}
      </section>
    </div>
  )
}
