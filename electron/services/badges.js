'use strict'

// Badges: KoZo's own trophies on the Profile (the maker: "First Ultra Rare", "100 hours club",
// "Finished 10 games"). Like XP, they're a pure function of the database, so they can't drift,
// and a restored backup brings them back. No XP of their own: XP stays what "How XP works"
// says. A newly earned one shows an overlay toast once (xpTracker.check -> newlyEarned; the
// keys already shown live in setting `badges_seen`; the first look ever records them quietly).

const SEEN = 'badges_seen'

// key, name, what earns it, the number it counts, the number it needs.
// `group` orders them on the Profile.
const DEFS = [
  { key: 'first-ultra',  group: 'Achievements', name: 'First Ultra Rare',  desc: 'Unlock an achievement fewer than 5% of players have', of: f => f.ultra, need: 1 },
  { key: 'ultra-10',     group: 'Achievements', name: 'Ultra Rare hunter', desc: 'Unlock 10 Ultra Rare achievements',                    of: f => f.ultra, need: 10 },
  { key: 'ach-100',      group: 'Achievements', name: 'Century',           desc: 'Unlock 100 achievements',                              of: f => f.unlocks, need: 100 },
  { key: 'ach-500',      group: 'Achievements', name: 'Collector',         desc: 'Unlock 500 achievements',                              of: f => f.unlocks, need: 500 },
  { key: 'ach-1000',     group: 'Achievements', name: 'Trophy room',       desc: 'Unlock 1,000 achievements',                            of: f => f.unlocks, need: 1000 },
  { key: 'perfect-1',    group: 'Achievements', name: 'Perfectionist',     desc: 'Unlock every achievement in a game',                   of: f => f.perfect, need: 1 },
  { key: 'perfect-5',    group: 'Achievements', name: 'Completionist',     desc: 'Unlock every achievement in 5 games',                  of: f => f.perfect, need: 5 },
  { key: 'finish-1',     group: 'Games',        name: 'The end',           desc: 'Finish a game',                                        of: f => f.finished, need: 1 },
  { key: 'finish-10',    group: 'Games',        name: 'Finished 10',       desc: 'Finish 10 games',                                      of: f => f.finished, need: 10 },
  { key: 'finish-25',    group: 'Games',        name: 'Finished 25',       desc: 'Finish 25 games',                                      of: f => f.finished, need: 25 },
  { key: 'replay',       group: 'Games',        name: 'Second wind',       desc: 'Finish a game again in a new playthrough',             of: f => f.replays, need: 1 },
  { key: 'planner',      group: 'Games',        name: 'Right on plan',     desc: 'Finish a game in the month you planned it for',        of: f => f.onPlan, need: 1 },
  { key: 'explorer',     group: 'Games',        name: 'Explorer',          desc: 'Play 10 different games for an hour or more',          of: f => f.explored, need: 10 },
  { key: 'club-100',     group: 'Time',         name: '100 hours club',    desc: 'Play one game for 100 hours',                          of: f => f.maxGameHours, need: 100 },
  { key: 'hours-500',    group: 'Time',         name: '500 hours',         desc: 'Play 500 hours in all',                                of: f => f.totalHours, need: 500 },
  { key: 'marathon',     group: 'Time',         name: 'Marathon',          desc: 'Play 4 hours in one session',                          of: f => f.longestSessionHours, need: 4 },
  { key: 'streak-7',     group: 'Time',         name: 'On a roll',         desc: 'Play 7 days in a row',                                 of: f => f.longestStreak, need: 7 },
  { key: 'streak-30',    group: 'Time',         name: 'Unstoppable',       desc: 'Play 30 days in a row',                                of: f => f.longestStreak, need: 30 },
  { key: 'night-owl',    group: 'Time',         name: 'Night owl',         desc: 'Start a session between midnight and 5 in the morning', of: f => f.nightSessions, need: 1 },
]

function db() { return require('../db/database').getDb() }

// The numbers the badges count, from computeXp and a few small queries.
function facts(xp) {
  const d = db()
  const one = (sql) => { try { return d.prepare(sql).get() || {} } catch { return {} } }
  const maxGame = one('SELECT MAX(total_playtime_seconds) AS s FROM games').s || 0
  const total = one('SELECT SUM(total_playtime_seconds) AS s FROM games').s || 0
  const longest = one('SELECT MAX(duration_seconds) AS s FROM sessions WHERE ended_at IS NOT NULL').s || 0
  const night = one("SELECT COUNT(*) AS c FROM sessions WHERE ended_at IS NOT NULL AND duration_seconds >= 60 AND strftime('%H', started_at, 'localtime') < '05'").c || 0
  return {
    ultra: xp.byRarity?.ultra || 0,
    unlocks: xp.unlockCount || 0,
    perfect: xp.perfectCount || 0,
    finished: xp.finishedCount || 0,
    replays: xp.replayCount || 0,
    onPlan: xp.milestones?.onPlan || 0,
    explored: xp.milestones?.explored || 0,
    maxGameHours: Math.floor(maxGame / 3600),
    totalHours: Math.floor(total / 3600),
    longestSessionHours: Math.floor((longest / 3600) * 10) / 10,
    longestStreak: xp.longestStreak || 0,
    nightSessions: night,
  }
}

// Pure: the badges from the numbers.
function badgesFrom(f) {
  return DEFS.map(b => {
    const have = Math.max(0, Number(b.of(f)) || 0)
    return { key: b.key, group: b.group, name: b.name, desc: b.desc, need: b.need, have: Math.min(have, b.need), earned: have >= b.need }
  })
}

function computeBadges(xp = null) {
  const x = xp || require('./xp').computeXp()
  const list = badgesFrom(facts(x))
  return { list, earned: list.filter(b => b.earned).length, total: list.length }
}

// Earned since they were last shown. The first look ever only records them.
function newlyEarned(xp) {
  const { list } = computeBadges(xp)
  const earned = list.filter(b => b.earned).map(b => b.key)
  const settings = require('../db/queries/settings')
  let seen = null
  try { seen = JSON.parse(settings.getSetting(SEEN) || 'null') } catch { seen = null }
  if (!Array.isArray(seen)) { settings.setSetting(SEEN, JSON.stringify(earned)); return [] }
  const fresh = list.filter(b => b.earned && !seen.includes(b.key))
  if (fresh.length) settings.setSetting(SEEN, JSON.stringify([...new Set([...seen, ...fresh.map(b => b.key)])]))
  return fresh
}

// Quietly mark everything earned now as seen (another PC's library, a new XP rule set).
function markAllSeen(xp) {
  try {
    const earned = computeBadges(xp).list.filter(b => b.earned).map(b => b.key)
    require('../db/queries/settings').setSetting(SEEN, JSON.stringify(earned))
  } catch {}
}

module.exports = { computeBadges, newlyEarned, markAllSeen, badgesFrom, DEFS }
