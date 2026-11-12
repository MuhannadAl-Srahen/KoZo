import React, { useCallback, useEffect, useState } from 'react'
import { IconBrandSteam, IconCheck, IconLoader2, IconTrash, IconUsers } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import SearchableSelect from '../ui/SearchableSelect'
import UndoBar from '../ui/UndoBar'
import s from './SteamAccountsModal.module.css'

// Settings > Connections > Steam accounts (electron/services/steamAccounts.js).
// Every Steam account that was signed in on this PC, and how each one counts: "Mine" in full,
// "Shared" only what was unlocked while KoZo saw the game being played here. The maker plays on
// shared accounts, and a shared account's other players' unlocks had been saved as the maker's.
const MODES = [
  { value: 'mine',   label: 'Mine: every unlock counts' },
  { value: 'shared', label: 'Shared: only what I unlock' },
]

export const accountName = (a) => a?.persona || a?.accountName || (a?.accountId ? `Account ${a.accountId}` : 'Steam account')

export default function SteamAccountsModal({ onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')        // the account id being changed, or 'remove'
  const [undo, setUndo] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const r = await window.kozo?.api?.steam?.accounts?.()
    if (r?.ok) setData(r.data)
    else setError(r?.error || 'Could not read the Steam accounts on this PC.')
  }, [])

  useEffect(() => {
    load()
    const off = window.kozo?.events?.onSteamAccountsChanged?.(() => load())
    return () => off?.()
  }, [load])

  async function act(key, fn) {
    setBusy(key); setError('')
    const r = await fn()
    setBusy('')
    if (!r?.ok) setError(r?.error || 'That did not work.')
    await load()
    onChanged?.()
    return r
  }

  const useAsMine = (a) => act(a.steamId, () => window.kozo.api.steam.useAccount(a.steamId))
  const setMode = (a, mode) => { if (mode && mode !== a.mode) act(a.steamId, () => window.kozo.api.steam.setAccountMode(a.steamId, mode)) }

  async function removeForeign() {
    const r = await act('remove', () => window.kozo.api.steam.removeForeign())
    const rows = r?.ok ? r.data?.rows || [] : []
    if (!rows.length) return
    setUndo({
      text: `Removed ${rows.length} achievement${rows.length === 1 ? '' : 's'} other people unlocked`,
      run: async () => { await window.kozo.api.steam.restoreUnlocks(rows); await load(); onChanged?.() },
    })
  }

  const accounts = data?.accounts || []
  const foreign = data?.foreign
  const needsPick = accounts.length > 1 && !data?.confirmed

  return (
    <Modal title="Steam accounts on this PC" icon={<IconUsers size={16} />} onClose={onClose} width={620}
      footer={<button type="button" className={ms.btnPrimary} onClick={onClose}>Done</button>}>
      <div className={s.body} data-steam-accounts>
        <p className={s.lead}>
          KoZo reads achievements from the Steam app on this PC, for every account you play on, so a private
          profile is never in the way. On an account other people use too, only what you unlock while KoZo sees
          you play counts.
        </p>

        {!data && !error && <p className={s.muted}><IconLoader2 size={14} className="spin" /> Reading the Steam app…</p>}
        {data && accounts.length === 0 && (
          <p className={s.muted}>No Steam account was found on this PC. Sign in with Steam in Settings, Connections.</p>
        )}
        {needsPick && <p className={s.ask}>Which account is yours? Until you say, no account is counted in full.</p>}

        <ul className={s.list}>
          {accounts.map(a => (
            <li key={a.steamId} className={`${s.row} ${a.connected ? s.rowOn : ''}`} data-steam-account={a.steamId}>
              <span className={s.avatar}><IconBrandSteam size={18} /></span>
              <span className={s.who}>
                <span className={s.name}>{accountName(a)}</span>
                <span className={s.sub}>
                  {[a.accountName && a.accountName !== a.persona ? a.accountName : null,
                    a.statsGames ? `${a.statsGames} game${a.statsGames === 1 ? '' : 's'} played here` : 'nothing played here yet',
                  ].filter(Boolean).join(', ')}
                </span>
                <span className={s.chips}>
                  {a.connected && data?.confirmed && <span className={`${s.chip} ${s.chipOn}`}><IconCheck size={11} stroke={2.4} /> Your account</span>}
                  {a.connected && !data?.confirmed && <span className={s.chip}>Connected</span>}
                  {a.signedInNow && <span className={s.chip}>Signed in now</span>}
                </span>
              </span>
              <span className={s.controls}>
                <span className={s.modeSlot}>
                  <SearchableSelect value={a.mode} onChange={(v) => setMode(a, v)} options={MODES}
                    searchable={false} clearable={false} width="100%" />
                </span>
                {!(a.connected && data?.confirmed) && (
                  <button type="button" className={ms.btnCancel} disabled={!!busy} onClick={() => useAsMine(a)}
                    title="Connect KoZo to this account: profile, wishlist and For you come from it, and every unlock on it counts">
                    {busy === a.steamId ? <IconLoader2 size={13} className="spin" /> : null} This is mine
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>

        {data?.confirmed && foreign?.total > 0 && (
          <div className={s.foreign} data-steam-foreign>
            <div>
              <strong>{foreign.total} achievement{foreign.total === 1 ? ' in KoZo was' : 's in KoZo were'} unlocked by other people</strong> on
              shared accounts, not while you played: {foreign.games.map(g => `${g.name} ${g.n}`).join(', ')}.
              Removing {foreign.total === 1 ? 'it takes its' : 'them takes their'} XP away too. Yours stay.
            </div>
            <button type="button" className={ms.btnDanger} disabled={!!busy} onClick={removeForeign}>
              {busy === 'remove' ? <IconLoader2 size={13} className="spin" /> : <IconTrash size={13} />} Remove them
            </button>
          </div>
        )}
        {error && <p className={s.error}>{error}</p>}
      </div>
      <UndoBar undo={undo} onDone={() => setUndo(null)} />
    </Modal>
  )
}
