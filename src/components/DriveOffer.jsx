import React, { useEffect, useMemo, useState } from 'react'
import { IconBrandGoogleDrive, IconCheck, IconLoader2 } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from './ui/Modal'
import { formatPlaytime, timeAgo } from '../lib/utils'
import s from './DriveOffer.module.css'

// After a Google sign-in, when the account holds another PC's backup: three questions, one
// after another. Game List, then Library, then game saves. Each Yes is done before the next
// question, one with nothing new is skipped, and closing the window stops them. Nothing on
// this PC is removed, and a game already here is never added twice (services/libraryMerge).

const games = (n) => (n === 1 ? '1 game' : `${n} games`)
function sizeText(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function questionsFor(offer) {
  const who = offer.pcs?.length > 1 ? 'your other PCs' : (offer.pcs?.[0]?.name || 'your other PC')
  const out = []
  const { list, library, saves } = offer
  if (list?.fresh > 0) {
    out.push({
      key: 'list',
      title: `Add the Game List from ${who}?`,
      text: `${games(list.total)} on it, ${list.fresh} not on this PC. Games you already have won't be added twice.`,
      yes: `Yes, add ${games(list.fresh)}`,
    })
  }
  if (library && (library.fresh > 0 || library.sessions > 0 || library.unlocks > 0)) {
    const extra = [library.seconds > 0 && `${formatPlaytime(library.seconds)} of playtime`, library.unlocks > 0 && (library.unlocks === 1 ? '1 achievement' : `${library.unlocks} achievements`)].filter(Boolean).join(' and ')
    out.push({
      key: 'library',
      title: `Add the Library from ${who}?`,
      text: library.fresh > 0
        ? `${games(library.total)}, ${library.fresh} not on this PC.${extra ? ` This adds ${extra}.` : ''} A game that isn't installed here shows as not installed.`
        : `No new games, but it adds ${extra || 'details'} to games you have.`,
      yes: library.fresh > 0 ? `Yes, add ${games(library.fresh)}` : 'Yes, add it',
    })
  }
  if (saves?.games > 0) {
    out.push({
      key: 'saves',
      title: 'Add the game saves from Google Drive?',
      text: `Backups for ${games(saves.games)}, ${sizeText(saves.bytes)}. They are kept as backups: your current saves stay until you put one back.`,
      warn: saves.enough ? null : `This PC needs ${sizeText(saves.needs)} free for that.`,
      yes: `Yes, download ${sizeText(saves.bytes)}`,
    })
  }
  return out
}

export default function DriveOffer({ offer, onClose }) {
  const questions = useMemo(() => questionsFor(offer), [offer])
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [added, setAdded] = useState([])

  useEffect(() => window.kozo?.events?.onDriveRestoreProgress?.((p) => setProgress(p)), [])

  const question = questions[index]
  // Pages keep their own caches, so a change shows after a reload.
  const finish = () => { if (added.length) window.location.reload(); else onClose() }

  function next(list = added) {
    if (index + 1 < questions.length) { setIndex(index + 1); return }
    if (list.length) setIndex(questions.length)
    else onClose()
  }

  async function yes() {
    setBusy(true); setError(null); setProgress(null)
    const r = await window.kozo?.api?.drive?.applyOffer?.({ step: question.key, restoreLook: !!offer.emptyHere })
    setBusy(false)
    if (!r?.ok) { setError(r?.error || "That didn't work. Nothing was changed."); return }
    const d = r.data || {}
    let line = null
    if (question.key === 'list') line = `Game List: ${games(d.list?.fresh ?? 0)} added.`
    if (question.key === 'library') line = `Library: ${games(d.library?.fresh ?? 0)} added${d.library?.seconds > 0 ? `, with ${formatPlaytime(d.library.seconds)} of playtime` : ''}.`
    if (question.key === 'saves') line = `Game saves: backups for ${games(d.games ?? 0)}. To put one back: Settings, Backups.`
    const list = line ? [...added, line] : added
    setAdded(list)
    next(list)
  }

  const saved = offer.pcs?.[0]?.at ? `Saved ${timeAgo(offer.pcs[0].at)}.` : null
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : null

  return (
    <Modal title={question ? 'Your other PC' : 'All done'} icon={<IconBrandGoogleDrive size={16} />} width={480}
      onClose={() => { if (!busy) finish() }}
      footer={question
        ? (
          <>
            <button type="button" className={ms.btnCancel} disabled={busy} onClick={() => next()} data-offer-no>No</button>
            <button type="button" className={ms.btnPrimary} disabled={busy || !!question.warn} onClick={yes} data-offer-yes>
              {busy ? <><IconLoader2 size={14} className="spin" /> {pct != null ? `Downloading ${pct}%` : 'Adding…'}</> : question.yes}
            </button>
          </>
        )
        : <button type="button" className={ms.btnPrimary} onClick={finish} data-offer-done><IconCheck size={14} /> Open my library</button>}>
      <div className={s.body} data-drive-offer={question?.key || 'done'}>
        {question ? (
          <>
            {questions.length > 1 && <p className={s.count}>Question {index + 1} of {questions.length}</p>}
            <h3 className={s.title}>{question.title}</h3>
            <p className={s.text}>{question.text}</p>
            {question.warn && <p className={s.warn}>{question.warn}</p>}
            {index === 0 && <p className={s.note}>{saved} Nothing on this PC gets removed.</p>}
            {error && <p className={s.warn}>{error}</p>}
          </>
        ) : (
          <ul className={s.done}>{added.map(line => <li key={line}><IconCheck size={14} /> {line}</li>)}</ul>
        )}
      </div>
    </Modal>
  )
}
