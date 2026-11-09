import React from 'react'
import {
  IconSparkles, IconStar, IconRepeat, IconDiscount2, IconBell, IconPackageOff, IconListCheck, IconSearch,
  IconBolt, IconDownload, IconPalette, IconTrash, IconDeviceGamepad2, IconShieldCheck, IconTool,
} from '@tabler/icons-react'
import Modal from './ui/Modal'
import { parseNotes } from '../lib/releaseNotes'
import s from './WhatsNewModal.module.css'

// What's new: after an update (once), or for an update that's downloading. The release's own
// notes laid out as a page: the headline, each new thing with an icon and its name in bold,
// and the fixes in a quieter list. The maker wanted it to really show what's new, not
// "Bug fixes and improvements." (which is only left for a release that has no notes).
const ICONS = [
  [/\bXP\b|level|rarit/i, IconStar],
  [/playthrough|again|second time/i, IconRepeat],
  [/discount|sale|price/i, IconDiscount2],
  [/notification|toast|colou?r/i, IconBell],
  [/uninstall/i, IconPackageOff],
  [/game list|select/i, IconListCheck],
  [/search/i, IconSearch],
  [/faster|lighter|memory|speed|quick/i, IconBolt],
  [/update/i, IconDownload],
  [/theme|look|appearance/i, IconPalette],
  [/delete|remove/i, IconTrash],
  [/big picture|controller/i, IconDeviceGamepad2],
  [/backup|save/i, IconShieldCheck],
]
function iconFor(item) {
  const t = `${item.title || ''} ${item.text}`
  return (ICONS.find(([re]) => re.test(t)) || [null, IconSparkles])[1]
}

export default function WhatsNewModal({ version, notes, url, upcoming = false, onClose }) {
  const { intro, sections } = parseNotes(notes)
  const empty = !sections.length && !intro
  return (
    <Modal
      title={upcoming ? `Coming in KoZo ${version}` : `What's new in KoZo ${version}`}
      icon={<IconSparkles size={16} />}
      onClose={onClose}
      width={620}
      footer={
        <div className={s.foot}>
          {url && (
            <button type="button" className={s.link} onClick={() => window.kozo?.api?.shell?.openExternal?.(url)}>
              Release page on GitHub
            </button>
          )}
          <button type="button" className={s.ok} onClick={onClose} data-gpnav data-whatsnew-ok>
            {upcoming ? 'OK' : 'Got it'}
          </button>
        </div>
      }
    >
      <div className={s.body} data-whatsnew="">
        {upcoming && <p className={s.note}>It's downloading now and installs when you restart KoZo (after your game, if one is running).</p>}
        {(intro || empty) && <p className={s.intro}>{intro || 'Bug fixes and improvements.'}</p>}
        {sections.map((sec, i) => (
          sec.kind === 'fixed' || sec.kind === 'text' ? (
            <div key={i} className={s.section}>
              {sec.title && <h3 className={s.head}><IconTool size={13} stroke={2} /> {sec.title}</h3>}
              <ul className={s.fixed}>
                {sec.items.map((it, j) => <li key={j}>{it.title ? <><b>{it.title}:</b> {it.text}</> : it.text}</li>)}
              </ul>
            </div>
          ) : (
            <div key={i} className={s.section}>
              {sec.title && <h3 className={s.head}><IconSparkles size={13} stroke={2} /> {sec.title}</h3>}
              <div className={s.items}>
                {sec.items.map((it, j) => {
                  const Icon = iconFor(it)
                  return (
                    <div key={j} className={s.item} data-whatsnew-item="">
                      <span className={s.icon}><Icon size={17} stroke={1.8} /></span>
                      <span className={s.itemText}>
                        {it.title && <b>{it.title}</b>}
                        <span>{it.text}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        ))}
      </div>
    </Modal>
  )
}
