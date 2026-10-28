import React, { useState } from 'react'
import { IconCalendarEvent } from '@tabler/icons-react'
import Modal, { modalStyles as ms } from '../ui/Modal'
import MonthPicker from '../ui/MonthPicker'
import { monthKey, formatMonthKey } from '../../lib/utils'
import s from './AddGameModal.module.css'

// Pick the month the selected Game List games are planned for (the play plan
// the Game List "Month" filter reads). `current` pre-selects a month.
export default function PlanMonthModal({ count, current, onClose, onSave }) {
  const [month, setMonth] = useState(current || monthKey())
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
        <MonthPicker value={month} onChange={setMonth} />
        <div className={s.inputHint}>Filter the Game List by this month to see your plan.</div>
      </div>
    </Modal>
  )
}
