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
  check('install-relative steam_settings (unzipped games)', has(path.join('C:\\FakeGame', 'steam_settings', 'achievements.json')))
  check('install-relative CODEX ini', has(path.join('C:\\FakeGame', 'achievements.ini')))
  check('CODEX/EMPRESS keyed by appid somewhere', has(path.join('480', 'achievements.ini')))
  check('SSE stats.bin candidate', has('stats.bin'))
  check('online-fix Stats\\Achievements.ini candidate', has(path.join('OnlineFix', '480', 'Stats', 'Achievements.ini')))

  // manual_appid fallback — the unzipped-game case with no steam_app_id
  const cands2 = cw.buildCandidates({ steam_app_id: null, manual_appid: 1234, install_path: 'C:\\FakeGame' })
  check('manual_appid keys emulator folders', cands2.some(c => c.path.includes('1234')))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
