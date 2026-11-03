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

// Upcoming "Picked for you": Steam's More like this lists, scored.
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

// Picked for you: sources come from the whole Game List, not only favourites.
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
  const { dealScore, lowState, tasteMatch } = require(path.join(__dirname, '..', 'electron', 'services', 'deals.js'))
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

;(async () => {
  try { await discordTests() } catch (e) { check('discord tests ran', false, e.message) }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
})()
