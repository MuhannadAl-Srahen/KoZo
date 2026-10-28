import React, { useState } from 'react'
import { IconCalendarEvent } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import { monthKey, formatMonthKey } from '../../lib/utils'
import s from './AddGameModal.module.css'

// Pick the month the selected Game List games are planned for (the play plan
// the Game List "Month" filter reads). `current` pre-selects a month.
export default function PlanMonthModal({ count, current, onClose, onSave }) {
  const now = new Date()
  const quick = [0, 1, 2].map(i => monthKey(new Date(now.getFullYear(), now.getMonth() + i, 1)))
  const [month, setMonth] = useState(current || quick[0])
  const [saving, setSaving] = useState(false)

  async function save(value) {
    setSaving(true)
    await onSave(value)
    setSaving(false)
  }

  return (
    <Modal
      title={`Plan ${count} game${count !== 1 ? 's' : ''} for a month`}
      icon={<IconCalendarEvent size={17} stroke={1.6} />}
      onClose={onClose}
      width={400}
      footer={
        <div style={{ display: 'flex', gap: 8, width: '100%' }}>
          {current && (
            <button className={ms.btnGhost} onClick={() => save(null)} disabled={saving}>Clear plan</button>
          )}
          <div style={{ flex: 1 }} />
          <button className={ms.btnCancel} onClick={onClose}>Cancel</button>
          <button className={ms.btnPrimary} onClick={() => save(month)} disabled={saving || !month}>
            {saving ? 'Saving…' : `Plan for ${formatMonthKey(month)}`}
          </button>
        </div>
      }
    >
      <div className={s.field}>
        <label className={s.label}>Month</label>
        <div className={s.pills}>
          {quick.map(k => (
            <button key={k} className={`${s.pill} ${month === k ? s.pillActive : ''}`} onClick={() => setMonth(k)}>
              {formatMonthKey(k)}
            </button>
          ))}
        </div>
        <input
          type="month"
          className={s.input}
          style={{ marginTop: 8 }}
          value={month}
          onChange={e => setMonth(e.target.value)}
        />
        <div className={s.inputHint}>Filter the Game List by this month to see your plan.</div>
      </div>
    </Modal>
  )
}
