// Discord Rich Presence: while a game is being tracked, Discord shows it
// ("Playing Elden Ring", with your KoZo level and hours underneath).
//
// No package: Discord's local RPC is a named pipe (\\?\pipe\discord-ipc-N)
// speaking frames of [opcode u32 LE][length u32 LE][JSON]. Op 0 is the
// handshake with the user's own Discord Application ID (Settings → General),
// op 1 carries commands (SET_ACTIVITY).
//
// Resource rules: nothing runs while no game is playing. When a session starts
// it connects; if Discord isn't open it retries at most once a minute, and
// only while a session is still active. The pipe is closed when play stops.

const net = require('net')
const settingsQ = require('../db/queries/settings')
const logger = require('../logger')

const OP_HANDSHAKE = 0
const OP_FRAME = 1
const OP_CLOSE = 2
const RETRY_MS = 60 * 1000
const REPO_URL = 'https://github.com/MuhannadAl-Srahen/KoZo'

let sock = null
let ready = false
let buf = Buffer.alloc(0)
let retryTimer = null
let current = null        // the activity Discord should show, or null
let status = 'off'        // off | no_id | connecting | connected | not_running
let nonce = 0

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8')
  const head = Buffer.alloc(8)
  head.writeUInt32LE(op, 0)
  head.writeUInt32LE(json.length, 4)
  return Buffer.concat([head, json])
}

// Split a byte stream into whole frames; returns [frames, leftover].
function decode(bytes) {
  const frames = []
  let off = 0
  while (bytes.length - off >= 8) {
    const op = bytes.readUInt32LE(off)
    const len = bytes.readUInt32LE(off + 4)
    if (bytes.length - off - 8 < len) break
    let data = null
    try { data = JSON.parse(bytes.slice(off + 8, off + 8 + len).toString('utf8')) } catch {}
    frames.push({ op, data })
    off += 8 + len
  }
  return [frames, bytes.slice(off)]
}

function enabled() { return settingsQ.getSetting('discord_presence') === '1' }
// The user's own Discord application, else KoZo's (electron/defaults.js).
function clientId() { return String(settingsQ.getSetting('discord_client_id') || '').trim() || require('../defaults').DISCORD_CLIENT_ID }

function send(op, data) {
  try { sock?.write(encode(op, data)) } catch {}
}

function pushActivity() {
  if (!ready) return
  send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: current }, nonce: String(++nonce) })
}

function disconnect() {
  clearTimeout(retryTimer); retryTimer = null
  if (sock) {
    try { if (ready) send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: String(++nonce) }) } catch {}
    try { sock.end(); sock.destroy() } catch {}
  }
  sock = null; ready = false; buf = Buffer.alloc(0)
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(() => { retryTimer = null; if (current) connect() }, RETRY_MS)
}

// Try discord-ipc-0..9 in turn (Discord, PTB and Canary each take a slot).
function connect(slot = 0) {
  const id = clientId()
  if (!id) { status = 'no_id'; return }
  if (sock) return
  if (slot > 9) { status = 'not_running'; scheduleRetry(); return }
  status = 'connecting'
  const s = net.connect(`\\\\?\\pipe\\discord-ipc-${slot}`)
  sock = s
  let opened = false
  s.on('connect', () => {
    opened = true
    send(OP_HANDSHAKE, { v: 1, client_id: id })
  })
  s.on('data', (chunk) => {
    const [frames, rest] = decode(Buffer.concat([buf, chunk]))
    buf = rest
    for (const f of frames) {
      if (f.op === OP_CLOSE) { logger.warn('discord: closed by Discord', { message: f.data?.message }); status = 'bad_id'; disconnect(); return }
      if (f.data?.evt === 'READY') { ready = true; status = 'connected'; pushActivity() }
      else if (f.data?.evt === 'ERROR') logger.warn('discord: error', { message: f.data?.data?.message })
    }
  })
  s.on('error', () => {})
  s.on('close', () => {
    if (sock !== s) return
    sock = null; ready = false; buf = Buffer.alloc(0)
    if (!opened) connect(slot + 1)          // nothing on this slot: next one
    else if (current) { status = 'not_running'; scheduleRetry() }   // Discord quit mid-game
  })
}

function hours(sec) {
  const h = Math.floor((sec || 0) / 3600)
  if (h >= 1) return `${h}h played`
  return `${Math.max(1, Math.round((sec || 0) / 60))}m played`
}

// Rebuild the activity from the live sessions (the first one wins).
function refresh() {
  if (!enabled()) { status = 'off'; current = null; disconnect(); return }
  if (!clientId()) { status = 'no_id'; current = null; disconnect(); return }
  let session = null
  try {
    for (const s of require('./processWatcher').getActiveSessions().values()) { session = s; break }
  } catch {}
  if (!session) {
    current = null
    disconnect()
    status = 'idle'
    return
  }
  let game = null, level = null
  try { game = require('../db/queries/games').getGame(session.game_id) } catch {}
  try { level = require('./xp').computeXp().level } catch {}
  const name = game?.name || session.game_name || 'a game'
  const art = /^https:\/\//.test(game?.banner_url || '') ? game.banner_url : null
  current = {
    type: 0,
    details: name,
    state: [level ? `KoZo level ${level}` : null, hours(game?.total_playtime_seconds)].filter(Boolean).join(' · '),
    timestamps: { start: new Date(session.started_at).getTime() || Date.now() },
    // Show the game's name (details) in the member list, not the app's.
    status_display_type: 2,
    assets: art ? { large_image: art, large_text: name } : undefined,
    buttons: [{ label: 'Track games with KoZo', url: REPO_URL }],
    instance: false,
  }
  if (ready) pushActivity()
  else if (!sock && !retryTimer) connect()
}

function start() {
  try { require('./processWatcher').onChange(() => { try { refresh() } catch (e) { logger.warn('discord: refresh failed', { message: e.message }) } }) } catch {}
  refresh()
}

function stop() { current = null; disconnect() }

function getStatus() {
  if (!enabled()) return 'off'
  if (!clientId()) return 'no_id'
  return status
}

module.exports = { start, stop, refresh, getStatus, _encode: encode, _decode: decode }
