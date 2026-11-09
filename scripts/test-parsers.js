'use strict'

// Standalone tests for the crack-achievement parsers — the core of KoZo's
// tracking pipeline — runnable in plain Node with no Electron:
//
//   node scripts/test-parsers.js
//
// Covers: Goldberg JSON, CODEX/EMPRESS/RUNE/ALI213/SSE INI variants, the SSE
// binary format, and the candidate-path builder (incl. unzipped-game paths).
// Exits 1 if anything fails. The in-app equivalent (Settings → About →
// "Test achievement tracking") exercises the same code end-to-end with a real
// scan + DB write + overlay toast.

const path = require('path')

// crackWatcher requires ../logger, which dereferences Electron's `app` when a
// log is written — stub it in the require cache BEFORE loading the module.
const loggerPath = require.resolve(path.join(__dirname, '..', 'electron', 'logger.js'))
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { info() {}, warn() {}, error() {}, debug() {} },
}

const cw = require(path.join(__dirname, '..', 'electron', 'services', 'crackWatcher.js'))

// Independent reference CRC-32 (IEEE 802.3) so the test doesn't share the
// implementation under test. Sanity-checked against the standard test vector.
function refCrc32(str) {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  const bytes = Buffer.from(str, 'utf8')
  let crc = -1
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF]
  return (crc ^ -1) >>> 0
}

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── parseGoldbergJson ─────────────────────────────────────────────────────────
console.log('\nparseGoldbergJson')
{
  const r = cw.parseGoldbergJson(JSON.stringify({
    ACH_A: { earned: true, earned_time: 1700000000 },
    ACH_B: { earned: '1', earned_time: 1700000001 },
    ACH_C: { earned: 1 },
    ACH_D: { earned: false, earned_time: 1700000002 },
  }))
  check('bool true earned', r.some(u => u.name === 'ACH_A' && u.unlocktime === 1700000000))
  check('string "1" earned', r.some(u => u.name === 'ACH_B'))
  check('number 1 earned, missing time → 0', r.some(u => u.name === 'ACH_C' && u.unlocktime === 0))
  check('earned:false excluded', !r.some(u => u.name === 'ACH_D'))
  check('exactly 3 unlocks', r.length === 3, `got ${r.length}`)
  check('malformed JSON → []', cw.parseGoldbergJson('{oops').length === 0)
}

// ── parseCodexIni ─────────────────────────────────────────────────────────────
console.log('\nparseCodexIni')
{
  const codex = '[ACH_ONE]\nAchieved=1\nUnlockTime=1700000123\n\n[ACH_TWO]\nAchieved=0\n'
  const r1 = cw.parseCodexIni(codex)
  check('CODEX Achieved=1 with time', r1.length === 1 && r1[0].name === 'ACH_ONE' && r1[0].unlocktime === 1700000123)
  check('CODEX Achieved=0 excluded', !r1.some(u => u.name === 'ACH_TWO'))

  const sse = '[ACH_SSE]\nHaveAchieved=1\nHaveAchievedTime=1700000456\n'
  const r2 = cw.parseCodexIni(sse)
  check('SSE-INI HaveAchieved=1', r2.length === 1 && r2[0].unlocktime === 1700000456)

  const empress = '[ACH_EMP]\nearned=1\n'
  check('EMPRESS earned=1', cw.parseCodexIni(empress).length === 1)

  const rune = '[ACH_RUNE]\nCurProgress=1\n'
  check('RUNE CurProgress=1', cw.parseCodexIni(rune).length === 1)

  const ali = '[ACH_ALI]\nState=0101\nTime=1700000789\n'
  const r3 = cw.parseCodexIni(ali)
  check('ALI213 State=0101 + Time', r3.length === 1 && r3[0].unlocktime === 1700000789)

  const skid = '[ACH_SKID]\nUnlocked=1\n'
  check('SKIDROW Unlocked=1', cw.parseCodexIni(skid).length === 1)

  const meta = '[SteamAchievements]\nCount=5\n[Settings]\nLang=en\n[ACH_REAL]\nAchieved=1\n'
  const r4 = cw.parseCodexIni(meta)
  check('meta sections skipped', r4.length === 1 && r4[0].name === 'ACH_REAL')

  // online-fix: boolean-word value + `timestamp=` key (real captured sample —
  // NOT `Achieved=1`/`UnlockTime=`, which is why it silently read as 0 unlocks
  // before this was added).
  const onlinefix = '[TROPHY_10]\nachieved=true\ntimestamp=1782324898\n\n[TROPHY_1]\nachieved=false\n'
  const r5 = cw.parseCodexIni(onlinefix)
  check('online-fix achieved=true + timestamp=', r5.length === 1 && r5[0].name === 'TROPHY_10' && r5[0].unlocktime === 1782324898)
  check('online-fix achieved=false excluded', !r5.some(u => u.name === 'TROPHY_1'))

  // Explicit boolean key must decide ALONE — a progress counter whose value
  // merely starts with "1" (CurProgress=12) must never fabricate an unlock.
  const progress = '[ACH_KILL_100]\nAchieved=0\nCurProgress=12\n\n[ACH_BIG]\nCurProgress=150\n'
  const r6 = cw.parseCodexIni(progress)
  check('Achieved=0 + CurProgress=12 excluded', !r6.some(u => u.name === 'ACH_KILL_100'))
  check('bare CurProgress=150 excluded', !r6.some(u => u.name === 'ACH_BIG'))

  // Trailing content after the value across a whitespace boundary is tolerated
  // (hand-edited "; comment"); a longer VALUE is never split ("Achieved=10" ≠ "1").
  const trail = '[ACH_T1]\nAchieved=1 ; comment\n\n[ACH_T2]\nAchieved=10\n\n[ACH_T3]\nState=0101 (done)\n\n[ACH_T4]\nState=01011\n'
  const r7 = cw.parseCodexIni(trail)
  check('trailing comment after Achieved=1 accepted', r7.some(u => u.name === 'ACH_T1'))
  check('Achieved=10 excluded (value is "10", not "1")', !r7.some(u => u.name === 'ACH_T2'))
  check('State=0101 with trailing note accepted', r7.some(u => u.name === 'ACH_T3'))
  check('State=01011 excluded', !r7.some(u => u.name === 'ACH_T4'))

  check('empty text → []', cw.parseCodexIni('').length === 0)
}

// ── parseSseBinary ────────────────────────────────────────────────────────────
console.log('\nparseSseBinary')
{
  check('reference CRC32 matches the standard test vector',
    refCrc32('123456789') === 0xCBF43926,
    `got 0x${refCrc32('123456789').toString(16)}`)

  // Build a synthetic stats.bin: header int32LE count, then 24-byte chunks:
  // [0..3]=CRC32(apiname) reversed-byte order, [8..11]=unlocktime, [20..23]=value
  function chunkFor(name, unlocktime, value) {
    const buf = Buffer.alloc(24)
    const crcHex = refCrc32(name).toString(16).padStart(8, '0')
    // parser does chunk.slice(0,4).reverse().toString('hex') → must equal crcHex
    const bytes = Buffer.from(crcHex, 'hex')   // big-endian bytes of the crc
    bytes.reverse().copy(buf, 0)               // store reversed so reverse() restores
    buf.writeInt32LE(unlocktime, 8)
    buf.writeInt32LE(value, 20)
    return buf
  }
  const names = ['ACH_BIN_ONE', 'ACH_BIN_TWO', 'ACH_STAT']
  const body = Buffer.concat([
    chunkFor('ACH_BIN_ONE', 1700000111, 1),   // unlocked achievement
    chunkFor('ACH_BIN_TWO', 0, 0),            // locked achievement
    chunkFor('ACH_STAT', 0, 99),              // stat entry — must be skipped
  ])
  const header = Buffer.alloc(4)
  header.writeInt32LE(3, 0)
  const bin = Buffer.concat([header, body])

  const r = cw.parseSseBinary(bin, names)
  check('unlocked entry matched via CRC32', r.length === 1 && r[0].name === 'ACH_BIN_ONE' && r[0].unlocktime === 1700000111)
  check('locked + stat entries excluded', !r.some(u => u.name !== 'ACH_BIN_ONE'))
  check('garbage buffer → []', cw.parseSseBinary(Buffer.from('nonsense'), names).length === 0)
  check('wrong count sanity check → []', cw.parseSseBinary(Buffer.concat([header, body.slice(0, 24)]), names).length === 0)
}

// ── buildCandidates ───────────────────────────────────────────────────────────
console.log('\nbuildCandidates')
{
  const cands = cw.buildCandidates({ steam_app_id: 480, install_path: 'C:\\FakeGame' })
  const paths = cands.map(c => c.path.toLowerCase())
  const has = frag => paths.some(p => p.includes(frag.toLowerCase()))
  check('Goldberg AppData path', has(path.join('Goldberg SteamEmu Saves', '480', 'achievements.json')))
  // steam_settings\achievements.json is deliberately NOT a candidate: it is the
  // achievement DEFINITIONS file (the one "Enable achievement tracking" writes),
  // never a save file — treating it as one imported the whole list as unlocked.
  check('install-relative steam_settings excluded (definitions, not saves)', !has(path.join('C:\\FakeGame', 'steam_settings', 'achievements.json')))
  check('install-relative CODEX ini', has(path.join('C:\\FakeGame', 'achievements.ini')))
  check('CODEX/EMPRESS keyed by appid somewhere', has(path.join('480', 'achievements.ini')))
  check('SSE stats.bin candidate', has('stats.bin'))
  check('online-fix Stats\\Achievements.ini candidate', has(path.join('OnlineFix', '480', 'Stats', 'Achievements.ini')))

  // manual_appid fallback — the unzipped-game case with no steam_app_id
  const cands2 = cw.buildCandidates({ steam_app_id: null, manual_appid: 1234, install_path: 'C:\\FakeGame' })
  check('manual_appid keys emulator folders', cands2.some(c => c.path.includes('1234')))
}

// ── Launcher import (Epic / GOG / Xbox) ───────────────────────────────────────
const li = require(path.join(__dirname, '..', 'electron', 'services', 'launcherImport.js'))
console.log('\nlauncherImport')
{
  const epic = li.parseEpicManifest(JSON.stringify({
    DisplayName: 'Hades', InstallLocation: 'D:\\Epic Games\\Hades', LaunchExecutable: 'x64\\Hades.exe',
    AppName: 'Min', CatalogNamespace: 'ns1', CatalogItemId: 'item1', MainGameAppName: 'Min',
    AppCategories: ['public', 'games', 'applications'], bIsIncompleteInstall: false,
  }))
  check('Epic: name and folder', epic?.name === 'Hades' && epic.install_path === 'D:\\Epic Games\\Hades')
  check('Epic: watched exe is the basename', epic?.exe_name === 'Hades.exe')
  check('Epic: launcher URI', epic?.launch_uri === 'com.epicgames.launcher://apps/ns1%3Aitem1%3AMin?action=launch&silent=true', epic?.launch_uri)
  check('Epic: DLC skipped', li.parseEpicManifest({ DisplayName: 'Pack', InstallLocation: 'D:\\x', AppName: 'Dlc1', MainGameAppName: 'Min', AppCategories: ['addons'] }) === null)
  check('Epic: unfinished install skipped', li.parseEpicManifest({ DisplayName: 'A', InstallLocation: 'D:\\a', bIsIncompleteInstall: true }) === null)
  check('Epic: broken JSON is null, not a crash', li.parseEpicManifest('{nope') === null)

  const reg = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924',
    '    gameID    REG_SZ    1207658924',
    '    gameName    REG_SZ    The Witcher: Enhanced Edition',
    '    exe    REG_SZ    C:\\GOG Games\\The Witcher\\System\\witcher.exe',
    '    path    REG_SZ    C:\\GOG Games\\The Witcher',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1400000001',
    '    gameName    REG_SZ    Some DLC',
    '    path    REG_SZ    C:\\GOG Games\\The Witcher',
    '    dependsOn    REG_SZ    1207658924',
  ].join('\r\n')
  const gog = li.parseGogRegistry(reg)
  check('GOG: one game, DLC skipped', gog.length === 1, JSON.stringify(gog))
  check('GOG: name, folder, exe', gog[0]?.name === 'The Witcher: Enhanced Edition' && gog[0]?.install_path === 'C:\\GOG Games\\The Witcher' && gog[0]?.exe_name === 'witcher.exe')
  const info = li.parseGogInfo({ gameId: '1', rootGameId: '1', name: 'Gwent', playTasks: [{ isPrimary: true, path: 'bin\\Gwent.exe' }] }, 'C:\\GOG Games\\Gwent')
  check('GOG .info: primary play task', info?.exe_name === 'Gwent.exe' && info.install_path === 'C:\\GOG Games\\Gwent')

  const xbox = li.parseXboxPackage({
    name: 'Microsoft.Forza5', familyName: 'Microsoft.Forza5_8wekyb3d8bbwe', installLocation: 'C:\\XboxGames\\Forza\\Content',
    gameConfig: '<Game><ExecutableList><Executable Name="ForzaHorizon5.exe" Id="Game" /></ExecutableList><ShellVisuals DefaultDisplayName="Forza Horizon 5" /></Game>',
    appxManifest: '<Package><Applications><Application Id="Game" Executable="GameLaunchHelper.exe"/></Applications></Package>',
  })
  check('Xbox: name from MicrosoftGame.config', xbox?.name === 'Forza Horizon 5')
  check('Xbox: watched exe', xbox?.exe_name === 'ForzaHorizon5.exe')
  check('Xbox: shell:AppsFolder URI', xbox?.launch_uri === 'shell:AppsFolder\\Microsoft.Forza5_8wekyb3d8bbwe!Game', xbox?.launch_uri)
  const xbox2 = li.parseXboxPackage({
    name: 'Studio.CoolGame', familyName: 'Studio.CoolGame_abc', installLocation: 'C:\\x',
    gameConfig: '<Game><ShellVisuals DefaultDisplayName="ms-resource:Name" /></Game>',
    appxManifest: '<Package><Properties><DisplayName>Cool Game</DisplayName></Properties></Package>',
  })
  check('Xbox: ms-resource name falls back to the manifest', xbox2?.name === 'Cool Game')
}

// ── Pick for me ───────────────────────────────────────────────────────────────
// src/lib/upcomingPick.js is an ES module; load it as a plain function body.
console.log('\nupcoming top bar')
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'upcomingPick.js'), 'utf8')
    .replace(/export function/g, 'function')
  const { readPickMode, defaultPickMode, filterBuckets, pickDay, onlyIds, weekRows } = new Function(src + '; return { readPickMode, defaultPickMode, filterBuckets, pickDay, onlyIds, weekRows }')()
  check('the old "picked" choice means Like my games', readPickMode('picked') === 'like')
  check('the three choices read back', ['like', 'others', 'all'].every(m => readPickMode(m) === m))
  check('nothing chosen stays unchosen', readPickMode(null) === null && readPickMode('nonsense') === null)
  check('someone with matches starts on Like my games', defaultPickMode({ picks: { 5: { pct: 80 } } }) === 'like')
  check('someone with none starts on All, not an empty calendar', defaultPickMode({ picks: {} }) === 'all' && defaultPickMode(null) === 'all')

  const a = { appid: 1, match: 90 }, b = { appid: 2, match: 0 }, c = { appid: 3, match: 70 }, d = { appid: 4, match: 0 }
  const buckets = { byDay: new Map([['x', [a, b]], ['y', [c]], ['z', [d]]]), byMonth: new Map([['m', [b]]]), later: [c, d], all: [a, b, c, d] }
  const like = filterBuckets(buckets, 'like'), others = filterBuckets(buckets, 'others')
  check('Like my games holds only matches', like.all.length === 2 && like.all.every(g => g.match > 0))
  check('Other games holds only the rest', others.all.length === 2 && others.all.every(g => !g.match))
  check('a game is in exactly one of the two', [...like.all, ...others.all].map(g => g.appid).sort().join() === '1,2,3,4')
  check('a day left with nothing is gone', !like.byDay.has('z') && !others.byDay.has('y') && !like.byMonth.has('m'))
  check('a day keeps only its own kind', like.byDay.get('x').length === 1 && others.byDay.get('x')[0].appid === 2)
  check('no match on the TBA shelf either', like.later[0].appid === 3 && others.later[0].appid === 4)
  check('All changes nothing', filterBuckets(buckets, 'all') === buckets)
  check('the originals are not touched', buckets.all.length === 4 && buckets.byDay.get('x').length === 2)

  const many = Array.from({ length: 12 }, (_, i) => ({ appid: i, match: i, popRank: 100 - i }))
  check('a like day: best match first, 5 of them', pickDay(many, 'like').map(g => g.appid).join() === '11,10,9,8,7')
  check('a same-match tie goes to the more popular', pickDay([{ appid: 1, match: 5, popRank: 9 }, { appid: 2, match: 5, popRank: 3 }], 'like')[0].appid === 2)
  check('an others day: most popular first, 8 of them', pickDay(many, 'others').length === 8 && pickDay(many, 'others')[0].appid === 11)
  check('picking a day leaves the list alone', many[0].appid === 0)

  // Steam's own picks (signed in to the Steam store) and its Monday-to-Friday weeks.
  check('signed in to the Steam store starts on its picks', defaultPickMode({ picks: { 5: { pct: 80 } } }, true) === 'steam' && readPickMode('steam') === 'steam')
  const only = onlyIds(buckets, new Set([2, 3]))
  check('Steam picks hold only its games', only.all.map(g => g.appid).join() === '2,3' && !only.byDay.has('z') && only.byDay.get('x').length === 1)
  check("a Steam day keeps Steam's order", pickDay([{ appid: 1, steamRank: 4 }, { appid: 2, steamRank: 1 }], 'steam')[0].appid === 2)
  // Sunday Nov 8 2026: Steam starts on Monday Nov 9, like the maker's screenshot.
  const games = new Map([['2026-11-09', [{ appid: 1 }]], ['2026-11-14', [{ appid: 2 }]], ['2026-11-18', [{ appid: 3 }]]])
  const rows = weekRows(games, '2026-11-08', '2026-11-08')
  check('weeks start on the Monday after a weekend', rows[0].cells[0].key === '2026-11-09' && rows[0].cells.length === 5, JSON.stringify(rows.map(r => r.key)))
  check('a Saturday release shows on the Monday after', rows[1].cells[0].key === '2026-11-16' && rows[1].cells[0].list.some(g => g.appid === 2))
  check('every weekday is a box, empty or not', rows[1].cells[2].list[0].appid === 3 && rows[1].cells[1].list.length === 0)
  check('two weeks, no more', rows.length === 2, String(rows.length))
  const mid = weekRows(new Map([['2026-11-11', [{ appid: 9 }]]]), '2026-11-11', '2026-11-11')
  check('on a Wednesday the week starts on its Monday, the past days dimmed', mid[0].cells[0].key === '2026-11-09' && mid[0].cells[0].past && !mid[0].cells[2].past)
  const { playedSources, forYouItems } = require(path.join(__dirname, '..', 'electron', 'services', 'steamForYou.js'))
  const owned = [
    { appid: 1, name: 'Old favourite', playtime_forever: 300 * 60 },
    { appid: 2, name: 'Playing now', playtime_forever: 40 * 60, playtime_2weeks: 30 * 60 },
    { appid: 3, name: 'Tried once', playtime_forever: 20 },
  ]
  const played = playedSources(owned)
  check("for you on Steam: games played under an hour are not asked about", played.length === 2 && !played.some(x => x.appid === 3))
  check("for you on Steam: recent play comes first", played[0].appid === 2, played.map(x => x.name).join())
  const items = forYouItems([{ appid: 50, priority: 2 }, { appid: 51, priority: 1 }, { appid: 52, priority: 0, added: 5 }, { appid: 1, priority: 3 }],
    { 60: { pct: 70, because: ['Old favourite'] }, 61: { pct: 95, because: ['Playing now'] }, 50: { pct: 99, because: ['x'] } }, new Set([1]))
  check('for you on Steam: the wishlist first, in its own order', items.slice(0, 3).map(x => x.appid).join() === '51,50,52', items.map(x => x.appid).join())
  check('for you on Steam: then games like yours, best first', items.slice(3).map(x => x.appid).join() === '61,60')
  check('for you on Steam: a game you own never shows, a wishlisted one shows once', !items.some(x => x.appid === 1) && items.filter(x => x.appid === 50).length === 1 && items.find(x => x.appid === 50).wishlist)
  check('for you on Steam: nothing connected, nothing shown', forYouItems(null, null).length === 0)
}

// src/lib/pickForMe.js is an ES module; load it as a plain function body.
console.log('\npickForMe')
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'pickForMe.js'), 'utf8')
    .replace(/export function/g, 'function')
  const { scoreCandidates, pickWeighted } = new Function(src + '; return { scoreCandidates, pickWeighted }')()
  const items = [
    { id: 1, name: 'Shooter', genres: '["Action","Shooter"]', game_id: 10 },
    { id: 2, name: 'Farm', genres: '["Simulation"]', game_id: null },
    { id: 3, name: 'Fav', genres: '[]', is_favorite: 1 },
  ]
  const sc = scoreCandidates(items, { action: 1, shooter: 0.5 }, { playableIds: new Set([10]) })
  check('taste + playable weight', Math.abs(sc[0].weight - (1 + 3 * 1.5 + 1)) < 1e-9, String(sc[0].weight))
  check('no taste match keeps base weight', sc[1].weight === 1)
  check('favourite bonus', sc[2].weight === 1.5)
  check('"because" lists the best genres', sc[0].because.join() === 'Action,Shooter')
  check('weighted pick follows rand', pickWeighted(sc, () => 0)?.item.id === 1 && pickWeighted(sc, () => 0.999)?.item.id === 3)
  check('Roll again never repeats the last pick', [0, 0.3, 0.6, 0.99].every(r => pickWeighted(sc, () => r, 1).item.id !== 1))
  check('empty list picks nothing', pickWeighted([], () => 0.5) === null)
}

// src/lib/utils.js release dates: the store record beats the search text, and
// vague dates ("Q1 2027") never land on an exact day.
console.log('\nrelease dates')
{
  let src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'utils.js'), 'utf8')
  const icons = (src.match(/^import \{([\s\S]*?)\} from '@tabler\/icons-react'/) || [])[1] || ''
  src = src.replace(/^import \{[\s\S]*?\} from '@tabler\/icons-react'\r?\n/, '')
    .replace(/export (const|function|async function)/g, '$1')
  const stubs = icons.split(',').map(x => x.trim()).filter(Boolean).map(n => `const ${n} = null;`).join('\n')
  const { parseRelease, storeRelease, countdownTo } = new Function(stubs + src + '; return { parseRelease, storeRelease, countdownTo }')()
  check('"Q1 2027" is a year, not a day', parseRelease('Q1 2027').precision === 'year')
  check('"Early 2027" is a year', parseRelease('Early 2027').precision === 'year')
  check('"Nov 5, 2026" is a day', parseRelease('Nov 5, 2026').precision === 'day')
  const at = Date.UTC(2027, 1, 18, 5, 0)   // 05:00 UTC
  const full = storeRelease({ ts: at, display: 'date_full' }, 'Feb 17, 2027')
  check('store date wins over the search text', full.precision === 'day' && full.ts === at)
  check('store month stays vague', storeRelease({ ts: Date.UTC(2026, 11, 31, 8), display: 'date_month' }, 'December 2026').precision === 'month')
  check('store quarter is a year', storeRelease({ ts: Date.UTC(2027, 2, 31, 7), display: 'date_quarter' }, 'Q1 2027').precision === 'year')
  check('TBA has no date', storeRelease({ ts: null, display: 'text_tba', text: 'To be announced' }, 'x').ts === null)
  check('no store record falls back to the text', storeRelease(null, 'Nov 5, 2026').precision === 'day')
  check('countdown', countdownTo({ ts: 10 * 3600000 + 5 * 60000, precision: 'day' }, 0) === 'in 10h 5m' &&
    countdownTo({ ts: 3 * 86400000 + 4 * 3600000, precision: 'day' }, 0) === 'in 3d 4h')
}

// Upcoming "Like my games": Steam's More like this lists, scored.
console.log('\npicks')
{
  const { scorePicks } = require(path.join(__dirname, '..', 'electron', 'services', 'steamApi.js'))
  const p = scorePicks([
    { name: 'Hollow Knight', weight: 3, ids: [10, 20, 30] },
    { name: 'Dead Cells', weight: 2, ids: [20, 40] },
  ])
  check('a game two favourites agree on ranks first', p[20].pct > p[10].pct && p[20].pct === 99, JSON.stringify(p))
  check('the reason names those games', p[20].because.join() === 'Hollow Knight,Dead Cells')
  check('everything listed is a pick', [10, 20, 30, 40].every(id => p[id]?.pct >= 45))
}

// Like my games: sources come from the whole Game List, not only favourites.
console.log('\npick sources')
{
  const { pickSources } = require(path.join(__dirname, '..', 'electron', 'services', 'steamApi.js'))
  const rows = [
    { appid: 1, name: 'Loved', status: 'finished', rating: 9 },
    { appid: 2, name: 'Played', status: 'playing', seconds: 40 * 3600 },
    { appid: 3, name: 'Wish new', status: 'want_to_play', addedAt: '2026-10-30' },
    { appid: 4, name: 'Wish old', status: 'want_to_play', addedAt: '2025-01-01' },
    { appid: 5, name: 'Hated', status: 'finished', rating: 3 },
    { appid: 6, name: 'Dropped', status: 'dropped' },
    { appid: 7, name: 'Soon', status: 'upcoming', addedAt: '2026-11-01' },
  ]
  const src = pickSources(rows, 6)
  const names = src.map(x => x.name)
  check('wanted games are sources too', names.includes('Wish new') && names.includes('Soon'), names.join())
  check('liked and wanted take turns', src[0].kind === 'liked' && src[1].kind === 'wanted', names.join())
  check('newest wish first', names.indexOf('Soon') < names.indexOf('Wish old'), names.join())
  check('dropped and low-rated never', !names.includes('Hated') && !names.includes('Dropped'), names.join())
}

// Games like: tag overlap, Steam's rank and reviews; editions and DLC out.
console.log('\ngames like')
{
  const { scoreSimilar, baseName } = require(path.join(__dirname, '..', 'electron', 'services', 'steamApi.js'))
  const T = (...ids) => ids.map(id => ({ id, w: 100 }))
  const seed = { appid: 1, name: 'Sekiro\u2122: Shadows Die Twice', tags: T(10, 11, 12, 13, 14) }
  const cands = [
    { appid: 2, name: 'Close', type: 0, tags: T(10, 11, 12, 13), reviews: { count: 5000, pct: 92 } },
    { appid: 3, name: 'Far', type: 0, tags: T(50, 51, 52, 13), reviews: { count: 5000, pct: 92 } },
    { appid: 4, name: 'Sekiro: Shadows Die Twice - GOTY Edition', type: 0, tags: T(10, 11, 12), reviews: { count: 9000, pct: 95 } },
    { appid: 5, name: 'Close DLC', type: 4, tags: T(10, 11, 12, 13), reviews: { count: 900, pct: 95 } },
    { appid: 6, name: 'Few reviews', type: 0, tags: T(10, 11, 12, 13), reviews: { count: 12, pct: 100 }, releasedAt: 1 },
    { appid: 7, name: 'Close but bad', type: 0, tags: T(10, 11, 12, 13), reviews: { count: 5000, pct: 40 } },
  ]
  const out = scoreSimilar(seed, cands, new Map([[3, 0]]))
  const ids = out.map(o => o.appid)
  check('closest tags win', ids[0] === 2, ids.join())
  check('editions of the seed left out', !ids.includes(4) && baseName('Sekiro: Shadows Die Twice - GOTY Edition') === baseName('Sekiro\u2122: Shadows Die Twice'), ids.join())
  check('DLC and tiny review counts left out', !ids.includes(5) && !ids.includes(6), ids.join())
  check('poor reviews pushed down', ids.indexOf(7) > ids.indexOf(2), ids.join())
  check('shared tags given as the reason', out[0].shared.includes(10) && out[0].pct === 99)
}

// Discounts: the deal score and the price-history verdict.
console.log('\ndeals')
{
  const { dealScore, lowState, tasteMatch, wellReviewed } = require(path.join(__dirname, '..', 'electron', 'services', 'deals.js'))
  check('deals: 500+ reviews at 80%+ show', wellReviewed({ count: 500, pct: 80 }) === true)
  check('deals: 100% of a dozen reviews is hidden', wellReviewed({ count: 12, pct: 100 }) === false)
  check('deals: 50,000 reviews at 79% is hidden', wellReviewed({ count: 50000, pct: 79 }) === false)
  check('deals: no reviews is hidden', wellReviewed(null) === false)
  const good = { count: 50000, pct: 95 }
  check('deeper discount scores higher', dealScore({ pct: 80, reviews: good, match: 0.5 }) > dealScore({ pct: 20, reviews: good, match: 0.5 }))
  check('few reviews do not beat many', dealScore({ pct: 50, reviews: { count: 15, pct: 100 }, match: 0.5 }) < dealScore({ pct: 50, reviews: good, match: 0.5 }))
  check('your taste counts', dealScore({ pct: 50, reviews: good, match: 0.9 }) > dealScore({ pct: 50, reviews: good, match: 0.1 }))
  check('lowest ever beats a fake sale', dealScore({ pct: 50, reviews: good, match: 0.5, low: 'lowest' }) > dealScore({ pct: 50, reviews: good, match: 0.5, low: 'above' }))
  check('score stays 1..99', dealScore({ pct: 100, reviews: good, match: 5, low: 'lowest' }) === 99)
  check('price history verdicts', lowState({ lowest: 4.99, steamUsd: 4.99 }) === 'lowest' && lowState({ lowest: 4.99, steamUsd: 5.99 }) === 'near' && lowState({ lowest: 4.99, steamUsd: 9.99 }) === 'above' && lowState(null) === null)
  const vec = new Map([[1, 5], [2, 3]])
  check('taste match prefers shared tags', tasteMatch(vec, [{ id: 1 }, { id: 2 }]) > tasteMatch(vec, [{ id: 9 }, { id: 8 }]))
}

// One file with everything: pack and unpack round trip.
console.log('\nkozo pack')
{
  const os = require('os'), fs = require('fs')
  const pack = require(path.join(__dirname, '..', 'electron', 'services', 'kozoPack.js'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kozo-pack-test-'))
  try {
    const src = path.join(dir, 'src'), dst = path.join(dir, 'dst')
    fs.mkdirSync(path.join(src, 'Game', 'vault', 'blobs'), { recursive: true })
    fs.writeFileSync(path.join(src, 'Game', 'vault', 'blobs', 'a.gz'), Buffer.alloc(3 * 1024 * 1024, 7))
    fs.writeFileSync(path.join(src, 'Game', 'empty.txt'), '')
    fs.writeFileSync(path.join(src, 'top.json'), '{"x":1}')
    const entries = [{ p: 'data.json', data: Buffer.from('{"app":"kozo"}') },
      ...pack.listFiles(src).map(rel => ({ p: `Saves/${rel}`, from: path.join(src, rel) })),
      { p: 'Saves/../evil.txt', data: Buffer.from('no') }]
    const file = path.join(dir, 'x.kozo')
    pack.writePack(file, entries).then(() => {
      const r = pack.readPack(file, { destFor: p => path.join(dst, ...p.slice(6).split('/')) })
      check('pack round trip keeps every file', r.files === 3 && fs.readFileSync(path.join(dst, 'Game', 'vault', 'blobs', 'a.gz')).equals(Buffer.alloc(3 * 1024 * 1024, 7)))
      check('pack keeps empty files and the data', fs.statSync(path.join(dst, 'Game', 'empty.txt')).size === 0 && String(r.data) === '{"app":"kozo"}')
      check('pack refuses paths that leave the folder', !fs.existsSync(path.join(dir, 'evil.txt')) && r.skipped === 1)
      let bad = false
      try { fs.writeFileSync(path.join(dir, 'bad.kozo'), 'hello'); pack.readPack(path.join(dir, 'bad.kozo'), { destFor: () => null }) } catch { bad = true }
      check('pack rejects other files', bad)
    }).catch(e => check('pack round trip ran', false, e.message))
      .finally(() => setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, 500))
  } catch (e) { check('pack test ran', false, e.message) }
}

// Saves found on their own: junk filter and learning from a session.
console.log('\nsave detection')
{
  const { isJunk, pickChangedFolders } = require(path.join(__dirname, '..', 'electron', 'services', 'saveDetect.js'))
  const { buildMatcher } = require(path.join(__dirname, '..', 'electron', 'services', 'saveFinder.js'))
  check('logs, caches and crash dumps are junk', isJunk('Logs/game.log') && isJunk('ShaderCache/a.bin') && isJunk('Crashes/x.dmp') && isJunk('a/output.log'))
  check('save files are not', !isJunk('SaveGames/slot1.sav') && !isJunk('user_0.dat') && !isJunk('Profiles/settings.json'))
  check('game data is never a save', isJunk('Paks/pakchunk0.pak') && isJunk('bin/game.exe') && isJunk('Mods/x/a.json') && isJunk('Binaries/Win64/a.dll'))
  const root = 'C:/Users/me/AppData/LocalLow'
  const files = [
    { root, rel: 'Team Cherry/Hollow Knight Silksong/user1.dat' },
    { root, rel: 'Team Cherry/Hollow Knight Silksong/Player.log' },
    { root, rel: 'Unity/Analytics/x.json' },
    { root: 'C:/Users/me/Documents', rel: 'Some App/Saves/thing.sav' },
    { root: 'D:/Games/HKS', rel: 'save/slot.dat' },
  ]
  const dirs = pickChangedFolders(files, { score: buildMatcher({ name: 'Hollow Knight Silksong' }), installPath: 'D:/Games/HKS' })
  check('the folder named after the game is found', dirs.includes(root + '/Team Cherry/Hollow Knight Silksong'), dirs.join(' | '))
  check('a save folder in the install folder is found', dirs.includes('D:/Games/HKS/save'), dirs.join(' | '))
  check('other apps are ignored', !dirs.some(d => /Unity|Some App/.test(d)), dirs.join(' | '))
}

// Google Drive space: thin the cloud copy, oldest automatic first.
console.log('\ndrive budget')
{
  const { cloudPrunePlan } = require(path.join(__dirname, '..', 'electron', 'services', 'googleDrive.js'))
  const MB = 1024 * 1024
  const games = [{ key: 'A', snaps: [
    { id: 'new', createdAt: '2026-11-02', reason: 'after-play', blobs: [['x', 10 * MB], ['y', 5 * MB]] },
    { id: 'mid', createdAt: '2026-10-20', reason: 'after-play', blobs: [['x', 10 * MB], ['z', 20 * MB]] },
    { id: 'old', createdAt: '2026-09-01', reason: 'before-play', blobs: [['w', 30 * MB]] },
    { id: 'mine', createdAt: '2026-08-01', reason: 'manual', blobs: [['m', 1 * MB]] },
  ] }]
  const all = cloudPrunePlan(games, 0)
  check('no limit keeps everything', all.keep.size === 4 && !all.over)
  const p = cloudPrunePlan(games, 40 * MB)
  check('oldest automatic goes first', !p.keep.has('A|old') && p.keep.has('A|mid'), [...p.keep].join())
  check('shared files are counted once', p.bytes === 36 * MB, String(p.bytes / MB))
  const tight = cloudPrunePlan(games, 5 * MB)
  check('the newest and manual ones always stay', tight.keep.has('A|new') && tight.keep.has('A|mine') && tight.over, [...tight.keep].join())
}

// Game-save backups: the smart history and the known save locations list.
console.log('\nsave backups')
{
  const vault = require(path.join(__dirname, '..', 'electron', 'services', 'saveVault.js'))
  const DAY = 86400000, now = Date.UTC(2026, 10, 2, 12)
  const at = (daysAgo, h = 0) => new Date(now - daysAgo * DAY - h * 3600000).toISOString()
  const snaps = [
    { id: 'a', createdAt: at(0), reason: 'after-play' },
    { id: 'b', createdAt: at(3), reason: 'before-play' },
    { id: 'c', createdAt: at(20, 1), reason: 'after-play' },
    { id: 'd', createdAt: at(20, 3), reason: 'after-play' },   // same day as c, older
    { id: 'e', createdAt: at(62), reason: 'after-play' },
    { id: 'f', createdAt: at(63), reason: 'after-play' },      // same week as e
    { id: 'g', createdAt: at(200), reason: 'after-play' },     // too old
    { id: 'h', createdAt: at(300), reason: 'manual' },         // manual: kept
  ]
  const drop = vault.prunePolicy(snaps, now).sort().join()
  check('smart history keeps recent, daily, weekly and manual', drop === 'd,f,g', drop)
  check('the newest backup always survives', !vault.prunePolicy([{ id: 'x', createdAt: at(400), reason: 'auto' }], now).length)

  const man = require(path.join(__dirname, '..', 'electron', 'services', 'saveManifest.js'))
  const compact = man.compactManifest({
    'Hollow Knight': {
      files: {
        '<winLocalAppDataLow>/Team Cherry/Hollow Knight/user*.dat': { tags: ['save'], when: [{ os: 'windows' }] },
        '<winLocalAppDataLow>/Team Cherry/Hollow Knight/*.log': { tags: ['config'] },
        '<home>/.config/unity3d/Team Cherry/Hollow Knight': { tags: ['save'], when: [{ os: 'linux' }] },
      },
      steam: { id: 367520 },
    },
    'No Files Game': { steam: { id: 1 } },
  })
  check('manifest keeps only Windows save paths', compact.length === 1 && compact[0].f.length === 1 && compact[0].s[0] === 367520, JSON.stringify(compact))
  const ph = { '<winLocalAppDataLow>': 'C:\\Users\\Me\\AppData\\LocalLow', '<base>': null, '<storeUserId>': '*' }
  check('placeholders fill in', man.fillPattern('<winLocalAppDataLow>/Team Cherry/x', ph) === path.join('C:\\Users\\Me\\AppData\\LocalLow', 'Team Cherry', 'x'))
  check('a placeholder with no value drops the path', man.fillPattern('<base>/saves', ph) === null)
}

// ── Discord Rich Presence (against a fake Discord pipe) ──────────────────────
async function discordTests() {
  console.log('\ndiscordPresence')
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, '..', 'electron', rel))
    require.cache[p] = { id: p, filename: p, loaded: true, exports }
  }
  const settings = { discord_presence: '1', discord_client_id: '123456789' }
  stub('db/queries/settings.js', { getSetting: (k) => settings[k] ?? null, setSetting() {} })
  const sessions = new Map()
  let onChange = null
  stub('services/processWatcher.js', { getActiveSessions: () => sessions, onChange: (cb) => { onChange = cb } })
  stub('db/queries/games.js', { getGame: () => ({ name: 'Hades', total_playtime_seconds: 7 * 3600, banner_url: 'https://cdn.example/h.jpg' }) })
  stub('services/xp.js', { computeXp: () => ({ level: 15 }) })
  const dp = require(path.join(__dirname, '..', 'electron', 'services', 'discordPresence.js'))

  const [frames] = dp._decode(Buffer.concat([dp._encode(1, { a: 1 }), dp._encode(2, { b: 2 }), Buffer.from([1, 0])]))
  check('frames round-trip, partial frame held back', frames.length === 2 && frames[0].op === 1 && frames[1].data.b === 2)

  const net = require('net')
  const got = []
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    sock.on('data', (chunk) => {
      const [fs, rest] = dp._decode(Buffer.concat([buf, chunk]))
      buf = rest
      for (const f of fs) {
        got.push(f)
        if (f.op === 0) sock.write(dp._encode(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }))
      }
    })
    sock.on('error', () => {})
  })
  const listening = await new Promise((res) => {
    server.once('error', () => res(false))
    server.listen('\\\\?\\pipe\\discord-ipc-0', () => res(true))
  })
  if (!listening) { console.log('  SKIP  Discord is running here (pipe in use)'); return }
  const wait = (ms) => new Promise(r => setTimeout(r, ms))

  dp.start()
  sessions.set(1, { game_id: 1, started_at: new Date(Date.now() - 60000).toISOString(), game_name: 'Hades' })
  onChange()
  await wait(400)
  const hello = got.find(f => f.op === 0)
  check('handshake sends the Application ID', hello?.data?.client_id === '123456789')
  const act = got.filter(f => f.data?.cmd === 'SET_ACTIVITY').pop()?.data?.args?.activity
  check('activity shows the game name', act?.details === 'Hades', JSON.stringify(act))
  check('activity shows level and hours', act?.state === 'KoZo level 15 · 7h played', act?.state)
  check('member list shows the game, not the app', act?.status_display_type === 2)
  check('status is connected', dp.getStatus() === 'connected')

  sessions.clear()
  onChange()
  await wait(300)
  const last = got.filter(f => f.data?.cmd === 'SET_ACTIVITY').pop()?.data?.args?.activity
  check('activity cleared when play stops', last === null)
  dp.stop()
  server.close()
}

// ── Achievement icon links ───────────────────────────────────────────────────
console.log('\nprice alerts')
{
  const { moneyText, targetState, alertChanges } = require(path.join(__dirname, '..', 'electron', 'services', 'deals.js'))
  check('money: dollars', moneyText(1000, '$19.99') === '$10.00')
  check('money: comma decimals, symbol after', moneyText(1000, '19,99€') === '10,00€')
  check('money: no decimals, thousands', moneyText(100000, '₹ 1,299') === '₹ 1,000')
  check('money: yen', moneyText(120000, '¥ 1,200') === '¥ 1,200')
  check('money: space thousands', moneyText(12000000, 'Rp 120 000') === 'Rp 120 000')
  check('money: two letter symbol', moneyText(2999, 'R$ 29,99') === 'R$ 29,99')
  check('money: symbol with a dollar sign stays', moneyText(500, 'CDN$ 9.99') === 'CDN$ 5.00')
  check('money: no sample still gives a number', moneyText(1250, null) === '12.50')

  check('alert: no target', targetState({ final: 100, target: null }) === null)
  check('alert: above the target waits', targetState({ final: 1100, target: 1000, targetCc: 'US', cc: 'US' }) === 'waiting')
  check('alert: exactly the target counts', targetState({ final: 1000, target: 1000, targetCc: 'US', cc: 'US' }) === 'reached')
  check('alert: under the target counts', targetState({ final: 999, target: 1000 }) === 'reached')
  check('alert: free counts', targetState({ final: 0, target: 1000 }) === 'reached')
  check('alert: another currency is never compared', targetState({ final: 1, target: 1000, targetCc: 'US', cc: 'DE' }) === 'currency')
  check('alert: no price from Steam is unknown', targetState({ final: null, target: 1000 }) === 'unknown')

  const ch = alertChanges([
    { id: 'new', state: 'reached', hit: false }, { id: 'told', state: 'reached', hit: true },
    { id: 'back', state: 'waiting', hit: true }, { id: 'wait', state: 'waiting', hit: false },
    { id: 'gone', state: 'unknown', hit: true }, { id: 'money', state: 'currency', hit: true },
  ])
  check('alert: speaks once when reached', ch.fire.map(a => a.id).join() === 'new')
  check('alert: can speak again only after going back above', ch.clear.map(a => a.id).join() === 'back')

  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'money.js'), 'utf8').replace(/export function/g, 'function')
  const parseMoney = new Function(src + '; return parseMoney')()
  check('typed: whole number', parseMoney('10') === 1000)
  check('typed: dot decimals', parseMoney('9.99') === 999)
  check('typed: comma decimals', parseMoney('9,99') === 999)
  check('typed: one decimal', parseMoney('9.5') === 950)
  check('typed: symbol and thousands', parseMoney('$ 1,299') === 129900)
  check('typed: european thousands', parseMoney('1.299,50') === 129950)
  check('typed: no number', parseMoney('abc') === null && parseMoney('') === null)
}

console.log('\ngame news')
{
  const { newsBlocks, shapeNews } = require(path.join(__dirname, '..', 'electron', 'services', 'steamNews.js'))
  // The markup as Steam really sends it (Cyberpunk 2077, Balatro).
  const real = '[h1]Deckbuilders Fest![/h1][p][/p][p]Enjoy 20% off during &amp; after [b]Steam[/b] Fest.[/p][p][img src="{STEAM_CLAN_IMAGE}/44150325/d899.jpg"][/img][dynamiclink href="https://store.steampowered.com/app/2379780/Balatro/"][/dynamiclink][/p][previewyoutube="uMzXH1QJx6M;full"][/previewyoutube][list][*][p][Console] Fixed a [url=https://x.y]crash[/url][/p][/*][*]Older style item[/list][img]{STEAM_CLAN_IMAGE}/1/old.png[/img][p]End[/p]'
  const b = newsBlocks(real)
  const types = b.map(x => x.type).join()
  check('news: block order', types === 'h,p,img,link,link,li,li,img,p', types)
  check('news: heading text', b[0].text === 'Deckbuilders Fest!')
  check('news: formatting goes, text and entities stay', b[1].text === 'Enjoy 20% off during & after Steam Fest.', b[1].text)
  check('news: image placeholder becomes a real address', b[2].src === 'https://clan.fastly.steamstatic.com/images/44150325/d899.jpg', b[2].src)
  check('news: old image style too', b[7].src === 'https://clan.fastly.steamstatic.com/images/1/old.png', b[7].src)
  check('news: store link', b[3].href === 'https://store.steampowered.com/app/2379780/Balatro/')
  check('news: video link', b[4].href === 'https://www.youtube.com/watch?v=uMzXH1QJx6M')
  check('news: words in brackets stay', b[5].text === '[Console] Fixed a crash', b[5].text)
  check('news: older list style', b[6].text === 'Older style item')
  check('news: a <p> tag word is not a tag', newsBlocks('[patch] and [points]')[0].text === '[patch] and [points]')
  check('news: raw html stays out', newsBlocks('<script>x</script>Hi<br>there')[0].text === 'xHi there')
  check('news: only https images', newsBlocks('[img]http://a.b/c.jpg[/img]').length === 0 && newsBlocks('[img]{STEAM_APP_IMAGE}/c.jpg[/img]').length === 0)
  check('news: only https links', newsBlocks('[dynamiclink href="javascript:alert(1)"][/dynamiclink]').length === 0)
  check('news: nothing gives nothing', newsBlocks('').length === 0 && newsBlocks(null).length === 0)
  {
    // A real Call of Duty patch post is this long: past the limit, no raw markup.
    const long = newsBlocks('[list]' + '[*][p]A change[/p][/*]'.repeat(800) + '[/list]')
    check('news: a very long post has no raw markup left', long.every(b => !/\[\/?[*p]|\[\/?list/.test(b.text || '')), long.find(b => /\[/.test(b.text || ''))?.text?.slice(0, 60))
    check('news: a very long post says the rest is on Steam', /on Steam/.test(long[long.length - 1].text) && long.length <= 603, long.length)
    const fits = newsBlocks('[list]' + '[*][p]A change[/p][/*]'.repeat(50) + '[/list]')
    check('news: a normal list is all there, with no such note', fits.length === 50 && !fits.some(b => /on Steam/.test(b.text)), fits.length)
  }
  const [one] = shapeNews([{ gid: '5', title: 'A &amp; B', url: 'https://x.y/1', date: 100, tags: ['patchnotes'], contents: '[p]' + 'word '.repeat(80) + '[/p]' }])
  check('news: shape', one.id === '5' && one.title === 'A & B' && one.date === 100000 && one.patch === true)
  check('news: short excerpt', one.excerpt.length <= 203 && one.excerpt.endsWith('...'), String(one.excerpt.length))
  check('news: not patch notes without the tag', shapeNews([{ gid: 1, tags: [], contents: '' }])[0].patch === false)
  check('news: a bad address is dropped', shapeNews([{ gid: 1, url: 'javascript:x', contents: '' }])[0].url === null)
}

console.log('\nwishlist')
{
  const { wishlistNew, wishlistStatus, releaseText } = require(path.join(__dirname, '..', 'electron', 'services', 'wishlist.js'))
  const items = [{ appid: 1, added: 10 }, { appid: 2, added: 30 }, { appid: 3, added: 20 }, { appid: 2, added: 30 }, { appid: 0 }, { appid: 'x' }]
  check('wishlist: newest first, repeats and bad ids out', wishlistNew(items, [], []).map(i => i.appid).join() === '2,3,1')
  check('wishlist: on the list stays out', wishlistNew(items, [2], []).map(i => i.appid).join() === '3,1')
  check('wishlist: owned stays out', wishlistNew(items, [], [3]).map(i => i.appid).join() === '2,1')
  check('wishlist: ids as text match too', wishlistNew([{ appid: 5 }], ['5'], []).length === 0)
  const now = Date.UTC(2026, 5, 1)
  check('wishlist: not out yet = upcoming', wishlistStatus({ releasedAt: now + 1000 }, now) === 'upcoming')
  check('wishlist: out = want to play', wishlistStatus({ releasedAt: now - 1000 }, now) === 'want_to_play')
  check('wishlist: marked coming soon = upcoming', wishlistStatus({ release: { soon: true, ts: now - 1000 } }, now) === 'upcoming')
  check('wishlist: no date = want to play', wishlistStatus({}, now) === 'want_to_play')
  check('wishlist: a message date stays', releaseText({ release: { text: 'When it is done' } }) === 'When it is done')
  check('wishlist: a vague year stays vague', releaseText({ release: { ts: Date.UTC(2027, 5, 15), display: 'date_year' } }) === '2027')
  check('wishlist: a vague month stays vague', /^[A-Z][a-z]{2} 2027$/.test(releaseText({ release: { ts: Date.UTC(2027, 5, 15), display: 'date_month' } })))
  check('wishlist: a real date is precise', /^[A-Z][a-z]{2} \d{1,2}, 2027$/.test(releaseText({ release: { ts: Date.UTC(2027, 5, 15), display: 'date_full' } })))
  check('wishlist: no date gives none', releaseText({}) === null)
}

console.log('\nbreak reminder')
{
  const { breakDue } = require(path.join(__dirname, '..', 'electron', 'services', 'breakReminder.js'))
  const H = 3600
  let r = breakDue({ activeSec: 5, everySec: H, state: null })
  check('break: nothing at the start', r.due === false && r.state.stage === 0)
  r = breakDue({ activeSec: H - 1, everySec: H, state: r.state })
  check('break: not before the time', r.due === false)
  r = breakDue({ activeSec: H, everySec: H, state: r.state })
  check('break: at the time', r.due === true)
  r = breakDue({ activeSec: H + 5, everySec: H, state: r.state })
  check('break: only once for that hour', r.due === false)
  r = breakDue({ activeSec: 2 * H, everySec: H, paused: true, state: r.state })
  check('break: waits while paused', r.due === false)
  r = breakDue({ activeSec: 2 * H + 5, everySec: H, state: r.state })
  check('break: speaks when back from a pause', r.due === true)
  check('break: KoZo restarting mid-session stays quiet', breakDue({ activeSec: 5 * H, everySec: H, state: null }).due === false)
  const changed = breakDue({ activeSec: 3 * H, everySec: 2 * H, state: { everySec: H, stage: 2 } })
  check('break: changing the setting stays quiet', changed.due === false && changed.state.everySec === 2 * H)
  check('break: off', breakDue({ activeSec: 9 * H, everySec: 0, state: { everySec: H, stage: 1 } }).due === false)
  check('break: off clears it', breakDue({ activeSec: 9 * H, everySec: 0, state: { everySec: H, stage: 1 } }).state === null)
  check('break: a negative time is no time', breakDue({ activeSec: -50, everySec: H, state: { everySec: H, stage: 0 } }).due === false)
}

console.log('\nyour year')
{
  const { longestStreak, busiestMonth } = require(path.join(__dirname, '..', 'electron', 'db', 'queries', 'yearReview.js'))
  check('streak: none', longestStreak([]) === 0)
  check('streak: one day', longestStreak(['2026-03-01']) === 1)
  check('streak: days in a row', longestStreak(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-09']) === 3)
  check('streak: any order, repeats ignored', longestStreak(['2026-03-03', '2026-03-01', '2026-03-02', '2026-03-02']) === 3)
  check('streak: across a month', longestStreak(['2026-01-31', '2026-02-01']) === 2)
  check('streak: across clock changes', longestStreak(['2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26']) === 3)
  check('streak: across a leap day', longestStreak(['2028-02-28', '2028-02-29', '2028-03-01']) === 3)
  check('busiest: none played', busiestMonth(Array(12).fill(0)) === null)
  check('busiest: 1 to 12', busiestMonth([0, 5, 9, 2, 0, 0, 0, 0, 0, 0, 0, 0]) === 3)
  check('busiest: last month', busiestMonth([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]) === 12)
}

console.log('\nachIconUrl')
{
  const { achIconUrl } = require(path.join(__dirname, '..', 'electron', 'db', 'achIcons.js'))
  const NEW = 'https://shared.fastly.steamstatic.com/community_assets/images/apps/2218750/abc.jpg'
  check('old server moves to the new one', achIconUrl('https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/2218750/abc.jpg') === NEW)
  check('any host with the old path moves', achIconUrl('https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/2218750/abc.jpg') === NEW)
  check('a new link stays as it is', achIconUrl(NEW) === NEW)
  check('an unrelated link stays as it is', achIconUrl('https://example.com/a.jpg') === 'https://example.com/a.jpg')
  check('no icon stays null', achIconUrl(null) === null && achIconUrl(undefined) === null)
}

// ── Switching away from a game ───────────────────────────────────────────────
console.log('\nforegroundProbe')
{
  const fp = require(path.join(__dirname, '..', 'electron', 'services', 'foregroundProbe.js'))
  const game = { exe_name: 'Game.exe', install_path: 'D:\\Games\\Halls\\' }
  const app = (name, at = 1000, pid = 77, p = 'C:\\Windows\\' + name + '.exe') => ({ pid, name, path: p, since: at })

  const f = fp.parseLine('F\t123\tChrome\tC:\\Apps\\chrome.exe', 5)
  check('parses a front app line', f && f.pid === 123 && f.name === 'chrome' && f.path === 'C:\\Apps\\chrome.exe' && f.since === 5)
  check('an elevated app with no path still parses', fp.parseLine('F\t9\tgame\t', 1)?.path === '')
  check('a heartbeat is not a front app', fp.parseLine('H') === null)

  check('own pid counts as the game', fp.isGameWindow(app('x', 0, 42), { pid: 42 }, game))
  check('exe name counts as the game', fp.isGameWindow(app('game'), { pid: 1 }, game))
  check('a file inside the install folder counts', fp.isGameWindow(app('launcher', 0, 7, 'd:\\games\\halls\\bin\\launcher.exe'), { pid: 1 }, game))
  check('a sibling folder with the same start does not', !fp.isGameWindow(app('x', 0, 7, 'D:\\Games\\Halls2\\x.exe'), { pid: 1 }, game))
  check('another app is not the game', !fp.isGameWindow(app('chrome'), { pid: 1 }, game))
  check('unknown front app is not the game', !fp.isGameWindow(null, { pid: 1 }, game))

  const inFront = app('game', 0, 42)
  let s = { pid: 42 }
  check('never seen in front: never away', fp.awaySeconds(s, game, app('chrome', 0), 60, 500000) === 0)
  check('in front: not away', fp.awaySeconds(s, game, inFront, 60, 1000) === 0 && s._seenInFront === true)
  check('under the limit: nothing taken off', fp.awaySeconds(s, game, app('chrome', 10000), 60, 40000) === 0)
  check('at the limit: the whole span counts', fp.awaySeconds(s, game, app('chrome', 10000), 60, 70000) === 60)
  check('another app keeps the same start', fp.awaySeconds(s, game, app('discord', 65000), 60, 90000) === 80)
  check('back in the game: not away', fp.awaySeconds(s, game, inFront, 60, 91000) === 0)
  check('then away again counts from the new start', fp.awaySeconds(s, game, app('chrome', 100000), 60, 130000) === 0)
  check('an unknown front app never counts as away', fp.awaySeconds(s, game, null, 60, 999000) === 0)
  s = { pid: 42, _seenInFront: true }
  check('setting off: never away', fp.awaySeconds(s, game, app('chrome', 0), 0, 999000) === 0)
  check('no probe running: no front app', fp.current() === null)

  let seen = null
  const off = fp.onChange(x => { seen = x })
  fp.onLine('F\t88\tgame\t', 1000)
  check('a report becomes the front app', fp.current(1500)?.pid === 88 && seen?.pid === 88)
  fp.onLine('H', 50000)
  check('a heartbeat keeps it fresh', fp.current(120000)?.pid === 88)
  check('no line for 90 s: unknown, so nothing is taken off', fp.current(150000) === null)
  fp.onLine('F\t99\tchrome\t', 200000)
  fp.reset()
  check('the process ending clears it', fp.current(200001) === null)
  off()

  const ci = require(path.join(__dirname, '..', 'electron', 'services', 'controllerInput.js'))
  check('a controller never used counts as idle', ci.msSinceInput() === Infinity)
  ci.noteInput()
  check('a controller just used is not idle', ci.msSinceInput() < 1000)
}

// ── A session's window ────────────────────────────────────────────────────────
// src/lib/sessionDetail.js is an ES module; load it as a plain function body.
console.log('\nsession window')
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sessionDetail.js'), 'utf8')
    .replace(/export function/g, 'function')
  const { pausedSeconds, sessionGroups } = new Function(src + '; return { pausedSeconds, sessionGroups }')()
  const at = (min) => new Date(Date.UTC(2026, 10, 4, 12, min)).toISOString()

  check('paused: what ran but did not count', pausedSeconds({ started_at: at(0), ended_at: at(120), duration_seconds: 3600 }) === 3600)
  check('paused: nothing when all of it counted', pausedSeconds({ started_at: at(0), ended_at: at(60), duration_seconds: 3600 }) === 0)
  check('paused: never below zero', pausedSeconds({ started_at: at(0), ended_at: at(10), duration_seconds: 3600 }) === 0)
  check('paused: a session with no end', pausedSeconds({ started_at: at(0), ended_at: null, duration_seconds: 0 }) === 0)
  check('paused: uses the clock, not the idle column saved late', pausedSeconds({ started_at: '2026-11-04T12:11:15.574Z', ended_at: '2026-11-04T14:23:01.943Z', duration_seconds: 3879, idle_seconds: 4002 }) === 4027)

  const achs = [
    { id: 10, session_id: 1, unlock_id: 1, unlocked_at: at(50) },
    { id: 11, session_id: 1, unlock_id: 2, unlocked_at: at(5) },
    { id: 12, session_id: 1, unlock_id: 3, unlocked_at: null },
    { id: 13, session_id: 2, unlock_id: 4, unlocked_at: at(210) },
    { id: 14, session_id: null, unlock_id: 5, unlocked_at: at(6) },
    { id: 15, session_id: null, unlock_id: null, unlocked_at: null },
    { id: 16, session_id: 1, unlock_id: null, unlocked_at: null },
  ]
  const later = { id: 2, started_at: at(200), ended_at: at(260), duration_seconds: 3600 }
  const earlier = { id: 1, started_at: at(0), ended_at: at(120), duration_seconds: 3600 }
  const one = sessionGroups([earlier], achs)
  check('a session: only what it earned, in the order it came', JSON.stringify(one.groups[0].unlocks.map(a => a.id)) === '[11,10,12]')
  check('a session: another session on the same day stays out', !one.groups[0].unlocks.some(a => a.id === 13))
  check('a session: an unlock with no link stays out', !one.groups[0].unlocks.some(a => a.id === 14))
  check('a session: totals', one.played === 3600 && one.paused === 3600 && one.unlocks === 3)
  const day = sessionGroups([later, earlier], achs)
  check('a day: earliest session first', JSON.stringify(day.groups.map(g => g.session.id)) === '[1,2]')
  check('a day: each session keeps its own', day.groups[0].unlocks.length === 3 && day.groups[1].unlocks.length === 1)
  check('a day: totals add up', day.played === 7200 && day.paused === 3600 && day.unlocks === 4)
  const input = [later, earlier]
  sessionGroups(input, achs)
  check('the page\'s own lists stay as they were', input[0] === later && achs[0].id === 10)
}

// ── Adding another PC's library ───────────────────────────────────────────────
console.log('\nlibrary merge')
{
  const { planMerge, planIsEmpty, gameResolver, nameKey } = require(path.join(__dirname, '..', 'electron', 'services', 'libraryMerge.js'))
// The laptop and the PC: ids collide on purpose. Game 4 is a different game on each.
const local = {
  games: [
    { id: 4, name: 'Laptop Only', steam_app_id: 100, exe_name: 'l.exe', total_playtime_seconds: 500, first_played_at: '2026-01-01T00:00:00.000Z', last_played_at: '2026-01-02T00:00:00.000Z' },
    { id: 5, name: 'Both By Id', steam_app_id: 200, exe_name: 'mine.exe', install_path: 'C:/mine', total_playtime_seconds: 1000, completion_status: 'playing', first_played_at: '2026-03-01T00:00:00.000Z', last_played_at: '2026-03-02T00:00:00.000Z' },
    { id: 6, name: 'Red Alert 2', steam_app_id: null, exe_name: 'ra2.exe', total_playtime_seconds: 0 },
  ],
  sessions: [{ id: 1, game_id: 5, started_at: '2026-03-01T00:00:00.000Z' }],
  achievements: [{ id: 1, game_id: 5, steam_api_name: 'A1' }, { id: 2, game_id: 5, steam_api_name: 'A2' }],
  achievement_unlocks: [{ id: 1, achievement_id: 1, session_id: 1, unlocked_at: '2026-03-01T01:00:00.000Z' }, { id: 2, achievement_id: 2, session_id: null, unlocked_at: '2026-01-01T00:00:00.000Z' }],
  game_list: [
    { id: 1, game_id: 4, steam_app_id: 100, name: 'Laptop Only', status: 'playing', rating: 5, display_order: 3 },
    { id: 2, game_id: 5, steam_app_id: 200, name: 'Both By Id', status: 'playing', rating: null, planned_month: null },
    { id: 3, game_id: null, steam_app_id: 777, name: 'Wanted Here', status: 'want_to_play' },
  ],
}
const pc = {
  app: 'kozo', install: 'pc',
  games: [
    { id: 4, name: 'Different Name, Same Id', steam_app_id: 200, exe_name: 'theirs.exe', install_path: 'D:/theirs', total_playtime_seconds: 9000, completion_status: 'finished', is_installed: 1 },
    { id: 5, name: 'PC Only', steam_app_id: 300, exe_name: 'p.exe', install_path: 'D:/here', total_playtime_seconds: 7200, is_installed: 1, banner_local_path: 'D:/art.jpg', hero_local_path: 'D:/h.jpg', save_paths: '["D:/s"]', first_played_at: '2026-02-01T00:00:00.000Z' },
    { id: 6, name: 'Red-Alert-2', steam_app_id: 2229830, exe_name: 'other.exe', total_playtime_seconds: 60 },
    { id: 7, name: 'Same Name', steam_app_id: 111, exe_name: 'x.exe', total_playtime_seconds: 0 },
    { id: 8, name: 'Old Game', steam_app_id: 400, exe_name: 'o.exe', is_archived: 1, total_playtime_seconds: 0 },
  ],
  sessions: [
    { id: 1, game_id: 4, started_at: '2026-03-01T00:00:00.000Z', ended_at: '2026-03-01T02:00:00.000Z', duration_seconds: 7200 },   // already here
    { id: 2, game_id: 4, started_at: '2026-02-20T00:00:00.000Z', ended_at: '2026-02-20T01:00:00.000Z', duration_seconds: 3600 },   // new, earlier
    { id: 3, game_id: 4, started_at: '2026-04-20T00:00:00.000Z', ended_at: '2026-04-20T00:30:00.000Z', duration_seconds: 1800 },   // new, later
    { id: 4, game_id: 4, started_at: '2026-05-01T00:00:00.000Z', ended_at: null, duration_seconds: null },                        // still running there
    { id: 5, game_id: 5, started_at: '2026-02-01T00:00:00.000Z', ended_at: '2026-02-01T02:00:00.000Z', duration_seconds: 7200 },
  ],
  achievements: [
    { id: 9, game_id: 4, steam_api_name: 'A1', display_name: 'One' },
    { id: 10, game_id: 4, steam_api_name: 'A2', display_name: 'Two' },
    { id: 11, game_id: 4, steam_api_name: 'A3', display_name: 'Three' },
    { id: 12, game_id: 5, steam_api_name: 'P1', display_name: 'Pee' },
  ],
  achievement_unlocks: [
    { id: 1, achievement_id: 9, session_id: 2, unlocked_at: '2026-02-20T00:30:00.000Z', source: 'steam_api' },   // earlier than here: wins
    { id: 2, achievement_id: 10, session_id: 2, unlocked_at: '2026-02-20T00:40:00.000Z', source: 'steam_api' },  // later than here: ours stays
    { id: 3, achievement_id: 11, session_id: 3, unlocked_at: '2026-04-20T00:10:00.000Z', source: 'crack' },
    { id: 4, achievement_id: 12, session_id: 5, unlocked_at: '2026-02-01T01:00:00.000Z', source: 'crack' },
  ],
  game_list: [
    { id: 1, game_id: 4, steam_app_id: 200, name: 'Different Name, Same Id', status: 'finished', rating: 9, planned_month: '2026-12', is_favorite: 1, price_target_cents: 500, price_target_cc: 'US', price_target_hit: 0 },
    { id: 2, game_id: 5, steam_app_id: 300, name: 'PC Only', status: 'playing' },
    { id: 3, game_id: null, steam_app_id: 777, name: 'wanted here!', status: 'finished' },       // same game, status stays ours
    { id: 4, game_id: null, steam_app_id: null, name: 'Laptop  Only', status: 'dropped' },       // by name, status stays ours
    { id: 5, game_id: null, steam_app_id: 888, name: 'New Wish', status: 'upcoming', release_watch: 1, category_id: 3 },
    { id: 6, game_id: null, steam_app_id: 888, name: 'New Wish', status: 'upcoming' },            // twice in the file
  ],
}

const plan = planMerge([pc], local, { exists: (p) => p === 'D:/here' })
const byName = (name) => plan.newGames.find(g => g.name === name)

check('name key: spelling', nameKey('Red-Alert-2') === nameKey('red alert 2') && nameKey('Foo: Bar!') === nameKey('foo bar'))
check('name key: other alphabets', nameKey('黒い砂漠') !== '' && nameKey('黒い砂漠') !== nameKey('原神'))
check('colliding ids: their game 4 becomes our game 5, by Steam id', !byName('Different Name, Same Id'))
check('same Steam id: no second game', plan.newGames.filter(g => g.steam_app_id === 200).length === 0)
check('new game added with a new id', byName('PC Only')?.id < 0)
check('another spelling is the same game', !byName('Red-Alert-2'))
check('no Steam id here, one there: filled in', plan.gameChanges.get(6)?.steam_app_id === 2229830)
check('new game: pictures and save folders of that PC dropped', byName('PC Only').banner_local_path === null && byName('PC Only').hero_local_path === null && byName('PC Only').save_paths === null)
check('new game: installed only when the folder is here', byName('PC Only').is_installed === 1)
check('new game: not here means not installed', byName('Same Name').is_installed === 0)
check('matched game keeps this PC\'s folder, exe and status', !('install_path' in (plan.gameChanges.get(5) || {})) && !('exe_name' in (plan.gameChanges.get(5) || {})) && !('completion_status' in (plan.gameChanges.get(5) || {})))
check('same start time is not added twice', plan.newSessions.filter(s => s.started_at === '2026-03-01T00:00:00.000Z').length === 0)
check('a session still running there is skipped', !plan.newSessions.some(s => !s.ended_at))
check('sessions moved to our game id', plan.newSessions.filter(s => s.game_id === 5).length === 2)
check('playtime grows only by what was added', plan.gameChanges.get(5)?.total_playtime_seconds === 1000 + 3600 + 1800, plan.gameChanges.get(5)?.total_playtime_seconds)
check('first played moves back, last played forward', plan.gameChanges.get(5)?.first_played_at === '2026-02-20T00:00:00.000Z' && plan.gameChanges.get(5)?.last_played_at === '2026-04-20T00:30:00.000Z')
check('a new game keeps its own playtime once', byName('PC Only').total_playtime_seconds === 7200)
check('achievement already here is not added', plan.newAchievements.filter(a => a.game_id === 5).map(a => a.steam_api_name).join() === 'A3')
check('earlier unlock wins, and points at the moved session', plan.unlockChanges.length === 1 && plan.unlockChanges[0].id === 1 && plan.unlockChanges[0].unlocked_at === '2026-02-20T00:30:00.000Z' && plan.unlockChanges[0].session_id < 0)
check('later unlock changes nothing', !plan.unlockChanges.some(c => c.id === 2))
check('new unlock points at its moved session', plan.newUnlocks.some(u => u.source === 'crack' && u.session_id < 0))
check('Game List: no duplicate of a game already here', !plan.newList.some(r => /Laptop|Wanted|Different/.test(r.name)))
check('Game List: twice in the file is added once', plan.newList.filter(r => r.steam_app_id === 888).length === 1)
check('Game List: this PC\'s status stays', ![...plan.listChanges.values()].some(c => 'status' in c))
check('Game List: empty fields are filled', plan.listChanges.get(2)?.rating === 9 && plan.listChanges.get(2)?.planned_month === '2026-12' && plan.listChanges.get(2)?.is_favorite === 1 && plan.listChanges.get(2)?.price_target_cents === 500)
check('Game List: a rating here is not replaced', !('rating' in (plan.listChanges.get(1) || {})))
check('Game List: a new row drops the old category', plan.newList.every(r => r.category_id === null))
check('Game List: a new row links our new game', plan.newList.find(r => r.name === 'PC Only')?.game_id === byName('PC Only').id)
check('Game List: new rows go after ours', plan.newList.every(r => r.display_order > 3))
check('counts: list', plan.counts.list.fresh === 2 && plan.counts.list.total === 5, JSON.stringify(plan.counts.list))
check('counts: library leaves archived games out', plan.counts.library.fresh === 2 && plan.counts.library.total === 4, JSON.stringify(plan.counts.library))
check('counts: new playtime and unlocks', plan.counts.library.seconds === 3600 + 1800 + 7200 && plan.counts.library.sessions === 3 && plan.counts.library.unlocks === 2, JSON.stringify(plan.counts.library))

// Same name under two Steam ids stays two games.
{
  const two = planMerge([{ games: [{ id: 1, name: 'Foo', steam_app_id: 2, exe_name: '' }] }], { games: [{ id: 1, name: 'Foo', steam_app_id: 1, exe_name: '' }] })
  check('same name, different Steam ids: two games', two.newGames.length === 1)
  const list = planMerge([{ game_list: [{ id: 1, name: 'Foo', steam_app_id: 2, status: 'want_to_play' }] }], { game_list: [{ id: 1, name: 'Foo', steam_app_id: 1, status: 'want_to_play' }] })
  check('same for a list row', list.newList.length === 1)
}

// The three questions in order, on an in-memory copy of what the database would hold.
function applyToMemory(tables, p) {
  const ids = new Map(); let next = 1000
  const real = (id) => (id != null && id < 0 ? ids.get(id) : id)
  const t = JSON.parse(JSON.stringify(tables))
  for (const g of p.newGames) { const id = next++; ids.set(g.id, id); t.games.push({ ...g, id }) }
  for (const [id, f] of p.gameChanges) Object.assign(t.games.find(g => g.id === id), f)
  for (const s of p.newSessions) { const id = next++; ids.set(s.id, id); t.sessions.push({ ...s, id, game_id: real(s.game_id) }) }
  for (const a of p.newAchievements) { const id = next++; ids.set(a.id, id); t.achievements.push({ ...a, id, game_id: real(a.game_id) }) }
  for (const u of p.newUnlocks) t.achievement_unlocks.push({ ...u, id: next++, achievement_id: real(u.achievement_id), session_id: real(u.session_id) })
  for (const c of p.unlockChanges) Object.assign(t.achievement_unlocks.find(u => u.id === c.id), { unlocked_at: c.unlocked_at, session_id: real(c.session_id) })
  for (const r of p.newList) t.game_list.push({ ...r, id: next++, game_id: real(r.game_id) })
  for (const [id, f] of p.listChanges) Object.assign(t.game_list.find(r => r.id === id), { ...f, ...('game_id' in f ? { game_id: real(f.game_id) } : {}) })
  return t
}
{
  const all = applyToMemory(local, plan)
  check('running it again adds nothing', planIsEmpty(planMerge([pc], all, { exists: () => true })), JSON.stringify([...planMerge([pc], all).gameChanges]))

  // Question 1 then question 2, what the window really does.
  const afterList = applyToMemory(local, planMerge([pc], local, { list: true, library: false }))
  check('Game List only: no games, sessions or achievements', afterList.games.length === local.games.length && afterList.sessions.length === local.sessions.length && afterList.achievements.length === local.achievements.length)
  check('Game List only: new rows are in, not linked to a game that is not here', afterList.game_list.find(r => r.name === 'PC Only')?.game_id === null)
  const q2 = planMerge([pc], afterList, { list: false, library: true })
  const afterBoth = applyToMemory(afterList, q2)
  const pcOnly = afterBoth.games.find(g => g.name === 'PC Only')
  check('then Library: the row from question 1 gets linked, not doubled', afterBoth.game_list.filter(r => r.steam_app_id === 300).length === 1 && afterBoth.game_list.find(r => r.steam_app_id === 300).game_id === pcOnly.id)
  check('then Library: same result as both at once', afterBoth.games.length === all.games.length && afterBoth.sessions.length === all.sessions.length && afterBoth.game_list.length === all.game_list.length)

  const onlyLib = applyToMemory(local, planMerge([pc], local, { list: false, library: true }))
  check('Library only: new games bring their rows', onlyLib.game_list.some(r => r.steam_app_id === 300))
  check('Library only: rows of other games stay out', !onlyLib.game_list.some(r => r.steam_app_id === 888))
  check('neither: nothing', planIsEmpty(planMerge([pc], local, { list: false, library: false })))

  // Two other PCs that both have the same game.
  const third = { games: [{ id: 50, name: 'PC Only', steam_app_id: 300, exe_name: 'p.exe', total_playtime_seconds: 100 }], sessions: [{ id: 1, game_id: 50, started_at: '2026-06-01T00:00:00.000Z', ended_at: '2026-06-01T00:01:40.000Z', duration_seconds: 100 }], game_list: [{ id: 9, game_id: 50, steam_app_id: 300, name: 'PC Only', status: 'finished' }] }
  const twoPcs = planMerge([pc, third], local, {})
  check('two PCs with one game: added once', twoPcs.newGames.filter(g => g.steam_app_id === 300).length === 1 && twoPcs.newList.filter(r => r.steam_app_id === 300).length === 1)
  check('two PCs with one game: both playtimes count', twoPcs.newGames.find(g => g.steam_app_id === 300).total_playtime_seconds === 7300)
  check('two PCs: the session sits on the one new game', twoPcs.newSessions.filter(s => s.started_at === '2026-06-01T00:00:00.000Z')[0].game_id === twoPcs.newGames.find(g => g.steam_app_id === 300).id)
}

// An empty PC and an empty backup.
{
  const fresh = planMerge([pc], { games: [], sessions: [], achievements: [], achievement_unlocks: [], game_list: [] }, {})
  check('empty PC: everything comes in', fresh.newGames.length === 5 && fresh.newList.length === 5, JSON.stringify([fresh.newGames.length, fresh.newList.length]))
  check('empty backup: nothing', planIsEmpty(planMerge([{ app: 'kozo', games: [] }], local, {})))
}

// Which game a save folder belongs to here.
{
  const resolve = gameResolver([pc], local.games)
  check('folder: by name', resolve('Laptop Only') === 4)
  check('folder: another spelling', resolve('Red Alert-2') === 6)
  check('folder: their name, our game, through the Steam id', resolve('Different Name, Same Id') === 5)
  check('folder: game not here', resolve('Nothing Like It') === null)
}
}

// ── A library file per PC, and what Drive has that this PC lacks ──────────────
console.log('\ngoogle drive files')
{
  const { pickLibraries, missingSaves } = require(path.join(__dirname, '..', 'electron', 'services', 'googleDrive.js'))
  const f = (name, install, at, games = 1, list = 1) => ({ name, install, at, games, list })
  check('library: this PC\'s own file is never offered', pickLibraries([f('a', 'me', '2')], 'me').length === 0)
  check('library: an empty file is not offered', pickLibraries([f('a', 'pc', '2', 0, 0)], 'me').length === 0)
  check('library: only a Game List still counts', pickLibraries([f('a', 'pc', '2', 0, 3)], 'me').length === 1)
  check('library: the newest file per PC', pickLibraries([f('old', 'pc', '1'), f('new', 'pc', '2')], 'me').map(x => x.name).join() === 'new')
  check('library: two PCs, newest first', pickLibraries([f('a', 'one', '1'), f('b', 'two', '2')], 'me').map(x => x.name).join() === 'b,a')
  check('library: an old shared file from this PC stays out', pickLibraries([f('Data/kozo-autobackup.json', 'me', '9'), f('b', 'two', '2')], 'me').map(x => x.name).join() === 'b')
  check('library: an old file with no install id still counts', pickLibraries([f('old', null, '1')], 'me').length === 1)

  const remote = new Map([
    ['Saves/G/vault/meta.json', { id: 'm', size: 10 }],
    ['Saves/G/vault/snapshots/s.json', { id: 's', size: 20 }],
    ['Saves/G/vault/blobs/here.gz', { id: 'h', size: 30 }],
    ['Saves/G/vault/blobs/new.gz', { id: 'n', size: 40 }],
    ['Saves/../evil.gz', { id: 'e', size: 1 }],
    ['Saves/G/..\\evil.gz', { id: 'e2', size: 1 }],
    ['Data/kozo-library-x.json', { id: 'd', size: 1 }],
  ])
  const items = missingSaves(remote, 'C:/root', (p) => /here\.gz$/.test(p))
  check('saves: only what this PC lacks, nothing else', items.map(i => i.id).join() === 'n,s,m', items.map(i => i.id).join())
  check('saves: pieces, then restore points, then the owner', items[0].id === 'n' && items[2].id === 'm')
}

// ── Where a restore point goes on another PC ──────────────────────────────────
console.log('\nsave paths')
{
  const { mapSource } = require(path.join(__dirname, '..', 'electron', 'services', 'saveVault.js'))
  const home = 'C:\\Users\\Laptop'
  check('path: another user name moves to this home', mapSource('C:\\Users\\Other\\AppData\\Roaming\\Game', home) === 'C:\\Users\\Laptop\\AppData\\Roaming\\Game')
  check('path: this home stays as written', mapSource('c:\\users\\laptop\\Saved Games\\X', home) === 'c:\\users\\laptop\\Saved Games\\X')
  check('path: Public is the same everywhere', mapSource('C:\\Users\\Public\\Documents\\X', home) === 'C:\\Users\\Public\\Documents\\X')
  check('path: a game folder stays', mapSource('D:\\Games\\X\\saves', home) === 'D:\\Games\\X\\saves')
  check('path: forward slashes', mapSource('C:/Users/Other/Game', home) === 'C:\\Users\\Laptop/Game')
  check('path: the home itself', mapSource('C:\\Users\\Other', home) === 'C:\\Users\\Laptop')
  check('path: a folder only starting with Users', mapSource('C:\\UsersOld\\Other\\X', home) === 'C:\\UsersOld\\Other\\X')
}

// ── A tool or an installer is not the game ────────────────────────────────────
console.log('\ntool exes')
{
  const { isHelperExe, pickBestExe } = require(path.join(__dirname, '..', 'electron', 'services', 'pcScanner.js'))
  for (const n of ['WorldBuilder.exe', 'CnCNet5_YR_Installer.exe', 'map-editor.exe', 'LevelEditor.exe', 'Editor.exe', 'game_editor.exe', 'Game_Setup.exe', 'ModKit.exe', 'unity_modtools.exe', 'crs-handler.exe']) check('tool: ' + n, isHelperExe(n))
  for (const n of ['Halls of Torment.exe', 'AlienShooter.exe', 'Atomic Exile.exe', 'generals.exe', 'gamemd.exe', 'Cyberpunk2077.exe', 'Builder.exe', 'WorldBox.exe', 'Fortnite.exe', 'Setup Your Base.exe', 'Red Dead Redemption 2.exe', 'Editorial.exe']) check('game: ' + n, !isHelperExe(n))
  check('tool: Scan PC prefers the game when there is one', pickBestExe([{ name: 'WorldBuilder.exe', size: 9e8 }, { name: 'generals.exe', size: 1e6 }], 'Zero Hour') === 'generals.exe')
  check('tool: a folder with only a tool still has an answer', pickBestExe([{ name: 'WorldBuilder.exe', size: 1 }], 'Zero Hour') === 'WorldBuilder.exe')
}

// ── Background color ───────────────────────────────────────────────────────
console.log('\nbackground color')
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'bgTone.js'), 'utf8').replace(/export function/g, 'function')
  const { bgTone, bgToneHex } = new Function(src + '; return { bgTone, bgToneHex }')()
  const hexOf = (h, s, v) => {
    const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0') }
    return `#${f(5)}${f(3)}${f(1)}`
  }
  // The whole color square, for a few hues.
  const grid = []
  for (const h of [0, 120, 240, 300]) for (let s = 0; s <= 10; s++) for (let v = 0; v <= 10; v++) grid.push(hexOf(h, s / 10, v / 10))
  check('bg: a dark or colorful pick stays dark', grid.filter(c => !bgTone(c).light).every(c => { const t = bgTone(c); return t.l >= 4 && t.l <= 16 && t.s <= 55 }))
  check('bg: a light pick stays light', grid.filter(c => bgTone(c).light).every(c => { const t = bgTone(c); return t.l >= 84 && t.l <= 100 && t.s <= 70 }))
  {
    const L = (hex) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
    const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
    const lights = []
    for (let h = 0; h < 360; h += 15) for (const s of [0, 0.5, 1]) for (const l of [0.7, 0.8, 0.9, 1]) {
      const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0') }
      lights.push(bgToneHex('#' + f(0) + f(8) + f(4)))
    }
    const worst = Math.min(...lights.map(b => ratio('#50536a', b)))
    check('bg: on a light pick the quiet text is readable', worst >= 4, worst.toFixed(2))
    check('bg: on a light pick the main text is easy to read', Math.min(...lights.map(b => ratio('#15161d', b))) >= 7)
    check('bg: a pale pink stays pink', (() => { const x = bgToneHex('#ffd6e0'); return parseInt(x.slice(1, 3), 16) - parseInt(x.slice(3, 5), 16) >= 25 })(), bgToneHex('#ffd6e0'))
  }
  check('bg: white gives white', bgToneHex('#ffffff') === '#ffffff' && bgTone('#ffffff').light, bgToneHex('#ffffff'))
  check('bg: light gray and pale pink give a light KoZo', bgTone('#d0d0d0').light && bgTone('#ffd6e0').light)
  check('bg: pure red, black and mid gray stay dark', !bgTone('#ff0000').light && !bgTone('#000000').light && !bgTone('#808080').light)
  check('bg: white, gray and black all differ', new Set(['#ffffff', '#808080', '#000000'].map(bgToneHex)).size === 3, ['#ffffff', '#808080', '#000000'].map(bgToneHex).join())
  // The bug: most of the square landed on one color.
  const row = (h, v) => new Set(Array.from({ length: 11 }, (_, s) => bgToneHex(hexOf(h, s / 10, v)))).size
  check('bg: along the top of the square the color keeps changing', row(0, 1) >= 10, row(0, 1))
  const down = new Set(Array.from({ length: 11 }, (_, v) => bgToneHex(hexOf(200, 0.8, v / 10)))).size
  check('bg: down the square the color keeps changing', down >= 10, down)
  const hues = new Set([0, 60, 120, 180, 240, 300].map(h => bgToneHex(hexOf(h, 1, 1)))).size
  check('bg: every hue is its own color', hues === 6, hues)
  const red = bgToneHex('#ff0000')
  check('bg: red comes out red', parseInt(red.slice(1, 3), 16) > parseInt(red.slice(3, 5), 16) * 2, red)
  const blue = bgToneHex('#2060ff')
  check('bg: blue comes out blue', parseInt(blue.slice(5, 7), 16) > parseInt(blue.slice(1, 3), 16) * 2, blue)
  check('bg: a broken value still gives a color', bgToneHex('nonsense').startsWith('#'))
  // Contrast against the lightest surface a pick can reach (+5.5% lightness).
  const lum = (hex) => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const lightest = hexOf(0, 0, 0.215)
  check('bg: quiet text is readable on the lightest shade', contrast('#9292b0', lightest) >= 3, contrast('#9292b0', lightest).toFixed(2))
  check('bg: main text is easy to read on it', contrast('#ececf8', lightest) >= 7, contrast('#ececf8', lightest).toFixed(2))
}

// ── Another PC has something new ───────────────────────────────────────────
console.log('\ndrive news')
{
  const { newsSince } = require(path.join(__dirname, '..', 'electron', 'services', 'libraryMerge.js'))
  const zero = { list: 0, games: 0, sessions: 0, unlocks: 0, saves: 0 }
  check('news: nothing there, nothing new', newsSince(zero, null).isNew === false)
  check('news: a first look at another PC is news', newsSince({ ...zero, list: 2 }, null).isNew === true)
  check('news: the same counts are not news twice', newsSince({ ...zero, list: 2 }, { ...zero, list: 2 }).isNew === false)
  check('news: one more game is news', newsSince({ ...zero, list: 3 }, { ...zero, list: 2 }).isNew === true)
  check('news: fewer is not news (a yes brought them in)', newsSince({ ...zero, list: 1 }, { ...zero, list: 30 }).isNew === false)
  const after = newsSince(zero, { ...zero, list: 30 })
  check('news: after a yes, what comes later is new again', newsSince({ ...zero, list: 1 }, after.seen).isNew === true)
  check('news: a saved game counts too', newsSince({ ...zero, saves: 1 }, zero).isNew === true)
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'lib', 'driveNews.js'), 'utf8')
    .replace(/^import .*$/m, '').replace(/export function/g, 'function')
  const { driveNewsText } = new Function('formatPlaytime', src + '; return { driveNewsText }')((s) => `${Math.round(s / 3600)}h`)
  const pc = [{ name: 'DESKTOP-ABC' }]
  check('news: the bar names the PC and what is new', driveNewsText({ pcs: pc, list: { fresh: 2 }, library: { fresh: 1, seconds: 7200, sessions: 3, unlocks: 1 }, saves: { games: 1 } })
    === 'DESKTOP-ABC has something new: 2 games on the Game List, 1 game in the Library, 2h of play, 1 achievement, saves for 1 game.')
  check('news: several PCs read right', driveNewsText({ pcs: [{ name: 'A' }, { name: 'B' }], list: { fresh: 1 } }) === 'Your other PCs have something new: 1 game on the Game List.')
  check('news: no dashes in its text', !/[\u2013\u2014]/.test(driveNewsText({ pcs: pc, list: { fresh: 1 } })))
}

// ── Play and the watched file never starts ─────────────────────────────────
console.log('\nplay check')
{
  const { candidatesFor, launchAfterPick } = require(path.join(__dirname, '..', 'electron', 'services', 'launchCheck.js'))
  const base = { watched: 'launcher.exe', deny: new Set(['explorer.exe', 'smartscreen.exe']), isHelper: (n) => /crashpad|unins|editor/i.test(n), isGame: (f) => !/cncnetqm|clientdx/i.test(f) }
  const found = candidatesFor({ ...base,
    running: [{ name: 'gamemd.exe' }, { name: 'Discord.exe' }, { name: 'smartscreen.exe' }, { name: 'newtool.exe' }, { name: 'CnCNetQM.exe' }, { name: 'clientdx.exe' }, { name: 'editor.exe' }],
    inFolder: [{ name: 'gamemd.exe', dir: 'C:\\G' }, { name: 'launcher.exe', dir: 'C:\\G' }, { name: 'editor.exe', dir: 'C:\\G' }, { name: 'CnCNetQM.exe', dir: 'C:\\G\\Qt' }, { name: 'clientdx.exe', dir: 'C:\\G\\R' }],
  })
  check('check: a running game file in the game folder is offered', found[0]?.exe_name === 'gamemd.exe' && found[0].install_path === 'C:\\G')
  check('check: nothing else', found.length === 1, found.map(f => f.exe_name).join())
  check('check: a Windows program that started after Play is never offered', !found.some(f => f.exe_name === 'smartscreen.exe'))
  check('check: an online client in the folder is not the game', !found.some(f => /cncnetqm|clientdx/i.test(f.exe_name)))
  check('check: what merely started after Play is not offered', !found.some(f => f.exe_name === 'newtool.exe'))
  check('check: not running, not offered', candidatesFor({ ...base, running: [], inFolder: [{ name: 'gamemd.exe', dir: 'C:\\G' }] }).length === 0)
  check('check: at most five', candidatesFor({ ...base, running: Array.from({ length: 9 }, (_, i) => ({ name: `g${i}.exe` })), inFolder: Array.from({ length: 9 }, (_, i) => ({ name: `g${i}.exe`, dir: 'C:\\G' })) }).length === 5)
  const pick = { oldFile: 'C:\\G\\launcher.exe', oldExists: true, newFile: 'C:\\G\\game.exe', oldIsTool: false, hasLauncher: false }
  check('pick: what started the game keeps starting it', launchAfterPick(pick) === 'C:\\G\\launcher.exe')
  check('pick: not if it is gone', launchAfterPick({ ...pick, oldExists: false }) === null)
  check('pick: not if it was a tool', launchAfterPick({ ...pick, oldIsTool: true }) === null)
  check('pick: not when a launcher is already set', launchAfterPick({ ...pick, hasLauncher: true }) === null)
  check('pick: not when it is the same file', launchAfterPick({ ...pick, newFile: 'c:\\g\\LAUNCHER.exe' }) === null)
}

// ── Is it the game? What Scan PC may use ─────────────────────────────────────
console.log('\ngame file check')
{
  const fs = require('fs')
  const ec = require(path.join(__dirname, '..', 'electron', 'services', 'exeCheck.js'))
  const scanner = require(path.join(__dirname, '..', 'electron', 'services', 'pcScanner.js'))
  // The smallest program the reader accepts: headers, one section, an import table.
  const fakeExe = (dlls, pad = 0) => {
    const raw = 0x400, va = 0x1000
    const desc = Buffer.alloc((dlls.length + 1) * 20)
    let at = desc.length
    const names = dlls.map((d, i) => { const b = Buffer.from(d + '\0', 'latin1'); desc.writeUInt32LE(va + at, i * 20 + 12); at += b.length; return b })
    const body = Buffer.concat([desc, ...names])
    const head = Buffer.alloc(raw)
    head.write('MZ', 0, 'latin1'); head.writeUInt32LE(0x80, 0x3c)
    head.write('PE\0\0', 0x80, 'latin1'); head.writeUInt16LE(1, 0x86); head.writeUInt16LE(0xe0, 0x94)
    head.writeUInt16LE(0x10b, 0x98)
    head.writeUInt32LE(va, 0x98 + 96 + 8); head.writeUInt32LE(body.length, 0x98 + 96 + 12)
    const sec = 0x98 + 0xe0
    head.writeUInt32LE(body.length, sec + 8); head.writeUInt32LE(va, sec + 12); head.writeUInt32LE(body.length, sec + 16); head.writeUInt32LE(raw, sec + 20)
    return Buffer.concat([head, body, Buffer.alloc(pad)])
  }
  // Not under Temp: Scan PC never looks inside a temp folder.
  const root = path.join(require('os').homedir(), `kozo-scan-test-${process.pid}`)
  const put = (rel, buf = Buffer.alloc(16)) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return f }
  try {
    const draws = put('reader/game.exe', fakeExe(['KERNEL32.dll', 'ddraw.dll', 'DSOUND.dll']))
    const plain = put('reader/plain.exe', fakeExe(['KERNEL32.dll', 'USER32.dll']))
    check('reader: lists what a program loads', ec.readImports(draws)?.dlls.join() === 'kernel32.dll,ddraw.dll,dsound.dll', ec.readImports(draws)?.dlls.join())
    check('reader: something that is no program', ec.readImports(put('reader/x.exe', Buffer.from('not a program'))) === null)
    check('reader: a file that is not there', ec.readImports(path.join(root, 'nope.exe')) === null)
    check('reader: graphics or game sound count', ec.loadsGameParts(['d3d11.dll']) && ec.loadsGameParts(['dinput8.dll']) && ec.loadsGameParts(['binkw32.dll']) && ec.loadsGameParts(['steam_api64.dll']))
    check('reader: everyday libraries do not', !ec.loadsGameParts(['kernel32.dll', 'user32.dll', 'mscoree.dll', 'qt5core.dll']))
    check('reader: an engine starter counts by the files beside it', ec.engineBeside('Bar.exe', ['UnityPlayer.dll']) && ec.engineBeside('Bar.exe', ['Bar.pck']) && ec.engineBeside('Bar.exe', ['Bar_Data']))
    check('reader: and nothing else beside it does', !ec.engineBeside('Bar.exe', ['readme.txt', 'foo.dll']))
    check('reader: the two kinds of file', ec.looksLikeGame(draws) && !ec.looksLikeGame(plain))

    // The folder that went wrong: only a map editor and a settings helper, a wrapper around it.
    put('zh-wrapper/Zero Hour/WorldBuilder.exe', fakeExe(['mss32.dll']))
    put('zh-wrapper/Zero Hour/RedistInstallers/Options_Helper/Options_INI_Helper.exe', fakeExe(['USER32.dll']))
    put('zh-wrapper/Zero Hour/_CommonRedist/DirectX/DXSETUP.exe', fakeExe(['USER32.dll']))
    const [zh] = scanner.scanFolder(path.join(root, 'zh-wrapper'))
    check('scan: only tools means no game file', zh?.no_game_file === true && zh.exe_name === null, JSON.stringify(zh))
    check('scan: and never a helper', zh?.exe_name !== 'Options_INI_Helper.exe')
    check('scan: an installer folder is not looked in', !scanner.collectExes(path.join(root, 'zh-wrapper'), 4).some(e => e.name === 'Options_INI_Helper.exe'))
    check('tool: a helper by name', scanner.isHelperExe('Options_INI_Helper.exe') && scanner.isHelperExe('settings-helper.exe'))

    // Red Alert 2: the 5 MB game beside a 100 MB installer and an online client.
    put('ra2/Game/gamemd-spawn.exe', fakeExe(['ddraw.dll', 'DSOUND.dll'], 5000))
    put('ra2/Game/CnCNet5_YR_Installer.exe', fakeExe(['KERNEL32.dll'], 90000))
    put('ra2/Game/CnCNetYRLauncher.exe', fakeExe(['mscoree.dll']))
    put('ra2/Game/YuriScreenResolution.exe', fakeExe(['USER32.dll'], 9000))
    put('ra2/Game/Syringe.exe', fakeExe(['KERNEL32.dll'], 8000))
    put('ra2/Game/Qt/CnCNetQM.exe', fakeExe(['Qt5Core.dll'], 40000))
    const [ra2] = scanner.scanFolder(path.join(root, 'ra2'))
    check('scan: what loads a game beats what is big', ra2?.exe_name === 'gamemd-spawn.exe', ra2?.exe_name)
    check('scan: and it is sure of it', !ra2?.exe_unsure && !ra2?.no_game_file)
    check('scan: its own folder', ra2?.install_path === path.join(root, 'ra2', 'Game'), ra2?.install_path)

    put('Halls Game/Halls Game.exe', fakeExe(['KERNEL32.dll']))
    const [named] = scanner.scanFolder(path.join(root, 'Halls Game'))
    check('scan: an exe named after the game is fine with a small starter', named?.exe_name === 'Halls Game.exe' && !named.exe_unsure)

    put('unity-one/Bar.exe', fakeExe(['KERNEL32.dll'])); put('unity-one/UnityPlayer.dll')
    const [unity] = scanner.scanFolder(path.join(root, 'unity-one'))
    check('scan: an engine starter is fine', unity?.exe_name === 'Bar.exe' && !unity.exe_unsure)

    put('odd-folder/Thing.exe', fakeExe(['KERNEL32.dll']))
    const [odd] = scanner.scanFolder(path.join(root, 'odd-folder'))
    check('scan: no sign of a game means not sure, never ticked for you', odd?.exe_name === 'Thing.exe' && odd.exe_unsure === true, JSON.stringify(odd))

    put('deep-one/Launcher.exe', fakeExe(['KERNEL32.dll']))
    put('deep-one/bin/Real.exe', fakeExe(['d3d9.dll']))
    const [deep] = scanner.scanFolder(path.join(root, 'deep-one'))
    check('scan: the game further in beats a starter with no sign', deep?.exe_name === 'Real.exe' && deep.install_path === path.join(root, 'deep-one', 'bin'), deep?.exe_name)

    put('direct-one/Setup_Tool_Setup.exe', fakeExe(['KERNEL32.dll']))
    put('direct-one/bin/Good.exe', fakeExe(['d3d9.dll']))
    const [direct] = scanner.scanFolder(path.join(root, 'direct-one'))
    check('scan: a tool in the folder does not beat the game further in', direct?.exe_name === 'Good.exe', direct?.exe_name)

    // Same game?
    const same = scanner.sameGameFolder
    check('folder: the same one', same('C:\\Games\\Foo', 'c:/games/foo/'))
    check('folder: one inside the other', same('C:\\Games\\Foo\\Bar', 'C:\\Games\\Foo') && same('C:\\Games\\Foo', 'C:\\Games\\Foo\\Redist\\Helper'))
    check('folder: side by side is not', !same('C:\\Games\\Foo', 'C:\\Games\\Foobar'))
    check('folder: a library of games is not one game', !same('C:\\Games', 'C:\\Games\\Foo') && !same('C:\\', 'C:\\Foo'))
    check('folder: nothing is not a match', !same('', 'C:\\Games\\Foo') && !same(null, null))

    const sgdb = require(path.join(__dirname, '..', 'electron', 'services', 'steamGridDb.js'))
    check('name: punctuation does not make another game', sgdb.nameKey('Command and Conquer Generals Zero Hour') === sgdb.nameKey('Command & Conquer: Generals - Zero Hour'))
    check('name: other games stay other', sgdb.nameKey('Red Alert 2') !== sgdb.nameKey('Red Alert 3'))
    check('name: the real name when the search is sure', sgdb.officialName({ name: 'Command & Conquer: Generals – Zero Hour', score: 1 }) === 'Command & Conquer: Generals - Zero Hour')
    check('name: not when it is not', sgdb.officialName({ name: 'Something', score: 0.6 }) === null && sgdb.officialName(null) === null)

    // Scan PC and the launchers are one list.
    const { mergeLauncherGames } = require(path.join(__dirname, '..', 'electron', 'services', 'launcherImport.js'))
    const merged = mergeLauncherGames(
      [{ name: 'Folder Only', install_path: 'C:\\Games\\A' }, { name: 'Hades', install_path: 'D:\\Epic Games\\Hades\\', exe_name: 'x.exe', detected_type: 'Cracked' }],
      [{ name: 'Hades', install_path: 'd:/epic games/hades', detected_type: 'Epic', launch_uri: 'com.epicgames://x' }, { name: 'Forza', install_path: 'E:\\Xbox\\Forza', detected_type: 'Xbox' }])
    check('launchers: a game in both is the launcher\'s', merged.filter(g => g.name === 'Hades').length === 1 && merged.find(g => g.name === 'Hades').launch_uri === 'com.epicgames://x')
    check('launchers: the rest are added', merged.length === 3 && merged.some(g => g.name === 'Forza' && g.isInstalled))
    check('launchers: folder games stay', merged[0].name === 'Folder Only')

  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// ── Names, covers, blank cards, news previews ──────────────────────────────
console.log('\nnames and covers')
{
  const scanner = require(path.join(__dirname, '..', 'electron', 'services', 'pcScanner.js'))
  check('name: hyphens for spaces', scanner.tidyFolderName('Red-Alert-2-Yuris-Revenge') === 'Red Alert 2 Yuris Revenge')
  check('name: underscores too', scanner.tidyFolderName('Some_Game_Name') === 'Some Game Name')
  check('name: one hyphen is a real name', scanner.tidyFolderName('Half-Life') === null)
  check('name: spaces already read fine', scanner.tidyFolderName('Spider-Man Miles-Morales Edition') === null)
  check('name: a scan cleans the download site off too', scanner.cleanGameName('Command-and-Conquer-Generals-Zero-Hour-AnkerGames') === 'Command and Conquer Generals Zero Hour', scanner.cleanGameName('Command-and-Conquer-Generals-Zero-Hour-AnkerGames'))
  check('name: a scan still reads Half-Life', scanner.cleanGameName('Half-Life') === 'Half-Life')
  check('tool: a screen resolution tool is not the game', scanner.isHelperExe('YuriScreenResolution.exe'))
  check('junk: a Redist folder is no game', scanner.isJunkFolder('Redist'))

  const sgdb = require(path.join(__dirname, '..', 'electron', 'services', 'steamGridDb.js'))
  // What the search really answered for these names.
  const full = [
    { id: 5446169, name: 'Command & Conquer and The Covert Operations' },
    { id: 5446171, name: 'Command & Conquer: Red Alert 2 and Yuri’s Revenge' },
    { id: 5446173, name: 'Command & Conquer: Tiberian Sun and Firestorm' },
    { id: 1560, name: 'Command & Conquer: Red Alert 3' },
  ]
  const lastWords = [
    { id: 5249925, name: 'Command & Conquer: Generals – Zero Hour' },
    { id: 5268281, name: 'Command & Conquer: Generals – Zero Hour World Builder' },
    { id: 4889513, name: 'Generals & Rulers' },
  ]
  const ra2 = [
    { id: 38629, name: "Command & Conquer: Red Alert 2 - Yuri's Revenge" },
    { id: 5334386, name: "Command & Conquer: Red Alert 2 - Yuri's Revenge - Red-Resurrection" },
    { id: 5255740, name: 'Command & Conquer: Red Alert 2' },
  ]
  const zh = 'Command and Conquer Generals Zero Hour'
  check('cover: the wrong C&C game is not good enough', sgdb.bestMatch(zh, full) === null)
  check('cover: the right one wins over its map editor', sgdb.bestMatch(zh, lastWords)?.id === 5249925)
  check('cover: Red Alert 2 finds Yuri\'s Revenge', sgdb.bestMatch('Red Alert 2 Yuris Revenge', ra2)?.id === 38629)
  check('cover: an exact name is a full match', sgdb.matchScore('Alien Shooter', 'Alien Shooter') === 1)
  check('cover: a sequel is not the same game', sgdb.bestMatch('Alien Shooter', [{ id: 2, name: 'Alien Shooter 2 Conscription' }, { id: 1, name: 'Alien Shooter' }])?.id === 1)
  check('cover: nothing close, nothing picked', sgdb.bestMatch('Atomic Exile', [{ id: 1, name: 'Atomic Heart' }, { id: 2, name: 'Exile' }]) === null)

  const { isBlankRow } = require(path.join(__dirname, '..', 'electron', 'db', 'queries', 'gameList.js'))
  const blank = { status: 'want_to_play' }
  check('row: nothing to show and nothing said is blank', isBlankRow(blank) === true)
  for (const [what, extra] of [['a Steam id', { steam_app_id: 5 }], ['art', { banner_url: 'x' }], ['a rating', { rating: 7 }], ['a plan', { planned_month: '2026-11' }], ['a favorite', { is_favorite: 1 }], ['a price alert', { price_target_cents: 100 }], ['a tracked release', { release_watch: 1 }], ['finished', { status: 'finished' }]]) {
    check(`row: ${what} keeps it`, isBlankRow({ ...blank, ...extra }) === false)
  }

  const { excerptOf } = require(path.join(__dirname, '..', 'electron', 'services', 'steamNews.js'))
  const p = (text) => ({ type: 'p', text })
  check('news: the greeting is skipped', excerptOf([p('Dear Adventurers,'), p('We fixed the crash on the boss.')]) === 'We fixed the crash on the boss.')
  check('news: other greetings too', excerptOf([p('Hello everyone!'), p('Patch time.')]) === 'Patch time.' && excerptOf([p('Hi all,'), p('Patch time.')]) === 'Patch time.' && excerptOf([p('Dear Community,'), p('Patch time.')]) === 'Patch time.')
  check('news: a short sign of a greeting keeps real text', excerptOf([p('Hi-Fi RUSH gets a new mode today, and it is free.')]).startsWith('Hi-Fi RUSH'))
  check('news: a post that is only a greeting still says it', excerptOf([p('Dear Adventurers,')]) === 'Dear Adventurers,')
}

// ── Is a Steam account's data open? ───────────────────────────────────────────
console.log('\nsteam privacy')
{
  const steam = require(path.join(__dirname, '..', 'electron', 'services', 'steamApi.js'))
  const xml = (state) => `<profile><steamID64>1</steamID64><privacyState>${state}</privacyState><visibilityState>3</visibilityState></profile>`
  check('profile page: public', steam.privacyFromProfileXml(xml('public')) === 'public')
  check('profile page: private', steam.privacyFromProfileXml(xml('private')) === 'private')
  check('profile page: friends only counts as closed', steam.privacyFromProfileXml(xml('friendsonly')) === 'private')
  check('profile page: wrapped in CDATA', steam.privacyFromProfileXml('<privacyState><![CDATA[public]]></privacyState>') === 'public')
  check('profile page: no answer', steam.privacyFromProfileXml('<html>busy</html>') === null && steam.privacyFromProfileXml(null) === null)
  check('owned games: a list means open', steam.privacyFromOwnedGames({ response: { game_count: 36, games: [] } }) === 'public')
  check('owned games: no games is still open', steam.privacyFromOwnedGames({ response: { game_count: 0 } }) === 'public')
  check('owned games: an empty answer means closed', steam.privacyFromOwnedGames({ response: {} }) === 'private')
  check('owned games: no answer', steam.privacyFromOwnedGames(null) === null && steam.privacyFromOwnedGames({}) === null)
}

// ── The version of a game's files ─────────────────────────────────────────────
console.log('\ngame version')
{
  const v = require(path.join(__dirname, '..', 'electron', 'services', 'gameVersion.js'))

  // A VS_VERSIONINFO block by hand, laid out as Windows lays it out.
  const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  const wide = (t) => Buffer.from(t + '\0', 'utf16le')
  const node = (key, value, isText, children = []) => {
    const head = pad(Buffer.concat([Buffer.alloc(6), wide(key)]))
    const body = value ? pad(value) : Buffer.alloc(0)
    const kids = Buffer.concat(children.map(pad))
    const all = Buffer.concat([head, body, kids])
    all.writeUInt16LE(all.length, 0)
    all.writeUInt16LE(value ? (isText ? value.length / 2 : value.length) : 0, 2)
    all.writeUInt16LE(isText ? 1 : 0, 4)
    return all
  }
  const fixedInfo = Buffer.alloc(52)
  fixedInfo.writeUInt32LE(0xFEEF04BD, 0)
  fixedInfo.writeUInt32LE((3 << 16) | 4, 8)
  fixedInfo.writeUInt32LE((5 << 16) | 6, 12)
  const str = (k, t) => node(k, wide(t), true)
  const block = node('VS_VERSION_INFO', fixedInfo, false, [
    node('StringFileInfo', null, true, [node('040904B0', null, true, [str('FileVersion', '2, 5, 0, 1'), str('ProductName', 'My Game')])]),
    node('VarFileInfo', null, true, [node('Translation', Buffer.from([9, 4, 0xb0, 4]), false)]),
  ])
  const parsed = v.parseVersionBlock(block)
  check('exe version: the numbers', parsed.fixed === '3.4.5.6', parsed.fixed)
  check('exe version: the text', parsed.strings.FileVersion === '2, 5, 0, 1' && parsed.strings.ProductName === 'My Game', JSON.stringify(parsed.strings))
  check('exe version: a broken block gives nothing, no crash', Object.keys(v.parseVersionBlock(Buffer.from([255, 255, 0, 0, 1, 0, 65, 0])).strings).length === 0)
  check('exe version: the text wins over the numbers', v.exeVersion(parsed) === '2.5.0.1', v.exeVersion(parsed))
  check('exe version: numbers when there is no text', v.exeVersion({ fixed: '3.4.5.6', strings: {} }) === '3.4.5.6')

  if (process.platform === 'win32') {
    const ping = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE')
    const real = v.readExeVersion(ping)
    check('exe version: read from a real Windows file', /^\d+\.\d+/.test(v.cleanVersion(real?.strings?.FileVersion) || ''), real?.strings?.FileVersion)
  }
  check('exe version: a file that is not an exe', v.readExeVersion(__filename) === null)
  check('exe version: a missing file', v.readExeVersion('C:\\no\\such\\file.exe') === null)

  check('clean: commas', v.cleanVersion('2, 5, 0, 1') === '2.5.0.1')
  check('clean: trailing zeros go', v.cleanVersion('1.2.0.0') === '1.2')
  check('clean: a real zero stays', v.cleanVersion('0.5.1.3') === '0.5.1.3' && v.cleanVersion('1.0.0.7') === '1.0.0.7')
  check('clean: placeholders are no version', v.cleanVersion('1.0.0.0') === null && v.cleanVersion('0.0.0.0') === null)
  check('clean: nothing', v.cleanVersion('') === null && v.cleanVersion(null) === null && v.cleanVersion('abc') === null)

  const stamp = (strings) => v.exeVersion({ strings, fixed: null })
  check('engine: Unreal\'s own version is not the game\'s', stamp({ FileVersion: '4.27.2.0', ProductName: 'UnrealGame' }) === null)
  check('engine: nor Epic\'s', stamp({ FileVersion: '5.3.2.0', CompanyName: 'Epic Games, Inc.' }) === null)
  check('engine: nor Unity\'s', stamp({ FileVersion: '2021.3.16.1', ProductName: 'Some Game' }) === null && stamp({ FileVersion: '6.0.1.2', FileDescription: 'Unity Player' }) === null)
  check('engine: a game\'s own stays', stamp({ FileVersion: '0.5.1.3', ProductName: 'Atomic Exile' }) === '0.5.1.3')

  const branches = '[{"name":"experimental","build_id":99},{"name":"public","build_id":21054390,"time_updated":1764856145}]'
  check('branches: the public build', v.buildFromBranches(branches).build === 21054390)
  check('branches: its date', new Date(v.buildFromBranches(branches).date).toISOString().startsWith('2025-12-04'))
  check('branches: broken file', v.buildFromBranches('{nope') === null && v.buildFromBranches('[]') === null)
  const acf = '"AppState"\n{\n\t"appid"\t\t"10"\n\t"LastUpdated"\t\t"1764856145"\n\t"buildid"\t\t"123456"\n}'
  check('manifest: build and date', v.buildFromManifest(acf).build === 123456 && v.buildFromManifest(acf).date === 1764856145000)
  check('manifest: none', v.buildFromManifest('{}') === null)
  check('folder: a version', v.versionInFolder('Game.Name.v1.2.3-RUNE') === '1.2.3' && v.versionInFolder('Game Name v1.05') === '1.05' && v.versionInFolder('Game_v2_1') === '2.1')
  check('folder: none', v.versionInFolder('Atomic.Exile') === null && v.versionInFolder('Dev2 Tools') === null && v.versionInFolder('Halo 3.5 Remake') === null)

  check('title: a version', v.versionInTitle('Update 0.5.4.7') === '0.5.4.7' && v.versionInTitle('Hotfix 0.5.4.6') === '0.5.4.6' && v.versionInTitle('Patch v1.2 is live') === '1.2' && v.versionInTitle('What is new in 1.4.2') === '1.4.2')
  check('title: a date is not a version', v.versionInTitle('HoT Patch | 2026-10-29') === null)
  check('title: plain words', v.versionInTitle('Low FPS bug fixed.') === null && v.versionInTitle('New version!') === null && v.versionInTitle('Top 3.5 reasons') === null)

  const post = (title, date, patch = true) => ({ title, date, patch })
  check('news: the newest patch, by date', v.newsFacts([post('Update 1.1', 100), post('Update 1.2', 200), post('Sale!', 300, false)]).version === '1.2')
  check('news: its date, patch notes only', v.newsFacts([post('Update 1.2', 200), post('Sale!', 300, false)]).at === 200)
  check('news: a number from the last few patches', v.newsFacts([post('Hotfix', 300), post('Update 1.2', 200)]).version === '1.2')
  check('news: an old number doesn\'t count', v.newsFacts([post('Fix', 500), post('Fix', 400), post('Fix', 300), post('Update 1.2', 200)]).version === null)
  check('news: nothing', v.newsFacts([post('Sale!', 300, false)]) === null && v.newsFacts(null) === null)

  check('compare: by number', v.compareVersions('1.10', '1.9') === 1 && v.compareVersions('0.5.1.3', '0.5.4.7') === -1)
  check('compare: missing parts are zero', v.compareVersions('1.2', '1.2.0') === 0)

  const day = 86400000, jan = Date.UTC(2026, 0, 1)
  check('state: an old build is behind', v.versionState({ build: 21054390 }, { build: 26295339 }) === 'behind')
  check('state: the same build is current', v.versionState({ build: 5 }, { build: 5 }) === 'current')
  check('state: a newer build is current', v.versionState({ build: 6 }, { build: 5 }) === 'current')
  check('state: an old version number is behind', v.versionState({ version: '0.5.1.3' }, { version: '0.5.4.7' }) === 'behind')
  check('state: a build beats a version number', v.versionState({ build: 5, version: '1.0.1' }, { build: 5, version: '9.9' }) === 'current')
  check('state: a date only says maybe', v.versionState({ date: jan }, { at: jan + 30 * day }) === 'maybe')
  check('state: a close date says nothing', v.versionState({ date: jan }, { at: jan + day }) === 'unknown')
  check('state: a date never says up to date', v.versionState({ date: jan + 30 * day }, { at: jan }) === 'unknown')
  check('state: nothing from Steam', v.versionState({ build: 5 }, null) === 'unknown')

  const behind = v.versionSummary({ version: '0.5.1.3', build: null, date: Date.UTC(2025, 11, 15, 12) }, { build: 26226397, at: Date.UTC(2026, 9, 26, 12), version: '0.5.4.7' })
  check('tag: shows the version', behind.text === 'v0.5.1.3' && behind.state === 'behind')
  check('tag: says both sides', /0\.5\.1\.3/.test(behind.hint) && /0\.5\.4\.7/.test(behind.hint) && /Oct 26, 2026/.test(behind.hint), behind.hint)
  check('tag: a build', v.versionSummary({ version: null, build: 21054390, date: null }, null).text === 'Build 21054390')
  check('tag: only a date', /^Files from \w+ 2018$/.test(v.versionSummary({ version: null, build: null, date: Date.UTC(2018, 0, 31, 12) }, null).text))
  const maybe = v.versionSummary({ version: '2.5.0.1', build: null, date: Date.UTC(2018, 0, 31, 12) }, { build: 3863653, at: Date.UTC(2019, 4, 28, 12), version: null })
  check('tag: a date comparison says it can be wrong', maybe.state === 'maybe' && /another store/.test(maybe.hint), maybe.hint)
  check('tag: nothing known, no tag', v.versionSummary({ version: null, build: null, date: null }, null) === null && v.versionSummary(null, null) === null)
  check('tag: no dashes in its text', ![behind, maybe].some(x => /[\u2013\u2014]/.test(x.text + x.hint)))
}

// Still on this PC? Called from the closing async block below.
async function installCheckTests() {
  const fs = require('fs')
  const ic = require(path.join(__dirname, '..', 'electron', 'services', 'installCheck.js'))
  const root = path.join(require('os').tmpdir(), `kozo-install-test-${process.pid}`)
  const put = (rel) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f }
  const has = async (rel, more = {}) => ic.hasGameFile({ id: Math.random(), install_path: path.join(root, rel), ...more })
  try {
    put('kept/Kept.exe')
    put('uninstalled/saves/slot1.sav')
    put('uninstalled/unins000.exe')
    put('nested/bin/x64/Deep.exe')
    put('launcher-only/start.bat')
    const inst = {
      kept: await has('kept', { exe_name: 'Kept.exe' }),
      left: await has('uninstalled', { exe_name: 'Kept.exe' }),
      nested: await has('nested', { exe_name: 'steam_1.exe' }),
      bat: await has('launcher-only', { exe_name: 'Gone.exe', launch_file: path.join(root, 'launcher-only', 'start.bat') }),
      uri: await has('nothing-here', { exe_name: 'x.exe', launch_uri: 'shell:AppsFolder/x' }),
      gone: await has('nothing-here', { exe_name: 'x.exe' }),
    }
    check('installed: its file is there', inst.kept === true)
    check('installed: saves left by an uninstaller are not a game', inst.left === false)
    check('installed: an exe further in counts', inst.nested === true)
    check('installed: the file it starts from counts', inst.bat === true)
    check('installed: a store app is not judged by its folder', inst.uri === true)
    check('installed: nothing there', inst.gone === false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

// The "update ready, restart?" box never pops up over a game: the download can finish
// mid-game, and a box there can pull a full-screen game out of focus.
async function updaterTests() {
  const Module = require('module')
  const { EventEmitter } = require('events')
  const fakeUpdater = Object.assign(new EventEmitter(), { quitAndInstall() {}, checkForUpdates: async () => {} })
  let asked = 0
  const fakeElectron = {
    app: { isPackaged: false, getVersion: () => '1.0.0', getPath: () => require('os').tmpdir() },
    dialog: { showMessageBox: async () => { asked++; return { response: 1 } } },
    BrowserWindow: { getAllWindows: () => [] },
  }
  let playing = true, queued = null
  const pwPath = require.resolve(path.join(__dirname, '..', 'electron', 'services', 'processWatcher.js'))
  const upPath = require.resolve(path.join(__dirname, '..', 'electron', 'services', 'appUpdater.js'))
  const savedPw = require.cache[pwPath]
  require.cache[pwPath] = { id: pwPath, filename: pwPath, loaded: true, exports: {
    isSessionActive: () => playing,
    runWhenIdle: (key, fn) => { if (!playing) fn(); else queued = fn },
  } }
  delete require.cache[upPath]
  const realLoad = Module._load
  Module._load = function (req, ...rest) {
    if (req === 'electron-updater') return { autoUpdater: fakeUpdater }
    if (req === 'electron') return fakeElectron
    return realLoad.call(this, req, ...rest)
  }
  try {
    const up = require(upPath)
    up.getAutoUpdater()
    fakeUpdater.emit('update-downloaded', { version: '9.9.9' })
    await new Promise(r => setTimeout(r, 20))
    check('update: ready is known at once', up.getState().state === 'ready' && up.getState().version === '9.9.9')
    check('update: no box while a game is running', asked === 0)
    playing = false
    if (queued) queued()
    await new Promise(r => setTimeout(r, 20))
    check('update: the box comes once the game is closed', asked === 1, `asked ${asked}`)
    fakeUpdater.emit('update-downloaded', { version: '9.9.10' })
    await new Promise(r => setTimeout(r, 20))
    check('update: with no game it asks right away', asked === 2, `asked ${asked}`)
  } finally {
    Module._load = realLoad
    delete require.cache[upPath]
    if (savedPw) require.cache[pwPath] = savedPw; else delete require.cache[pwPath]
  }
}

// Every "Settings, X" a message points people to is a real Settings tab. The Steam tab was
// renamed Connections, and six messages kept sending people to a tab that no longer existed.
function settingsPathTests() {
  const fs = require('fs')
  const srcDir = path.join(__dirname, '..', 'src')
  const settings = fs.readFileSync(path.join(srcDir, 'pages', 'Settings.jsx'), 'utf8')
  const tabs = new Set([...settings.matchAll(/key: '[a-z]+',\s+label: '([A-Za-z ]+)'/g)].map(m => m[1]))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.jsx?$/.test(e.name) ? [path.join(d, e.name)] : [])
  const bad = []
  for (const f of walk(srcDir)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      for (const m of line.replace(/\/\/.*$/, '').matchAll(/(?<![A-Za-z])Settings(?:,| →| >) ?([A-Z][a-z]+)/g)) {
        if (!tabs.has(m[1])) bad.push(`${path.relative(srcDir, f)}:${i + 1} ${m[1]}`)
      }
    })
  }
  check('settings: the tab names were read', tabs.size >= 8, [...tabs].join(','))
  check('settings: every "Settings, X" in a message is a real tab', bad.length === 0, bad.join(' | '))
}

// The tray popup is as tall as what it shows, hanging from the taskbar's edge.
function crackSaveTests() {
  const cs = require(path.join(__dirname, '..', 'electron', 'services', 'crackSaves.js'))
  const ip = 'C:\\Games\\Halls of Torment'
  const gse = 'C:\\Users\\me\\AppData\\Roaming\\GSE Saves\\2218750\\remote'
  const tenoke = ip + '\\SteamData'
  const opts = { appid: '2218750', installPath: ip }
  check('crack saves: Goldberg remote is a cloud folder', cs.isCloudFolder(gse, opts) === true)
  check('crack saves: TENOKE SteamData in the game is one', cs.isCloudFolder(tenoke, opts) === true)
  check('crack saves: a SteamData elsewhere is not', cs.isCloudFolder('D:\\Other\\SteamData', opts) === false)
  check('crack saves: another game\'s remote is not', cs.isCloudFolder('C:\\x\\GSE Saves\\999\\remote', opts) === false)
  const roaming = 'C:\\Users\\me\\AppData\\Roaming\\HallsOfTorment'
  const moved = cs.retarget([gse, roaming], { ...opts, current: tenoke })
  check('crack saves: a restore goes to the current crack\'s folder', moved[0] === tenoke && moved[1] === roaming, JSON.stringify(moved))
  check('crack saves: already there, nothing moves', JSON.stringify(cs.retarget([gse, tenoke], { ...opts, current: tenoke })) === JSON.stringify([gse, tenoke]))
  check('crack saves: unknown crack, nothing moves', JSON.stringify(cs.retarget([gse], { ...opts, current: null })) === JSON.stringify([gse]))
  // Every emulator, not only Goldberg and TENOKE (the maker: "for all games").
  const env = { appdata: 'C:\\A', local: 'C:\\L', publicDocs: 'C:\\P', docs: 'C:\\D' }
  const f = (label) => cs.crackFolders(label, 480, env)
  check('crack saves: CODEX keeps them in Public Documents', f('CODEX').sure && f('CODEX').dirs[0] === 'C:\\P\\Steam\\CODEX\\480\\remote', f('CODEX').dirs[0])
  check('crack saves: RUNE too', f('RUNE').dirs[0] === 'C:\\P\\Steam\\RUNE\\480\\remote')
  check('crack saves: OnlineFix keeps them in Saves', f('online-fix').dirs[0] === 'C:\\P\\OnlineFix\\480\\Saves' && !f('online-fix').sure)
  check('crack saves: SKIDROW in Storage', f('SKIDROW').dirs[0] === 'C:\\L\\SKIDROW\\480\\Storage')
  check('crack saves: EMPRESS and SSE are known', f('EMPRESS').dirs.length > 0 && f('SmartSteamEmu').dirs.length > 0)
  check('crack saves: an unknown emulator has no folder', f('Unknown Steam emulator (steam_api64.dll present)').dirs.length === 0)
  check('crack saves: every emulator folder counts as one', cs.CRACK_LABELS.every(l => f(l).dirs.every(d => cs.isCloudFolder(d, { appid: '480', installPath: 'C:\\G' }))),
    cs.CRACK_LABELS.flatMap(l => f(l).dirs).filter(d => !cs.isCloudFolder(d, { appid: '480', installPath: 'C:\\G' })).join())
  check("crack saves: another game's OnlineFix Saves is not", cs.isCloudFolder('C:\\P\\OnlineFix\\999\\Saves', { appid: '480' }) === false)
  const codex = 'C:\\P\\Steam\\CODEX\\480\\remote', ofix = 'C:\\P\\OnlineFix\\480\\Saves'
  check('crack saves: CODEX to OnlineFix, a restore goes to OnlineFix', cs.retarget([codex], { appid: '480', installPath: 'C:\\G', current: ofix })[0] === ofix)
  check('crack saves: 92 KB of progress beats a fresh 1.6 KB profile', cs.hasMoreProgress(91892, 1612) === true)
  check('crack saves: the same progress is not offered again', cs.hasMoreProgress(91892, 91892) === false)
  check('crack saves: a tiny backup is never offered', cs.hasMoreProgress(900, 0) === false)

  const { parseTenokeIni } = require(path.join(__dirname, '..', 'electron', 'services', 'crackWatcher.js'))
  const ini = [
    '[ACHIEVEMENTS]',
    '"q_Caverns_Boss_1" = {unlocked = true, time = 1762620000}',
    '"q_Locked" = {unlocked = false, time = 0}',
    'q_Bare = {unlocked = true, time = 1762620500}',
    '[STATS]',
    '"kills" = 12.000000',
  ].join('\r\n')
  const got = parseTenokeIni(ini)
  check('TENOKE: unlocked achievements with their time', got.length === 2 && got[0].name === 'q_Caverns_Boss_1' && got[0].unlocktime === 1762620000 && got[1].name === 'q_Bare', JSON.stringify(got))
  check('TENOKE: stats are not achievements', !got.some(a => a.name === 'kills'))
  check('TENOKE: an empty file has none', parseTenokeIni('').length === 0)

  const gv = require(path.join(__dirname, '..', 'electron', 'services', 'gameVersion.js'))
  const oldIni = gv.loaderTargetFromIni('[Launcher]\r\nTarget=HallsOfTorment.exe\r\nStartIn=Halls of Torment\r\nCommandLine=--rendering-driver opengl3\r\n')
  check('loader: the older layout names its game', oldIni && oldIni.exe === 'HallsOfTorment.exe' && oldIni.dir === 'Halls of Torment', JSON.stringify(oldIni))
  const gbe = gv.loaderTargetFromIni('[SteamClient]\nExe=game.exe\nExeRunDir=.\nAppId=480\n')
  check('loader: ColdClientLoader names its game', gbe && gbe.exe === 'game.exe' && gbe.dir === '.', JSON.stringify(gbe))
  check('loader: no exe, no target', gv.loaderTargetFromIni('[Launcher]\nStartIn=x\n') === null)
  const DAY = 86400000
  const newer = gv.pickNewerCopy({ file: 'old.exe', created: 1000 * DAY }, [{ file: 'a.exe', created: 1000.5 * DAY }, { file: 'b.exe', created: 1300 * DAY }])
  check('newer copy: one installed later is found', newer && newer.file === 'b.exe', JSON.stringify(newer))
  check('newer copy: copies made the same day are not', gv.pickNewerCopy({ file: 'old.exe', created: 1000 * DAY }, [{ file: 'a.exe', created: 1000.5 * DAY }]) === null)
}

function steamCopyTests() {
  const sc = require(path.join(__dirname, '..', 'electron', 'services', 'steamCopy.js'))
  const base = { isCracked: true, appid: 480, steamDir: 'D:\\Steam\\steamapps\\common\\Some Game', installPath: 'C:\\Games\\Some Game', dismissedDir: null }
  check('Steam copy: a game with no launcher, now installed on Steam, is offered the switch', sc.shouldOffer(base) === true)
  check('Steam copy: already the Steam folder, nothing to offer', sc.shouldOffer({ ...base, installPath: base.steamDir + '\\Binaries' }) === false)
  check('Steam copy: not installed on Steam, nothing to offer', sc.shouldOffer({ ...base, steamDir: null }) === false)
  check('Steam copy: a Steam game is never offered', sc.shouldOffer({ ...base, isCracked: false }) === false)
  check('Steam copy: "Not now" holds for that Steam folder', sc.shouldOffer({ ...base, dismissedDir: base.steamDir }) === false)
  const helpers = { isHelperExe: (n) => /unins|crash/i.test(n), pickBestExe: (list) => list.sort((a, b) => b.size - a.size)[0].name }
  const exes = [{ name: 'Game.exe', size: 10, dir: 'D' }, { name: 'Other.exe', size: 99, dir: 'D' }, { name: 'unins000.exe', size: 500, dir: 'D' }]
  check('Steam copy: the same file name is kept', sc.pickSteamExe(exes, 'game.exe', 'Some Game', helpers)?.name === 'Game.exe')
  check('Steam copy: else the best real game file', sc.pickSteamExe(exes, 'Old.exe', 'Some Game', helpers)?.name === 'Other.exe')
  check('Steam copy: only tools, no file at all', sc.pickSteamExe([exes[2]], 'Old.exe', 'Some Game', helpers) === null)
}

function storageTests() {
  const { driveOf, group } = require(path.join(__dirname, '..', 'electron', 'services', 'gameSizes.js'))
  check('storage: the drive of a path', driveOf('d:\Games\X') === 'D:' && driveOf('') === null)
  const drives = [{ drive: 'C:', free: 50, size: 500 }, { drive: 'D:', free: 300, size: 1000 }]
  const games = [{ id: 1, name: 'Small', install_path: 'C:\G\A', size: 10 }, { id: 2, name: 'Big', install_path: 'C:\G\B', size: 90 }, { id: 3, name: 'Elsewhere', install_path: 'E:\G', size: 5 }]
  const out = group(drives, games)
  const c = out.find(d => d.drive === 'C:')
  check('storage: games sit under their drive, biggest first', c.games.map(g => g.name).join() === 'Big,Small' && c.gamesBytes === 100, JSON.stringify(c))
  check('storage: a drive with no games still shows', !!out.find(d => d.drive === 'D:' && d.games.length === 0))
  check("storage: a game on a drive that isn't listed still shows", !!out.find(d => d.drive === 'E:' && d.games.length === 1))
}

function gpuTrimTests() {
  const { shouldTrim, MIN_GAP_MS } = require(path.join(__dirname, '..', 'electron', 'services', 'gpuTrim.js'))
  const base = { now: 10 * MIN_GAP_MS, lastAt: 0, windowShown: false, sessionActive: false, compositing: 'enabled', mb: 300 }
  check('gpuTrim: frees a big graphics process with nothing on screen', shouldTrim(base) === true)
  check('gpuTrim: never with a window on screen', shouldTrim({ ...base, windowShown: true }) === false)
  check('gpuTrim: never during a game', shouldTrim({ ...base, sessionActive: true }) === false)
  check('gpuTrim: at most once every 2 hours', shouldTrim({ ...base, lastAt: base.now - MIN_GAP_MS + 60000 }) === false && shouldTrim({ ...base, lastAt: base.now - MIN_GAP_MS }) === true)
  check('gpuTrim: leaves a small process alone', shouldTrim({ ...base, mb: 80 }) === false)
  check('gpuTrim: never when drawing without the graphics card', shouldTrim({ ...base, compositing: 'disabled_software' }) === false && shouldTrim({ ...base, compositing: undefined }) === false)
}

;(async () => {
  settingsPathTests()
  gpuTrimTests()
  storageTests()
  crackSaveTests()
  steamCopyTests()
  await installCheckTests()
  try { await updaterTests() } catch (e) { check('updater tests ran', false, e.message) }
  try { await discordTests() } catch (e) { check('discord tests ran', false, e.message) }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
})()
