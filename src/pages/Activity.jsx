import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { IconChartBar, IconHistory, IconTrophy } from '@tabler/icons-react'
import Statistics from './Statistics'
import Sessions from './Sessions'
import AchievementsHub from './AchievementsHub'
import s from './Activity.module.css'

// Activity: Statistics (Overview), Sessions and Achievements under one tab.
// Each section is the full original page; the bar on top switches between
// them through ?tab= so links and the old routes land on the right one.
const TABS = [
  { key: 'overview',     label: 'Overview',     Icon: IconChartBar, Page: Statistics },
  { key: 'sessions',     label: 'Sessions',     Icon: IconHistory,  Page: Sessions },
  { key: 'achievements', label: 'Achievements', Icon: IconTrophy,   Page: AchievementsHub },
]

export default function Activity() {
  const location = useLocation()
  const navigate = useNavigate()
  const key = new URLSearchParams(location.search).get('tab')
  const tab = TABS.find(t => t.key === key) || TABS[0]
  const Page = tab.Page
  return (
    <div className={s.wrap}>
      <div className={s.bar} role="tablist" aria-label="Activity">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === tab.key}
            className={`${s.tab} ${t.key === tab.key ? s.tabOn : ''}`}
            onClick={() => navigate(`/activity?tab=${t.key}`, { replace: true })}
            data-gpnav=""
          >
            <t.Icon size={15} stroke={1.7} /> {t.label}
          </button>
        ))}
      </div>
      <div className={s.body}><Page key={tab.key} /></div>
    </div>
  )
}
