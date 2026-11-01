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
